/**
 * Locates a package manager's executable and, optionally, reads its version.
 *
 * This is the sharp edge of the package-manager check, so the constraints are
 * deliberately narrow and stated here rather than discovered in review:
 *
 *   • PATH only. `node_modules/.bin` is never searched — it is writable by any
 *     dependency install, so resolving a "package manager" from there would run
 *     project-controlled code simply to ask its name.
 *   • No shell. Arguments are passed as an array, so a directory name containing
 *     `;` or `&` cannot become a command.
 *   • Bounded probing. Version output is a nice-to-have; a hung binary must never
 *     hang the doctor.
 *   • Non-zero exit is evidence, not an error. `npm --version` failing tells us
 *     something about the environment; it is not a QAT fault and must not be
 *     thrown as one.
 *
 * Everything the module needs from the outside world (PATH value, platform,
 * filesystem checks, process execution) is injected, and every default is supplied
 * by a named factory in this file. The environment and the host platform are read
 * in exactly two defaulted argument positions, through the one helper below, so
 * tests are deterministic and the reads are greppable.
 *
 * ## Why the filesystem probe lives here
 *
 * "Exists, is a regular file, and is executable by us" is not a general filesystem
 * capability — it is this locator's definition of a candidate it would actually
 * run. Keeping it beside the security rule it serves means the two are reviewed
 * together, and it keeps `core/filesystem` from growing a function that exists for
 * one caller's private definition.
 *
 * ## Why the method is called `locateExecutable`
 *
 * It matches `ExecutableLocator` in `core/application/ports`, which lets this
 * factory *be* the port: composition assigns it directly instead of wrapping it to
 * bridge two names. An adapter with no translation inside it is a second name for
 * the same function, and this file would rather not have one.
 */

import { access, constants, stat } from "node:fs/promises";

import type {
  ExecutableAvailability,
  ExecutableLocatorPort,
  PackageManagerExecutablePort,
  PackageManagerName,
  PackageManagerProbePort,
  VersionEvidence,
} from "./contracts.js";
import { PACKAGE_MANAGER_POLICY } from "./policy.js";

// ─────────────────────────────────────────────────────────────────────────────
// Ambient access
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reads one environment variable.
 *
 * The bracket form is not a style preference: `NodeJS.ProcessEnv` is an index
 * signature, so dot access is refused outright by the compiler — which is the
 * mechanism that stops `process.env.PATH` from being scattered across the module.
 * Funnelling it through one function keeps that guarantee, and gives a single
 * place to look when asking "what does this module take from the machine?".
 *
 * Returns `undefined` for an unset variable rather than an empty string, so a
 * caller can tell "not set" from "set but empty" — a distinction the locator
 * relies on, because an empty PATH segment means "the current directory".
 */
function readEnvironmentVariable(name: string): string | undefined {
  return process.env[name];
}

// ─────────────────────────────────────────────────────────────────────────────
// Budgets
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Upper bound for a single version probe.
 *
 * Chosen to be long enough for a cold binary on a loaded CI runner and short
 * enough that an unresponsive shim cannot make `qat doctor` look frozen. The
 * probe is also skipped entirely when no version was declared, so this budget is
 * paid only when it buys something.
 */
export const PROBE_TIMEOUT_MS = 2_000;

/**
 * Output is truncated before parsing. A binary that prints megabytes is either
 * broken or hostile; neither deserves memory in the diagnostic process.
 */
export const PROBE_MAX_OUTPUT_BYTES = 512;

// ─────────────────────────────────────────────────────────────────────────────
// Filesystem port used by the locator
// ─────────────────────────────────────────────────────────────────────────────

/** The only filesystem question the locator needs answered. */
export interface ExecutableFileProbe {
  /** True when the path exists, is a regular file and is executable by us. */
  readonly isExecutableFile: (path: string) => Promise<boolean>;
}

/**
 * The default probe: exists, is a regular file, and is executable by us.
 *
 * Two deliberate softenings, both of which remove a way for the doctor to fail
 * for a reason that is not the user's problem:
 *
 *   • A failed stat is `false`, not a throw. The locator asks about many paths, and
 *     one unreadable or dangling entry must not abort the search — ENOENT and
 *     EACCES answer the same question we asked.
 *   • On Windows the executable bit is not a meaningful concept: `PATHEXT` decides
 *     what runs, so requiring X_OK would reject every legitimate `.cmd` shim.
 *     Being an existing file is the strongest portable claim available there.
 *
 * `platform` is a parameter rather than a `process.platform` read inside, so the
 * Windows branch is reachable from a test running on any machine.
 */
export function createExecutableFileProbe(
  platform: NodeJS.Platform = process.platform,
): ExecutableFileProbe {
  return {
    isExecutableFile: async (path: string): Promise<boolean> => {
      try {
        const info = await stat(path);
        if (!info.isFile()) return false;
        if (platform === "win32") return true;

        await access(path, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Process port used by the probe
// ─────────────────────────────────────────────────────────────────────────────

/** Result of running a command, with failure states modelled explicitly. */
export type CommandOutcome =
  | {
      readonly status: "exited";
      readonly exitCode: number;
      readonly stdout: string;
    }
  | { readonly status: "timed-out"; readonly stdout: string }
  | { readonly status: "failed"; readonly reason: string };

/**
 * Runs a command without a shell.
 *
 * Bound by composition to the core process runner, which already treats a
 * non-zero exit code as a result rather than an exception — the same convention
 * that lets QAT preserve a test runner's own status instead of flattening it.
 *
 * Structurally identical to `CommandRunner` in `core/application/ports`; the
 * duplication should be retired in favour of that one, which is the layer that
 * owns machine-level vocabulary.
 */
export interface CommandRunnerPort {
  readonly run: (
    command: string,
    args: readonly string[],
    options: { readonly timeoutMs: number; readonly maxOutputBytes: number },
  ) => Promise<CommandOutcome>;
}

// ─────────────────────────────────────────────────────────────────────────────
// PATH locator
// ─────────────────────────────────────────────────────────────────────────────

export interface PathLocatorOptions {
  /** Raw PATH value. Default is read once, at factory call time. */
  readonly pathValue?: string;
  readonly platform?: NodeJS.Platform;
  /** Windows executable extensions, normally from PATHEXT. */
  readonly pathExtensions?: string;
  /**
   * Filesystem probe. Optional, defaulting to {@link createExecutableFileProbe}, so
   * the common case is one call — `createPathLocator()` — and a test still supplies
   * a fake without touching a disk.
   */
  readonly files?: ExecutableFileProbe;
}

/** Windows resolves `pnpm` via these suffixes; POSIX does not have the concept. */
const DEFAULT_WINDOWS_EXTENSIONS = ".COM;.EXE;.BAT;.CMD";

/**
 * True when a directory lives inside a `node_modules` tree.
 *
 * Split on both separators because a Windows PATH can contain forward slashes
 * and the check must not depend on `path` semantics for the platform that
 * happens to be running the test suite.
 */
function isInsideNodeModules(directory: string): boolean {
  return directory
    .split(/[\\/]/)
    .some((segment) => segment.toLowerCase() === "node_modules");
}

/**
 * Resolves a bare command name against PATH.
 *
 * Deliberate exclusions, each of which removes a real failure mode:
 *
 *   • empty PATH segments — they mean "the current directory", the classic
 *     PATH-hijack vector on Windows and a quiet way to run a repo's own file;
 *   • relative segments — resolved against an unspecified working directory, so
 *     they cannot produce a trustworthy absolute path;
 *   • anything under node_modules — see the module header.
 *
 * First match wins, in PATH order, exactly as a shell would. We do not `realpath`
 * the result: the extra syscall buys nothing here, and the reported path is
 * evidence, not something we later execute by path.
 */
export function createPathLocator(
  options: PathLocatorOptions = {},
): ExecutableLocatorPort {
  // Read once, here. A locator that re-read the environment per call could give
  // two answers within one run if something mutated it in between.
  const pathValue = options.pathValue ?? readEnvironmentVariable("PATH") ?? "";
  const platform = options.platform ?? process.platform;
  const pathExtensions =
    options.pathExtensions ??
    readEnvironmentVariable("PATHEXT") ??
    DEFAULT_WINDOWS_EXTENSIONS;

  // Built once with the same platform the search uses, so the two cannot disagree
  // about whether X_OK is meaningful on this machine.
  const files = options.files ?? createExecutableFileProbe(platform);

  const separator = platform === "win32" ? ";" : ":";

  // An empty suffix is tried first so a POSIX-style name without an extension —
  // or a Windows binary that already carries one — resolves without a second pass.
  const suffixes =
    platform === "win32"
      ? [
          "",
          ...pathExtensions
            .split(";")
            .map((extension) => extension.trim())
            .filter(Boolean),
        ]
      : [""];

  return {
    async locateExecutable(command: string): Promise<string | undefined> {
      for (const rawDirectory of pathValue.split(separator)) {
        const directory = rawDirectory.trim();
        if (directory === "") continue; // cwd segment — refused
        if (!isAbsoluteFor(platform, directory)) continue;
        if (isInsideNodeModules(directory)) continue;

        for (const suffix of suffixes) {
          const candidate = joinFor(platform, directory, command + suffix);
          if (await files.isExecutableFile(candidate)) return candidate;
        }
      }

      return undefined;
    },
  };
}

// Thin platform-aware helpers kept local so the locator has no ambient dependency
// on the platform the code happens to be compiled for.
function isAbsoluteFor(platform: NodeJS.Platform, value: string): boolean {
  return platform === "win32"
    ? /^[A-Za-z]:[\\/]|^\\\\/.test(value)
    : value.startsWith("/");
}

function joinFor(
  platform: NodeJS.Platform,
  directory: string,
  name: string,
): string {
  const trimmed = directory.replace(/[\\/]+$/, "");
  return platform === "win32" ? `${trimmed}\\${name}` : `${trimmed}/${name}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Version probe
// ─────────────────────────────────────────────────────────────────────────────

/** First `x.y.z` (optionally `v`-prefixed, optionally tagged) in the output. */
const VERSION_TOKEN = /\bv?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/;

export interface VersionProbeOptions {
  /**
   * Host platform. Defaults to the running one, read once at construction.
   *
   * Injectable for the same reason the locator's platform is: without it, the
   * `.cmd`/`.bat` guard below can only ever be exercised on a Windows machine, and
   * the branch that protects against spawning a shell shim would stay untested on
   * every CI runner that is not Windows.
   */
  readonly platform?: NodeJS.Platform;
}

/**
 * Reads a manager's version, treating every failure as evidence.
 *
 * Windows caveat, and the reason this is safe: since the shell-injection hardening
 * in Node's `child_process`, `.cmd`/`.bat` shims cannot be spawned without
 * `shell: true`. We refuse to enable a shell for this, so such shims are reported
 * as `not-probed` — the check simply skips the version comparison and says
 * nothing, rather than opening an execution hole to satisfy curiosity.
 */
export function createVersionProbe(
  runner: CommandRunnerPort,
  options: VersionProbeOptions = {},
): PackageManagerProbePort {
  const platform = options.platform ?? process.platform;

  return {
    async probeVersion(executablePath: string): Promise<VersionEvidence> {
      if (platform === "win32" && /\.(cmd|bat)$/i.test(executablePath)) {
        return { status: "not-probed" };
      }

      const outcome = await runner.run(executablePath, ["--version"], {
        timeoutMs: PROBE_TIMEOUT_MS,
        maxOutputBytes: PROBE_MAX_OUTPUT_BYTES,
      });

      switch (outcome.status) {
        case "timed-out":
          return { status: "unreadable", reason: "timeout" };

        case "failed":
          return { status: "unreadable", reason: "failed" };

        case "exited": {
          // Non-zero exit means the binary ran but declined to answer; that is
          // information about the environment, not a crash to report as one.
          if (outcome.exitCode !== 0)
            return { status: "unreadable", reason: "failed" };

          const [, version] = VERSION_TOKEN.exec(outcome.stdout) ?? [];

          // Unreachable when the pattern matched, because it has exactly one
          // capture group — and still guarded rather than asserted, because
          // `noUncheckedIndexedAccess` types a capture as possibly absent and the
          // guard is what makes the assumption legible instead of silent.
          if (version === undefined)
            return { status: "unreadable", reason: "empty-output" };

          // "answered, but with nothing we can compare" is distinct from
          // "did not answer": the former is a broken toolchain, the latter a
          // hung one, and the remediation differs.
          return { status: "read", value: version };
        }
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Composed port
// ─────────────────────────────────────────────────────────────────────────────

export interface PackageManagerExecutableOptions {
  readonly locator: ExecutableLocatorPort;
  readonly probe: PackageManagerProbePort;
  /**
   * Whether a version is worth probing for this manager.
   *
   * Composition decides, from the snapshot: a project that declared no version
   * and no `engines` range gains nothing from spawning the binary, so the common
   * case pays neither latency nor process risk.
   */
  readonly shouldProbe: (manager: PackageManagerName) => boolean;
}

/**
 * Resolves availability for a manager: first executable found on PATH wins.
 *
 * `missing` is a definitive answer and must not be conflated with
 * `version: not-probed`. One means "install the tool"; the other means
 * "everything is fine, we just did not look at a version".
 */
export function createPackageManagerExecutablePort(
  options: PackageManagerExecutableOptions,
): PackageManagerExecutablePort {
  return {
    async resolve(
      manager: PackageManagerName,
    ): Promise<ExecutableAvailability> {
      for (const command of PACKAGE_MANAGER_POLICY[manager].executables) {
        const path = await options.locator.locateExecutable(command);
        if (path === undefined) continue;

        // Annotated rather than asserted: the annotation supplies the contextual
        // type, so the object literal is checked against `VersionEvidence` and
        // no `as const` is needed to stop `status` widening to `string`.
        const version: VersionEvidence = options.shouldProbe(manager)
          ? await options.probe.probeVersion(path)
          : { status: "not-probed" };

        return Object.freeze({ status: "found", path, version });
      }

      return Object.freeze({ status: "missing" });
    },
  };
}
