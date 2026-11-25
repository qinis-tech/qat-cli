/**
 * Options for assembling an application.
 *
 * The assembled shape lives in `core/application/ports`, so that a consumer depends on what it
 * receives rather than on the thing that built it.
 */
import type { DestinationStream } from "pino";

import type {
  ExecutionRepository,
  RuntimeProbe,
} from "../core/application/ports.js";
import type { RuntimeRequirement } from "../core/compatibility/index.js";
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
   * Same purpose as `repository` above: assembly is the only place that names real things, so it is also the only
   * place that has to be told about fakes. Substituting the probe is how the supported/unsupported boundary matrix is
   * driven through the real check with a literal version, instead of by editing `process.versions` in a test or
   * spawning a second interpreter to observe one.
   *
   * The seam is narrow on purpose — it answers one question, so a fake is three lines — and it replaces the *source*
   * of the version, never the parsing or the comparison, which stay in one place no matter who supplies the string.
   */
  readonly runtime?: RuntimeProbe;

  /**
   * Replaces the range this build declares, instead of reading it from its own `package.json`.
   *
   * A wider seam than the others, and worth saying out loud: it overrides **policy**, not infrastructure. A test that
   * supplies a range is testing *how the checks react* to a declared requirement — never *what* the requirement is.
   * The real value is guarded by the contract test that reads the manifest and compares it with the CI matrix, so
   * nothing here can quietly redefine what QAT supports.
   *
   * `range` is passed through verbatim, including the empty string. Supplying `""` is a legitimate test: it is exactly
   * what a broken installation produces, and the expected outcome is an unreadable-policy warning rather than a pass.
   *
   * Any caller outside a test that sets this is a review flag, not a feature: a build whose support range is decided
   * by whoever assembled it cannot make a support claim at all.
   */
  readonly nodeRequirement?: RuntimeRequirement;
}
