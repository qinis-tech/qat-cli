/**
 * Unit tests for executable location and version probing.
 *
 * Two of the three things this module does are pure and one is not:
 *
 *   • the **filesystem probe** is a thin adapter over `stat`/`access`, so it is exercised against real files in a
 *     temporary directory — mocking it would test the mock;
 *   • the **locator** and the **probe** are pure once their collaborators are injected, so every security rule they
 *     encode (PATH only, no `node_modules/.bin`, no bare segment, no shell) is asserted against a fake.
 *
 * The rules are the point of this file. A locator is fifteen lines of loop and four of them are defences against
 * executing a file the project controls; a test that only proved "it finds pnpm" would leave all four unverified.
 *
 * ## Fakes model the port, not the filesystem
 *
 * The first version of `fakeLocator` took a set of *paths* and compared them with the *command name* it received, so
 * every resolution answered `missing` — a fake whose contract did not match the port it stood in for. A fake is a
 * claim about an interface; when it disagrees with that interface, the tests are asserting against the claim.
 */
import { mkdir, mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createExecutableFileProbe,
  createPackageManagerExecutablePort,
  createPathLocator,
  createVersionProbe,
  PROBE_MAX_OUTPUT_BYTES,
  PROBE_TIMEOUT_MS,
  type CommandOutcome,
  type CommandRunnerPort,
  type ExecutableFileProbe,
  type ExecutableLocatorPort,
  type PackageManagerProbePort,
  type VersionEvidence,
} from "~/project/package-manager/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// Fakes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A locator over an in-memory map of command name → resolved path.
 *
 * A map from *names* to *paths*, mirroring the port: `locateExecutable(command)` takes a bare name and answers with a
 * path or `undefined`. Recording the names it was asked about matters because half the rules in this module are about
 * what must not be searched, and a test that only asserted a result could not tell "skipped" from "tried and missed".
 */
function fakeLocator(
  available: Readonly<Record<string, string>>,
): ExecutableLocatorPort & {
  readonly located: string[];
} {
  const located: string[] = [];

  return {
    located,
    locateExecutable: (command) => {
      located.push(command);
      return Promise.resolve(available[command]);
    },
  };
}

/** A filesystem probe over an in-memory set, for locator tests that are about path rules rather than real files. */
function fakeFiles(
  existing: readonly string[],
): ExecutableFileProbe & { readonly asked: string[] } {
  const asked: string[] = [];
  const known = new Set(existing);

  return {
    asked,
    isExecutableFile: (path) => {
      asked.push(path);
      return Promise.resolve(known.has(path));
    },
  };
}

/**
 * A command runner that returns one canned outcome and records the call.
 *
 * Three fields are recorded rather than one because the probe's contract is as much about *how* it runs a command (no
 * shell, a bounded timeout, an output cap) as about what it does with the answer.
 */
function fakeRunner(outcome: CommandOutcome): CommandRunnerPort & {
  readonly calls: {
    command: string;
    args: readonly string[];
    timeoutMs: number;
    maxOutputBytes: number;
  }[];
} {
  const calls: {
    command: string;
    args: readonly string[];
    timeoutMs: number;
    maxOutputBytes: number;
  }[] = [];

  return {
    calls,
    run: (command, args, options) => {
      calls.push({
        command,
        args,
        timeoutMs: options.timeoutMs,
        maxOutputBytes: options.maxOutputBytes,
      });

      return Promise.resolve(outcome);
    },
  };
}

/**
 * A version probe that answers one canned result and records the paths it was asked about.
 *
 * A closure rather than an object method using `this`, so the recorded array cannot be lost to a binding change — the
 * port calls `probe.probeVersion(...)`, and an implementation that quietly stopped recording would make the assertions
 * about "was the probe called at all" pass for the wrong reason.
 */
function fakeProbe(
  evidence: VersionEvidence,
): PackageManagerProbePort & { readonly calls: string[] } {
  const calls: string[] = [];

  return {
    calls,
    probeVersion: (path) => {
      calls.push(path);
      return Promise.resolve(evidence);
    },
  };
}

/** Standard output for a manager that answers normally. */
function answered(stdout: string, exitCode = 0): CommandOutcome {
  return { status: "exited", exitCode, stdout };
}

// ─────────────────────────────────────────────────────────────────────────────
// Filesystem probe
// ─────────────────────────────────────────────────────────────────────────────

describe("createExecutableFileProbe", () => {
  let root: string;
  let executable: string;
  let plain: string;
  let directory: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "qat-exec-"));
    executable = join(root, "tool");
    plain = join(root, "plain.txt");
    directory = join(root, "dir");

    await writeFile(executable, "#!/bin/sh\n", "utf8");
    await writeFile(plain, "text", "utf8");
    await mkdir(directory);
    await chmod(executable, 0o755);
    await chmod(plain, 0o644);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("accepts a file with the execute bit", () => {
    // A real file, because this function's whole job is to ask the filesystem — and an in-memory fake would be testing
    // the fake's opinion of what an executable is.
    return expect(
      createExecutableFileProbe("linux").isExecutableFile(executable),
    ).resolves.toBe(true);
  });

  it("refuses a file without the execute bit", () => {
    return expect(
      createExecutableFileProbe("linux").isExecutableFile(plain),
    ).resolves.toBe(false);
  });

  it("refuses a directory, even one that could be opened", () => {
    return expect(
      createExecutableFileProbe("linux").isExecutableFile(directory),
    ).resolves.toBe(false);
  });

  it("refuses a path that does not exist, rather than throwing", async () => {
    // The locator asks about many candidates. A dangling entry must answer `false`, not abort the search — one
    // unreadable directory in PATH should not stop a tool being found further down it.
    await expect(
      createExecutableFileProbe("linux").isExecutableFile(join(root, "absent")),
    ).resolves.toBe(false);
  });

  it("refuses a path inside a directory that does not exist", async () => {
    await expect(
      createExecutableFileProbe("linux").isExecutableFile(
        join(root, "absent", "tool"),
      ),
    ).resolves.toBe(false);
  });

  it("accepts any existing file on Windows, where the execute bit is not meaningful", async () => {
    // `PATHEXT` decides what runs on Windows. Requiring X_OK there would reject every legitimate `.cmd` shim, which is
    // the population this check exists to find.
    await expect(
      createExecutableFileProbe("win32").isExecutableFile(plain),
    ).resolves.toBe(true);
  });

  it("still refuses a directory on Windows", async () => {
    await expect(
      createExecutableFileProbe("win32").isExecutableFile(directory),
    ).resolves.toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PATH locator
// ─────────────────────────────────────────────────────────────────────────────

describe("createPathLocator", () => {
  it("finds a command in a PATH directory", async () => {
    const files = fakeFiles(["/usr/local/bin/pnpm"]);

    const locator = createPathLocator({
      pathValue: "/usr/bin:/usr/local/bin",
      platform: "linux",
      files,
    });

    await expect(locator.locateExecutable("pnpm")).resolves.toBe(
      "/usr/local/bin/pnpm",
    );
    expect(files.asked).toStrictEqual(["/usr/bin/pnpm", "/usr/local/bin/pnpm"]);
  });

  it("returns undefined when nothing matches", async () => {
    const locator = createPathLocator({
      pathValue: "/usr/bin",
      platform: "linux",
      files: fakeFiles([]),
    });

    await expect(locator.locateExecutable("pnpm")).resolves.toBeUndefined();
  });

  it("takes the first match in PATH order, as a shell would", async () => {
    const locator = createPathLocator({
      pathValue: "/first:/second",
      platform: "linux",
      files: fakeFiles(["/first/pnpm", "/second/pnpm"]),
    });

    await expect(locator.locateExecutable("pnpm")).resolves.toBe("/first/pnpm");
  });

  it("never searches a project-local binary directory", async () => {
    // The security rule: `node_modules/.bin` is writable by any dependency install, so resolving a "package manager"
    // from there would execute project-controlled code merely to learn its name.
    const files = fakeFiles(["/project/node_modules/.bin/pnpm"]);

    const locator = createPathLocator({
      pathValue: "/project/node_modules/.bin:/usr/bin",
      platform: "linux",
      files,
    });

    await expect(locator.locateExecutable("pnpm")).resolves.toBeUndefined();
    expect(files.asked.some((path) => path.includes("node_modules"))).toBe(
      false,
    );
  });

  it("never searches a nested node_modules directory", async () => {
    const files = fakeFiles(["/project/packages/app/node_modules/.bin/pnpm"]);

    const locator = createPathLocator({
      pathValue: "/project/packages/app/node_modules/.bin",
      platform: "linux",
      files,
    });

    await expect(locator.locateExecutable("pnpm")).resolves.toBeUndefined();
    expect(files.asked).toStrictEqual([]);
  });

  it("refuses an empty segment, which means the current directory", async () => {
    // The classic PATH-hijack vector: an empty segment makes a shell look in the working directory, which is whatever
    // repository the user happened to run the command from.
    const files = fakeFiles(["/pnpm", "/usr/bin/pnpm"]);

    const locator = createPathLocator({
      pathValue: ":/usr/bin",
      platform: "linux",
      files,
    });

    await expect(locator.locateExecutable("pnpm")).resolves.toBe(
      "/usr/bin/pnpm",
    );
    expect(files.asked).toStrictEqual(["/usr/bin/pnpm"]);
  });

  it("refuses a relative segment", async () => {
    const files = fakeFiles(["bin/pnpm", "/usr/bin/pnpm"]);

    const locator = createPathLocator({
      pathValue: "bin:/usr/bin",
      platform: "linux",
      files,
    });

    await expect(locator.locateExecutable("pnpm")).resolves.toBe(
      "/usr/bin/pnpm",
    );
    expect(files.asked).toStrictEqual(["/usr/bin/pnpm"]);
  });

  it("trims whitespace around a segment", async () => {
    const locator = createPathLocator({
      pathValue: "  /usr/local/bin  ",
      platform: "linux",
      files: fakeFiles(["/usr/local/bin/pnpm"]),
    });

    await expect(locator.locateExecutable("pnpm")).resolves.toBe(
      "/usr/local/bin/pnpm",
    );
  });

  it("tries the bare name before any Windows extension", async () => {
    const files = fakeFiles(["C:\\tools\\pnpm"]);

    const locator = createPathLocator({
      pathValue: "C:\\tools",
      platform: "win32",
      pathExtensions: ".COM;.EXE;.BAT;.CMD",
      files,
    });

    await expect(locator.locateExecutable("pnpm")).resolves.toBe(
      "C:\\tools\\pnpm",
    );
    expect(files.asked[0]).toBe("C:\\tools\\pnpm");
  });

  it("tries PATHEXT suffixes on Windows", async () => {
    // A real Windows install is `pnpm.CMD`; without the suffixes the locator would report every tool missing on the
    // platform where most users are.
    const files = fakeFiles(["C:\\tools\\pnpm.CMD"]);

    const locator = createPathLocator({
      pathValue: "C:\\tools",
      platform: "win32",
      pathExtensions: ".COM;.EXE;.BAT;.CMD",
      files,
    });

    await expect(locator.locateExecutable("pnpm")).resolves.toBe(
      "C:\\tools\\pnpm.CMD",
    );
    expect(files.asked).toStrictEqual([
      "C:\\tools\\pnpm",
      "C:\\tools\\pnpm.COM",
      "C:\\tools\\pnpm.EXE",
      "C:\\tools\\pnpm.BAT",
      "C:\\tools\\pnpm.CMD",
    ]);
  });

  it("uses semicolons as the Windows separator", async () => {
    const locator = createPathLocator({
      pathValue: "C:\\first;C:\\second",
      platform: "win32",
      pathExtensions: ".EXE",
      files: fakeFiles(["C:\\second\\pnpm.EXE"]),
    });

    await expect(locator.locateExecutable("pnpm")).resolves.toBe(
      "C:\\second\\pnpm.EXE",
    );
  });

  it("refuses a Windows relative and drive-relative segment", async () => {
    const files = fakeFiles(["tools\\pnpm", "\\tools\\pnpm", "C:tools\\pnpm"]);

    const locator = createPathLocator({
      pathValue: "tools;\\tools;C:tools",
      platform: "win32",
      pathExtensions: "",
      files,
    });

    await expect(locator.locateExecutable("pnpm")).resolves.toBeUndefined();
    expect(files.asked).toStrictEqual([]);
  });

  it("refuses a node_modules directory identified with backslashes", async () => {
    // The separator check must know both kinds, or the same rule is enforced on one platform and not the other.
    const files = fakeFiles(["C:\\project\\node_modules\\.bin\\pnpm.CMD"]);

    const locator = createPathLocator({
      pathValue: "C:\\project\\node_modules\\.bin",
      platform: "win32",
      pathExtensions: ".CMD",
      files,
    });

    await expect(locator.locateExecutable("pnpm")).resolves.toBeUndefined();
    expect(files.asked).toStrictEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Version probe
// ─────────────────────────────────────────────────────────────────────────────

describe("createVersionProbe", () => {
  it("reads a version from normal output", async () => {
    const probe = createVersionProbe(fakeRunner(answered("9.1.0\n")), {
      platform: "linux",
    });

    await expect(probe.probeVersion("/usr/bin/pnpm")).resolves.toStrictEqual({
      status: "read",
      value: "9.1.0",
    });
  });

  it("tolerates a leading v", async () => {
    const probe = createVersionProbe(fakeRunner(answered("v20.11.1\n")), {
      platform: "linux",
    });

    await expect(probe.probeVersion("/usr/bin/node")).resolves.toStrictEqual({
      status: "read",
      value: "20.11.1",
    });
  });

  it("finds the version among other output", async () => {
    // A manager that prints a banner before its version is common, and a probe that required the whole output to be a
    // version would report it unreadable.
    const probe = createVersionProbe(
      fakeRunner(answered("pnpm 9.1.0\nCopyright 2024\n")),
      {
        platform: "linux",
      },
    );

    await expect(probe.probeVersion("/usr/bin/pnpm")).resolves.toStrictEqual({
      status: "read",
      value: "9.1.0",
    });
  });

  it("runs the command with --version and the declared budgets", async () => {
    // The budgets are part of the contract: a hung binary must not be able to make a health check appear frozen, and
    // output must be capped before it reaches memory.
    const runner = fakeRunner(answered("9.1.0\n"));

    await createVersionProbe(runner, { platform: "linux" }).probeVersion(
      "/usr/bin/pnpm",
    );

    expect(runner.calls).toStrictEqual([
      {
        command: "/usr/bin/pnpm",
        args: ["--version"],
        timeoutMs: PROBE_TIMEOUT_MS,
        maxOutputBytes: PROBE_MAX_OUTPUT_BYTES,
      },
    ]);
  });

  it("treats a non-zero exit as evidence, not as a failure", async () => {
    // `pnpm --version` failing tells us something about the environment. Throwing would make the message about the
    // environment into an exception about QAT.
    const probe = createVersionProbe(fakeRunner(answered("", 1)), {
      platform: "linux",
    });

    await expect(probe.probeVersion("/usr/bin/pnpm")).resolves.toStrictEqual({
      status: "unreadable",
      reason: "failed",
    });
  });

  it("reports a timeout as a timeout", async () => {
    const probe = createVersionProbe(
      fakeRunner({ status: "timed-out", stdout: "" }),
      {
        platform: "linux",
      },
    );

    await expect(probe.probeVersion("/usr/bin/pnpm")).resolves.toStrictEqual({
      status: "unreadable",
      reason: "timeout",
    });
  });

  it("reports a command that could not be started", async () => {
    const probe = createVersionProbe(
      fakeRunner({ status: "failed", reason: "ENOENT" }),
      {
        platform: "linux",
      },
    );

    await expect(probe.probeVersion("/usr/bin/pnpm")).resolves.toStrictEqual({
      status: "unreadable",
      reason: "failed",
    });
  });

  it.each<string>(["", "\n", "no version here", "v-next", "lts/*"])(
    "reports unusable output %j as empty-output",
    async (stdout) => {
      // "Answered, but with nothing we can compare" is distinct from "did not answer": the first is a broken
      // toolchain, the second a hung one, and the remediation differs.
      const probe = createVersionProbe(fakeRunner(answered(stdout)), {
        platform: "linux",
      });

      await expect(probe.probeVersion("/usr/bin/pnpm")).resolves.toStrictEqual({
        status: "unreadable",
        reason: "empty-output",
      });
    },
  );

  it("refuses to spawn a Windows shim rather than enabling a shell", async () => {
    // `.cmd`/`.bat` cannot be spawned without `shell: true`. Enabling a shell to read a version would turn a read-only
    // diagnostic into an execution surface for a project-controlled file — so the probe declines instead.
    const runner = fakeRunner(answered("9.1.0\n"));

    const probe = createVersionProbe(runner, { platform: "win32" });
    const result = await probe.probeVersion("C:\\tools\\pnpm.CMD");

    expect(result).toStrictEqual({ status: "not-probed" });
    expect(runner.calls).toStrictEqual([]);
  });

  it("refuses a .bat shim for the same reason", async () => {
    const runner = fakeRunner(answered("9.1.0\n"));

    const probe = createVersionProbe(runner, { platform: "win32" });

    await expect(
      probe.probeVersion("C:\\tools\\pnpm.BAT"),
    ).resolves.toStrictEqual({
      status: "not-probed",
    });
    expect(runner.calls).toStrictEqual([]);
  });

  it("probes an executable on Windows when it is not a shim", async () => {
    const runner = fakeRunner(answered("9.1.0\n"));

    const probe = createVersionProbe(runner, { platform: "win32" });

    await expect(
      probe.probeVersion("C:\\tools\\pnpm.exe"),
    ).resolves.toStrictEqual({
      status: "read",
      value: "9.1.0",
    });
    expect(runner.calls).toHaveLength(1);
  });

  it("probes a POSIX path that happens to end in .bat", async () => {
    // The shim rule is a Windows rule. Applying it on POSIX would refuse a legitimate file for a reason that does not
    // exist there.
    const runner = fakeRunner(answered("9.1.0\n"));

    const probe = createVersionProbe(runner, { platform: "linux" });

    await expect(
      probe.probeVersion("/usr/bin/pnpm.bat"),
    ).resolves.toStrictEqual({
      status: "read",
      value: "9.1.0",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Composed port
// ─────────────────────────────────────────────────────────────────────────────

describe("createPackageManagerExecutablePort", () => {
  it("resolves the path and the probed version", async () => {
    const port = createPackageManagerExecutablePort({
      locator: fakeLocator({ pnpm: "/resolved/pnpm" }),
      probe: fakeProbe({ status: "read", value: "9.1.0" }),
      shouldProbe: () => true,
    });

    await expect(port.resolve("pnpm")).resolves.toStrictEqual({
      status: "found",
      path: "/resolved/pnpm",
      version: { status: "read", value: "9.1.0" },
    });
  });

  it("reports a missing binary as missing", async () => {
    const port = createPackageManagerExecutablePort({
      locator: fakeLocator({}),
      probe: fakeProbe({ status: "not-probed" }),
      shouldProbe: () => true,
    });

    await expect(port.resolve("pnpm")).resolves.toStrictEqual({
      status: "missing",
    });
  });

  it("asks for the command the policy names", async () => {
    // The locator receives `pnpm`, not `/resolved/pnpm`: the port asks for a *command* and the locator answers where it
    // is. A fake that took paths instead is what made this suite report every tool missing.
    const locator = fakeLocator({});

    await createPackageManagerExecutablePort({
      locator,
      probe: fakeProbe({ status: "not-probed" }),
      shouldProbe: () => false,
    }).resolve("pnpm");

    expect(locator.located).toStrictEqual(["pnpm"]);
  });

  it("does not probe when composition decided a version is not worth reading", async () => {
    // The common case: nothing declared a version, so spawning the binary buys nothing and costs latency plus process
    // risk. `not-probed` is an answer, not an absence — it must not be reported as unverified.
    const versionProbe = fakeProbe({ status: "read", value: "9.1.0" });

    const port = createPackageManagerExecutablePort({
      locator: fakeLocator({ pnpm: "/resolved/pnpm" }),
      probe: versionProbe,
      shouldProbe: () => false,
    });

    await expect(port.resolve("pnpm")).resolves.toStrictEqual({
      status: "found",
      path: "/resolved/pnpm",
      version: { status: "not-probed" },
    });
    expect(versionProbe.calls).toStrictEqual([]);
  });

  it("passes the resolved path to the probe, not the command name", async () => {
    // The probe executes what it is given. Passing the bare name would resolve a second time, possibly to a different
    // file, and would execute whatever the current directory happened to contain.
    const versionProbe = fakeProbe({ status: "read", value: "9.1.0" });

    await createPackageManagerExecutablePort({
      locator: fakeLocator({ pnpm: "/usr/local/bin/pnpm" }),
      probe: versionProbe,
      shouldProbe: () => true,
    }).resolve("pnpm");

    expect(versionProbe.calls).toStrictEqual(["/usr/local/bin/pnpm"]);
  });

  it("returns frozen availability", async () => {
    const port = createPackageManagerExecutablePort({
      locator: fakeLocator({ pnpm: "/resolved/pnpm" }),
      probe: fakeProbe({ status: "not-probed" }),
      shouldProbe: () => false,
    });

    await expect(port.resolve("pnpm")).resolves.toSatisfy(Object.isFrozen);
  });
});
