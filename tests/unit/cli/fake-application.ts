/**
 * A fake application, for tests that exercise the program rather than a command.
 *
 * Not a test file: the unit suite's include pattern is `**\/*.test.ts`, so this module is imported and never collected.
 *
 * ## Why a factory rather than a constant
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
 * Four reject — `repository`, `discovery`, `initialisation` and `configuration.inspect` — and `configuration.resolve`
 * throws synchronously, each with a message naming the collaborator that was reached for. A test that accidentally
 * calls one fails loudly instead of silently succeeding against a stub that returned nothing — and the silent success is
 * the worse failure, because it looks like a passing test and hides an assertion that never ran.
 *
 * The two shapes follow the port rather than a preference here. `configuration.resolve` is synchronous, because
 * resolution is a pure function of a document and a project root; `configuration.inspect` is not, because it reads a
 * disk. A fake that rejected a promise from the first would be describing an interface nobody implements, and a fake that
 * threw synchronously from the second would let a caller forget an `await` the implementation requires.
 *
 * The logger is the exception, and deliberately: a handler is entitled to log, and a rejecting logger would fail a test
 * for doing something correct. Its methods discard.
 *
 * ## Why the evidence is a value and not a trap
 *
 * `runtime`, `nodeRequirement`, `environment`, `executables` and `files` are the five members the health checks were
 * given, and they are treated differently from the collaborators above — because they are not collaborators. They are
 * *evidence*: a version string, a declared range, an answer about whether a variable is usable, a way to find a command
 * and a way to read what is on disk, all of which a doctor run reads as a matter of course.
 *
 * Trapping them would make a legitimate read fail with "runtime is unused in this test", which is worse than useless: it
 * names the wrong problem, and it teaches whoever hits it to loosen the trap. A fixture that states a version, a range, a
 * presence answer, a search result and a path that does not exist admits itself, is visible at the call site, and is
 * overridable when a test needs a different answer.
 *
 * The defaults are **fixtures, not claims about this machine**. The shipped policy is `engines.node`, and the contract
 * suite is the only place entitled to assert anything about it; a unit test must not depend on the machine it runs on,
 * which is why the defaults are literals rather than `process.versions.node`, the real `PATH` or the real environment.
 *
 * ## What to do instead of loosening a trap
 *
 * A test that genuinely needs one of these should give it something real, not a stub. A handler needing a resolved
 * configuration reads the one attached to its assessment, produced from a temporary project; a handler needing to
 * initialise one belongs in the end-to-end suite, where the file either appears on disk or does not. A stub that returns
 * a plausible value turns either of those into a test of the stub.
 */

import {
  EnvironmentPresence,
  type Application,
  type EnvironmentReader,
  type ExecutableLocator,
  type FileInspector,
  type RuntimeProbe,
} from "~/core/application/ports.js";
// The widened name. This fake stands in for an assembly that produces one value of this shape, whatever owns the
// requirement it describes — so naming the runtime-era alias here would put a deprecated spelling in the fixture every
// other CLI test is built on.
import type { VersionRequirement } from "~/core/compatibility/index.js";

/**
 * The version a fake reports unless a test says otherwise, and a range that admits it.
 *
 * Paired deliberately: a fixture that reported a version its own range refused would make every lifecycle test look like
 * it had an unsupported runtime, and the resulting warning would be read as a defect in the program rather than as a
 * badly chosen fixture.
 */
const FAKE_VERSION = "v20.11.1";

/** Frozen, like the real one, so a test cannot accidentally change what the next assertion reads. */
const FAKE_REQUIREMENT: VersionRequirement = Object.freeze({
  source: "qat",
  range: ">=20.11.0 <21.0.0",
  origin: "package.json#engines.node",
  severityWhenUnsatisfied: "error",
});

/**
 * Where a fake says a command lives.
 *
 * Under `/fake/` on purpose: the prefix makes it obvious in any rendered report or captured output that this path did
 * not come from the machine the test ran on. A plausible-looking real path would be the kind of fixture that ends up
 * quoted in a bug report as if it were evidence.
 *
 * The command name is echoed back rather than ignored, so an assertion can tell which command was asked for — which is
 * the only thing a test asserting detection behaviour actually cares about.
 */
function fakeExecutablePath(command: string): string {
  return `/fake/bin/${command}`;
}

export interface FakeApplicationOptions {
  /** Called when the handler disposes the application. Records the lifecycle without a spy. */
  readonly onDispose?: () => void;

  /** Replaces the reported interpreter. Supply one to exercise an unsupported or unreadable runtime. */
  readonly runtime?: RuntimeProbe;

  /** Replaces the declared range. Supply one to exercise a policy the fixture range would not reach. */
  readonly nodeRequirement?: VersionRequirement;

  /**
   * Replaces the presence probe. Supply one to exercise a missing or blank variable.
   *
   * The default answers `set` for every name — see the member's own note. This is the seam a test needs when presence
   * *is* the question under test, and it is the only way to express `unknown`, which a plain map of strings cannot: a
   * map is always consultable, and "I could not look" only exists for a source that might not be.
   */
  readonly environment?: EnvironmentReader;

  /**
   * Replaces the tool locator. Supply one to exercise a missing binary, or a tool that is present under another name.
   *
   * The default answers every command with a synthetic path — "found" — because that is the quiet case: a fake that
   * reported every tool missing would make a doctor run emit advisory findings nobody asked for, and a test would be
   * reading the fixture's opinion instead of the code's.
   */
  readonly executables?: ExecutableLocator;

  /**
   * Replaces what is on disk. Supply one to exercise a readable file, a directory occupying the path, or a symlink that
   * escapes the project.
   *
   * The default reports that nothing exists anywhere, which is the only answer that cannot be mistaken for evidence
   * about a real file — see the note on the member itself.
   */
  readonly files?: FileInspector;
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
  collaborator: "configuration" | "discovery" | "initialisation" | "repository",
): Promise<never> {
  const message = `${collaborator} is unused in this test`;
  return Promise.reject(new Error(message));
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
  const message = `${collaborator} is unused in this test`;
  throw new Error(message);
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

    /**
     * Evidence, like the four around it, and for the same reason: a doctor run asks the selected profile's references
     * about the host as a matter of course.
     *
     * The default answers `set` for every name, which is the quiet case — the same reasoning as the locator's default
     * below. A fake that reported every variable unset would emit advisory findings nobody asked for, and a test
     * asserting on a report would be reading the fixture's opinion instead of the code's.
     *
     * It answers an enum rather than a value, and that stays true of the fixture as much as of the implementation:
     * there is no arrangement of this fake that puts a credential within reach of a diagnostic. That is the port's
     * entire purpose, and a fake that could leak would be the first place it stopped being true.
     */
    environment: options.environment ?? {
      probe: () => EnvironmentPresence.Set,
    },

    // Evidence, so a synthetic answer rather than a trap — see the note at the top of this file. Asynchronous because
    // the real one stats the filesystem, and a fake that resolved synchronously would let a caller forget an `await`
    // that the implementation requires.
    executables: options.executables ?? {
      locateExecutable: (command) =>
        Promise.resolve(fakeExecutablePath(command)),
    },

    /**
     * Evidence, like the three above, and for the same reason: a doctor run reads the filesystem as a matter of course.
     *
     * The default reports **that nothing exists at any path**, which is the only answer that cannot be mistaken for
     * evidence about a real file. A fixture claiming a mode, a size or a symlink target would be inventing facts about a
     * tree the test never created — and invented facts in a fixture are how a test starts asserting its own assumptions
     * back at itself.
     *
     * `resolveRealPath` echoes its input rather than fabricating a destination, the same convention `fakeExecutablePath`
     * follows: a caller that resolves a path it was given gets that path back, and no test is ever written against a
     * target that does not exist. `readPrefix` resolves an empty array for the same reason it exists at all — it is a
     * bounded read, and zero bytes is the honest answer when there is no file.
     *
     * Asynchronous, matching the port, so a caller cannot forget an `await` the implementation requires.
     */
    files: options.files ?? {
      inspect: () => Promise.resolve(undefined),
      resolveRealPath: (path) => Promise.resolve(path),
      readPrefix: () => Promise.resolve(new Uint8Array(0)),
    },

    /**
     * Two members, and they fail differently because the port does.
     *
     * `resolve` throws synchronously: it is a pure function of a document and a project root, so there is no promise for
     * a caller to await and a rejected one would describe an interface nobody implements.
     *
     * `inspect` rejects, for the same reason `executables` and `files` resolve rather than return: it reads a disk, so a
     * synchronous throw would let a caller forget an `await` that the real implementation requires.
     *
     * Neither is a stub, and neither is likely to be needed. A command that wants a resolved configuration does not call
     * this port — it reads the one attached to its assessment, which `discovery.assess` above traps for the same reason.
     * A command that wants to know whether the file is usable asks the assessment, not the resolver. Reaching for the
     * resolver directly from a handler is itself the defect these traps report.
     */
    configuration: {
      resolve: () => unusedImmediately("configuration"),
      inspect: () => unused("configuration"),
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
