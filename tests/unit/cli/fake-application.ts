/**
 * A fake application, for tests that exercise the program rather than a command.
 *
 * Not a test file: the unit suite's include pattern is `**\/*.test.ts`, so this module is imported and never collected.
 *
 * ## Why it is a factory rather than a constant
 *
 * The program disposes the application after a command runs, and a test that checks the lifecycle has to observe that.
 * An optional callback records it without a spy, which keeps the fake free of a mocking framework and usable from a
 * test that does not care.
 *
 * ## Why it lives here rather than in `tests/helpers/`
 *
 * Two files in this directory use it and nothing else does. Promoting it to `tests/helpers/` when a second suite needs
 * it is a file move, not a rewrite; importing a CLI-specific fake from a shared directory before then would make it look
 * like a general facility.
 *
 * ## Every collaborator that is not provided rejects
 *
 * `discovery` and `repository` reject rather than resolve, with a message naming which one was reached for. A test that
 * accidentally calls one fails loudly instead of silently succeeding against a stub that returned nothing — and the
 * silent success is the worse failure, because it looks like a passing test and hides an assertion that never ran.
 *
 * The logger is the exception, and deliberately: a handler is entitled to log, and a rejecting logger would fail a test
 * for doing something correct. Its methods discard.
 */
import type { Application } from "~/core/application/ports.js";

export interface FakeApplicationOptions {
  /** Called when the handler disposes the application. Records the lifecycle without a spy. */
  readonly onDispose?: () => void;
}

/**
 * Rejects with a message naming the collaborator that was reached for.
 *
 * One message per collaborator rather than per method. A message like `discovery.diagnose is unused in this test` is
 * more precise and ends up in a rendered error, where an assertion on that exact text is the kind of coupling that
 * breaks for a reason nobody looks at. The stack names the call site; the message only has to say which collaborator
 * was touched, and the phrase below is the one the existing suites already match on.
 *
 * Returning `Promise<never>` rather than `Promise<unknown>` is what lets each member keep its declared return type: a
 * promise that never resolves is assignable to every result type this port has.
 */
function unused(collaborator: "discovery" | "repository"): Promise<never> {
  return Promise.reject(new Error(`${collaborator} is unused in this test`));
}

export function fakeApplication(
  options: FakeApplicationOptions = {},
): Application {
  return {
    logger: {
      trace: () => undefined,
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      fatal: () => undefined,
    },

    // Rejecting rather than resolving. Nothing in a program-level test should reach these, so a rejection is either a
    // test that needs a different fixture or a command that grew a dependency its tests have not provided — and both
    // are worth failing for.
    repository: {
      create: () => unused("repository"),
      complete: () => unused("repository"),
      findById: () => unused("repository"),
      list: () => unused("repository"),
      close: () => unused("repository"),
    },

    // Four members, in the order the port declares them: which directory, what is there, may I act on it, give me the
    // project. The one a command is most likely to reach for is `assess`, which is why it is a trap rather than a stub
    // that returns an empty assessment — an assessment nothing computed would make a gated command look ready.
    discovery: {
      resolveWorkingDirectory: () => unused("discovery"),
      diagnose: () => unused("discovery"),
      assess: () => unused("discovery"),
      discover: () => unused("discovery"),
    },

    dispose: () => {
      // Synchronous, before the returned promise settles, for two reasons.
      //
      // A lifecycle test asserts on the flag immediately after awaiting the program, and an ordering that depended on
      // a microtask would be a test that passes most of the time. And a callback that throws propagates synchronously
      // — which is where a bug in the test should surface, at the call site, rather than as a rejected promise that
      // the program's error handler might render as though the application had failed.
      options.onDispose?.();

      return Promise.resolve();
    },
  };
}
