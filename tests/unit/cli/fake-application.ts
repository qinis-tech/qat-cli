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
 * ## Every collaborator that is not provided fails loudly
 *
 * Three reject — `repository`, `discovery` and `initialisation` — and `configuration.resolve` throws, each with a message
 * naming the collaborator that was reached for. A test that accidentally calls one fails loudly instead of silently
 * succeeding against a stub that returned nothing — and the silent success is the worse failure, because it looks like a
 * passing test and hides an assertion that never ran.
 *
 * The two shapes follow the port rather than a preference here: `configuration.resolve` is synchronous, because
 * resolution is a pure function of a document and a project root, so a fake that rejected a promise from it would be
 * describing an interface nobody implements.
 *
 * The logger is the exception, and deliberately: a handler is entitled to log, and a rejecting logger would fail a test
 * for doing something correct. Its methods discard.
 *
 * ## What to do instead of loosening a trap
 *
 * A test that genuinely needs one of these should give it something real, not a stub. A handler needing a resolved
 * configuration reads the one attached to its assessment, produced from a temporary project; a handler needing to
 * initialise one belongs in the end-to-end suite, where the file either appears on disk or does not. A stub that returns
 * a plausible value turns either of those into a test of the stub.
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
 * breaks for a reason nobody looks at. The stack names the call site; the message only has to say which collaborator was
 * touched, and the phrase below is the one the existing suites already match on.
 *
 * Returning `Promise<never>` rather than `Promise<unknown>` is what lets each member keep its declared return type: a
 * promise that never resolves is assignable to every result type these ports have.
 */
function unused(
  collaborator: "discovery" | "initialisation" | "repository",
): Promise<never> {
  return Promise.reject(new Error(`${collaborator} is unused in this test`));
}

/**
 * The same trap for a member that returns a value rather than a promise.
 *
 * Throwing synchronously rather than returning a rejected promise is the whole point: a caller that awaited the result
 * of a fake would be testing an interface with an `await` the real one does not need, and a bug in that caller would
 * surface as an unhandled rejection at the end of the run instead of at the line that caused it.
 *
 * `never` is assignable to the member's declared return type, so the signature stays intact.
 */
function unusedImmediately(collaborator: "configuration"): never {
  throw new Error(`${collaborator} is unused in this test`);
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

    // One member, and it throws rather than rejecting: see `unusedImmediately`. A command that needs a resolved
    // configuration does not call this — it reads the one attached to its assessment, which `discovery.assess` above
    // traps for the same reason. Reaching for the resolver directly from a handler is itself the defect this trap
    // reports.
    configuration: {
      resolve: () => unusedImmediately("configuration"),
    },

    // One operation, and it rejects rather than returning an outcome, because no arrangement of a fake makes an
    // initialisation test meaningful: the whole question is whether a file appeared on disk, and only the end-to-end
    // suite can answer it. A stub returning `created` would let a handler test pass while nothing was ever written.
    initialisation: {
      initialise: () => unused("initialisation"),
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
