/**
 * Unit tests for Cypress binary location, inspection and bounded verification.
 *
 * Everything here is a value in and a value out: the filesystem and the process runner are injected, so these tests
 * assert the *decisions* — which cache root, which state, which command — without touching a disk, a PATH or a binary.
 * The alternative would be a suite that passes on a developer machine that happens to have Cypress installed and fails
 * on a clean CI image, which is the exact failure mode this module exists to diagnose.
 *
 * Grouped by exported function, in dependency order: where is the cache → what path does that imply → how is a path
 * presented → what state is the file in → how is it verified → how is a probe result folded back in.
 */

import { constants as fsConstants } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type {
  BinaryFileSystem,
  CreateBinaryProbeOptions,
  ProbeProcessResult,
  ProbeProcessRunner,
} from "~/project/cypress-health/binary.js";
import {
  applyProbeResult,
  BINARY_PROBE_MAX_OUTPUT_BYTES,
  BINARY_VERIFY_TIMEOUT_MS,
  createCypressBinaryInspector,
  createCypressVerifyProbe,
  CYPRESS_VERIFY_ARGUMENTS,
  expectedBinaryPath,
  resolveCacheLocation,
  toDisplayPath,
} from "~/project/cypress-health/binary.js";
import type { CypressBinaryEvidence } from "~/project/cypress-health/contracts.js";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const HOME = path.resolve("/home/dev");
const APP_DATA = path.resolve("/users/dev/AppData/Local");

const CACHE_ROOT = path.join(HOME, ".cache", "Cypress");
const BINARY_PATH = path.join(CACHE_ROOT, "13.6.0", "Cypress", "Cypress");

/** A POSIX environment with a home directory, which is what most cases use. */
const POSIX_ENV: Readonly<Record<string, string | undefined>> = { HOME };

/** An environment for the Windows cases, where the cache hangs off LOCALAPPDATA instead. */
const WINDOWS_ENV: Readonly<Record<string, string | undefined>> = {
  HOME,
  LOCALAPPDATA: APP_DATA,
};

interface FakeStat {
  isFile(): boolean;
  mode: number;
  size: number;
}

interface FakeFileSystem {
  readonly fileSystem: BinaryFileSystem;
  readonly statCalls: string[];
  readonly accessCalls: readonly { target: string; mode: number }[];
}

/**
 * A filesystem fake driven by two answers.
 *
 * Neither member is `async`: neither contains an `await`, and an `async` function that only returns a value promises
 * work it never performs. `Promise.resolve` / `Promise.reject` say exactly what happens.
 */
function createFakeFileSystem(answers: {
  readonly stat: FakeStat | Error;
  readonly access?: undefined | Error;
}): FakeFileSystem {
  const statCalls: string[] = [];
  const accessCalls: { target: string; mode: number }[] = [];

  return {
    statCalls,
    accessCalls,
    fileSystem: {
      stat: (target) => {
        statCalls.push(target);

        return answers.stat instanceof Error
          ? Promise.reject(answers.stat)
          : Promise.resolve(answers.stat);
      },

      access: (target, mode) => {
        accessCalls.push({ target, mode });

        return answers.access === undefined
          ? Promise.resolve()
          : Promise.reject(answers.access);
      },
    },
  };
}

function systemError(code: string, target: string): Error {
  const error: NodeJS.ErrnoException = new Error(`${code}: ${target}`);
  error.code = code;

  return error;
}

const EXECUTABLE: FakeStat = { isFile: () => true, mode: 0o755, size: 12 };
const NOT_EXECUTABLE: FakeStat = { isFile: () => true, mode: 0o644, size: 12 };

/** The evidence the inspector should produce for a statically verified, accessible binary. */
function expectedEvidence(
  overrides: Partial<CypressBinaryEvidence> = {},
): CypressBinaryEvidence {
  return {
    version: "13.6.0",
    cacheRoot: "~/.cache/Cypress",
    expectedPath: "~/.cache/Cypress/13.6.0/Cypress/Cypress",
    state: "accessible",
    verifiedBy: "static-cache-inspection",
    probeDetail: null,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* resolveCacheLocation                                                       */
/* -------------------------------------------------------------------------- */

describe("resolveCacheLocation", () => {
  it("uses the platform default root and entry", () => {
    expect(resolveCacheLocation(POSIX_ENV, "linux")).toStrictEqual({
      cacheRoot: CACHE_ROOT,
      entry: ["Cypress", "Cypress"],
    });

    expect(resolveCacheLocation(POSIX_ENV, "darwin")).toStrictEqual({
      cacheRoot: path.join(HOME, "Library", "Caches", "Cypress"),
      entry: ["Cypress.app", "Contents", "MacOS", "Cypress"],
    });

    expect(resolveCacheLocation(WINDOWS_ENV, "win32")).toStrictEqual({
      cacheRoot: path.join(APP_DATA, "Cypress", "Cache"),
      entry: ["Cypress.exe"],
    });
  });

  it("reads LOCALAPPDATA on Windows rather than HOME", () => {
    // Asserted by absence as well as presence: an implementation that quietly fell back to HOME would put the cache
    // somewhere Cypress never looks, and the finding would name a directory that does not exist.
    expect(resolveCacheLocation({ HOME }, "win32")).toStrictEqual({
      cacheRoot: null,
      entry: null,
    });
    expect(
      resolveCacheLocation({ LOCALAPPDATA: APP_DATA }, "linux"),
    ).toStrictEqual({ cacheRoot: null, entry: null });
  });

  it("honours an absolute CYPRESS_CACHE_FOLDER", () => {
    const relocated = path.resolve("/var/cypress-cache");

    expect(
      resolveCacheLocation(
        { ...POSIX_ENV, CYPRESS_CACHE_FOLDER: relocated },
        "linux",
      ),
    ).toStrictEqual({
      cacheRoot: relocated,
      entry: ["Cypress", "Cypress"],
    });
  });

  it("treats a relative CYPRESS_CACHE_FOLDER as undeterminable", () => {
    // Its meaning depends on Cypress's working directory, which is not ours to assume. A confidently wrong path is worse
    // than "I could not determine the cache location".
    expect(
      resolveCacheLocation(
        { ...POSIX_ENV, CYPRESS_CACHE_FOLDER: "./cache" },
        "linux",
      ).cacheRoot,
    ).toBeNull();
  });

  it("ignores a blank CYPRESS_CACHE_FOLDER", () => {
    expect(
      resolveCacheLocation(
        { ...POSIX_ENV, CYPRESS_CACHE_FOLDER: "   " },
        "linux",
      ).cacheRoot,
    ).toBe(CACHE_ROOT);
  });

  it("reports nothing for an unsupported platform", () => {
    expect(resolveCacheLocation(POSIX_ENV, "freebsd")).toStrictEqual({
      cacheRoot: null,
      entry: null,
    });
  });
});

/* -------------------------------------------------------------------------- */
/* expectedBinaryPath                                                         */
/* -------------------------------------------------------------------------- */

describe("expectedBinaryPath", () => {
  it("joins root, version and the platform entry", () => {
    expect(expectedBinaryPath("13.6.0", POSIX_ENV, "linux")).toBe(BINARY_PATH);

    expect(expectedBinaryPath("13.6.0", POSIX_ENV, "darwin")).toBe(
      path.join(
        HOME,
        "Library",
        "Caches",
        "Cypress",
        "13.6.0",
        "Cypress.app",
        "Contents",
        "MacOS",
        "Cypress",
      ),
    );

    expect(expectedBinaryPath("13.6.0", WINDOWS_ENV, "win32")).toBe(
      path.join(APP_DATA, "Cypress", "Cache", "13.6.0", "Cypress.exe"),
    );
  });

  it.each(["13.6.0", "13.6.0+build.7", "14.0.0-rc.1", "11.2.0"])(
    "accepts the version %s",
    (version) => {
      expect(expectedBinaryPath(version, POSIX_ENV, "linux")).not.toBeNull();
    },
  );

  const unsafeVersions: readonly [string, string][] = [
    ["", "empty"],
    ["   ", "blank"],

    // Dot-segment cases. These are the ones a naive character class lets through: `.` is needed for versions like
    // `13.6.0`, so a class that allows it also allows `..`, which `path.join` then collapses into the parent directory.
    [".", "a single dot segment"],
    ["..", "a parent segment"],
    ["...", "three dots"],
    ["13.6.0..", "a trailing empty segment"],
    [".13.6.0", "a leading empty segment"],
    ["13..6", "an empty segment between digits"],

    // Separator cases.
    ["../../etc", "a traversal chain"],
    ["13.6.0/../../etc", "traversal after a version"],
    ["13.6.0/13.6.0", "a nested path"],
    ["..\\..\\windows", "a Windows traversal"],
    ["13.6.0\n", "a trailing newline"],
  ];

  it.each(unsafeVersions)("refuses %j as unsafe (%s)", (version) => {
    // The version comes from a manifest we do not control. Joining it into a path unchecked would turn a health check
    // into an arbitrary-path stat oracle — and collapsing `..` is exactly that, even though the string never contains
    // a separator.
    expect(expectedBinaryPath(version, POSIX_ENV, "linux")).toBeNull();
  });

  it("reports nothing when the cache root cannot be determined", () => {
    expect(expectedBinaryPath("13.6.0", {}, "linux")).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* toDisplayPath                                                              */
/* -------------------------------------------------------------------------- */

describe("toDisplayPath", () => {
  it("abbreviates the home directory", () => {
    expect(toDisplayPath(CACHE_ROOT, POSIX_ENV)).toBe("~/.cache/Cypress");
    expect(toDisplayPath(HOME, POSIX_ENV)).toBe("~");
  });

  it("prefers LOCALAPPDATA when both are set", () => {
    // The first variable that matches wins, so a Windows path is abbreviated by the variable that describes it.
    expect(
      toDisplayPath(path.join(APP_DATA, "Cypress", "Cache"), WINDOWS_ENV),
    ).toBe("~/Cypress/Cache");
  });

  it("leaves an unrelated path alone", () => {
    expect(toDisplayPath(path.resolve("/opt/cypress"), POSIX_ENV)).toBe(
      path.resolve("/opt/cypress"),
    );
  });

  it("leaves everything alone when no profile variable is set", () => {
    expect(toDisplayPath(path.resolve("/opt/cypress"), {})).toBe(
      path.resolve("/opt/cypress"),
    );
  });
});

/* -------------------------------------------------------------------------- */
/* createCypressBinaryInspector                                               */
/* -------------------------------------------------------------------------- */

describe("createCypressBinaryInspector", () => {
  interface InspectOptions {
    readonly stat?: FakeStat | Error;
    readonly access?: Error;
    readonly version?: string;
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly platform?: NodeJS.Platform;
  }

  /**
   * Runs one inspection and returns the evidence together with what the filesystem was asked.
   *
   * `async`, and it awaits the port call itself: returning an object that *holds* a promise would make every call site
   * `await` a plain object, which is both a lint error and a misreading of what the await is for.
   */
  async function inspect(options: InspectOptions = {}): Promise<{
    readonly fake: FakeFileSystem;
    readonly evidence: CypressBinaryEvidence | null;
  }> {
    const fake = createFakeFileSystem({
      stat: options.stat ?? EXECUTABLE,
      ...(options.access === undefined ? {} : { access: options.access }),
    });

    const inspector = createCypressBinaryInspector({
      fileSystem: fake.fileSystem,
      platform: options.platform ?? "linux",
    });

    const evidence = await inspector.inspect({
      version: options.version ?? "13.6.0",
      environment: options.environment ?? POSIX_ENV,
    });

    return { fake, evidence };
  }

  it("reports an accessible binary with display-safe paths", async () => {
    const { evidence } = await inspect();

    expect(evidence).toStrictEqual(expectedEvidence());
  });

  it("names the cache root itself, not the version directory inside it", async () => {
    // Reported separately from the shape assertion above so the failure message says which field is wrong: an
    // implementation that walks *up* from the binary path is off by one segment on Linux and by three on macOS.
    const { evidence } = await inspect();

    expect(evidence?.cacheRoot).toBe("~/.cache/Cypress");
  });

  it("reports the method that produced the verdict, never overclaiming", async () => {
    // "static-cache-inspection" means "a file with execute bits", not "Cypress started". Publishing the method stops a
    // stat from being read as proof of execution.
    const { evidence } = await inspect();

    expect(evidence?.verifiedBy).toBe("static-cache-inspection");
  });

  it("checks the execute bit for this user", async () => {
    const { fake } = await inspect();

    expect(fake.accessCalls).toStrictEqual([
      { target: BINARY_PATH, mode: fsConstants.X_OK },
    ]);
  });

  it("reports absent when the file does not exist", async () => {
    const { evidence } = await inspect({
      stat: systemError("ENOENT", BINARY_PATH),
    });

    expect(evidence?.state).toBe("absent");
  });

  it("reports absent when the path exists but is not a file", async () => {
    const { evidence, fake } = await inspect({
      stat: { isFile: () => false, mode: 0o755, size: 0 },
    });

    expect(evidence?.state).toBe("absent");
    // A directory cannot be probed for execute permission, so nothing should have been attempted.
    expect(fake.accessCalls).toStrictEqual([]);
  });

  it("reports not-executable when no execute bit is set", async () => {
    const { evidence, fake } = await inspect({ stat: NOT_EXECUTABLE });

    expect(evidence?.state).toBe("not-executable");
    expect(fake.accessCalls).toStrictEqual([]);
  });

  it("reports not-executable when the bit is set but access is refused", async () => {
    const { evidence } = await inspect({
      access: systemError("EACCES", BINARY_PATH),
    });

    expect(evidence?.state).toBe("not-executable");
  });

  it("reports absent when access finds the file gone", async () => {
    // A race with a concurrent install: the stat succeeded and the file disappeared before the permission check.
    const { evidence } = await inspect({
      access: systemError("ENOENT", BINARY_PATH),
    });

    expect(evidence?.state).toBe("absent");
  });

  it.each(["EACCES", "EIO", "EPERM"])(
    "reports unknown when stat fails with %s",
    async (code) => {
      // Anything other than "not there" means the fact could not be established. Claiming "absent" would send a reader to
      // re-download a binary that may be perfectly present.
      const { evidence } = await inspect({
        stat: systemError(code, BINARY_PATH),
      });

      expect(evidence?.state).toBe("unknown");
    },
  );

  describe("on Windows", () => {
    it("treats a present, non-empty file as accessible", async () => {
      // There is no POSIX execute bit on Windows; requiring one would reject every legitimate .exe.
      const { evidence } = await inspect({
        platform: "win32",
        environment: WINDOWS_ENV,
      });

      expect(evidence?.state).toBe("accessible");
      expect(evidence?.cacheRoot).toBe("~/Cypress/Cache");
      expect(evidence?.expectedPath).toBe("~/Cypress/Cache/13.6.0/Cypress.exe");
    });

    it("treats an empty file as absent", async () => {
      const { evidence } = await inspect({
        platform: "win32",
        environment: WINDOWS_ENV,
        stat: { isFile: () => true, mode: 0o666, size: 0 },
      });

      expect(evidence?.state).toBe("absent");
    });
  });

  it("reports nothing when there is no safe path to inspect", async () => {
    // No home directory, an unsupported platform or an unusable version all mean "no evidence was gathered", which the
    // assessor reports as unknown rather than as a missing binary.
    const noHome = await inspect({ environment: {} });
    const unsupported = await inspect({ platform: "freebsd" });
    const traversal = await inspect({ version: ".." });

    expect(noHome.evidence).toBeNull();
    expect(unsupported.evidence).toBeNull();
    expect(traversal.evidence).toBeNull();
  });

  it("returns frozen evidence", async () => {
    const { evidence } = await inspect();

    expect(Object.isFrozen(evidence)).toBe(true);
  });

  it("reads the filesystem at most twice, and never writes", async () => {
    const { fake } = await inspect();

    expect(fake.statCalls).toHaveLength(1);
    expect(fake.accessCalls).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* createCypressVerifyProbe                                                   */
/* -------------------------------------------------------------------------- */

describe("createCypressVerifyProbe", () => {
  const CLI = path.resolve("/work/project/node_modules/cypress/bin/cypress");

  interface RunCall {
    readonly command: string;
    readonly args: readonly string[];
    readonly options: {
      readonly timeoutMs: number;
      readonly maxOutputBytes: number;
      readonly shell: false;
    };
  }

  function createProbe(
    outcome: ProbeProcessResult | Error,
    options: Omit<CreateBinaryProbeOptions, "runProcess"> = {},
  ): {
    readonly probe: ReturnType<typeof createCypressVerifyProbe>;
    readonly calls: RunCall[];
  } {
    const calls: RunCall[] = [];

    const runProcess: ProbeProcessRunner = (command, args, runOptions) => {
      calls.push({ command, args, options: runOptions });

      return outcome instanceof Error
        ? Promise.reject(outcome)
        : Promise.resolve(outcome);
    };

    return {
      probe: createCypressVerifyProbe({ runProcess, ...options }),
      calls,
    };
  }

  function exited(
    overrides: Partial<ProbeProcessResult> = {},
  ): ProbeProcessResult {
    return {
      timedOut: false,
      exitCode: 0,
      stdout: "",
      stderr: "",
      ...overrides,
    };
  }

  const PROBE_INPUT = {
    cypressCliPath: CLI,
    timeoutMs: 1_000,
    maxOutputBytes: 64,
  };

  it("runs node with the verify argument and nothing else", async () => {
    // `verify` is the only command this module may run: it checks the cached binary and never executes a spec.
    const { probe, calls } = createProbe(exited());

    await probe.verify(PROBE_INPUT);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toStrictEqual([CLI, "verify"]);
    expect(calls[0]?.command).toBe(process.execPath);
    expect(CYPRESS_VERIFY_ARGUMENTS).toStrictEqual(["verify"]);
  });

  it("passes the budgets it was constructed with, and never a shell", async () => {
    const { probe, calls } = createProbe(exited());

    await probe.verify(PROBE_INPUT);

    expect(calls[0]?.options).toStrictEqual({
      timeoutMs: BINARY_VERIFY_TIMEOUT_MS,
      maxOutputBytes: BINARY_PROBE_MAX_OUTPUT_BYTES,
      shell: false,
    });
  });

  it("honours the construction-time overrides", async () => {
    const { probe, calls } = createProbe(exited(), {
      nodeExecutable: path.resolve("/usr/local/bin/node"),
      timeoutMs: 5_000,
      maxOutputBytes: 32,
    });

    await probe.verify(PROBE_INPUT);

    expect(calls[0]?.command).toBe(path.resolve("/usr/local/bin/node"));
    expect(calls[0]?.options).toMatchObject({
      timeoutMs: 5_000,
      maxOutputBytes: 32,
    });
  });

  it("keeps a path containing shell metacharacters as one argument", async () => {
    // `shell: false` and an argument array are what stop a project path from becoming a second command.
    const hostile = path.resolve(
      "/work/pro; rm -rf ~/project/node_modules/cypress/bin/cypress",
    );
    const { probe, calls } = createProbe(exited());

    await probe.verify({ ...PROBE_INPUT, cypressCliPath: hostile });

    expect(calls[0]?.args).toStrictEqual([hostile, "verify"]);
    expect(calls[0]?.options.shell).toBe(false);
  });

  it("reports usable on a zero exit status", async () => {
    const { probe } = createProbe(exited());

    await expect(probe.verify(PROBE_INPUT)).resolves.toStrictEqual({
      outcome: "usable",
    });
  });

  it("reports unusable with the error output when the binary cannot be used", async () => {
    const { probe } = createProbe(
      exited({
        exitCode: 1,
        stderr: "Cypress binary is missing for version 13.6.0.\n",
      }),
    );

    await expect(probe.verify(PROBE_INPUT)).resolves.toStrictEqual({
      outcome: "unusable",
      detail: "Cypress binary is missing for version 13.6.0.",
    });
  });

  it("falls back to standard output when there is no error output", async () => {
    const { probe } = createProbe(
      exited({ exitCode: 2, stdout: "platform mismatch" }),
    );

    await expect(probe.verify(PROBE_INPUT)).resolves.toStrictEqual({
      outcome: "unusable",
      detail: "platform mismatch",
    });
  });

  it("falls back to the exit status when there is no output at all", async () => {
    const { probe } = createProbe(exited({ exitCode: 127 }));

    await expect(probe.verify(PROBE_INPUT)).resolves.toStrictEqual({
      outcome: "unusable",
      detail: "exit code 127",
    });
  });

  it("collapses multi-line output into one line", async () => {
    const { probe } = createProbe(
      exited({ exitCode: 1, stderr: "\n\n  first\n\tsecond   \n" }),
    );

    await expect(probe.verify(PROBE_INPUT)).resolves.toStrictEqual({
      outcome: "unusable",
      detail: "first second",
    });
  });

  it("keeps the actionable tail of a long message", async () => {
    // The reason is almost always last, so truncation keeps the end — and the ellipsis says something was dropped.
    const { probe } = createProbe(
      exited({
        exitCode: 1,
        stderr: `prefix ${"x".repeat(400)} the actual reason`,
      }),
    );

    const result = await probe.verify(PROBE_INPUT);
    const detail = result.outcome === "unusable" ? result.detail : "";

    expect(detail.startsWith("…")).toBe(true);
    expect(detail.endsWith("the actual reason")).toBe(true);
    expect(detail).toHaveLength(301);
  });

  it("reports unverified when the probe times out", async () => {
    // "Could not finish checking" says nothing about the binary. Reporting it as unusable would be a fabricated finding.
    const { probe } = createProbe(exited({ timedOut: true, exitCode: null }));

    await expect(probe.verify(PROBE_INPUT)).resolves.toStrictEqual({
      outcome: "unverified",
      detail: `verification did not finish within ${String(BINARY_VERIFY_TIMEOUT_MS)} ms`,
    });
  });

  it("reports unverified when the process cannot be started", async () => {
    const { probe } = createProbe(systemError("ENOENT", CLI));

    await expect(probe.verify(PROBE_INPUT)).resolves.toStrictEqual({
      outcome: "unverified",
      detail: "verification process could not be started",
    });
  });
});

/* -------------------------------------------------------------------------- */
/* applyProbeResult                                                           */
/* -------------------------------------------------------------------------- */

describe("applyProbeResult", () => {
  const staticEvidence: CypressBinaryEvidence = expectedEvidence({
    state: "unknown",
  });

  it("upgrades static evidence when the binary starts", () => {
    // The probe only ever upgrades a verdict; it never replaces the observation that produced it.
    expect(
      applyProbeResult(staticEvidence, { outcome: "usable" }),
    ).toStrictEqual(
      expectedEvidence({
        state: "accessible",
        verifiedBy: "cypress-verify",
        probeDetail: null,
      }),
    );
  });

  it("records a usable binary as not-executable when Cypress refuses it", () => {
    expect(
      applyProbeResult(staticEvidence, {
        outcome: "unusable",
        detail: "wrong architecture",
      }),
    ).toStrictEqual(
      expectedEvidence({
        state: "not-executable",
        verifiedBy: "cypress-verify",
        probeDetail: "wrong architecture",
      }),
    );
  });

  it("leaves the state untouched when the probe was inconclusive", () => {
    // The state is what was actually observed statically; the detail is what the probe could not conclude.
    expect(
      applyProbeResult(staticEvidence, {
        outcome: "unverified",
        detail: "timed out",
      }),
    ).toStrictEqual(
      expectedEvidence({
        state: "unknown",
        verifiedBy: "cypress-verify",
        probeDetail: "timed out",
      }),
    );
  });

  it("does not mutate the evidence it was given", () => {
    const original = expectedEvidence({ state: "absent" });
    const snapshot = { ...original };

    applyProbeResult(original, { outcome: "usable" });

    expect(original).toStrictEqual(snapshot);
  });

  it("returns frozen evidence", () => {
    expect(
      Object.isFrozen(applyProbeResult(staticEvidence, { outcome: "usable" })),
    ).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

describe("budgets", () => {
  it("bounds verification at thirty seconds", () => {
    // Long enough to avoid a false "unverified" on a cold filesystem, short enough that a doctor run cannot appear hung.
    expect(BINARY_VERIFY_TIMEOUT_MS).toBe(30_000);
  });

  it("caps probe output so a misbehaving binary cannot flood the log", () => {
    expect(BINARY_PROBE_MAX_OUTPUT_BYTES).toBeGreaterThan(0);
    expect(BINARY_PROBE_MAX_OUTPUT_BYTES).toBeLessThanOrEqual(8_192);
  });

  it("freezes the argument vector so the prohibition is testable", () => {
    expect(Object.isFrozen(CYPRESS_VERIFY_ARGUMENTS)).toBe(true);
    expect(CYPRESS_VERIFY_ARGUMENTS).not.toContain("run");
    expect(CYPRESS_VERIFY_ARGUMENTS).not.toContain("open");
  });
});
