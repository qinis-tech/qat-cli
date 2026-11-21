/**
 * Error codes, categories and recoverability classes.
 *
 * The failure vocabulary for the whole application. Nothing here is framework-specific, nothing
 * here imports anything, and nothing here is a message — codes identify conditions, callers supply
 * the sentence.
 *
 * ## Why codes are strings and not enum members
 *
 * A code crosses the process boundary: it appears in a terminal, in a log line, in a JSON result
 * and in a bug report pasted by a user. It has to be stable and readable outside the program, so it
 * is a plain string with a fixed value rather than a compiled enum member whose value is an
 * integer.
 *
 * ## Why codes are permanent
 *
 * A code's meaning never changes, and a withdrawn condition leaves its code unused. This mirrors
 * HTTP status codes: the value is a promise to whatever reads it, so stability matters more than
 * tidiness. A user who searched for `QAT3002` last year must find the same explanation this year.
 *
 * ## Ranges
 *
 * The thousands digit is the category, so a code identifies itself in a log without a lookup:
 *
 *   1xxx  how the command was invoked
 *   2xxx  the project
 *   3xxx  the configuration
 *   4xxx  the environment
 *   5xxx  infrastructure — filesystem and child processes
 *   6xxx  execution — the framework could not run
 *   7xxx  storage
 *   8xxx  reporting
 *   9xxx  internal, unexpected
 *
 * The final three digits are sequential within a range and carry no meaning.
 *
 * ## Adding a code
 *
 * 1. Append to the end of the relevant range. Do not renumber or reuse.
 * 2. Add the value type to that category's union at the bottom of this file.
 * 3. Assign it in `errors.ts` by narrowing the class's constructor parameter type.
 *
 * Step 2 is what makes a mismatched category and code a compile error rather than a runtime
 * surprise in a log.
 */

/**
 * Every condition the CLI must distinguish.
 *
 * Keys are camelCase for ergonomic reference in code; values are the permanent identifiers. Do
 * not derive one from the other — the key may be renamed for clarity, the value never changes.
 */
export const ErrorCode = {
  // ── 1xxx — how the command was invoked ─────────────────────────────────────
  /** An argument, flag or value the command does not accept. */
  invalidArgument: "QAT1001",
  /** A command name that does not exist. */
  unsupportedCommand: "QAT1002",

  // ── 2xxx — the project ─────────────────────────────────────────────────────
  /** No project found at the given path. */
  projectNotFound: "QAT2001",
  /** A project exists, but no supported test framework was detected. */
  frameworkNotDetected: "QAT2002",
  /** A framework was detected at a version QAT does not support. */
  frameworkUnsupported: "QAT2003",
  /** More than one framework configuration exists, so the intended one is unknowable. */
  projectAmbiguous: "QAT2004",

  // ── 3xxx — the configuration ───────────────────────────────────────────────
  /** A configuration file was referenced but does not exist. */
  configurationNotFound: "QAT3001",
  /** A configuration file exists but failed validation. */
  configurationInvalid: "QAT3002",

  // ── 4xxx — the environment ─────────────────────────────────────────────────
  /** The runtime, platform or architecture is not supported. */
  runtimeUnsupported: "QAT4001",
  /** A required dependency is absent or not executable. */
  dependencyMissing: "QAT4002",

  // ── 5xxx — infrastructure ──────────────────────────────────────────────────
  // Two concerns share this range because both describe "something on the machine went
  // wrong". They are grouped rather than interleaved so a reader scanning for filesystem
  // behaviour does not have to filter past process behaviour.

  // Filesystem (5001–5005)
  /** A filesystem operation failed: permission, path, space. */
  filesystemFailure: "QAT5001",
  /** A path is malformed, or resolves outside the directory it was supposed to stay within. */
  filesystemPathInvalid: "QAT5003",
  /** A file was expected to contain JSON and does not. */
  filesystemInvalidJson: "QAT5004",
  /** A file could not be accessed because another process holds it. */
  filesystemLocked: "QAT5005",

  // Child processes (5002, 5006–5008)
  /** A child process could not be started, or exited in an unexpected way. */
  processFailure: "QAT5002",
  /** The executable does not exist, or is not on the path. */
  processExecutableNotFound: "QAT5006",
  /** The process did not finish within the configured limit and was terminated. */
  processTimedOut: "QAT5007",
  /** The process was cancelled by the caller. */
  processCancelled: "QAT5008",

  // ── 6xxx — execution ───────────────────────────────────────────────────────
  /**
   * The framework could not run at all.
   *
   * Not a failing test. A failing test is a completed run with exit code 1; this means the run
   * never started.
   */
  frameworkExecutionFailed: "QAT6001",

  // ── 7xxx — storage ─────────────────────────────────────────────────────────
  /** Persisting or reading execution records failed. */
  storageFailure: "QAT7001",

  // ── 8xxx — reporting ───────────────────────────────────────────────────────
  /** Generating or writing a report failed. */
  reportGenerationFailed: "QAT8001",

  // ── 9xxx — internal ────────────────────────────────────────────────────────
  /** An unexpected failure. Always wrapped, never invented deliberately. */
  internalError: "QAT9001",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * Why it happened, in terms a caller can act on.
 *
 * Categories exist to answer one question: which exit code does this produce? They are also what
 * makes a message groupable — "all the configuration failures this week" is a query a category
 * answers and an error code does not.
 *
 * Deliberately not aligned one-to-one with error codes: several codes share a category, and one
 * code range may serve two classes of error.
 */
export const ErrorCategory = {
  /** The command was invoked wrongly. */
  UserInput: "user-input",
  /** The project is not something QAT can run. */
  Project: "project",
  /** The configuration is wrong or missing. */
  Configuration: "configuration",
  /** The machine cannot support the run. */
  Environment: "environment",
  /** Something on the machine failed during the run. */
  Infrastructure: "infrastructure",
  /** The framework itself failed. */
  Execution: "execution",
  /** Persistence failed. */
  Storage: "storage",
  /** Report generation failed. */
  Reporting: "reporting",
  /** An unexpected failure. */
  Internal: "internal",
} as const;

export type ErrorCategory = (typeof ErrorCategory)[keyof typeof ErrorCategory];

/**
 * Who can fix it.
 *
 * Kept independent of category because one category spans several answers. A missing dependency
 * and an unsupported runtime are both `Environment`, but the first is fixed by the person running
 * the command and the second is not.
 *
 * This is what turns an error message from a description into a next action: a `UserActionable`
 * failure gets a remediation line, a `Fatal` one gets a request to report a defect.
 */
export const Recoverability = {
  /** The person running the command can fix it, by changing something. */
  UserActionable: "user-actionable",
  /** Possibly transient. Running again may work. */
  Retryable: "retryable",
  /** Needs a maintainer. Retrying wastes time. */
  Fatal: "fatal",
} as const;

export type Recoverability =
  (typeof Recoverability)[keyof typeof Recoverability];

// ─────────────────────────────────────────────────────────────────────────────
// Per-category code unions
//
// Each specialised error class accepts only its own union, so pairing a storage code with a
// configuration error is a compile error rather than a confusing log line.
// ─────────────────────────────────────────────────────────────────────────────

export type UserInputCode =
  typeof ErrorCode.invalidArgument | typeof ErrorCode.unsupportedCommand;

export type ProjectCode =
  | typeof ErrorCode.projectNotFound
  | typeof ErrorCode.frameworkNotDetected
  | typeof ErrorCode.frameworkUnsupported
  | typeof ErrorCode.projectAmbiguous;

export type ConfigurationCode =
  | typeof ErrorCode.configurationNotFound
  | typeof ErrorCode.configurationInvalid;

export type EnvironmentCode =
  typeof ErrorCode.runtimeUnsupported | typeof ErrorCode.dependencyMissing;

export type InfrastructureCode =
  | typeof ErrorCode.filesystemFailure
  | typeof ErrorCode.filesystemPathInvalid
  | typeof ErrorCode.filesystemInvalidJson
  | typeof ErrorCode.filesystemLocked
  | typeof ErrorCode.processFailure
  | typeof ErrorCode.processExecutableNotFound
  | typeof ErrorCode.processTimedOut
  | typeof ErrorCode.processCancelled;

export type ExecutionCode = typeof ErrorCode.frameworkExecutionFailed;

export type StorageCode = typeof ErrorCode.storageFailure;

export type ReportingCode = typeof ErrorCode.reportGenerationFailed;

export type InternalCode = typeof ErrorCode.internalError;
