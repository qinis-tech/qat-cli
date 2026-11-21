/**
 * Process exit codes: the CLI's contract with automation.
 *
 * This file is the single place where a failure becomes a number. Everything else in the
 * error model exists to make that number correct.
 *
 * ## The contract
 *
 *   0   success
 *   1   the tests ran and some failed
 *   2   the command or its inputs were wrong — arguments, project, configuration
 *   3   the environment or infrastructure prevented the run
 *   4   an unexpected internal error
 *   130 the run was interrupted
 *
 * ## Why 1 is reserved
 *
 * `1` means "your code is broken". Nothing else is allowed to mean that. A CI script
 * distinguishes "the change under test is faulty" from "the tool is faulty" solely by this
 * number, because a CI script cannot read a stack trace. Spending `1` on a configuration
 * typo — which is what most CLIs do — destroys the distinction permanently and silently:
 * the build goes red, the developer investigates their own code, and the actual problem is
 * a missing dependency.
 *
 * That is why `exitCodeForError` can never return `TestsFailed`. It is not a policy note;
 * a test asserts it.
 *
 * ## Changing these is a breaking change
 *
 * Renumbering, or assigning a new meaning to an existing value, breaks every pipeline that
 * branches on it. It requires a `BREAKING CHANGE` footer and a documented migration.
 */
import { ApplicationError } from "./application-error.js";
import { ErrorCategory } from "./codes.js";
import { InternalError } from "./errors.js";

export const ExitCode = {
  /** The command completed and everything it ran passed. */
  Success: 0,

  /** The tests executed and at least one failed. Not an error condition. */
  TestsFailed: 1,

  /** The command could not be understood, or its inputs did not make sense. */
  InvalidInput: 2,

  /** The machine could not support the run, or something on it failed. */
  Environment: 3,

  /** A defect in QAT. */
  Internal: 4,

  /**
   * Interrupted by a signal.
   *
   * `128 + SIGINT`, which is the shell convention and what a caller running several
   * commands in sequence already expects to see.
   *
   * Deliberately unreachable from `exitCodeForError`: interruption is a terminal state,
   * not a failure classification. No error category maps to it, because an interruption
   * is not an error the program decided on — it is a signal it did not choose.
   */
  Interrupted: 130,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

/**
 * Category → exit code.
 *
 * A `Record` over the category union rather than a `switch`. The difference matters when
 * a category is added: with a `Record`, the object fails to compile until the new member
 * is mapped, so the omission is impossible. With a `switch` carrying a `default`, the new
 * member would be silently absorbed and every instance of it would exit with whatever the
 * default happened to be.
 *
 * Not exported. Callers ask for the exit code of a specific error; exposing the table
 * invites a caller to consult it directly instead of going through the type guard.
 */
const CATEGORY_EXIT_CODE: Readonly<Record<ErrorCategory, ExitCode>> = {
  [ErrorCategory.UserInput]: ExitCode.InvalidInput,
  [ErrorCategory.Project]: ExitCode.InvalidInput,
  [ErrorCategory.Configuration]: ExitCode.InvalidInput,
  [ErrorCategory.Environment]: ExitCode.Environment,
  [ErrorCategory.Infrastructure]: ExitCode.Environment,
  [ErrorCategory.Execution]: ExitCode.Environment,
  [ErrorCategory.Storage]: ExitCode.Environment,
  [ErrorCategory.Reporting]: ExitCode.Environment,
  [ErrorCategory.Internal]: ExitCode.Internal,
};

/**
 * The exit code for anything that was caught, known or not.
 *
 * Accepts `unknown` rather than `ApplicationError` on purpose. The value that reaches a
 * top-level catch is whatever was thrown, and requiring the caller to narrow first means
 * the one path that most needs to be correct is the one with a type assertion in it.
 *
 * An unrecognised value becomes `Internal` rather than propagating. An uncaught exception
 * must still produce a defined code, or the process exits with whatever Node chooses and
 * the caller reads it as something else entirely.
 */
export function exitCodeForError(error: unknown): ExitCode {
  return error instanceof ApplicationError
    ? CATEGORY_EXIT_CODE[error.category]
    : ExitCode.Internal;
}

/**
 * Normalises anything caught into an application error, preserving the original.
 *
 * Two effects, both wanted: every failure has a code and a category by the time it is
 * logged, and the original is retained as `cause` rather than discarded. "Something went
 * wrong" with no cause is the failure mode this function exists to prevent.
 *
 * Wrapping is not double-wrapping: an existing `ApplicationError` passes through unchanged,
 * so a specific code is never replaced by `internalError`.
 *
 * Note that a non-application error escaping from a layer that should have handled it — a
 * raw schema validation error, say — becomes `Internal` rather than being reclassified.
 * That is correct. If a loader was supposed to validate and return a result, an escaping
 * exception means the loader broke its own contract, and that is a defect in QAT, not a
 * problem with the user's configuration.
 */
export function toApplicationError(error: unknown): ApplicationError {
  return error instanceof ApplicationError
    ? error
    : new InternalError({ cause: error });
}
