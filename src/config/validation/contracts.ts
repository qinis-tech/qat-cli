/**
 * What validating a configuration reports.
 *
 * ## Why a code per condition
 *
 * A message is prose: it changes when somebody improves the wording, and a script or a support document that matched
 * on it stops matching without anything failing. A code is permanent — quoted in a bug report, grepped in a CI log,
 * and never reused once withdrawn.
 *
 * One of four prefixes in this codebase, each answering a different question: `QAT-D` is what detection found wrong
 * with a project, `QAT-V` is whether that stops an operation, `QAT-C` is what is wrong with a *configuration
 * document*, and `QAT-H` is what is wrong with the machine or the run. A reader seeing one in a terminal knows which
 * layer is speaking.
 *
 * ## Where the codes are declared, and why not here
 *
 * `ConfigurationDiagnosticCode` lives in `core/application/configuration.ts`. The identifiers are vocabulary: a layer
 * above this one has to name them — the doctor reports a configuration condition alongside conditions it found
 * itself — and a contract is what a layer above may depend on. Importing an implementation path to reach a permanent
 * identifier would make the application layer depend on how this module is built.
 *
 * Only the identifiers moved. The rules and every sentence behind them stay here and in `./guidance.ts`, because only
 * prose is this layer's business. Nothing in this file re-exports the code set: a second route to one name is the
 * route that goes stale.
 *
 * ## Why the value never appears
 *
 * A diagnostic names a path and a rule. It never quotes what was in the field, because the field may be
 * `environments.staging.API_TOKEN` and the value may be the reason it is a secret. That is not a hypothetical: the
 * validation library's own message for an enum or a literal echoes the received value, so the message is authored here
 * rather than passed through. See §5 of the validation document.
 */
import type { ConfigurationDiagnosticCode } from "../../core/application/configuration.js";
import type { QatConfig } from "../schema/index.js";

/**
 * One thing wrong with a configuration file.
 *
 * Carries no value from the file, by rule rather than by convention — see the header. The path is enough to find the
 * line, and it is not sensitive in the way a value is: a variable *name* has to be named for the diagnostic to be
 * actionable at all.
 *
 * `remediation` rather than `remedy`, which is the field name every other finding in the project uses and the one a
 * renderer should read. `ConfigurationFinding.remedy` is a duplicate of this idea that survives in the resolution
 * vocabulary; it should be retired rather than taught to a third consumer.
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
