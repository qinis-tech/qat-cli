/**
 * Options for assembling an application.
 *
 * The assembled shape lives in `core/application/ports`, so that a consumer depends on what it
 * receives rather than on the thing that built it.
 */
import type { DestinationStream } from "pino";

import type { ExecutionRepository } from "../core/application/ports.js";
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
}
