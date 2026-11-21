/**
 * The base class for every expected failure.
 *
 * Two kinds of failure exist, and the difference is worth more than the code that
 * enforces it:
 *
 *   Expected — a condition the program anticipated: no project here, configuration
 *   invalid, dependency missing. It has a code, a category, a recoverability class and
 *   usually a remediation. It is rendered as a sentence a person can act on.
 *
 *   Unexpected — a defect in QAT. It has no meaningful code beyond "internal", no
 *   remediation worth printing, and a stack trace that is noise to the user and an
 *   information leak to everyone else. It is wrapped, its original is preserved as
 *   `cause`, and it is rendered as one generic line.
 *
 * Conflating the two is what produces tools whose error output is a wall of stack for a
 * typo in a config file. Keeping them apart is what produces a line that says what to do.
 *
 * ## Subclass contract
 *
 * Subclasses fix `category`, fix `recoverability`, and narrow `code` to their own union.
 * Narrowing is deliberate: a storage code on a configuration error becomes a compile
 * error rather than a confusing log line.
 *
 * They must not read `this.code` from their own constructor before assigning it. Field
 * initializers and constructor bodies in a subclass run after the base constructor, so
 * anything the base did with `this.code` would see `undefined`. The base therefore uses
 * none of the abstract fields.
 */
import type { ErrorCategory, ErrorCode, Recoverability } from "./codes.js";

/**
 * Diagnostic context attached to an error.
 *
 * Values are primitives on purpose. Allowing objects invites passing a whole response
 * body, a client instance or a parsed configuration tree — which is precisely how
 * credentials and file contents end up in a log line. A caller has to choose, deliberately
 * and visibly, what to record.
 *
 * Keys are unstyled camelCase and appear verbatim in output, so name them for a reader:
 * `specPath`, not `sp`.
 */
export type ErrorContext = Readonly<Record<string, string | number | boolean>>;

export interface ApplicationErrorOptions {
  /**
   * The original error, preserved intact.
   *
   * Never rendered to the user by default. It exists so a logger can serialise it, and so
   * a maintainer reading a report can get at the real failure without the user having to
   * understand it.
   */
  readonly cause?: unknown;

  readonly context?: ErrorContext;

  /**
   * What the reader can do next.
   *
   * Imperative and specific: "Install Cypress with `npm install --save-dev cypress`",
   * not "Cypress is required". Omitted for failures where no action is available — an
   * empty instruction is worse than none, because it reads as one that was forgotten.
   */
  readonly remediation?: string;
}

export abstract class ApplicationError extends Error {
  /** Permanent identifier for the condition. Never reused, never redefined. */
  abstract readonly code: ErrorCode;

  /** Drives the exit code. See `exit-codes.ts` for the mapping. */
  abstract readonly category: ErrorCategory;

  /** Who can fix it. Independent of category, because one category spans several. */
  abstract readonly recoverability: Recoverability;

  readonly context: ErrorContext;
  readonly remediation: string | undefined;

  protected constructor(
    message: string,
    options: ApplicationErrorOptions = {},
  ) {
    // Passing `cause` to super keeps the chain intact for logging. The alternative —
    // storing it as a plain property — breaks `instanceof`-free inspection and every
    // tool that already understands `error.cause`.
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );

    // `new.target.name` rather than a hardcoded string, so a subclass automatically
    // reports its own name. Caveat: a bundler that minifies class names would change it,
    // which is one more reason this package ships unbundled.
    this.name = new.target.name;

    // Copied, so a caller mutating the object it passed cannot retroactively change what
    // this error reports. Frozen for the same reason, one layer further out.
    this.context = Object.freeze({ ...options.context });

    // `exactOptionalPropertyTypes` forbids receiving an explicit `undefined` in an
    // optional property. Reading the option and assigning the result is unambiguous,
    // whereas `this.remediation = options.remediation` on an optional field would not be.
    this.remediation = options.remediation;
  }

  /**
   * Structured form for a logger.
   *
   * Excludes the stack and the cause. The logger decides what to serialise and how to
   * redact it; a cause may hold anything at all, including objects with credentials.
   * Emitting it here would make every caller responsible for the same decision.
   *
   * Optional keys are omitted rather than set to `undefined`, so the output stays small
   * and a JSON consumer does not have to distinguish "absent" from "null".
   */
  toLogObject(): Readonly<Record<string, unknown>> {
    return {
      name: this.name,
      code: this.code,
      category: this.category,
      recoverability: this.recoverability,
      message: this.message,
      ...(this.remediation === undefined
        ? {}
        : { remediation: this.remediation }),
      ...(Object.keys(this.context).length === 0
        ? {}
        : { context: this.context }),
    };
  }
}

/**
 * Narrows an unknown value to an `ApplicationError`.
 *
 * A named function rather than scattered `instanceof` checks, so there is one place to
 * change if detection ever needs to handle a second module instance — which happens when
 * a package is loaded twice, and which `instanceof` does not survive.
 *
 * Note the current limitation honestly: detection is `instanceof`, so two copies of this
 * module in one process would each consider the other's errors foreign. A single-package
 * CLI does not hit that today.
 */
export function isApplicationError(error: unknown): error is ApplicationError {
  return error instanceof ApplicationError;
}
