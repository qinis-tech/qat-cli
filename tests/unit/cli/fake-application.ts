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
 * ## Why the runtime evidence is a value and not a trap
 *
 * `runtime` and `nodeRequirement` are the two members added for the runtime checks, and they are treated differently
 * from the collaborators above — because they are not collaborators. They are *evidence*: a version string and a
 * declared range, both of which a doctor run reads as a matter of course.
 *
 * Trapping them would make a legitimate read fail with "runtime is unused in this test", which is worse than useless: it
 * names the wrong problem, and it teaches whoever hits it to loosen the trap. A fixture that states a version and a range
 * admits itself is honest, visible at the call site, and overridable when a test needs a different answer.
 *
 * The default is a **fixture, not a claim about what this build supports**. The shipped policy is `engines.node`, and
 * the contract suite is the only place entitled to assert anything about it; a unit test must not depend on the machine
 * it runs on, which is why the default is a literal rather than `process.versions.node`.
 *
 * ## What to do instead of loosening a trap
 *
 * A test that genuinely needs one of these should give it something real, not a stub. A handler needing a resolved
 * configuration reads the one attached to its assessment, produced from a temporary project; a handler needing to
 * initialise one belongs in the end-to-end suite, where the file either appears on disk or does not. A stub that returns
 * a plausible value turns either of those into a test of the stub.
 */
import type { Application, RuntimeProbe } from "~/core/application/ports.js";
import type { RuntimeRequirement } from "~/core/compatibility/index.js";

/**
 * The version a fake reports unless a test says otherwise, and a range that admits it.
 *
 * Paired deliberately: a fixture that reported a version its own range refused would make every lifecycle test look like
 * it had an unsupported runtime, and the resulting warning would be read as a defect in the program rather than as a
 * badly chosen fixture.
 */
const FAKE_VERSION = "v20.11.1";

/** Frozen, like the real one, so a test cannot accidentally change what the next assertion reads. */
const FAKE_REQUIREMENT: RuntimeRequirement = Object.freeze({
  source: "qat",
  range: ">=20.11.0 <21.0.0",
  origin: "package.json#engines.node",
  severityWhenUnsatisfied: "error",
});

export interface FakeApplicationOptions {
  /** Called when the handler disposes the application. Records the lifecycle without a spy. */
  readonly onDispose?: () => void;

  /** Replaces the reported interpreter. Supply one to exercise an unsupported or unreadable runtime. */
  readonly runtime?: RuntimeProbe;

  /** Replaces the declared range. Supply one to exercise a policy the fixture range would not reach. */
  readonly nodeRequirement?: RuntimeRequirement;
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

    // Inline rather than `createProcessRuntime`: a fake of a *value* should not borrow the adapter it is standing in
    // for, or the fake and the implementation would agree for the same reason and neither would be tested. The default
    // is overridable because a test that needs an unsupported runtime needs only to say so.
    runtime: options.runtime ?? { readNodeVersion: () => FAKE_VERSION },

    // A value rather than a resolver, matching the port: the range is read once at composition and shared. Frozen so
    // that a test which mutated it could not silently change what a later assertion in the same file reads.
    nodeRequirement: options.nodeRequirement ?? FAKE_REQUIREMENT,

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
