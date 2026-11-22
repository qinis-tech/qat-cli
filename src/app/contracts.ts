/**
 * The assembled application, and the options that assemble it.
 *
 * A value, not a container. Nothing here is global and nothing is a singleton: a caller receives an
 * application, passes it to whatever needs it, and disposes it. Two of them in one process are
 * independent, which is what makes them testable.
 */
import type { DestinationStream } from "pino";

import type {
  ExecutionRepository,
  ProjectDiscovery,
} from "../core/application/ports.js";
import type { EnvironmentSource } from "../core/environment/index.js";
import type { LoggerService } from "../core/logging/index.js";

export interface ApplicationOptions {
  /**
   * Log level as supplied on the command line.
   *
   * A string, not a `LogLevel`, because it has not been validated yet. An unknown value is an error
   * rather than a silent fallback: someone who typed `--log-level chatty` wants to know.
   */
  readonly logLevel?: string;

  /**
   * Where environment variables are read from. Defaults to `process.env`.
   *
   * A parameter rather than a direct read, so a test supplies three lines of fixture instead of
   * arranging the machine it runs on.
   */
  readonly environment?: EnvironmentSource;

  /** Where log entries go. Defaults to standard error. Tests capture it. */
  readonly logDestination?: DestinationStream;

  /**
   * Replaces the wired repository.
   *
   * The composition root decides which implementation the application gets; a test needs to decide
   * differently, and a future `--no-history` flag will want an in-memory store deliberately.
   */
  readonly repository?: ExecutionRepository;
}

export interface Application {
  /** Bound to the `qat` component, so every entry is attributable without being told. */
  readonly logger: LoggerService;

  readonly repository: ExecutionRepository;

  readonly discovery: ProjectDiscovery;

  /**
   * Releases every resource the application holds, in reverse construction order.
   *
   * Safe to call more than once. Shutdown is reached from a signal handler and from a normal exit,
   * and neither can be relied on to be the only path.
   */
  dispose(): Promise<void>;
}
