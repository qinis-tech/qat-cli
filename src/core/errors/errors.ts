/**
 * One class per condition the CLI must distinguish.
 *
 * Each fixes its `category`, fixes its `recoverability`, and narrows `code` to that
 * category's union. The narrowing is the point: passing a storage code to a configuration
 * error is a compile error rather than a confusing line in a log six months later.
 *
 * Choosing the right class is choosing two things at once — the exit code (via `category`)
 * and whether the reader is told to fix something or to report a bug (via
 * `recoverability`). Both are decisions, and both are easy to get wrong when there is only
 * one generic error type to throw.
 *
 * ## Adding a class
 *
 * Add one only when the condition needs a distinct exit code or a distinct recoverability
 * class. A new class that shares both with an existing one adds a name without adding
 * information, and the list stops being a decision aid.
 */
import {
  ApplicationError,
  type ApplicationErrorOptions,
} from "./application-error.js";
import {
  ErrorCategory,
  ErrorCode,
  Recoverability,
  type ConfigurationCode,
  type EnvironmentCode,
  type ExecutionCode,
  type InfrastructureCode,
  type InternalCode,
  type ProjectCode,
  type ReportingCode,
  type StorageCode,
  type UserInputCode,
} from "./codes.js";

// ─────────────────────────────────────────────────────────────────────────────
// The command was invoked wrongly
// ─────────────────────────────────────────────────────────────────────────────

/**
 * An argument, flag or value the command does not accept.
 *
 * Raise for anything the user typed that cannot be honoured: an unknown flag, a missing
 * required value, a mutually exclusive pair. Never raise it for something the user could
 * not have known — that is a documentation or validation defect on our side.
 */
export class InvalidArgumentError extends ApplicationError {
  readonly code: UserInputCode;
  readonly category = ErrorCategory.UserInput;
  readonly recoverability = Recoverability.UserActionable;

  constructor(
    code: UserInputCode,
    message: string,
    options?: ApplicationErrorOptions,
  ) {
    super(message, options);
    this.code = code;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The project is not something QAT can run
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The directory is not a project QAT can operate on.
 *
 * Covers all three 2xxx conditions: nothing here, no framework detected, or a detected
 * framework at an unsupported version. An unsupported *framework* belongs here rather
 * than with environment errors because it is a property of the project that discovery
 * established, not of the machine.
 */
export class InvalidProjectError extends ApplicationError {
  readonly code: ProjectCode;
  readonly category = ErrorCategory.Project;
  readonly recoverability = Recoverability.UserActionable;

  constructor(
    code: ProjectCode,
    message: string,
    options?: ApplicationErrorOptions,
  ) {
    super(message, options);
    this.code = code;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The configuration is wrong or missing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Configuration could not be read, or did not validate.
 *
 * Almost always raised by the configuration loader. When validation produces several
 * issues, aggregate them into one message rather than raising once per issue: a user
 * fixing six typos wants to see six lines, not six runs.
 */
export class InvalidConfigurationError extends ApplicationError {
  readonly code: ConfigurationCode;
  readonly category = ErrorCategory.Configuration;
  readonly recoverability = Recoverability.UserActionable;

  constructor(
    code: ConfigurationCode,
    message: string,
    options?: ApplicationErrorOptions,
  ) {
    super(message, options);
    this.code = code;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The machine cannot support the run
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A required dependency is absent or not executable.
 *
 * `UserActionable`, not `Fatal`: the fix is one install command, and telling the reader to
 * file a bug instead would waste everyone's time. This is the class that carries the
 * remediation in most real usage.
 */
export class MissingDependencyError extends ApplicationError {
  readonly code: EnvironmentCode;
  readonly category = ErrorCategory.Environment;
  readonly recoverability = Recoverability.UserActionable;

  constructor(
    code: EnvironmentCode,
    message: string,
    options?: ApplicationErrorOptions,
  ) {
    super(message, options);
    this.code = code;
  }
}

/**
 * The runtime or platform is not supported at all.
 *
 * `Fatal`, not `UserActionable`, and that difference is the whole reason this is a
 * separate class from `MissingDependencyError`. A missing package can be installed; a
 * Node.js major version below the declared floor, or an architecture with no build
 * available, cannot be fixed by the person reading the message.
 */
export class UnsupportedEnvironmentError extends ApplicationError {
  readonly code: EnvironmentCode;
  readonly category = ErrorCategory.Environment;
  readonly recoverability = Recoverability.Fatal;

  constructor(
    code: EnvironmentCode,
    message: string,
    options?: ApplicationErrorOptions,
  ) {
    super(message, options);
    this.code = code;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Something on the machine failed during the run
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A filesystem operation failed: permission, missing path, no space.
 *
 * `Retryable`, because these are frequently transient or environmental — a locked file, a
 * full disk that is about to be cleaned, a network mount that has not yet settled.
 * `EACCES` on a path the user owns is a configuration problem, but the filesystem is not
 * in a position to know that, so retry is the honest classification.
 */
export class FilesystemError extends ApplicationError {
  readonly code: InfrastructureCode;
  readonly category = ErrorCategory.Infrastructure;
  readonly recoverability = Recoverability.Retryable;

  constructor(
    code: InfrastructureCode,
    message: string,
    options?: ApplicationErrorOptions,
  ) {
    super(message, options);
    this.code = code;
  }
}

/**
 * A child process could not be started, or exited in a way we could not interpret.
 *
 * Not for a non-zero exit that we *did* interpret — a framework reporting failing tests
 * is a result, not an error. This class is for the case where the process never produced
 * anything usable.
 */
export class ProcessExecutionError extends ApplicationError {
  readonly code: InfrastructureCode;
  readonly category = ErrorCategory.Infrastructure;
  readonly recoverability = Recoverability.Retryable;

  constructor(
    code: InfrastructureCode,
    message: string,
    options?: ApplicationErrorOptions,
  ) {
    super(message, options);
    this.code = code;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The framework itself failed
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The framework could not run at all.
 *
 * The single most important distinction in this file, and the one most likely to be
 * eroded by accident. A failed assertion is **not** this error: the tests ran, the test
 * failed, the run is complete, and the exit code is 1. This class means the run never
 * started — a crashed binary, an unreadable config the framework rejected, a browser that
 * would not launch. The exit code is 3, and a CI reader must be able to tell those apart
 * without reading English.
 */
export class FrameworkExecutionError extends ApplicationError {
  readonly code: ExecutionCode;
  readonly category = ErrorCategory.Execution;
  readonly recoverability = Recoverability.Retryable;

  constructor(
    code: ExecutionCode,
    message: string,
    options?: ApplicationErrorOptions,
  ) {
    super(message, options);
    this.code = code;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Persistence and reporting
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Persisting or reading execution records failed.
 *
 * Note what this is not for: failing to find a record is `undefined`, not an error.
 * Reserving this class for genuine failures keeps "no previous run" from looking like
 * breakage.
 */
export class StorageError extends ApplicationError {
  readonly code: StorageCode;
  readonly category = ErrorCategory.Storage;
  readonly recoverability = Recoverability.Retryable;

  constructor(
    code: StorageCode,
    message: string,
    options?: ApplicationErrorOptions,
  ) {
    super(message, options);
    this.code = code;
  }
}

/**
 * A report could not be generated or written.
 *
 * Worth keeping distinct from `FilesystemError` even though the immediate cause is often
 * the same: a reporting failure happens *after* a run has already produced a valid result,
 * and the user needs to know the result still exists.
 */
export class ReportGenerationError extends ApplicationError {
  readonly code: ReportingCode;
  readonly category = ErrorCategory.Reporting;
  readonly recoverability = Recoverability.Retryable;

  constructor(
    code: ReportingCode,
    message: string,
    options?: ApplicationErrorOptions,
  ) {
    super(message, options);
    this.code = code;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Unexpected
// ─────────────────────────────────────────────────────────────────────────────

/**
 * An unexpected failure. A defect in QAT, not in the user's project.
 *
 * Never constructed with a message from user input, and never constructed deliberately to
 * report a known condition — if a condition is known, it has a class above. This exists
 * only to wrap whatever was caught, preserving the original as `cause` so the detail is
 * available to a logger and unavailable to a terminal by default.
 *
 * The message is fixed rather than parameterised. A caller that could supply one would
 * eventually use it to smuggle detail back into the terminal, which is exactly what the
 * wrapping exists to prevent.
 */
export class InternalError extends ApplicationError {
  readonly code: InternalCode = ErrorCode.internalError;
  readonly category = ErrorCategory.Internal;
  readonly recoverability = Recoverability.Fatal;

  constructor(options?: ApplicationErrorOptions) {
    super("An unexpected internal error occurred.", options);
  }
}
