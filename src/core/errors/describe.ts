/**
 * Turning an error into something safe to show a person.
 *
 * The default output is deliberately austere: a code, one sentence, optional remediation,
 * and the diagnostic context the raiser chose to attach. No stack, no cause, no framework
 * internals.
 *
 * That austerity is the feature. A stack trace in default output is noise to the person
 * running the command and an information leak to everyone else — it discloses absolute
 * paths, usernames, dependency versions and, on a bad day, fragments of configuration. A
 * stack is genuinely useful exactly once: when a maintainer is debugging, and then it is
 * worth asking for explicitly rather than printing for everyone.
 *
 * This module is pure and cheap. Safe to call from a top-level catch, from a logger, from
 * a test.
 */
import type { ApplicationError } from "./application-error.js";
import { ErrorCode } from "./codes.js";
import { toApplicationError } from "./exit-codes.js";

/**
 * Developer detail, present only when explicitly requested.
 *
 * Contains the original error, which may hold anything: paths, hostnames, request bodies.
 * It exists so `--debug` can show it locally. It must never be enabled implicitly, and must
 * never be included automatically in a bug report — a user pasting debug output is pasting
 * their filesystem.
 */
export interface RenderedErrorDiagnostics {
  /** Class name of the error that was rendered. */
  readonly name: string;
  /** Stack of the original error, when one was caught. */
  readonly stack: string | undefined;
  /** `name: message` of the underlying cause, when there is one. */
  readonly cause: string | undefined;
}

export interface RenderedError {
  /** Permanent error code, e.g. `QAT3002`. The one thing safe to copy into a report. */
  readonly code: string;
  /** One actionable sentence. Never a stack, never a JSON blob. */
  readonly message: string;
  /**
   * What to do next.
   *
   * Optional, and absent rather than empty when there is no action — an empty instruction
   * reads as one that was forgotten, which is worse than none.
   */
  readonly remediation?: string;
  /** Chosen diagnostic context, rendered as `key: value` and sorted. */
  readonly details: readonly string[];
  /** Developer detail, only when requested. */
  readonly diagnostics?: RenderedErrorDiagnostics;
}

export interface DescribeErrorOptions {
  /**
   * Include developer diagnostics.
   *
   * Wire this to a `--debug` flag and nothing else. There is no configuration key for it: a
   * setting that silently switched it on for everyone would defeat the reason it is off.
   */
  readonly includeDiagnostics?: boolean;
}

/**
 * Stable guidance for the one class of failure the user cannot act on.
 *
 * Written as a single line on purpose. Splitting it across concatenated literals puts a
 * significant space at the end of a source line, and that space is invisible: it survives
 * review, then disappears in a reformat, and the joined message reads "your project.Report
 * it". One literal cannot be broken that way.
 *
 * Referenced rather than duplicated so a change of wording happens in one place. A tool
 * whose every bug message says something slightly different is a tool whose users report
 * bugs to the wrong place.
 */
export const INTERNAL_ERROR_HINT = `This is a defect in QAT, not in your project. Report it at the project issue tracker, quoting the code ${ErrorCode.internalError} and the command you ran.`;

/**
 * Renders a value for a human — including values that are not errors at all.
 *
 * Accepts `unknown` because the top-level catch receives whatever was thrown, and the one
 * path that most needs to be correct should not require the caller to narrow first.
 *
 * Recognised failures render as themselves. Everything else becomes an internal error with
 * a generic sentence, so an unanticipated exception cannot invent user-facing text.
 */
export function describeError(
  error: unknown,
  options: DescribeErrorOptions = {},
): RenderedError {
  const applicationError = toApplicationError(error);

  // Resolved once, into a const. Calling it again inside the spread would produce a
  // second invocation whose type is `string | undefined`, and `exactOptionalPropertyTypes`
  // rejects assigning that to an optional property — the narrowing from the first call
  // does not carry across to the second.
  const remediation = resolveRemediation(applicationError);

  return {
    code: applicationError.code,
    message: applicationError.message,
    // Sorted so output is stable regardless of how the context object was built. That
    // makes it diffable and makes a test assertion on it meaningful.
    details: Object.entries(applicationError.context)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}: ${String(value)}`),
    ...(remediation === undefined ? {} : { remediation }),
    ...(options.includeDiagnostics === true
      ? { diagnostics: buildDiagnostics(applicationError, error) }
      : {}),
  };
}

/**
 * A remediation, falling back to the internal-error guidance.
 *
 * Guarantees that an internal error always tells the reader what to do with it. Without the
 * fallback, the one failure the user genuinely cannot fix is the one that leaves them with
 * no next step — which is how "QAT is broken" turns into a support message that says only
 * "it didn't work".
 */
function resolveRemediation(error: ApplicationError): string | undefined {
  if (error.remediation !== undefined) return error.remediation;

  return error.code === ErrorCode.internalError
    ? INTERNAL_ERROR_HINT
    : undefined;
}

/**
 * Extracts developer detail from the original thrown value.
 *
 * Prefers the wrapped cause over the wrapper, because the wrapper is always `InternalError`
 * and its stack points at the wrapping site rather than at the defect.
 *
 * `cause` is compared against `undefined` explicitly rather than using `??`, so a cause that
 * is deliberately `null` is treated as a real value instead of being skipped.
 */
function buildDiagnostics(
  applicationError: ApplicationError,
  thrown: unknown,
): RenderedErrorDiagnostics {
  const original: unknown =
    applicationError.cause === undefined ? thrown : applicationError.cause;
  const source = original instanceof Error ? original : undefined;

  return {
    name: applicationError.name,
    stack: source?.stack,
    cause:
      source === undefined
        ? String(original)
        : `${source.name}: ${source.message}`,
  };
}
