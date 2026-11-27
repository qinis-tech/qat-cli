/**
 * The bounded loader probe for CFG-004's deepest tier.
 *
 * Tier 2 answers a question nothing else can: does the project's own Cypress
 * actually accept this configuration? An executable configuration cannot be
 * parsed, only loaded, so the only authority is the loader that will run it.
 *
 * This file exists so that authority is exercised under control:
 *
 *   • **Opt-in.** Tier 2 never runs unless the caller asked for depth. Loading a
 *     configuration executes project code, which is acceptable on request and
 *     unacceptable as a silent default.
 *   • **Bounded.** One process, one hard timeout, one capped output budget. A
 *     config that hangs must not hang the doctor.
 *   • **Not the test suite.** The command is a frozen constant that describes
 *     "load the configuration". No spec, no browser, no `run`, no `open`.
 *   • **Content-blind.** Stdout is discarded, not stored. A resolved Cypress
 *     configuration contains `env` values, which is exactly where credentials
 *     live, and no diagnostic should ever copy them into evidence.
 *
 * Everything here is I/O. The ladder that decides *whether* to call this lives in
 * `validate.ts` and stays pure; this module owns only the process boundary, which
 * is why its failures are values rather than exceptions.
 */

import type { ConfigLoadProbePort, ConfigLoadProbeResult } from "./validate.js";

/**
 * Hard bound on the load attempt.
 *
 * Generous enough for a cold TypeScript config on a slow machine, short enough
 * that a hung loader cannot make `qat doctor` appear frozen. Declared as a
 * constant rather than a parameter so the documented promise and the behaviour
 * cannot drift apart.
 */
export const CONFIG_LOAD_TIMEOUT_MS = 60_000;

/**
 * Cap on captured stderr.
 *
 * A failing loader can emit a full stack trace with an embedded code frame. The
 * useful part is at the top, and an unbounded buffer is a memory hazard when the
 * thing you are running is the thing that is broken.
 */
export const MAX_LOADER_OUTPUT_BYTES = 64 * 1024;

/**
 * The exact argument vector, frozen.
 *
 * One argument, and a deliberately small one: ask Cypress to print its resolved
 * configuration, which forces it to load the configuration file and nothing else.
 * Kept as data so a test can assert this command can never become a test run, and
 * so the supported-for-this-Cypress-version question is answered in one place.
 */
export const CONFIG_LOAD_ARGUMENTS = Object.freeze(["config"] as const);

/**
 * Stderr signatures that mean "this mechanism is not available here", not "your
 * configuration is broken".
 *
 * The distinction is the whole point of the tier: reporting a missing mechanism
 * as an invalid configuration would blame the user for our own limitation, and
 * reporting it as a pass would be worse. Anything matching these becomes
 * `unavailable`, which the ladder surfaces as `indeterminate`.
 *
 * Deliberately short and specific. A broad pattern here would quietly convert real
 * configuration failures into shrugs.
 */
const UNAVAILABLE_MARKERS: readonly RegExp[] = Object.freeze([
  /unknown command/i,
  /unknown argument/i,
  /not a cypress command/i,
  // The loader could not start at all: a missing binary or a broken install is a
  // prerequisite owned by the dependency checks, not a verdict about this file.
  /binary (?:is )?not (?:found|installed)/i,
  /cannot find module/i,
]);

/** Options forwarded to the process runner, so the adapter owns the platform details. */
export interface CommandInvocation {
  readonly command: string;
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  /** The project's environment: a config may legitimately read it. */
  readonly env: NodeJS.ProcessEnv;
}

/**
 * What the runner reports back.
 *
 * `timedOut` is separate from an exit code on purpose: a killed process has no
 * meaningful status, and conflating the two would let a timeout look like a
 * failure the user could act on.
 */
export interface CommandOutcome {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly durationMs: number;
}

/**
 * The process boundary, as this module needs it.
 *
 * Structural rather than importing the framework's runner type directly: the
 * composition root adapts the existing process utility to this shape, and this
 * module stays testable with a three-line stub. It also means preflight cannot
 * reach any richer API than "run one command and report what happened".
 */
export interface CommandRunnerPort {
  readonly run: (invocation: CommandInvocation) => Promise<CommandOutcome>;
}

/**
 * Resolves the project's own Cypress CLI entry point.
 *
 * Owned by the Cypress health checks: resolution must be project-local, never a
 * global install and never a `node_modules/.bin` shim. Returning `undefined` is a
 * normal answer, not an error — it means the prerequisite is missing, which is
 * another check's finding.
 */
export interface CypressCliResolverPort {
  readonly resolve: () => Promise<string | undefined>;
}

export function createCypressConfigLoaderProbe(deps: {
  readonly runner: CommandRunnerPort;
  readonly resolveCli: CypressCliResolverPort;
  /** The Node binary running QAT. Injected so a test need not spawn anything. */
  readonly nodeExecutable?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}): ConfigLoadProbePort {
  const nodeExecutable = deps.nodeExecutable ?? process.execPath;
  const timeoutMs = deps.timeoutMs ?? CONFIG_LOAD_TIMEOUT_MS;
  const maxOutputBytes = deps.maxOutputBytes ?? MAX_LOADER_OUTPUT_BYTES;

  return {
    load: async ({ projectRoot }): Promise<ConfigLoadProbeResult> => {
      const cliPath = await deps.resolveCli.resolve();

      // No project-local Cypress means there is no loader to ask. That is a
      // dependency finding, and this tier simply has no evidence to offer.
      if (cliPath === undefined) return { outcome: "unavailable" };

      let outcome: CommandOutcome;

      try {
        outcome = await deps.runner.run({
          // The Node that is running QAT, invoked with the project's CLI file:
          // no PATH lookup, no shell, no shim that anything could have replaced.
          command: nodeExecutable,
          arguments: [cliPath, ...CONFIG_LOAD_ARGUMENTS],
          cwd: projectRoot,
          timeoutMs,
          maxOutputBytes,
          // The environment is passed through because a configuration may read it
          // legitimately. It is never logged, never persisted and never included
          // in evidence.
          env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
        });
      } catch {
        // A runner that cannot start the process tells us nothing about the
        // configuration. Reporting it as invalidity would be a false finding.
        return { outcome: "unavailable" };
      }

      return classify(outcome);
    },
  };
}

/**
 * Turns a process outcome into a verdict about the *configuration*.
 *
 * Order matters. A timeout is checked first because a killed process's exit code
 * and output are artefacts of the kill. Exit zero is authoritative proof that the
 * loader accepted the file. Only after those two is it worth reading stderr, and
 * then only to separate "mechanism not available" from a real failure.
 */
function classify(outcome: CommandOutcome): ConfigLoadProbeResult {
  if (outcome.timedOut) {
    return { outcome: "timeout", durationMs: outcome.durationMs };
  }

  // The loader exited cleanly: it read the configuration and was satisfied. This
  // is the only path that can produce a pass, and it comes from the only
  // authority entitled to give one.
  if (outcome.exitCode === 0) {
    return { outcome: "loaded", durationMs: outcome.durationMs };
  }

  const stderr = outcome.stderr.trim();

  if (UNAVAILABLE_MARKERS.some((marker) => marker.test(stderr))) {
    return { outcome: "unavailable" };
  }

  // Prefer stderr: it is where a loader explains itself. Falling back to stdout
  // keeps the message useful for loaders that report on the wrong stream, and the
  // exit code alone is better than an empty message when both are silent.
  const detail = stderr !== "" ? stderr : outcome.stdout.trim();

  return {
    outcome: "failed",
    message:
      detail !== ""
        ? detail
        : `The Cypress configuration loader exited with code ${outcome.exitCode}.`,
    durationMs: outcome.durationMs,
  };
}
