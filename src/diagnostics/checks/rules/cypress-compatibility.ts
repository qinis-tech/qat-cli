/**
 * DEP-004 — Cypress version compatibility.
 *
 * This rule reports the third and sixth Cypress facts: whether a version could be identified at all,
 * and whether that version is inside the range the adapter actually supports.
 *
 * Division of labour, which is the point of the file being this small:
 *
 *   • `assessCypressHealth` decides **status** and the **severity of a failed condition** — it knows
 *     that a version older than the floor cannot work (error), that a version newer than the highest
 *     tested release probably works and nobody has proven it (warning), and that a pre-release is
 *     outside a support claim stated for releases only (warning).
 *   • This file decides **wording, evidence and identity**. It never re-derives a severity from a
 *     reason, never re-parses a range, and never contains a copy of the supported numbers a user is
 *     asked to install.
 *
 * Two consequences worth stating, because they are easy to undo by accident:
 *
 *  • The supported range is read from the *gathered* evidence and the recommended install target from
 *    injected policy. If the adapter's range changes, every message changes with it; no remediation
 *    text can go stale, and there is no second copy to forget.
 *  • A *skipped* result is not a failure. When DEP-003 could not establish an installation, this check
 *    points at DEP-003 as the thing to fix — it does not repeat the install instructions. One problem,
 *    one instruction, in the finding that actually observed it.
 *
 * ## The finding carries the condition's severity
 *
 * A check declares one severity in the catalogue, but this check legitimately produces both: an
 * unsupported-old version cannot work, while an untested-newer version is a warning. The definition
 * therefore carries the catalogue's declared default, and each finding carries the severity the
 * assessment decided for *that* condition. The finding is the more specific statement, so a runner
 * deciding whether to block should prefer it when present — see the note on `CheckFinding.severity`.
 */

import type {
  CheckCategory,
  CheckFinding,
  CheckId,
  CheckSeverity,
} from "../../../core/application/checks.js";
import type {
  CypressConditionResult,
  CypressProblemReason,
} from "../../../project/cypress-health/index.js";
import { CYPRESS_PACKAGE_NAME } from "../../../project/cypress-health/index.js";
import { readEvidenceText } from "../../models/cypress-health.js";
import type {
  CheckDefinition,
  CheckFacts,
  CheckVerdict,
  CypressFacts,
} from "../contracts.js";
import { FactGroup, PASS, present } from "../contracts.js";

/* -------------------------------------------------------------------------- */
/* Identity and presentation policy                                            */
/* -------------------------------------------------------------------------- */

/**
 * The registered facts about this check.
 *
 * Supplied by the catalogue, never derived here. `code` is typed as the finding's own code rather than
 * as a bare string, so whatever vocabulary the reporting layer uses is enforced at the one place that
 * supplies a value.
 */
export interface CypressCompatibilityCheckIdentity {
  readonly id: CheckId;
  readonly category: CheckCategory;
  /** The catalogue's declared severity for this check. Each finding carries the condition's own. */
  readonly severity: CheckSeverity;
  /** The diagnostic code a finding from this check reports under. */
  readonly code: CheckFinding["code"];
  /** The check that must have passed for this one to be meaningful — DEP-003. */
  readonly precondition?: CheckId;
}

/**
 * Presentation policy the rule cannot gather.
 *
 * These are not per-run facts: they are how the adapter chooses to *phrase* advice. Kept out of the
 * fact groups so evidence stays a description of the project, and injected at registration so this
 * file contains no version number of its own.
 */
export interface CypressCompatibilityCheckOptions {
  /**
   * A concrete, verified release to recommend, derived from the adapter's policy, so "upgrade Cypress"
   * always names something inside the supported range. When absent, remediation describes the range
   * instead of inventing a version.
   */
  readonly recommendedRange?: string | null;
  /** Documentation anchor for the policy, appended to remediation when available. */
  readonly documentationAnchor?: string;
}

/* -------------------------------------------------------------------------- */
/* Reasons this check reports                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The subset of problem reasons DEP-004 owns.
 *
 * Held as a frozen list as well as a type, so membership can be proven without a cast: narrowing by
 * assertion would let a future reason fall into the fallback silently instead of failing to compile.
 */
const COMPATIBILITY_REASONS = [
  "CYPRESS_VERSION_UNKNOWN",
  "CYPRESS_VERSION_BELOW_MINIMUM",
  "CYPRESS_VERSION_ABOVE_TESTED_MAXIMUM",
  "CYPRESS_VERSION_PRERELEASE",
] as const satisfies readonly CypressProblemReason[];

type CompatibilityReason = (typeof COMPATIBILITY_REASONS)[number];

function isCompatibilityReason(reason: string): reason is CompatibilityReason {
  return COMPATIBILITY_REASONS.some((candidate) => candidate === reason);
}

/**
 * The facts a message may quote.
 *
 * Narrow on purpose: guidance receives data rather than the whole finding, so it cannot come to depend
 * on a status, an evidence key or a path that later disappears.
 *
 * Every field is `string | null` rather than optional, because a published finding is serialised to
 * JSON where `undefined` vanishes and erases the difference between "absent" and "unknown".
 */
interface CompatibilityFacts {
  readonly detected: string | null;
  readonly supportedRange: string | null;
  readonly supportedOrigin: string | null;
  /** A verified release to suggest, or `null` when the policy does not offer one. */
  readonly recommendedRange: string | null;
  readonly documentationAnchor: string | null;
  /** Set only for skipped results: the check that must be fixed first. */
  readonly blockedBy: string | null;
}

/* -------------------------------------------------------------------------- */
/* The check, as data                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Builds the DEP-004 definition.
 *
 * No collector, no clock, no port. The health conditions were decided while facts were gathered, so this
 * check is a pure function of one fact group — constructible in a test with a literal identity.
 *
 * `precondition` expresses the ordering the skip message used to explain in prose: without an installed
 * package there is no version to judge, so the runner turns a failed or skipped DEP-003 into a skip here
 * rather than letting this check report a consequence as a second problem.
 */
export function createCypressCompatibilityCheck(
  identity: CypressCompatibilityCheckIdentity,
  options: CypressCompatibilityCheckOptions = {},
): CheckDefinition {
  const guidance = createCompatibilityGuidance(options);

  return {
    id: identity.id,
    category: identity.category,
    title: "Cypress version compatibility",
    purpose:
      "Confirm that the installed Cypress version can be identified and is inside the range this adapter supports.",
    procedure:
      "Read the installed Cypress version and compare it with the supported range.",
    requires: [FactGroup.Cypress],
    ...(identity.precondition === undefined
      ? {}
      : { precondition: identity.precondition }),
    severity: identity.severity,
    scenarios: [
      "version-supported",
      "version-below-minimum",
      "version-above-tested-maximum",
      "version-prerelease",
      "version-unknown",
      "precondition-unsatisfied",
    ],
    evaluate: (facts: CheckFacts) =>
      evaluateCompatibility(present(facts.cypress), identity, guidance),
  };
}

/**
 * Maps the gathered conditions to a verdict.
 *
 * Exactly one finding per run. "Version unknown" and "version out of range" are two states of one
 * question, and splitting them into separate findings would let a user fix one and believe the other is
 * still outstanding.
 */
function evaluateCompatibility(
  facts: CypressFacts,
  identity: CypressCompatibilityCheckIdentity,
  guidance: CompatibilityGuidance,
): CheckVerdict {
  const result = pickCompatibilityResult(facts.results);

  // The happy path: the shared value, allocated once at module load, and no finding to word. Returning
  // here is also what makes every finding below guaranteed to have a remediation.
  if (result.status === "pass") return PASS;

  const compatibilityFacts: CompatibilityFacts = {
    detected: readEvidenceText(result, "detected"),
    supportedRange: readEvidenceText(result, "supported"),
    supportedOrigin: readEvidenceText(result, "supportedOrigin"),
    recommendedRange: guidance.recommendedRange,
    documentationAnchor: guidance.documentationAnchor,
    blockedBy: result.prerequisite?.checkId ?? null,
  };

  const text = guidance.forResult(result, compatibilityFacts);

  // `fail` is the only verdict that names a broken condition. "Could not establish" and "not evaluated
  // because a prerequisite failed" are both warnings: a question we could not answer must not block work
  // we can still perform.
  return {
    verdict: result.status === "fail" ? "fail" : "warn",
    finding: toFinding(result, text, compatibilityFacts, identity),
  };
}

/**
 * Selects this check's condition from the gathered results.
 *
 * Assessment always produces one result per check, so a missing entry means the vocabulary and the
 * assessor have drifted apart — a programming error, not a project condition. Throwing is correct: the
 * runner isolates a throwing check and reports it as failed, whereas inventing a pass would be the one
 * outcome worse than crashing.
 */
function pickCompatibilityResult(
  results: readonly CypressConditionResult[],
): CypressConditionResult {
  const own = results.find((candidate) => candidate.checkId === "DEP-004");

  if (own === undefined) {
    throw new Error(
      "Cypress health assessment did not return a DEP-004 result",
    );
  }

  return own;
}

/* -------------------------------------------------------------------------- */
/* Finding                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Turns the condition into a finding.
 *
 * `code` and `severity` are required by the reporting contract. The code comes from the injected
 * identity so the finding is filed under a code the catalogue and filters know; the severity comes from
 * the *assessment*, because the difference between "cannot work" and "not proven to work" is the whole
 * point of this check and lives in that decision, not here.
 *
 * Evidence is allowlisted rather than spread. The internal contract will grow — it already carries the
 * resolved package directory, which is an absolute path — and each addition should be a deliberate
 * decision about what leaves the process.
 */
function toFinding(
  result: CypressConditionResult,
  text: FindingText,
  facts: CompatibilityFacts,
  identity: CypressCompatibilityCheckIdentity,
): CheckFinding {
  return Object.freeze({
    code: identity.code,
    severity: toFindingSeverity(result.severity),
    explanation: text.explanation,
    remediation: text.remediation,
    evidence: Object.freeze({
      detected: facts.detected,
      supported: facts.supportedRange,
      supportedOrigin: facts.supportedOrigin,
      evaluatorReason: readEvidenceText(result, "evaluatorReason"),
      blockedBy: facts.blockedBy,
      blockedByReason: result.prerequisite?.reason ?? null,
    }),
  });
}

/**
 * Translates the assessment's severity vocabulary into the reporting layer's.
 *
 * The two vocabularies are not identical, which is why this is a translation and not a cast:
 * `CypressConditionResult` uses `information` for a *passed* or *skipped* condition, while a diagnostic
 * finding is only ever error or warning — the reporting layer has no third level, because a finding that
 * is not worth acting on is not worth emitting.
 *
 * `information` is reachable here despite the pass path returning early: assessment gives a skipped
 * condition the severity `information`, and a skip still produces a finding so the reader learns that a
 * check did not run and which check to fix first. Mapping it to `warning` keeps that skip visible — a
 * silent `information`-level finding would be the "silence reads as consent" failure this whole design
 * avoids — while never escalating it into a blocker.
 *
 * An exhaustive switch rather than a cast, so a new member in either vocabulary fails the build instead
 * of publishing a severity the report cannot render.
 */
function toFindingSeverity(
  severity: CypressConditionResult["severity"],
): CheckFinding["severity"] {
  switch (severity) {
    case "error":
      return "error";

    case "warning":
      return "warning";

    // Passed and skipped conditions both land here; a passed one never reaches this function because
    // `evaluateCompatibility` returns `PASS` before any finding is built, so in practice this is the skip
    // path. Warning, not error: work can still proceed, and the explanation names the blocking check.
    case "information":
      return "warning";
  }
}

/* -------------------------------------------------------------------------- */
/* Guidance                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Wording for a finding.
 *
 * `remediation` is non-nullable on purpose: a finding exists only when something needs attention, and a
 * finding that cannot tell the reader what to do is a dead end. The "satisfied check stays quiet" case is
 * not a quiet finding — it is no finding at all, returned as `PASS` before any wording is produced.
 */
interface FindingText {
  readonly explanation: string;
  readonly remediation: string;
}

interface CompatibilityGuidance {
  readonly recommendedRange: string | null;
  readonly documentationAnchor: string | null;
  readonly forResult: (
    result: CypressConditionResult,
    facts: CompatibilityFacts,
  ) => FindingText;
}

/**
 * Builds the wording for this check.
 *
 * Guidance is keyed by *reason*, not by finding: two projects with the same reason need the same next
 * step, and two projects with different reasons must never receive the same sentence. The map is a total
 * `Record` over the reasons this check owns, so adding a reason without writing its message is a compile
 * error rather than a vague fallback shipped to users.
 *
 * Every install suggestion is built from injected policy or from gathered evidence. This file contains no
 * version number that could drift away from the adapter's declaration.
 */
function createCompatibilityGuidance(
  options: CypressCompatibilityCheckOptions,
): CompatibilityGuidance {
  const recommendedRange = options.recommendedRange ?? null;
  const documentationAnchor = options.documentationAnchor ?? null;

  /** Install target: a verified release when the policy offers one, else a description of the range. */
  const installTarget =
    recommendedRange ?? "a release inside the supported range";
  const policyPointer =
    documentationAnchor === null ? "" : `\nPolicy: ${documentationAnchor}`;

  const messages: Record<
    CompatibilityReason,
    (facts: CompatibilityFacts) => FindingText
  > = {
    CYPRESS_VERSION_BELOW_MINIMUM: (facts) => ({
      explanation: `Cypress ${facts.detected ?? "(unknown version)"} is older than the oldest release this QAT adapter supports${rangeSuffix(facts)}. Older releases lack APIs the adapter relies on, so a run would fail for reasons unrelated to your tests.`,
      remediation: `Upgrade Cypress, then re-run \`qat doctor\`:
  npm install --save-dev ${CYPRESS_PACKAGE_NAME}@${installTarget}${policyPointer}`,
    }),

    // Wording matters here: newer is not broken, it is unproven. Saying "unsupported" invites people to
    // pin without understanding why, and then to be surprised when the pin itself causes a problem.
    CYPRESS_VERSION_ABOVE_TESTED_MAXIMUM: (facts) => ({
      explanation: `Cypress ${facts.detected ?? "(unknown version)"} is newer than the highest release verified with this adapter${rangeSuffix(facts)}. It may work, but QAT has not been tested against it, so a failure inside Cypress cannot be told apart from an adapter problem.`,
      remediation: `Pin to a verified release if you want a supported combination:
  npm install --save-dev ${CYPRESS_PACKAGE_NAME}@${installTarget}
Or keep the newer release and report any adapter failure with the exact Cypress version.${policyPointer}`,
    }),

    CYPRESS_VERSION_PRERELEASE: (facts) => ({
      explanation: `Cypress ${facts.detected ?? "(pre-release)"} is a pre-release. Support is claimed only for released versions${rangeSuffix(facts)}.`,
      remediation: `Use the matching released version:
  npm install --save-dev ${CYPRESS_PACKAGE_NAME}@${installTarget}
Pre-releases are worth exercising deliberately, but not as a project default.${policyPointer}`,
    }),

    // Reached when a version could not be read or could not be evaluated. Both mean the question was not
    // answered, so the message asks for evidence rather than asserting a compatibility problem nobody
    // observed.
    CYPRESS_VERSION_UNKNOWN: (facts) => ({
      explanation:
        facts.detected === null
          ? `QAT could not read a usable Cypress version from the installed package, so compatibility${facts.supportedRange === null ? "" : ` with ${facts.supportedRange}`} could not be checked.`
          : `QAT could not evaluate Cypress ${facts.detected}${facts.supportedRange === null ? "" : ` against ${facts.supportedRange}`}${facts.supportedOrigin === null ? "" : ` (${facts.supportedOrigin})`}.`,
      remediation: `Confirm the installed package is intact, then re-run \`qat doctor\`:
  npm ls ${CYPRESS_PACKAGE_NAME}${policyPointer}`,
    }),
  };

  return {
    recommendedRange,
    documentationAnchor,

    forResult: (result, facts) => {
      // A skip is not a finding about Cypress; it is a statement about order. Pointing at the blocking
      // check keeps one problem to one instruction, in the finding that actually observed it.
      if (result.status === "skipped") {
        const blockedBy = facts.blockedBy ?? "DEP-003";

        return {
          explanation: `Not evaluated because ${blockedBy} could not establish an installed Cypress package.`,
          remediation: `Resolve ${blockedBy} first — that finding names the exact next step.`,
        };
      }

      if (isCompatibilityReason(result.reason)) {
        return messages[result.reason](facts);
      }

      // Unknown reasons fall back rather than throwing: the condition's severity still tells the reader how
      // serious it is, and a report that admits it cannot name the problem is more useful than a crash.
      return {
        explanation:
          "The Cypress compatibility check reported a condition it could not describe.",
        remediation: `Verify the installed version and compare it with the supported range, then re-run \`qat doctor\`:
  npx ${CYPRESS_PACKAGE_NAME} version${policyPointer}`,
      };
    },
  };
}

/**
 * Appends the supported range to a sentence when it was gathered.
 *
 * A tiny helper rather than a nested ternary in three templates: the range arrives from evidence and can
 * legitimately be absent, and every one of these sentences has to read correctly either way.
 */
function rangeSuffix(facts: CompatibilityFacts): string {
  return facts.supportedRange === null ? "" : ` (${facts.supportedRange})`;
}
