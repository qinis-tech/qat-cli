/**
 * Locating and verifying the Cypress binary.
 *
 * This module establishes two of the six Cypress facts — *is a binary installed for this version?* and *is it
 * runnable?* — and it does so without ever running the project's tests.
 *
 * Why a binary check exists at all: `npm ci` can succeed, `node_modules/cypress` can be perfectly present, and the
 * ~150 MB Cypress binary can still be missing. The binary lives in a *version-keyed cache outside the project*, is
 * downloaded by a post-install step that is frequently skipped (`--ignore-scripts`, read-only CI caches, offline
 * installs), and is platform-specific. The resulting error looks like a Cypress bug and is almost always a cache
 * problem.
 *
 * The approved method, in order:
 *
 *   1. **Static inspection.** Reproduce Cypress's own cache layout for the resolved version and look at the file.
 *      Fast, offline, silent, and needs no cooperation from the project.
 *   2. **Bounded verification.** Only when static evidence is ambiguous, run the project's *own* Cypress CLI with
 *      `verify` — a documented, non-interactive command that checks the cached binary and exits non-zero when it is
 *      unusable. Executed through the shared process runner, with a hard timeout, `shell: false`, and capped output.
 *   3. **Never** `cypress run` or `cypress open`. A diagnostic answers "could a run start?"; it does not start one. The
 *      user's test suite is never executed, which also means this check cannot fail for reasons that belong to a test.
 *
 * Two safety details that are easy to miss:
 *
 *  • The version string originates in an untrusted, user-editable manifest. It is validated against a semver-shaped
 *    path guard before being joined into a path — otherwise a crafted version such as `../../etc` would turn a health
 *    check into an arbitrary-path stat oracle. The guard also refuses dot-only segments such as `..`, which need no
 *    separator to escape a directory: `path.join` collapses them for you.
 *  • Paths are reported in display form (`~`-abbreviated). A diagnostic needs to say *where* it looked; it never needs
 *    to publish a full home directory into a CI log.
 */

import { constants as fsConstants } from "node:fs";
import path from "node:path";

import type {
  CypressBinaryEvidence,
  CypressBinaryInspectorPort,
  CypressBinaryProbeInput,
  CypressBinaryProbePort,
  CypressBinaryProbeResult,
  CypressBinaryState,
} from "./contracts.js";

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Hard upper bound for the verification process.
 *
 * `cypress verify` reads and starts the binary; on a cold or slow filesystem it can take a few seconds. Thirty seconds
 * is generous enough to avoid false "unverified" results and short enough that a doctor run can never appear hung.
 */
export const BINARY_VERIFY_TIMEOUT_MS = 30_000;

/** Cap on captured probe output, so a misbehaving binary cannot flood the log. */
export const BINARY_PROBE_MAX_OUTPUT_BYTES = 2_048;

/**
 * The only argument vector this module is permitted to run.
 *
 * Frozen and exported so the prohibition is testable rather than aspirational: a test asserts that no probe invocation
 * carries `run`, `open` or a spec path.
 */
export const CYPRESS_VERIFY_ARGUMENTS: readonly string[] = Object.freeze([
  "verify",
]);

/** Environment variable Cypress itself honours for a relocated cache. */
const CACHE_FOLDER_ENV = "CYPRESS_CACHE_FOLDER";

/**
 * Platforms this module understands.
 *
 * Declared as an explicit union rather than derived from a table's keys, so the tables below can be typed against it
 * and the compiler can prove every platform case is covered. A derived union plus `keyof typeof` typically forces casts
 * at every lookup; this shape needs none.
 */
type SupportedPlatform = "darwin" | "linux" | "win32";

/**
 * Narrows a Node platform to the platforms we have a cache layout for.
 *
 * The predicate form — rather than `platform in TABLE` — is what lets the compiler narrow the argument, which is why
 * the rest of this file needs no type assertions on platform lookups.
 */
function isSupportedPlatform(
  platform: NodeJS.Platform,
): platform is SupportedPlatform {
  return platform === "darwin" || platform === "linux" || platform === "win32";
}

interface CacheRootSpec {
  /** Environment variable that holds the base directory for this platform. */
  readonly homeVariable: string;
  /** Path segments appended to that base to reach the Cypress cache. */
  readonly suffix: readonly string[];
}

/**
 * Cache roots per platform, mirroring Cypress's own defaults.
 *
 * Kept as data so a user-facing message can never name a different directory from the one actually inspected — and so
 * adding a platform is a table edit plus a test, not a code change in three places.
 */
const CACHE_ROOTS: Readonly<Record<SupportedPlatform, CacheRootSpec>> =
  Object.freeze({
    /** `~/Library/Caches/Cypress` */
    darwin: { homeVariable: "HOME", suffix: ["Library", "Caches", "Cypress"] },
    /** `~/.cache/Cypress` */
    linux: { homeVariable: "HOME", suffix: [".cache", "Cypress"] },
    /** `%LOCALAPPDATA%\Cypress\Cache` */
    win32: { homeVariable: "LOCALAPPDATA", suffix: ["Cypress", "Cache"] },
  });

/**
 * Relative path of the executable inside `<cacheRoot>/<version>/`.
 * macOS ships an app bundle; Linux a plain ELF binary; Windows an `.exe`.
 */
const BINARY_ENTRIES: Readonly<Record<SupportedPlatform, readonly string[]>> =
  Object.freeze({
    darwin: ["Cypress.app", "Contents", "MacOS", "Cypress"],
    linux: ["Cypress", "Cypress"],
    win32: ["Cypress.exe"],
  });

/**
 * Variables that may hold the user's profile directory, checked in order when abbreviating a path for display.
 */
const DISPLAY_HOME_VARIABLES: readonly string[] = ["LOCALAPPDATA", "HOME"];

/**
 * Path-safety guard for a version segment.
 *
 * This is not a version parser — the shared version engine owns validation. Its only job is to prove the string cannot
 * escape the cache directory.
 *
 * The shape is dot-*separated* runs rather than a flat character class. A class containing `.` also accepts `..`, and
 * `path.join` then collapses that into the parent directory — a traversal that contains no separator at all and would
 * therefore slip past any check that only looks for `/` or `\`. Versions still pass, because every version separator
 * sits between two runs: `13.6.0`, `14.0.0-rc.1`, `13.6.0+build.7`.
 */
const SAFE_PATH_SEGMENT = /^[0-9A-Za-z+_-]+(?:\.[0-9A-Za-z+_-]+)*$/;

/* -------------------------------------------------------------------------- */
/* Injectable boundaries                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The two filesystem calls inspection needs: `stat` and an execute check.
 *
 * Nothing here can write, so the module cannot repair what it finds — repair is the user's `cypress install`, never the
 * doctor's.
 */
export interface BinaryFileSystem {
  readonly stat: (target: string) => Promise<{
    readonly isFile: () => boolean;
    readonly mode: number;
    readonly size: number;
  }>;
  readonly access: (target: string, mode: number) => Promise<void>;
}

/**
 * Result shape of the shared process runner, narrowed to what this module reads.
 *
 * The adapter supplied at composition time delegates to the existing runner, so there is exactly one process
 * implementation in the product with one definition of "timed out", one signal policy and one output cap. This
 * interface exists to keep the dependency direction pointing inwards, not to invite a second runner.
 */
export interface ProbeProcessResult {
  readonly timedOut: boolean;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type ProbeProcessRunner = (
  command: string,
  args: readonly string[],
  options: {
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
    readonly shell: false;
  },
) => Promise<ProbeProcessResult>;

/* -------------------------------------------------------------------------- */
/* Cache location — pure                                                       */
/* -------------------------------------------------------------------------- */

export interface CypressCacheLocation {
  /** Absolute cache root, or `null` when it cannot be determined safely. */
  readonly cacheRoot: string | null;
  /** Relative segments of the binary inside the version directory. */
  readonly entry: readonly string[] | null;
}

/**
 * Determines where Cypress keeps binaries on this machine.
 *
 * Returns an undefined root rather than guessing when the environment does not provide what the platform needs — a
 * diagnostic that prints an invented path is worse than one that says "I could not determine the cache location".
 *
 * Precedence: `CYPRESS_CACHE_FOLDER` (Cypress's own override) first, then the platform default. A *relative* override is
 * treated as undeterminable: its meaning depends on Cypress's working directory, which differs from ours, and silently
 * resolving it against the project root would produce a confidently wrong path.
 */
export function resolveCacheLocation(
  environment: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): CypressCacheLocation {
  if (!isSupportedPlatform(platform)) return { cacheRoot: null, entry: null };

  const entry = BINARY_ENTRIES[platform];

  const override = environment[CACHE_FOLDER_ENV];
  if (override !== undefined && override.trim() !== "") {
    return path.isAbsolute(override)
      ? { cacheRoot: path.normalize(override), entry }
      : { cacheRoot: null, entry: null };
  }

  const defaults = CACHE_ROOTS[platform];
  const home = environment[defaults.homeVariable];
  if (home === undefined || home.trim() === "")
    return { cacheRoot: null, entry: null };

  return { cacheRoot: path.join(home, ...defaults.suffix), entry };
}

/**
 * The absolute path the binary was expected at, or `null` when it cannot be computed safely.
 *
 * The version guard is load-bearing: the version string comes from a manifest we do not control, and joining it into a
 * path unchecked would allow traversal out of the cache directory — including by a dot-only segment, which needs no
 * separator to escape.
 */
export function expectedBinaryPath(
  version: string,
  environment: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (!SAFE_PATH_SEGMENT.test(version)) return null;

  const location = resolveCacheLocation(environment, platform);
  if (location.cacheRoot === null || location.entry === null) return null;

  return path.join(location.cacheRoot, version, ...location.entry);
}

/**
 * Rewrites a path for display: the profile directory becomes `~`.
 *
 * Keeps messages readable and stops a diagnostic from publishing a full home path into a shared CI log. Only a display
 * transformation — never used for I/O.
 */
export function toDisplayPath(
  absolutePath: string,
  environment: Readonly<Record<string, string | undefined>>,
): string {
  for (const variable of DISPLAY_HOME_VARIABLES) {
    const home = environment[variable];
    if (home === undefined || home === "") continue;

    const normalised = path.normalize(home);
    if (absolutePath === normalised) return "~";
    if (absolutePath.startsWith(normalised + path.sep)) {
      return "~" + absolutePath.slice(normalised.length);
    }
  }

  return absolutePath;
}

/* -------------------------------------------------------------------------- */
/* Inspection — bounded I/O                                                    */
/* -------------------------------------------------------------------------- */

export interface CreateBinaryInspectorOptions {
  readonly fileSystem: BinaryFileSystem;
  readonly platform?: NodeJS.Platform;
}

/**
 * Builds the inspector port.
 *
 * Inspection never throws and never returns a bare boolean: "absent", "present but not executable", "present and
 * executable" and "cannot tell" are four different messages, and collapsing them is how users get told to run
 * `cypress install` when the real problem is a permission bit or an architecture mismatch.
 */
export function createCypressBinaryInspector(
  options: CreateBinaryInspectorOptions,
): CypressBinaryInspectorPort {
  const { fileSystem } = options;
  const platform = options.platform ?? process.platform;

  return {
    async inspect({
      version,
      environment,
    }): Promise<CypressBinaryEvidence | null> {
      // The location is resolved once and used for both the path and the reported root. Deriving the root from the
      // binary path separately would have to know how deep the platform entry is — two segments on Linux, four on
      // macOS — and getting that arithmetic wrong reports a directory that is not the cache root at all.
      const location = resolveCacheLocation(environment, platform);
      if (location.cacheRoot === null || location.entry === null) {
        // No safe path to inspect: unknown platform, missing profile variable, or a relative cache override. `null`
        // tells the assessor "no evidence was gathered", which it reports as unknown rather than as a missing binary.
        return null;
      }

      if (!SAFE_PATH_SEGMENT.test(version)) return null;

      const absolutePath = path.join(
        location.cacheRoot,
        version,
        ...location.entry,
      );

      const state = await inspectPath(fileSystem, absolutePath, platform);

      // Annotated before freezing so every property is contextually typed by the contract — no literal assertions, and
      // the result is immutable because these findings are read by the report, the JSON export and the history store.
      const evidence: CypressBinaryEvidence = {
        version,
        cacheRoot: toDisplayPath(location.cacheRoot, environment),
        expectedPath: toDisplayPath(absolutePath, environment),
        state,
        // Static inspection is the default and is always reported, so a result can never be read as "proven to launch a
        // browser" when it only proves a file exists with the right permission bits.
        verifiedBy: "static-cache-inspection",
        probeDetail: null,
      };

      return Object.freeze(evidence);
    },
  };
}

/**
 * Turns filesystem facts into one state.
 *
 * Windows note: Node's `X_OK` is effectively an existence check there — the platform has no POSIX execute bit. Rather
 * than pretend otherwise, a present, non-empty file is treated as accessible on Windows and the bounded `verify` probe
 * provides the real answer when one is run.
 */
async function inspectPath(
  fileSystem: BinaryFileSystem,
  target: string,
  platform: NodeJS.Platform,
): Promise<CypressBinaryState> {
  let stats: Awaited<ReturnType<BinaryFileSystem["stat"]>>;

  try {
    stats = await fileSystem.stat(target);
  } catch (error) {
    const code = readErrorCode(error);

    // A missing binary is the common, expected case: not downloaded, or downloaded for another platform or version.
    if (code === "ENOENT" || code === "ENOTDIR") return "absent";

    // Anything else — permissions on a parent directory, an I/O error, a cache on an unmounted volume — means we could
    // not establish the fact.
    return "unknown";
  }

  if (!stats.isFile()) return "absent";
  if (platform === "win32") return stats.size > 0 ? "accessible" : "absent";

  // No execute bit at all: an unpacked-but-unusable binary, which is a different fix from a missing one.
  if ((stats.mode & 0o111) === 0) return "not-executable";

  try {
    await fileSystem.access(target, fsConstants.X_OK);
    return "accessible";
  } catch (error) {
    return readErrorCode(error) === "ENOENT" ? "absent" : "not-executable";
  }
}

/**
 * Reads a system error code without trusting the thrown value's shape.
 *
 * Errors cross a module boundary as `unknown`, and narrowing that safely is the only assertion this file needs — kept
 * in one place with one explanation rather than sprinkled through every `catch`.
 */
function readErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;

  const candidate: { code?: unknown } = error;
  return typeof candidate.code === "string" ? candidate.code : undefined;
}

/* -------------------------------------------------------------------------- */
/* Verification — the bounded fallback                                         */
/* -------------------------------------------------------------------------- */

export interface CreateBinaryProbeOptions {
  readonly runProcess: ProbeProcessRunner;
  /** Node executable used to launch the Cypress CLI. Defaults to this process. */
  readonly nodeExecutable?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

/**
 * Builds the verification probe.
 *
 * The project's *installed* Cypress CLI is executed through Node explicitly rather than through `node_modules/.bin`,
 * because `.bin` is a POSIX symlink and a Windows `.cmd` shim — both replaceable, both divergent in behaviour. Passing
 * the resolved package's own entry file to the current Node interpreter removes that ambiguity.
 *
 * `shell: false` and an argument array are not stylistic: they are what stops a project path containing `;`, `&` or a
 * space from turning into a second command.
 *
 * The budgets are fixed at construction and are deliberately **not** read from the request: the hard bound is a product
 * decision that a caller must not be able to raise. (`CypressBinaryProbeInput` still carries `timeoutMs` and
 * `maxOutputBytes`; either they should be removed from the port or honoured as a *cap* on these values — carrying both
 * and using one is how a caller passes a tighter budget and silently does not get it.)
 */
export function createCypressVerifyProbe(
  options: CreateBinaryProbeOptions,
): CypressBinaryProbePort {
  const nodeExecutable = options.nodeExecutable ?? process.execPath;
  const timeoutMs = options.timeoutMs ?? BINARY_VERIFY_TIMEOUT_MS;
  const maxOutputBytes =
    options.maxOutputBytes ?? BINARY_PROBE_MAX_OUTPUT_BYTES;

  return {
    async verify(
      input: CypressBinaryProbeInput,
    ): Promise<CypressBinaryProbeResult> {
      try {
        const result = await options.runProcess(
          nodeExecutable,
          [input.cypressCliPath, ...CYPRESS_VERIFY_ARGUMENTS],
          {
            timeoutMs,
            maxOutputBytes,
            shell: false,
          },
        );

        // A probe that did not finish tells us nothing about the binary. Reporting "unusable" here would be a fabricated
        // finding; `unverified` is the honest answer and is reported as indeterminate.
        if (result.timedOut) {
          return {
            outcome: "unverified",
            detail: `verification did not finish within ${timeoutMs} ms`,
          };
        }

        // A non-zero exit status is a RESULT about the environment, not a QAT error: it means the binary is present but
        // cannot be used.
        if (result.exitCode !== 0) {
          return {
            outcome: "unusable",
            detail:
              summarise(result.stderr) ??
              summarise(result.stdout) ??
              `exit code ${String(result.exitCode)}`,
          };
        }

        return { outcome: "usable" };
      } catch {
        // Spawn failure (missing interpreter, EACCES on the CLI, E2BIG): again "could not verify", never "the binary is
        // broken".
        return {
          outcome: "unverified",
          detail: "verification process could not be started",
        };
      }
    },
  };
}

/**
 * Collapses probe output into something safe to store.
 *
 * Multi-line Cypress output is useful in a terminal and useless in an evidence blob; whitespace is collapsed and the
 * tail kept, because the actionable line is almost always last. The caller's output cap already bounds the size.
 */
function summarise(output: string): string | null {
  const collapsed = output.replace(/\s+/g, " ").trim();
  if (collapsed === "") return null;

  return collapsed.length > 300 ? `…${collapsed.slice(-300)}` : collapsed;
}

/* -------------------------------------------------------------------------- */
/* Evidence assembly                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Folds a probe result into existing evidence.
 *
 * Static evidence is never discarded — the probe only *upgrades* the verdict, and `verifiedBy` records which method
 * produced the final answer so a later reader knows whether "accessible" means "a file with the right bits" or
 * "Cypress itself started successfully".
 */
export function applyProbeResult(
  evidence: CypressBinaryEvidence,
  result: CypressBinaryProbeResult,
): CypressBinaryEvidence {
  switch (result.outcome) {
    case "usable": {
      const upgraded: CypressBinaryEvidence = {
        ...evidence,
        state: "accessible",
        verifiedBy: "cypress-verify",
        probeDetail: null,
      };

      return Object.freeze(upgraded);
    }

    case "unusable": {
      // The binary exists but Cypress cannot use it: wrong architecture, a partial download, a quarantined macOS
      // bundle. Actionable, and distinct from absent.
      const rejected: CypressBinaryEvidence = {
        ...evidence,
        state: "not-executable",
        verifiedBy: "cypress-verify",
        probeDetail: result.detail,
      };

      return Object.freeze(rejected);
    }

    case "unverified": {
      const inconclusive: CypressBinaryEvidence = {
        ...evidence,
        verifiedBy: "cypress-verify",
        probeDetail: result.detail,
      };

      return Object.freeze(inconclusive);
    }
  }
}
