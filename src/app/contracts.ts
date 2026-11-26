/**
 * Options for assembling an application.
 *
 * The assembled shape lives in `core/application/ports`, so that a consumer depends on what it receives rather than on
 * the thing that built it.
 *
 * Almost every member here is a seam for something a test cannot otherwise control. That is the rule: an option exists
 * because the thing it replaces is a property of the *machine* — an environment, a stream, a repository file, a runtime,
 * a PATH, a declared range — and a test that exercised the real one would be testing the CI image rather than the code.
 *
 * `logLevel` is the exception and is here for a different reason: it is an input a command parsed, passed to the factory
 * so validation happens once at the boundary rather than in every caller. It is not a seam and nothing is substituted by
 * passing it.
 *
 * Nothing here is a feature flag. No option changes behaviour a user can rely on, and none of them may be set by a caller
 * outside a test without raising the question of what the build actually supports.
 */
import type { DestinationStream } from "pino";

import type {
  ExecutionRepository,
  ExecutableLocator,
  RuntimeProbe,
} from "../core/application/ports.js";
// The widened name. The runtime-era alias still exists in `core/compatibility` so that call sites in flight keep
// compiling, but the type this option carries is a statement about a version — whoever owns it — and the seam is named
// for what it overrides rather than for where the override first appeared.
import type { VersionRequirement } from "../core/compatibility/index.js";
import type { EnvironmentSource } from "../core/environment/index.js";

export type { Application } from "../core/application/ports.js";

export interface ApplicationOptions {
  /** Log level as supplied on the command line, not yet validated. */
  readonly logLevel?: string;

  /** Where environment variables are read from. Defaults to `process.env`. */
  readonly environment?: EnvironmentSource;

  /** Where log entries go. Defaults to standard error. */
  readonly logDestination?: DestinationStream;

  /** Replaces the wired repository. */
  readonly repository?: ExecutionRepository;

  /**
   * Replaces the wired runtime probe.
   *
   * Same purpose as `repository` above: assembly is the only place that names real things, so it is also the only place
   * that has to be told about fakes. Substituting the probe is how the supported/unsupported boundary matrix is driven
   * through the real check with a literal version, instead of by editing `process.versions` in a test or spawning a
   * second interpreter to observe one.
   *
   * The seam is narrow on purpose — it answers one question, so a fake is three lines — and it replaces the *source* of
   * the version, never the parsing or the comparison, which stay in one place no matter who supplies the string.
   */
  readonly runtime?: RuntimeProbe;

  /**
   * Replaces PATH resolution, so a test does not depend on the machine it runs on.
   *
   * The narrowest seam of the set, because the port is one method with one argument: `locateExecutable(command)`. A fake
   * is a single `Map`, which is what makes the whole package-manager detection matrix — a tool present, absent, present
   * under another name, present only inside a project-local `node_modules` — testable without touching a disk or the
   * runner's PATH.
   *
   * What it replaces is *where a tool lives*, never *the rules for deciding*. PATH-only, no `node_modules/.bin`, no
   * empty or relative segment, and what counts as an executable file all remain inside the locator implementation, beside
   * the tests that prove them. Substituting this seam cannot loosen those rules; it can only change the machine they are
   * applied to.
   *
   * There is deliberately no companion option for the locator object behind the port. Replacing the implementation while
   * keeping a different port would describe a configuration that cannot occur, and every extra seam is a combination a
   * reviewer has to reason about for a case nobody has.
   */
  readonly executables?: ExecutableLocator;

  /**
   * Replaces the range this build declares, instead of reading it from its own `package.json`.
   *
   * A wider seam than the others, and worth saying out loud: it overrides **policy**, not infrastructure. A test that
   * supplies a range is testing *how the checks react* to a declared requirement — never *what* the requirement is. The
   * real value is guarded by the contract test that reads the manifest and compares it with the CI matrix, so nothing
   * here can quietly redefine what QAT supports.
   *
   * `range` is passed through verbatim, including the empty string. Supplying `""` is a legitimate test: it is exactly
   * what a broken installation produces, and the expected outcome is an unreadable-policy warning rather than a pass.
   *
   * The type is `VersionRequirement` rather than anything runtime-shaped, and that is the widening doing its work: the
   * same shape carries the package-manager pin a project declares, so a future seam for that value needs no new type and
   * no second vocabulary. Nothing in this file constructs one — it is assembled once, from the manifest, and passed
   * through.
   *
   * Any caller outside a test that sets this is a review flag, not a feature: a build whose support range is decided by
   * whoever assembled it cannot make a support claim at all.
   */
  readonly nodeRequirement?: VersionRequirement;
}
