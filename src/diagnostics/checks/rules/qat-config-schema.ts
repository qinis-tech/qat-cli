/**
 * CFG-002 — "QAT configuration schema valid".
 *
 * Scope
 * ─────
 * One question: when a configuration document exists, is it one this release can
 * interpret — and if not, which field is the reason?
 *
 * Only two states are this check's business:
 *
 *   version-unsupported   we cannot read a document of that version at all
 *   schema-invalid        we read it and the schema rejected specific fields
 *
 * Everything else is somebody else's sentence. `missing` is a supported state
 * (defaults apply). `inaccessible` and `malformed` are CFG-001's answers, and
 * this check is *skipped* for them — by the runner, from `precondition`, not by
 * a verdict returned here.
 *
 * ## Why the skip lives on `precondition`
 *
 * `CheckVerdict` has no `skip`. A check that could return one would be able to
 * excuse itself, and "not run" would become indistinguishable from "chose not to
 * run". Declaring `precondition: CheckId.QatConfigurationLoadable` states the
 * dependency once, where the catalogue can see it, and the runner emits the skip
 * with a named cause — "configuration not readable" — which is the only
 * actionable thing about a skipped row.
 *
 * The consequence is the two `throw`s at the bottom of the switch: if this
 * function is ever called with an unreadable configuration, the catalogue and the
 * runner disagree. That is a defect in this layer rather than a condition of a
 * project, and the house precedent for it is `present()` — fail loudly, because
 * reporting it would put a programmer's mistake in a user's terminal and passing
 * would let the check claim something it never examined.
 *
 * ## Why the code is chosen here and the prose is not
 *
 * Four of the five codes this check can produce come from *one* state, and which
 * one applies depends on which field the schema objected to — a decision the
 * configuration module already makes (`primaryReasonForIssues`), because it owns
 * the list of path-bearing sections. Re-deriving that here would be a second
 * answer to "which field matters most", and the two would diverge the first time
 * the schema grew a section.
 *
 * This layer contributes the mapping from reason to `HealthCode` and nothing about
 * what "unsupported" means. The prose is `guidance.ts`'s, keyed by the code.
 */
import {
  primaryReasonForIssues,
  type QatConfigReason,
} from "../../../config/diagnostics/index.js";
import {
  CheckCategory,
  CheckId,
  CheckSeverity,
  HealthCode,
} from "../../../core/application/checks.js";
import {
  FactGroup,
  PASS,
  present,
  type CheckDefinition,
  type CheckFacts,
  type CheckVerdict,
} from "../contracts.js";
import { healthFinding } from "../guidance.js";

/**
 * The four field-specific reasons, mapped to the code that phrases them.
 *
 * `Partial` rather than total on purpose: a reason that is not listed is a schema
 * failure of the general kind, and treating it as such is correct rather than a
 * default. A total record would force an entry for reasons this state cannot
 * produce — `QAT_CONFIG_MISSING`, for one — and those entries would be unreachable
 * lines asserting an impossible transition.
 */
const FIELD_FAILURE_CODES = {
  QAT_CONFIG_VERSION_INVALID: HealthCode.ConfigurationVersionInvalid,
  QAT_CONFIG_OUTPUT_PATH_INVALID: HealthCode.ConfigurationOutputPathInvalid,
  QAT_CONFIG_FRAMEWORK_UNSUPPORTED:
    HealthCode.ConfigurationFrameworkUnsupported,
  QAT_CONFIG_SCHEMA_INVALID: HealthCode.ConfigurationSchemaInvalid,
} as const satisfies Partial<Record<QatConfigReason, HealthCode>>;

/**
 * The validity half of QAT's configuration pair.
 *
 * `error` severity, because every answer this check gives is a blocking one: a
 * document we cannot interpret, or one whose fields the schema rejected. It never
 * warns, and it never passes on anything it did not examine.
 */
export const qatConfigSchemaCheck: CheckDefinition = {
  id: CheckId.QatConfigurationValid,
  category: CheckCategory.QatConfiguration,
  title: "QAT configuration schema valid",
  purpose:
    "A configuration file QAT cannot interpret is worse than none at all, and a reader needs the field that was rejected rather than a general 'invalid'.",
  procedure:
    "Reads the composed configuration verdict and reports an unsupported schema version, or the field the schema rejected.",
  // The same single group as its sibling: one verdict, read by both checks. Two
  // groups here would mean two reads, and two reads of one file can disagree.
  requires: [FactGroup.Configuration],
  // The dependency that produces the skip, declared where the catalogue can see
  // it. Nothing can be validated until something has been read.
  precondition: CheckId.QatConfigurationLoadable,
  severity: CheckSeverity.Error,
  scenarios: [
    "qat.configuration-valid.valid",
    "qat.configuration-valid.absent-nothing-to-validate",
    "qat.configuration-valid.version-unsupported",
    "qat.configuration-valid.version-invalid",
    "qat.configuration-valid.field-rejected",
    "qat.configuration-valid.output-path-rejected",
    "qat.configuration-valid.framework-rejected",
    "qat.configuration-valid.skipped-when-unreadable",
  ],

  evaluate: (facts) => {
    const inspection = present(facts.configuration);

    switch (inspection.state) {
      /** Read and accepted. */
      case "valid":
        return PASS;

      /**
       * No document, so nothing is invalid.
       *
       * A pass rather than a skip: the precondition is satisfied — CFG-001 found
       * nothing to read and said so — and there is genuinely nothing wrong here.
       * Whether a *command* may proceed without a configuration is that
       * command's preflight, not this check's opinion.
       */
      case "missing":
        return PASS;

      /**
       * A version we are not allowed to interpret.
       *
       * Reported alone, with no field complaints. There is nothing meaningful to
       * say about fields in a document whose version we do not understand, and a
       * wall of schema errors would bury the one fact the reader can act on.
       */
      case "version-unsupported":
        return fail(HealthCode.ConfigurationVersionUnsupported, facts);

      /** Read, and rejected field by field. */
      case "schema-invalid": {
        const reason = primaryReasonForIssues(inspection.issues);
        const code =
          FIELD_FAILURE_CODES[reason as keyof typeof FIELD_FAILURE_CODES];

        // Any reason outside the four field-specific ones is the general report:
        // the schema objected, and no single field is the headline.
        return fail(code ?? HealthCode.ConfigurationSchemaInvalid, facts);
      }

      /**
       * Unreachable through the catalogue: `precondition` guarantees CFG-001
       * established a document, and these two states mean it did not.
       *
       * Reaching them is a defect in this layer, not a condition of a project, so
       * they are loud. Reporting them as findings would put a programmer's mistake
       * into a user's terminal; passing would let this check claim a verdict about
       * bytes nobody parsed.
       */
      case "inaccessible":
      case "malformed":
        throw new Error(
          `qat.configuration-valid was evaluated with an unreadable configuration (${inspection.state}). Its precondition should have skipped it.`,
        );
    }
  },
};

/**
 * Renders one failure verdict.
 *
 * Severity is not a parameter: it comes from the guidance table, keyed by the
 * code, so a check cannot report the same condition at two weights.
 */
function fail(code: HealthCode, facts: CheckFacts): CheckVerdict {
  return { verdict: "fail", finding: healthFinding(code, facts) };
}
