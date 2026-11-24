/**
 * What validating a configuration reports.
 *
 * ## Why a code per condition
 *
 * A message is prose: it changes when somebody improves the wording, and a script or a support document that matched
 * on it stops matching without anything failing. A code is permanent — quoted in a bug report, grepped in a CI log,
 * and never reused once withdrawn.
 *
 * The prefix is the third in this codebase and each answers a different question: `QAT-D` is what detection found
 * wrong with a project, `QAT-V` is whether that stops an operation, and `QAT-C` is what is wrong with a *configuration
 * file*. A reader seeing one in a terminal knows which of the three they are being told about.
 *
 * ## Why the value never appears
 *
 * A diagnostic names a path and a rule. It never quotes what was in the field, because the field may be
 * `environments.staging.API_TOKEN` and the value may be the reason it is a secret. That is not a hypothetical: the
 * validation library's own message for an enum or a literal echoes the received value, so the message is authored here
 * rather than passed through. See §5 of the validation document.
 */
import type { QatConfig } from "../schema/index.js";

/** Conditions a configuration file can be in. Permanent: a withdrawn code is retired, never reused. */
export const ConfigurationDiagnosticCode = {
  /** The document is not a JSON object at all — an array, a string, a number, or `null`. */
  NotAnObject: "QAT-C001",
  /** The document declares a schema version this build does not read. */
  UnsupportedVersion: "QAT-C002",
  /** A required field is absent. */
  Missing: "QAT-C003",
  /** A field holds the wrong kind of value — a string where an object belongs, a number where a string does. */
  WrongType: "QAT-C004",
  /** A field holds a value outside the set the schema allows. */
  UnsupportedValue: "QAT-C005",
  /**
   * A field holds a value the rules refuse: too long, too short, the wrong shape, a path that escapes the project, a
   * name the language reserves.
   */
  RefusedValue: "QAT-C006",
  /** A key the schema does not declare. */
  UnknownField: "QAT-C007",
} as const;

export type ConfigurationDiagnosticCode =
  (typeof ConfigurationDiagnosticCode)[keyof typeof ConfigurationDiagnosticCode];

/**
 * One thing wrong with a configuration file.
 *
 * Carries no value from the file, by rule rather than by convention — see the header. The path is enough to find the
 * line, and it is not sensitive in the way a value is: a variable *name* has to be named for the diagnostic to be
 * actionable at all.
 */
export interface ConfigurationDiagnostic {
  readonly code: ConfigurationDiagnosticCode;
  /**
   * Dotted path to the field, e.g. `output.reports`.
   *
   * Empty when the condition is about the document rather than a field: a document that is not an object has no path
   * to point at, and an unrecognised top-level key is named in the message instead.
   */
  readonly path: string;
  /** One sentence stating the condition. Authored here, so it contains no configured value. */
  readonly message: string;
  /** What to do about it. Absent where there is nothing honest to suggest. */
  readonly remediation?: string;
}

/**
 * The result of validating one parsed document.
 *
 * A union rather than `{ valid: boolean; config?: … }`, so a caller cannot read a configuration that failed — the same
 * rule the loader applies one layer up, and for the same reason.
 */
export type ConfigurationValidation =
  | { readonly valid: true; readonly config: QatConfig }
  | {
      readonly valid: false;
      readonly diagnostics: readonly ConfigurationDiagnostic[];
    };
