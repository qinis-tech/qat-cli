/**
 * ENV-001 — required environment variables present.
 *
 * Checks whether the variables declared by the selected profile are usable, without ever reading their
 * values.
 *
 * The environment classifier owns classification, reason and severity. This rule translates its
 * diagnostics into doctor verdicts.
 *
 * ## The boundary is checked by the compiler, not by a cast
 *
 * The previous version cast the classifier through `unknown` to a hand-written signature. That made the
 * type error disappear and took the guarantees with it: `readonly EnvironmentDiagnostic[]` is not a
 * mutable array, and a cast that says otherwise is a promise the producer does not make. Calling the
 * function directly gives the real type — which is also a superset of the local contract, so it is
 * assignable where the rule needs it, with no seam.
 *
 * What protects the local contract is `asEnvironmentDiagnostic` below: an identity function whose
 * parameter is the classifier's own output type. It compiles only while the producer's union remains
 * assignable to the local mirror, so a new reason or status fails the build here rather than reaching a
 * reader as an unhandled condition.
 */

import { classifyEnvironment } from "../../../config/environment/index.js";
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

// ─── Diagnostic contract ─────────────────────────────────────────────────────

/**
 * The classifier's output, mirrored locally.
 *
 * Only the members this rule reads — the full diagnostic also carries the profile, the selection origin
 * and a detail map, and none of those reach a verdict here.
 */
type EnvironmentDiagnosticStatus =
  "fail" | "indeterminate" | "pass" | "skipped";

/**
 * Three weights, not two.
 *
 * The omission of `"information"` was the bug that made every healthy project crash: the classifier uses
 * it for the pass and the skip, and a predicate that rejected it turned "nothing to report" into a
 * reported disagreement.
 */
type EnvironmentDiagnosticSeverity = "error" | "warning" | "information";

type EnvironmentReason =
  | "ENV_VARIABLE_MISSING"
  | "ENV_VARIABLE_BLANK"
  | "ENV_REFERENCE_SOURCE_NOT_APPROVED"
  | "ENV_REFERENCE_NAME_INVALID"
  | "ENV_VARIABLE_UNVERIFIABLE"
  | "ENV_NO_SELECTION"
  | "ENV_SELECTION_INVALID"
  | "ENV_PROFILE_NOT_FOUND"
  | "ENV_REFERENCE_DANGLING"
  | "ENV_PROFILE_INVALID"
  | "ENV_SETTING_MISSING"
  | "ENV_PATH_INVALID";

interface EnvironmentDiagnostic {
  readonly id: string;
  readonly reason: EnvironmentReason | null;
  readonly status: EnvironmentDiagnosticStatus;
  readonly severity: EnvironmentDiagnosticSeverity;
}

/**
 * Compile-time probe: the local mirror must still describe the classifier's output.
 *
 * An identity function, so it costs nothing at runtime. Its parameter is
 * `ReturnType<typeof classifyEnvironment>[number]`, so if the classifier ever gains a reason or a status
 * the mirror lacks, this assignment stops compiling — in the file that would have to handle it, which is
 * the only place the failure is cheap.
 */
function asEnvironmentDiagnostic(
  diagnostic: ReturnType<typeof classifyEnvironment>[number],
): EnvironmentDiagnostic {
  return diagnostic;
}

// ─── Catalogue identity ──────────────────────────────────────────────────────

const ENVIRONMENT_VARIABLES_ID = "ENV-001";

// ─── Rule ────────────────────────────────────────────────────────────────────

export const environmentVariablesCheck: CheckDefinition = {
  id: CheckId.EnvironmentVariablesPresent,
  category: CheckCategory.EnvironmentProfiles,

  title: "Required environment variables present",

  purpose:
    "A profile that references a variable the host does not provide fails at the first request that needs it, long after the run started — and the doctor can say which name is absent before anything launches.",

  procedure:
    "Compares each variable the selected profile declares with the host's report of whether it is set, blank or absent, and reports the worst condition found.",

  requires: [FactGroup.Environment],

  precondition: CheckId.EnvironmentResolvable,

  severity: CheckSeverity.Error,

  scenarios: [
    "qat.environment-variables-present.all-present",
    "qat.environment-variables-present.none-declared",
    "qat.environment-variables-present.required-missing",
    "qat.environment-variables-present.unspecified-missing",
    "qat.environment-variables-present.blank-required",
    "qat.environment-variables-present.source-unapproved",
    "qat.environment-variables-present.name-unusable",
    "qat.environment-variables-present.unverified",
  ],

  evaluate(facts: CheckFacts): CheckVerdict {
    const group = present(facts.environment);

    // No annotation and no cast: the inferred type is the producer's own, and it is assignable wherever
    // this rule needs it. Declaring the signature here is what produced the readonly mismatch.
    const diagnostics = classifyEnvironment(group.inspection, {
      required: group.requiredForOperation,
    });

    // Lookup on the identifier and nothing else. A diagnostic whose `reason` is null is a *result* — the
    // classifier saying it examined the references and found nothing to report — not a missing entry.
    const verdict = diagnostics.find(
      (diagnostic) => diagnostic.id === ENVIRONMENT_VARIABLES_ID,
    );

    if (verdict === undefined) {
      // A genuinely absent entry: the classifier and this catalogue disagree about the identifier. Note
      // what it is not: an entry that reports nothing.
      throw new Error(
        "The environment classifier produced no ENV-001 entry. The classifier and this catalogue disagree.",
      );
    }

    return toVerdict(asEnvironmentDiagnostic(verdict), facts);
  },
};

// ─── Verdict adaptation ──────────────────────────────────────────────────────

/**
 * One diagnostic, as a verdict.
 *
 * Two rules, and they are different rules:
 *
 *  • **A failure at error weight blocks; everything else is reported.** Weight is a property of the code,
 *    decided by the classifier from the profile's declaration, so this function does not re-derive it.
 *  • **`indeterminate` never blocks, whatever weight it carries.** "I could not establish this" must not
 *    refuse work we can still perform — the previous version mapped an error-weight indeterminate to
 *    `fail`, which would have blocked a run on the strength of an unanswered question.
 */
function toVerdict(
  diagnostic: EnvironmentDiagnostic,
  facts: CheckFacts,
): CheckVerdict {
  const { reason, status, severity } = diagnostic;

  // Silence: every declared variable is present, or the profile declares none, or the profile could not
  // be judged and the runner owns that skip through `precondition`.
  if (reason === null) return PASS;

  if (status === "pass" || status === "skipped") return PASS;

  const finding = healthFinding(toCode(reason, severity), facts);

  return status === "fail" && severity === "error"
    ? { verdict: "fail", finding }
    : { verdict: "warn", finding };
}

// ─── Health-code mapping ─────────────────────────────────────────────────────

function toCode(
  reason: EnvironmentReason,
  severity: EnvironmentDiagnosticSeverity,
): HealthCode {
  switch (reason) {
    case "ENV_VARIABLE_MISSING":
      return severity === "error"
        ? HealthCode.EnvironmentVariableMissing
        : HealthCode.EnvironmentVariableMissingUnconfirmed;

    case "ENV_VARIABLE_BLANK":
      return severity === "error"
        ? HealthCode.EnvironmentVariableBlank
        : HealthCode.EnvironmentVariableBlankUnconfirmed;

    case "ENV_REFERENCE_SOURCE_NOT_APPROVED":
      return HealthCode.EnvironmentVariableSourceUnapproved;

    case "ENV_REFERENCE_NAME_INVALID":
      return HealthCode.EnvironmentVariableNameInvalid;

    case "ENV_VARIABLE_UNVERIFIABLE":
      return HealthCode.EnvironmentVariableUnverifiable;

    // Profile-level reasons belong to ENV-002. Reaching one here means the classifier attributed a
    // condition to the wrong check, which is a defect worth failing on rather than rendering under a code
    // whose guidance describes a different problem.
    case "ENV_NO_SELECTION":
    case "ENV_SELECTION_INVALID":
    case "ENV_PROFILE_NOT_FOUND":
    case "ENV_REFERENCE_DANGLING":
    case "ENV_PROFILE_INVALID":
    case "ENV_SETTING_MISSING":
    case "ENV_PATH_INVALID":
      throw new Error(
        `The environment classifier attributed ${reason} to ENV-001. Profile-level conditions belong to ENV-002.`,
      );

    default:
      return assertNever(reason);
  }
}

// ─── Exhaustiveness ──────────────────────────────────────────────────────────

function assertNever(value: never): never {
  const message = `Unhandled environment diagnostic: ${JSON.stringify(value)}`;
  throw new Error(message);
}
