/**
 * ENV-002 — environment profile validity.
 *
 * A deliberately thin adapter, and thin is the point: the judgement already lives in
 * `src/config/environment`, which is pure, framework-free and consumed by `qat run`'s preflight as well
 * as by the doctor. This file adds exactly three things and nothing else:
 *
 *   1. it names the question in the catalogue's vocabulary;
 *   2. it translates the configuration module's four-state verdict into the doctor's three-value one;
 *   3. it maps each reason onto the `QAT-H` code that owns its prose, so text and severity come from the
 *      guidance table rather than from here.
 *
 * ## It maps reasons; it does not decide them
 *
 * The first version of this file re-derived `ENV_REFERENCE_DANGLING` from the selection's origin —
 * "`configuration-default` means a file named something that does not exist". That was wrong twice
 * over: the classifier already emits that reason directly, and a second derivation is a second
 * classifier that will one day disagree with the first. The mapping below is one reason to one code,
 * with the only branch being the severity split the guidance table cannot express (the same reason at
 * two weights is two codes, decided by the status the classifier already set).
 *
 * ## A null reason is silence, not a condition
 *
 * `EnvironmentDiagnostic.reason` is nullable, and `null` means the check examined the profile and found
 * nothing to say. Mapping `null` to a code would invent a condition out of an absence, so it is
 * handled first, before the mapping is reached at all.
 *
 * ## Translating "indeterminate" without lying to either side
 *
 * The classifier reports four states; the doctor reports three.
 *
 *   classifier          doctor          why
 *   ─────────────────────────────────────────────────────────────────────────────────
 *   fail / error        fail            a blocking condition was established
 *   fail / warning      warn            a condition was established, and it does not block
 *   indeterminate       warn            we looked and could not establish the answer
 *   indeterminate /     pass            nothing was selected and nothing needed to be — an
 *     information                       observation with nothing to fix
 *   pass                pass            the condition the check documents was met
 *
 * The informational row is the one worth defending. `qat run`'s preflight consumes the classifier
 * directly and must keep seeing `indeterminate` there: a preflight that treated absence as consent
 * would launch a run against an environment nobody chose. The *doctor* has a different job — it
 * describes the project — and "no environment selection, defaults apply" is a supported state that
 * should read as a pass rather than as a warning people learn to skim.
 *
 * It returns a *bare* pass today, without attaching the `QAT-H038` observation, because `CheckVerdict`
 * has no finding slot on its pass arm. That is a contract gap rather than a decision: the sibling
 * configuration check has the same shape and loses `QAT-H030` the same way, so this file behaves
 * consistently with it rather than inventing a third pattern. The note at the foot of this file names
 * the one-line change that restores the observation.
 *
 * ## Nothing is caught
 *
 * There is no collaborator to fail: `classifyEnvironment` is a pure function of the inspection. The
 * only throw here is this file's own defect, which must be loud rather than rendered as a finding about
 * someone's project.
 */

import {
  classifyEnvironment,
  type EnvironmentDiagnostic,
  type EnvironmentDiagnosticStatus,
  type EnvironmentReason,
} from "../../../config/environment/index.js";
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

// ─── Catalogue identity ──────────────────────────────────────────────────────

/**
 * The catalogue's identifier for this question.
 *
 * `ENV-002` appears in documentation and in scenario names; it is not the runtime identifier. That is
 * `CheckId.EnvironmentResolvable`, which is what the report keys on and what a precondition names.
 * Keeping the two apart lets the catalogue renumber one without renumbering the other.
 */
const ENVIRONMENT_PROFILE_ID = "ENV-002";

// ─── Rule ────────────────────────────────────────────────────────────────────

/**
 * The ENV-002 check, as data.
 *
 * `severity: Error` is the check's declared weight, used only when it fails. The *finding's* severity
 * comes from the guidance entry for whichever code this run produced, which is how one check can emit
 * a warning and a failure across two runs without either disagreeing about what the check is for.
 */
export const environmentProfileCheck: CheckDefinition = {
  id: CheckId.EnvironmentResolvable,
  category: CheckCategory.EnvironmentProfiles,
  title: "Environment profile valid",

  purpose:
    "A run told to use an environment that does not exist, or that the schema rejected, fails at a point where nothing explains it — and the doctor can explain it now.",

  procedure:
    "Reads the decided state of the selected profile and reports which condition applies: nothing selected, an unusable selection, an undeclared profile, a dangling default, an invalid profile, or unusable configured paths.",

  // Only the environment group. The precondition already guarantees a readable configuration, so
  // requiring it again would declare a dependency this check never reads — and a check that lists a
  // group it does not touch makes the declaration untrustworthy for the ones that do.
  requires: [FactGroup.Environment],
  precondition: CheckId.QatConfigurationLoadable,
  severity: CheckSeverity.Error,

  scenarios: [
    "qat.environment-resolvable.none-selected",
    "qat.environment-resolvable.declared",
    "qat.environment-resolvable.undeclared",
    "qat.environment-resolvable.selection-unusable",
    "qat.environment-resolvable.default-dangling",
    "qat.environment-resolvable.profile-invalid",
    "qat.environment-resolvable.paths-unusable",
  ],

  evaluate(facts: CheckFacts): CheckVerdict {
    const group = present(facts.environment);

    // Classification is pure and cheap, and it runs here rather than in the gatherer because it needs
    // `requiredForOperation` — a property of the *command*, which the gatherer records and this layer
    // interprets. Same facts, same answer, every time.
    const diagnostics = classifyEnvironment(group.inspection, {
      required: group.requiredForOperation,
    });

    const verdict = diagnostics.find(
      (diagnostic) => diagnostic.id === ENVIRONMENT_PROFILE_ID,
    );

    // A missing verdict is this layer's own defect: the classifier emits exactly one ENV-002 entry for
    // every inspection it is handed. Returning `PASS` would make the row disappear from the report, and
    // a disappeared check is indistinguishable from a passing one — the failure mode the whole
    // diagnostics effort exists to prevent. So it is loud, and it names the disagreement.
    if (verdict === undefined) {
      throw new Error(
        "The environment classifier produced no ENV-002 verdict. The classifier and this catalogue disagree.",
      );
    }

    return toVerdict(verdict, facts);
  },
};

// ─── Adaptation ──────────────────────────────────────────────────────────────

/**
 * One diagnostic, as a verdict the runner understands.
 *
 * Order matters here, and the first branch is the one that was missing: a null reason is the
 * classifier saying it found nothing, and mapping it would invent a condition.
 */
function toVerdict(
  diagnostic: EnvironmentDiagnostic,
  facts: CheckFacts,
): CheckVerdict {
  const { reason, status, severity } = diagnostic;

  // Silence, not a condition. Also covers the `skipped` case in practice, since a skipped diagnostic
  // carries no reason — the runner owns that skip through `precondition`, and the check must not
  // express it a second time.
  if (reason === null) return PASS;

  const code = toCode(reason, status);

  switch (status) {
    case "fail": {
      // The finding's severity decides whether this blocks. A `fail` at warning weight is the
      // "condition established, does not block" row, and the runner reads that off the finding rather
      // than trusting this function to have counted correctly.
      const finding = healthFinding(code, facts);
      return severity === "error"
        ? { verdict: "fail", finding }
        : { verdict: "warn", finding };
    }

    case "indeterminate": {
      // Information means "we looked and nothing needed doing". It is returned as a bare pass because the
      // verdict type has no finding slot on its pass arm; the guidance text is still produced during
      // tests, so the wording is exercised even though the report cannot yet carry it.
      if (severity === "information") return PASS;

      // Any louder indeterminate is a genuine unknown — we could not establish the answer — and that
      // must never read as consent.
      return { verdict: "warn", finding: healthFinding(code, facts) };
    }

    case "pass":
      // Nothing to attach: a reason-bearing pass does not exist in this classifier, and if one appears
      // it still needs no remediation.
      return PASS;

    case "skipped":
      // Expressed by the runner through `precondition`, which names the check that must pass first.
      return PASS;

    default:
      return assertNever(status);
  }
}

/**
 * The `QAT-H` code that owns this reason's prose.
 *
 * One reason to one code. The single branch is the severity split on `ENV_NO_SELECTION`, and it exists
 * because severity is a property of the code in the guidance table: "absent and that is fine" and
 * "absent and this command cannot continue" cannot share an entry, so they cannot share a code.
 *
 * Two reasons share the profile-invalid code, which is a mapping decision rather than an oversight: a
 * required setting that is absent is a schema rejection like any other — the schema reports it as a
 * missing field, and the remedy is identical (correct the listed fields). If the wording should ever
 * differ, `ENV_SETTING_MISSING` gets its own code and guidance entry rather than a second branch here.
 *
 * Deliberately not total over the whole reason union. `ENV_VARIABLE_*` and the reference-policy reasons
 * belong to ENV-001; a profile check that rendered them would be answering a question it was not asked,
 * under a code whose guidance describes something else.
 */
function toCode(
  reason: EnvironmentReason,
  status: EnvironmentDiagnosticStatus,
): HealthCode {
  switch (reason) {
    case "ENV_NO_SELECTION":
      return status === "fail"
        ? HealthCode.EnvironmentNotSelectedRequired
        : HealthCode.EnvironmentNotSelected;

    case "ENV_SELECTION_INVALID":
      return HealthCode.EnvironmentSelectionInvalid;

    case "ENV_PROFILE_NOT_FOUND":
      return HealthCode.EnvironmentUndeclared;

    // The classifier distinguishes a *file* naming a missing profile from a *person* naming one. It
    // emits the distinction as its own reason, so this file only has to pass it on — deriving it from
    // the selection origin here was a second classifier, and the wrong one.
    case "ENV_REFERENCE_DANGLING":
      return HealthCode.EnvironmentReferenceDangling;

    case "ENV_PROFILE_INVALID":
    case "ENV_SETTING_MISSING":
      return HealthCode.EnvironmentProfileInvalid;

    case "ENV_PATH_INVALID":
      return HealthCode.EnvironmentPathInvalid;

    // Reasons this check must never receive. Reaching one means the classifier attributed a
    // variable-level condition to the profile check, which is a defect worth failing on rather than
    // rendering under a code that describes something else.
    case "ENV_VARIABLE_MISSING":
    case "ENV_VARIABLE_BLANK":
    case "ENV_VARIABLE_UNVERIFIABLE":
    case "ENV_REFERENCE_SOURCE_NOT_APPROVED":
    case "ENV_REFERENCE_NAME_INVALID":
      throw new Error(
        `The environment classifier attributed ${reason} to ENV-002. Variable-level conditions belong to ENV-001.`,
      );

    default:
      return assertNever(reason);
  }
}

/** Compile-time exhaustiveness guard: a widened union becomes a type error here. */
function assertNever(value: never): never {
  throw new Error(`Unhandled environment verdict: ${JSON.stringify(value)}`);
}
