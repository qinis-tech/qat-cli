/**
 * The CFG-004 preflight probe — the only place in this module that runs a process.
 *
 * Two things are being tested, and they are different in kind.
 *
 * The **invocation** is a contract with the operating system: which binary, which argument vector, which directory, what
 * bound, what environment. Every one of those is asserted from the recorded call rather than inferred from behaviour,
 * because a wrong `cwd` still loads *a* configuration and a shell that was never enabled is invisible in an exit code.
 *
 * The **classification** is a contract with the reader: an exit status, a timeout and a missing mechanism are three
 * different facts, and `validate.ts` maps them to three different verdicts. Getting this wrong is how a slow machine
 * becomes a broken configuration in a bug report.
 *
 * No process is spawned anywhere in this file. The runner is a fake that records what it was asked and answers with the
 * outcome under test, which is what makes "the loader printed a 900-character stack trace and exited 1" a two-line case.
 */

import { describe, expect, it } from "vitest";

import type {
  CommandInvocation,
  CommandOutcome,
  CommandRunnerPort,
  ConfigLoadProbeResult,
  CypressCliResolverPort,
} from "~/project/cypress-config/index.js";
import {
  CONFIG_LOAD_ARGUMENTS,
  CONFIG_LOAD_TIMEOUT_MS,
  MAX_LOADER_OUTPUT_BYTES,
  createCypressConfigLoaderProbe,
} from "~/project/cypress-config/index.js";

const ROOT = "/projects/example";
const CLI = `${ROOT}/node_modules/cypress/bin/cypress.js`;
const NODE = "/usr/local/bin/node";

/** A completed invocation, with the parts a case does not vary set to the happy path. */
function outcome(overrides: Partial<CommandOutcome> = {}): CommandOutcome {
  return {
    exitCode: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
    durationMs: 812,
    ...overrides,
  };
}

interface RecordingRunner {
  readonly port: CommandRunnerPort;
  readonly invocations: CommandInvocation[];
}

/**
 * A runner that answers with `value` and records the call.
 *
 * Not `async`: the fake performs no I/O, so an `async` declaration would claim a microtask it does not need and change
 * the interleaving of the code under test. `Promise.resolve` states the contract without implying a wait.
 */
function runnerReturning(value: CommandOutcome): RecordingRunner {
  const invocations: CommandInvocation[] = [];

  return {
    invocations,
    port: {
      run: (invocation) => {
        invocations.push(invocation);
        return Promise.resolve(value);
      },
    },
  };
}

/** A runner that cannot start the process at all — the shape the real one produces for a vanished binary. */
function runnerFailing(): RecordingRunner {
  const invocations: CommandInvocation[] = [];

  return {
    invocations,
    port: {
      run: (invocation) => {
        invocations.push(invocation);
        return Promise.reject(new Error("spawn ENOENT"));
      },
    },
  };
}

function resolverReturning(path: string | undefined): CypressCliResolverPort {
  return { resolve: () => Promise.resolve(path) };
}

/** The probe under test, with everything a case does not vary set to a healthy default. */
function makeProbe(
  overrides: {
    runner?: CommandRunnerPort;
    resolveCli?: CypressCliResolverPort;
    nodeExecutable?: string;
    timeoutMs?: number;
    maxOutputBytes?: number;
  } = {},
) {
  return createCypressConfigLoaderProbe({
    runner: overrides.runner ?? runnerReturning(outcome()).port,
    resolveCli: overrides.resolveCli ?? resolverReturning(CLI),
    nodeExecutable: overrides.nodeExecutable ?? NODE,
    ...(overrides.timeoutMs === undefined
      ? {}
      : { timeoutMs: overrides.timeoutMs }),
    ...(overrides.maxOutputBytes === undefined
      ? {}
      : { maxOutputBytes: overrides.maxOutputBytes }),
  });
}

describe("the declared bound", () => {
  it("is a constant rather than a parameter a caller can forget", () => {
    // The documented promise and the behaviour must be the same number, which is only true if the number exists once.
    expect(CONFIG_LOAD_TIMEOUT_MS).toBe(60_000);
    expect(MAX_LOADER_OUTPUT_BYTES).toBe(65_536);
  });

  it("asks Cypress to load the configuration and nothing else", () => {
    // A frozen, single-element vector. The assertion that matters is the negative one: no verb here can start a run or
    // open a browser, so a future edit that "helpfully" added a spec would fail this test rather than someone's CI.
    expect(CONFIG_LOAD_ARGUMENTS).toStrictEqual(["config"]);
    expect(Object.isFrozen(CONFIG_LOAD_ARGUMENTS)).toBe(true);
    expect(CONFIG_LOAD_ARGUMENTS).not.toContain("run");
    expect(CONFIG_LOAD_ARGUMENTS).not.toContain("open");
  });
});

describe("when the project has no Cypress CLI", () => {
  it("reports the mechanism as unavailable without spawning anything", async () => {
    const runner = runnerReturning(outcome());

    const result = await makeProbe({
      runner: runner.port,
      resolveCli: resolverReturning(undefined),
    }).load({ projectRoot: ROOT });

    // Nothing to ask. That is a dependency finding owned by the Cypress installation checks, so this tier simply has no
    // evidence to offer — and it must not invent a verdict about a file it never opened.
    expect(result).toStrictEqual({ outcome: "unavailable" });
    expect(runner.invocations).toStrictEqual([]);
  });
});

describe("the invocation", () => {
  it("runs the resolved CLI through the injected interpreter, as separate arguments", async () => {
    const runner = runnerReturning(outcome());

    await makeProbe({ runner: runner.port }).load({ projectRoot: ROOT });

    const [invocation] = runner.invocations;

    // No PATH lookup and no shell: the interpreter is named explicitly and the CLI travels as `argv[1]`, so nothing a
    // dependency install could replace gets resolved and nothing containing `;` can become a command.
    expect(invocation).toMatchObject({
      command: NODE,
      arguments: [CLI, "config"],
      cwd: ROOT,
    });
  });

  it("loads the project it was asked about, not the process's own directory", async () => {
    const runner = runnerReturning(outcome());

    await makeProbe({ runner: runner.port }).load({
      projectRoot: "/elsewhere/app",
    });

    // A configuration is resolved relative to the directory Cypress is started in, so this is the difference between
    // validating the user's project and validating whichever one QAT happens to be standing in.
    expect(runner.invocations[0]?.cwd).toBe("/elsewhere/app");
  });

  it("bounds the process with the documented defaults", async () => {
    const runner = runnerReturning(outcome());

    await makeProbe({ runner: runner.port }).load({ projectRoot: ROOT });

    expect(runner.invocations[0]).toMatchObject({
      timeoutMs: CONFIG_LOAD_TIMEOUT_MS,
      maxOutputBytes: MAX_LOADER_OUTPUT_BYTES,
    });
  });

  it("accepts tighter bounds for a caller that wants them", async () => {
    const runner = runnerReturning(outcome());

    await makeProbe({
      runner: runner.port,
      timeoutMs: 2_000,
      maxOutputBytes: 1_024,
    }).load({
      projectRoot: ROOT,
    });

    // Overridable because the bound is a policy the caller owns; the default exists so a caller who has no opinion gets
    // a safe one rather than an unbounded process.
    expect(runner.invocations[0]).toMatchObject({
      timeoutMs: 2_000,
      maxOutputBytes: 1_024,
    });
  });

  it("reads colour control without discarding the environment", async () => {
    const runner = runnerReturning(outcome());

    await makeProbe({ runner: runner.port }).load({ projectRoot: ROOT });

    const { env } = runner.invocations[0] ?? { env: {} };

    // Overrides merged over the inherited environment: a configuration may legitimately read a variable, and stripping
    // the environment would change the very answer this tier is trying to observe. Colour is a capture concern, so it is
    // switched off here rather than stripped from the output afterwards.
    expect(env).toMatchObject({ NO_COLOR: "1", FORCE_COLOR: "0" });
  });
});

describe("classifying what the loader said", () => {
  it("accepts a clean exit as proof, and records what it cost", async () => {
    const runner = runnerReturning(outcome({ exitCode: 0, durationMs: 812 }));

    const result = await makeProbe({ runner: runner.port }).load({
      projectRoot: ROOT,
    });

    // The only path that can produce a pass, and it comes from the only authority entitled to give one.
    expect(result).toStrictEqual({ outcome: "loaded", durationMs: 812 });
  });

  it("ignores stderr on a clean exit, because the exit status is the answer", async () => {
    const runner = runnerReturning(
      outcome({ exitCode: 0, stderr: "Warning: something noisy" }),
    );

    const result = await makeProbe({ runner: runner.port }).load({
      projectRoot: ROOT,
    });

    // Loaders are chatty. Treating any stderr as failure would make every project with a deprecation notice invalid.
    expect(result).toStrictEqual({ outcome: "loaded", durationMs: 812 });
  });

  it("reports a timeout before it reads anything else", async () => {
    const runner = runnerReturning(
      outcome({
        timedOut: true,
        exitCode: 0,
        stderr: "Error: broken config",
        durationMs: 60_000,
      }),
    );

    const result = await makeProbe({ runner: runner.port }).load({
      projectRoot: ROOT,
    });

    // A killed process's exit code and output are artefacts of the kill, so both are ignored. Reporting this as invalid
    // would blame the user's configuration for our own bound.
    expect(result).toStrictEqual({ outcome: "timeout", durationMs: 60_000 });
  });

  it("reports a real rejection as a failure, quoting the loader", async () => {
    const runner = runnerReturning(
      outcome({
        exitCode: 1,
        stderr: "Error: defineConfig is not a function\n",
      }),
    );

    const result = await makeProbe({ runner: runner.port }).load({
      projectRoot: ROOT,
    });

    // Trimmed, not sanitised: ANSI stripping, whitespace collapsing and the length cap belong to the ladder, which
    // decides what reaches a finding. This layer reports what the process said.
    expect(result).toStrictEqual({
      outcome: "failed",
      message: "Error: defineConfig is not a function",
      durationMs: 812,
    });
  });

  it("falls back to stdout for a loader that explains itself on the wrong stream", async () => {
    const runner = runnerReturning(
      outcome({
        exitCode: 1,
        stdout: "configuration is invalid\n",
        stderr: "",
      }),
    );

    const result = await makeProbe({ runner: runner.port }).load({
      projectRoot: ROOT,
    });

    expect(result).toMatchObject({
      outcome: "failed",
      message: "configuration is invalid",
    });
  });

  it("still says something when both streams are silent", async () => {
    const runner = runnerReturning(outcome({ exitCode: 7 }));

    const result = await makeProbe({ runner: runner.port }).load({
      projectRoot: ROOT,
    });

    // An exit code on its own is a poor message but a truthful one, and better than an empty string a reader cannot act
    // on or search for.
    expect(result).toMatchObject({
      outcome: "failed",
      message: "The Cypress configuration loader exited with code 7.",
    });
  });
});

describe("distinguishing a missing mechanism from a broken file", () => {
  it.each([
    ["unknown command 'config'"],
    ["Unknown argument: config"],
    ["'config' is not a cypress command"],
    ["The Cypress binary is not installed"],
    ["Cannot find module 'cypress'"],
  ])("reports %s as unavailable rather than invalid", async (stderr) => {
    const runner = runnerReturning(outcome({ exitCode: 1, stderr }));

    const result = await makeProbe({ runner: runner.port }).load({
      projectRoot: ROOT,
    });

    // These say "this mechanism is not available here", not "your configuration is broken". Reporting them as invalid
    // would blame the user for our limitation; reporting them as a pass would be worse.
    expect(result).toStrictEqual({ outcome: "unavailable" });
  });

  it("does not treat a failure merely mentioning an argument as a missing mechanism", async () => {
    const runner = runnerReturning(
      outcome({
        exitCode: 1,
        stderr: "Error: the baseUrl argument has an invalid value",
      }),
    );

    const result = await makeProbe({ runner: runner.port }).load({
      projectRoot: ROOT,
    });

    // The markers are deliberately narrow. A broad pattern here would quietly convert real configuration failures into
    // shrugs, which is the one direction this classification must never drift.
    expect(result).toMatchObject({ outcome: "failed" });
  });

  it("reads the markers from stderr only", async () => {
    const runner = runnerReturning(
      outcome({ exitCode: 1, stdout: "unknown command", stderr: "" }),
    );

    const result = await makeProbe({ runner: runner.port }).load({
      projectRoot: ROOT,
    });

    // A loader echoing its own help text on stdout is not evidence that the mechanism is missing. The rule is stated
    // because it is a choice: widening it would be easy, and wrong.
    expect(result).toMatchObject({ outcome: "failed" });
  });
});

describe("when the process cannot start at all", () => {
  it("reports an unavailable mechanism rather than a verdict about the file", async () => {
    const runner = runnerFailing();

    const result = await makeProbe({ runner: runner.port }).load({
      projectRoot: ROOT,
    });

    // A runner that cannot spawn tells us nothing about the configuration. Reporting it as invalidity would be a false
    // finding produced by a broken toolchain.
    expect(result).toStrictEqual({ outcome: "unavailable" });
    expect(runner.invocations).toHaveLength(1);
  });
});

describe("properties of the probe", () => {
  it("is deterministic for a runner that answers the same way twice", async () => {
    const runner = runnerReturning(outcome({ exitCode: 1, stderr: "boom" }));

    const [first, second] = await Promise.all([
      makeProbe({ runner: runner.port }).load({ projectRoot: ROOT }),
      makeProbe({ runner: runner.port }).load({ projectRoot: ROOT }),
    ]);

    // The probe holds no state between calls, so two loads of the same project cannot disagree.
    expect(first).toStrictEqual(second);
  });

  it("spawns at most one process per load", async () => {
    const runner = runnerReturning(outcome());

    await makeProbe({ runner: runner.port }).load({ projectRoot: ROOT });

    // A retry would be a second execution of project code and a second, possibly different, answer to one question.
    expect(runner.invocations).toHaveLength(1);
  });

  it("returns one of exactly four outcomes", async () => {
    const runner = runnerReturning(outcome({ exitCode: 1, stderr: "boom" }));

    const result: ConfigLoadProbeResult = await makeProbe({
      runner: runner.port,
    }).load({
      projectRoot: ROOT,
    });

    // Typed as the union the ladder switches on: a fifth shape added here without a branch there would be a compile
    // error in `validate.ts`, and this assertion is the reminder that the four are exhaustive today.
    expect(["loaded", "failed", "unavailable", "timeout"]).toContain(
      result.outcome,
    );
  });
});
