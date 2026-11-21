import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ErrorCode, ProcessExecutionError } from "~/core/errors/index.js";
import { ProcessOutput, runProcess } from "~/core/process/index.js";

/**
 * Tests spawn the Node binary that is already running the suite, using `process.execPath`.
 *
 * Choosing the runtime rather than a shell command is what makes these tests portable: the same
 * child works on Windows and Linux, and nothing depends on a shell being present or on its
 * quoting rules.
 *
 * Child scripts reach the filesystem through a dynamic `import()` rather than `require`. Whether
 * `node -e` defaults to CommonJS or respects the package's `"type": "module"` has varied between
 * releases, and a dynamic import is valid either way.
 */
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "qat-proc-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Evaluates a snippet in a child Node process. */
function node(
  args: readonly string[],
  extra: Partial<Parameters<typeof runProcess>[0]> = {},
): ReturnType<typeof runProcess> {
  return runProcess({
    executable: process.execPath,
    args: ["-e", ...args],
    ...extra,
  });
}

/**
 * Polls until `predicate` returns true, or the deadline passes.
 *
 * Accepts a synchronous predicate as well as an asynchronous one, so a caller with nothing to wait
 * for does not have to wrap it in an `async` function with no `await` in it.
 */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  deadlineMs = 5_000,
): Promise<boolean> {
  const until = Date.now() + deadlineMs;

  while (Date.now() < until) {
    if (await predicate()) return true;
    await delay(50);
  }

  return false;
}

/**
 * Whether a process with this id exists.
 *
 * Synchronous: `kill` with signal 0 performs the existence and permission checks without sending
 * anything, so there is nothing to await.
 */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("successful execution", () => {
  it("captures standard output and reports a zero exit code", async () => {
    const result = await node(["process.stdout.write('hello')"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello");
    expect(result.stderr).toBe("");
  });

  it("keeps standard output and standard error separate", async () => {
    const result = await node([
      "process.stdout.write('out'); process.stderr.write('err')",
    ]);

    expect(result.stdout).toBe("out");
    expect(result.stderr).toBe("err");
  });

  it("passes arguments verbatim, with no shell interpolation", async () => {
    // Every character here is meaningful to a shell. A string-interpolated command would either
    // fail or do something destructive; an argument array delivers it as text.
    const tricky =
      "hello world; echo injected && rm -rf /tmp/never $(whoami) `id`";

    const result = await node([
      "process.stdout.write(process.argv[1])",
      tricky,
    ]);

    expect(result.stdout).toBe(tricky);
  });

  it("runs in the configured working directory", async () => {
    await writeFile(join(root, "marker.txt"), "found");

    // Asserted behaviourally through a relative path, which avoids comparing path strings a
    // platform may normalise differently: symlinked temporary directories on macOS, drive-letter
    // casing on Windows.
    const script =
      "import('node:fs').then((fs) => { process.stdout.write(fs.readFileSync('marker.txt', 'utf8')); })";

    const result = await node([script], { cwd: root });

    expect(result.stdout).toBe("found");
  });

  it("inherits the environment and applies overrides on top of it", async () => {
    process.env["QAT_TEST_OVERRIDE"] = "inherited";

    try {
      const script =
        'process.stdout.write(process.env.QAT_TEST_OVERRIDE + "|" + (process.env.PATH ? "path" : "nopath"))';

      const result = await node([script], {
        env: { QAT_TEST_OVERRIDE: "overridden" },
      });

      // The override wins, and the inherited environment is still present — which is the whole
      // point of merging rather than replacing.
      expect(result.stdout).toBe("overridden|path");
    } finally {
      delete process.env["QAT_TEST_OVERRIDE"];
    }
  });

  it("closes standard input so a child cannot block waiting for an answer", async () => {
    const result = await node(
      [
        "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('eof'))",
      ],
      { timeoutMs: 5_000 },
    );

    expect(result.stdout).toBe("eof");
  });
});

describe("non-zero exit", () => {
  it("returns the exit code rather than throwing", async () => {
    // The central contract: the child ran and answered. Answering badly is still an answer.
    const result = await node(["process.exit(3)"]);

    expect(result.exitCode).toBe(3);
  });
});

describe("missing executable", () => {
  it("produces an actionable error naming the executable", async () => {
    const error = await runProcess({
      executable: "qat-definitely-not-executable-7f3a",
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProcessExecutionError);
    expect((error as ProcessExecutionError).code).toBe(
      ErrorCode.processExecutableNotFound,
    );
    expect((error as ProcessExecutionError).message).toContain("was not found");
    expect((error as ProcessExecutionError).remediation).toBeDefined();
  });
});

describe("timeout", () => {
  it("terminates the child and reports a timeout", async () => {
    const pidFile = join(root, "timeout.pid");

    const script =
      `import('node:fs').then((fs) => { fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); }); ` +
      "setInterval(() => {}, 1000);";

    const error = await runProcess({
      executable: process.execPath,
      args: ["-e", script],
      timeoutMs: 1_000,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProcessExecutionError);
    expect((error as ProcessExecutionError).code).toBe(
      ErrorCode.processTimedOut,
    );

    // The child must be gone, not merely abandoned. This is the assertion that distinguishes a
    // lifecycle from a timeout setting.
    const wrotePid = await waitFor(() =>
      readFile(pidFile, "utf8").then(
        () => true,
        () => false,
      ),
    );
    expect(wrotePid).toBe(true);

    const pid = Number(await readFile(pidFile, "utf8"));
    expect(await waitFor(() => !isRunning(pid))).toBe(true);
  }, 20_000);
});

describe("cancellation", () => {
  it("terminates the child and reports cancellation", async () => {
    const controller = new AbortController();

    const invocation = runProcess({
      executable: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      signal: controller.signal,
    });

    setTimeout(() => {
      controller.abort();
    }, 300);

    const error = await invocation.catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProcessExecutionError);
    expect((error as ProcessExecutionError).code).toBe(
      ErrorCode.processCancelled,
    );
  }, 20_000);
});

describe("output policy", () => {
  it("mirrors forwarded output to standard error and still captures it", async () => {
    const write = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    try {
      const result = await node(["process.stdout.write('forwarded')"], {
        output: { stdout: ProcessOutput.Forward },
      });

      expect(result.stdout).toBe("forwarded");
      expect(write).toHaveBeenCalled();
    } finally {
      write.mockRestore();
    }
  });

  it("discards output when asked, leaving the result fields empty", async () => {
    const result = await node(
      ["process.stdout.write('gone'); process.stderr.write('also gone')"],
      {
        output: {
          stdout: ProcessOutput.Discard,
          stderr: ProcessOutput.Discard,
        },
      },
    );

    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });
});
