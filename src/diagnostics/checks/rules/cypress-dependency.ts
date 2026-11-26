/**
 * DEP-003 — Cypress dependency installed.
 *
 * The rule is intentionally thin. All judgement lives in `assessCypressHealth`, which is pure and
 * fixture-testable; this file only turns one already-decided condition into a finding and supplies the
 * words a person reads. Keeping the two apart is what stops a wording change from altering behaviour, and
 * a behaviour change from altering wording.
 *
 * Where this check sits in the Cypress story: it answers the first two of the six facts — *is Cypress
 * declared?* and *is the declared package actually here?* It does not read a version, does not look at a
 * binary and does not compare ranges; those belong to the checks that own them, and a skip there points
 * back at this ID.
 *
 * ## Severity
 *
 * The catalogue declares one severity for this check, but the assessment produces two outcomes: a missing
 * or unusable installation (error — nothing can run) and a *ghost install*, meaning a package present on
 * disk that `package.json` never declares (warning — the project runs today, but will not reproduce on a
 * clean checkout or in CI). Each finding therefore carries the severity the assessment decided for that
 * condition; blocking on a ghost install would stop work over a problem that has not happened yet.
 *
 * ## What is injected, and why
 *
 * Identity (`id`, `category`, `severity`, `code`) belongs to the catalogue and is injected rather than
 * hardcoded, so this rule cannot report under a name or code nobody filters on. The install target and the
 * supported range are injected from the adapter's policy for the same reason they are not written here:
 * a version number repeated in a check, a README and a CI matrix is three numbers after the first release
 * that forgets two of them.
 *
 * ## Evidence
 *
 * Built from an allowlist, never by spreading raw observation. A finding may reach a shared CI log, a JSON
 * export and a persisted diagnostic session, so only deliberately chosen fields leave the process.
 * Absolute paths in particular never appear: where the package was found is available from the collector
 * for verbose logs, and a home directory does not belong in a report.
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

/** The registered facts about this check. Supplied by the catalogue, never derived here. */
export interface CypressDependencyCheckIdentity {
  readonly id: CheckId;
  readonly category: CheckCategory;
  /** The catalogue's declared severity. Each finding carries the condition's own severity instead. */
  readonly severity: CheckSeverity;
  /** The diagnostic code a finding from this check reports under. */
  readonly code: CheckFinding["code"];
}

/**
 * Presentation policy the rule cannot gather.
 *
 * Not per-run facts: these are how the adapter chooses to phrase advice. Kept out of the fact groups so
 * evidence stays a description of the project.
 */
export interface CypressDependencyCheckOptions {
  /** A verified release to suggest, e.g. `^13`. When absent, remediation describes the range instead. */
  readonly recommendedRange?: string | null;
  /** The supported range, quoted for reassurance. Optional because it is not needed to act. */
  readonly supportedRange?: string | null;
  /** Documentation anchor for the policy, appended to remediation when available. */
  readonly documentationAnchor?: string;
}

/* -------------------------------------------------------------------------- */
/* Reasons this check can report                                               */
/* -------------------------------------------------------------------------- */

/**
 * The subset of problem reasons DEP-003 owns.
 *
 * Each reason belongs to exactly one condition in the Cypress vocabulary, so a total `Record` over this
 * union is exhaustive for this check without mentioning reasons other checks report.
 *
 * Held as a frozen list as well as a type, so membership can be proven without a cast: narrowing by
 * assertion would let a future reason fall into the fallback silently instead of failing to compile.
 */
const DEPENDENCY_REASONS = [
  "CYPRESS_NOT_DECLARED",
  "CYPRESS_DECLARED_NOT_INSTALLED",
  "CYPRESS_INSTALLED_BUT_UNDECLARED",
  "CYPRESS_RESOLUTION_REJECTED_OUTSIDE_PROJECT",
  "CYPRESS_MANIFEST_UNREADABLE",
] as const satisfies readonly CypressProblemReason[];

type DependencyReason = (typeof DEPENDENCY_REASONS)[number];

function isDependencyReason(reason: string): reason is DependencyReason {
  return DEPENDENCY_REASONS.some((candidate) => candidate === reason);
}

/**
 * The facts a message may quote.
 *
 * Narrow on purpose: guidance receives data, not the whole finding, so it cannot come to depend on a status
 * or an evidence key that later disappears.
 *
 * Every field is `string | null` rather than optional, because a published finding is serialised to JSON
 * where `undefined` vanishes and erases the difference between "absent" and "unknown".
 */
interface DependencyFacts {
  readonly declaredIn: string | null;
  readonly declaredSpecifier: string | null;
  readonly installedVersion: string | null;
  readonly supportedRange: string | null;
  /** A verified release to suggest, or `null` when the policy offers none. */
  readonly recommendedRange: string | null;
  readonly documentationAnchor: string | null;
}

/* -------------------------------------------------------------------------- */
/* The check, as data                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Builds the DEP-003 definition.
 *
 * No collector, no clock, no port: the health conditions were decided while facts were gathered, so this is a
 * pure function of one fact group — constructible in a test with a literal identity.
 *
 * No `precondition`: this is the first Cypress check, and the two that follow declare it as theirs. Declaring
 * it here as well would invite a cycle and would mean nothing.
 */
export function createCypressDependencyCheck(
  identity: CypressDependencyCheckIdentity,
  options: CypressDependencyCheckOptions = {},
): CheckDefinition {
  const guidance = createDependencyGuidance(options);

  return {
    id: identity.id,
    category: identity.category,
    title: "Cypress dependency installed",
    purpose:
      "Confirm that the project declares Cypress and that the declared package is installed where QAT will run it.",
    procedure:
      "Read the project manifest and resolve the Cypress package from the project root.",
    requires: [FactGroup.Cypress],
    severity: identity.severity,
    scenarios: [
      "declared-and-installed",
      "not-declared",
      "declared-not-installed",
      "installed-not-declared",
      "resolved-outside-project",
      "manifest-unreadable",
    ],
    evaluate: (facts: CheckFacts) =>
      evaluateDependency(present(facts.cypress), identity, guidance),
  };
}

/**
 * Maps the gathered conditions to a verdict.
 *
 * Exactly one finding per run. A single check with a single verdict keeps aggregation honest: "declared but
 * not installed" is one problem with one fix, not a list a user has to reconcile.
 */
function evaluateDependency(
  facts: CypressFacts,
  identity: CypressDependencyCheckIdentity,
  guidance: DependencyGuidance,
): CheckVerdict {
  const result = pickDependencyResult(facts.results);

  // The happy path: the shared value, allocated once at module load, and no finding to word. Returning here
  // is what makes every finding below guaranteed to have a remediation.
  if (result.status === "pass") return PASS;

  const dependencyFacts: DependencyFacts = {
    declaredIn: readEvidenceText(result, "declaredIn"),
    declaredSpecifier: readEvidenceText(result, "declaredSpecifier"),
    installedVersion: readEvidenceText(result, "installedVersion"),
    supportedRange: guidance.supportedRange,
    recommendedRange: guidance.recommendedRange,
    documentationAnchor: guidance.documentationAnchor,
  };

  const text = guidance.forResult(result, dependencyFacts);

  // `fail` is the only verdict that names a broken condition. "Could not establish" and "not evaluated because
  // a prerequisite failed" are warnings: a question we could not answer must not block work we can still do.
  return {
    verdict: result.status === "fail" ? "fail" : "warn",
    finding: toFinding(result, text, dependencyFacts, identity),
  };
}

/**
 * Selects this check's result from the assessment.
 *
 * Assessment always returns one result per check, so a missing entry means the vocabulary and the assessor
 * have drifted apart — a programming error, not a project problem. Throwing is correct: the check engine
 * isolates a throwing check and reports it as failed, which is the outcome a broken rule deserves. Inventing
 * a pass would be the one thing worse than crashing.
 */
function pickDependencyResult(
  results: readonly CypressConditionResult[],
): CypressConditionResult {
  const own = results.find((candidate) => candidate.checkId === "DEP-003");

  if (own === undefined) {
    throw new Error(
      "Cypress health assessment did not return a DEP-003 result",
    );
  }

  return own;
}

/* -------------------------------------------------------------------------- */
/* Finding                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Turns one condition into a finding.
 *
 * `code` and `severity` are required by the reporting contract. The code comes from the injected identity; the
 * severity comes from the *assessment*, because the difference between "nothing is installed" and "installed
 * but undeclared" is a judgement this check must not re-make.
 *
 * Evidence is assembled field by field rather than spread, so adding an observation to the internal contract
 * cannot silently publish it. That property matters more than the brevity a spread would buy: the contract will
 * grow, and every growth should be a deliberate decision about what leaves the process.
 */
function toFinding(
  result: CypressConditionResult,
  text: FindingText,
  facts: DependencyFacts,
  identity: CypressDependencyCheckIdentity,
): CheckFinding {
  return Object.freeze({
    code: identity.code,
    severity: toFindingSeverity(result.severity),
    explanation: text.explanation,
    remediation: text.remediation,
    evidence: Object.freeze({
      declared: facts.declaredIn !== null,
      declaredIn: facts.declaredIn,
      declaredSpecifier: facts.declaredSpecifier,
      installedVersion: facts.installedVersion,
    }),
  });
}

/**
 * Translates the assessment's severity vocabulary into the reporting layer's.
 *
 * The two are not identical: the health module uses `information` for a passed or skipped condition, while a
 * diagnostic finding is only ever error or warning. `information` is reachable here despite the pass path
 * returning early, because a skipped condition still produces a finding — mapping it to `warning` keeps the
 * skip visible without escalating it into a blocker.
 *
 * An exhaustive switch rather than a cast, so a new member in either vocabulary fails the build instead of
 * publishing a severity the report cannot render.
 */
function toFindingSeverity(
  severity: CypressConditionResult["severity"],
): CheckFinding["severity"] {
  switch (severity) {
    case "error":
      return "error";

    case "warning":
      return "warning";

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
 * `remediation` is non-nullable on purpose: a finding exists only when something needs attention, and a finding
 * that cannot say what to do is a dead end. A satisfied check produces no finding at all, so "nothing to fix"
 * never has to be written.
 */
interface FindingText {
  readonly explanation: string;
  readonly remediation: string;
}

interface DependencyGuidance {
  readonly supportedRange: string | null;
  readonly recommendedRange: string | null;
  readonly documentationAnchor: string | null;
  readonly forResult: (
    result: CypressConditionResult,
    facts: DependencyFacts,
  ) => FindingText;
}

/**
 * Builds the wording for this check.
 *
 * Guidance is keyed by *reason*, not by finding: two projects with the same reason need the same next step, and
 * two projects with different reasons must never receive the same sentence. The map is a total `Record` over the
 * reasons this check owns, so adding a reason without writing its message is a compile error rather than a vague
 * fallback in production.
 *
 * Renderers take `DependencyFacts` so a message can quote what was actually observed — the field it was declared
 * in, the specifier, the installed version. A renderer that ignored its facts produced sentences with empty
 * placeholders, which is how "declared in ( )" reached users.
 */
function createDependencyGuidance(
  options: CypressDependencyCheckOptions,
): DependencyGuidance {
  const supportedRange = options.supportedRange ?? null;
  const recommendedRange = options.recommendedRange ?? null;
  const documentationAnchor = options.documentationAnchor ?? null;

  /** Install target: a verified release when the policy offers one, else a description of the range. */
  const installTarget =
    recommendedRange ?? "a Cypress release inside the supported range";
  const policyPointer =
    documentationAnchor === null ? "" : `\nPolicy: ${documentationAnchor}`;
  const supportReassurance =
    supportedRange === null
      ? ""
      : `\nAny Cypress release inside ${supportedRange} is supported.`;

  const messages: Record<
    DependencyReason,
    (facts: DependencyFacts) => FindingText
  > = {
    CYPRESS_NOT_DECLARED: () => ({
      explanation: `${CYPRESS_PACKAGE_NAME} is not declared in dependencies or devDependencies, so a clean install of this project would not install Cypress.`,
      remediation: `Add it, then install:
  npm install --save-dev ${CYPRESS_PACKAGE_NAME}@${installTarget}
  # or: pnpm add -D ${CYPRESS_PACKAGE_NAME}@${installTarget}${supportReassurance}${policyPointer}`,
    }),

    CYPRESS_DECLARED_NOT_INSTALLED: (facts) => ({
      explanation:
        facts.declaredSpecifier === null
          ? `${CYPRESS_PACKAGE_NAME} is declared but the package is not installed in this project.`
          : `${CYPRESS_PACKAGE_NAME} is declared in ${facts.declaredIn ?? "package.json"} (${facts.declaredSpecifier}) but the package is not installed in this project.`,
      // Deliberately manager-neutral: which manager this project uses is DEP-007's question, and guessing it
      // here would produce a wrong command half the time.
      remediation: `Run your project's install, then re-run \`qat doctor\`:
  npm install        # pnpm install / yarn install`,
    }),

    CYPRESS_INSTALLED_BUT_UNDECLARED: (facts) => ({
      explanation: `Cypress ${facts.installedVersion ?? "(unknown version)"} is installed in node_modules but package.json does not declare it. The project works on this machine and will not reproduce on a clean checkout.`,
      remediation: `Record the dependency so a clean install reproduces it:
  npm install --save-dev ${CYPRESS_PACKAGE_NAME}@${facts.installedVersion ?? installTarget}`,
    }),

    // The subtle failure: something answered, but it was not this project's Cypress.
    CYPRESS_RESOLUTION_REJECTED_OUTSIDE_PROJECT: () => ({
      explanation:
        "The Cypress package resolved from outside this project. A globally installed or workspace-hoisted Cypress was found, and QAT will not treat it as this project's dependency.",
      remediation: `Install Cypress locally for this project:
  npm install --save-dev ${CYPRESS_PACKAGE_NAME}@${installTarget}
If you believe a global install is being picked up, check with \`npm ls -g ${CYPRESS_PACKAGE_NAME}\`.${policyPointer}`,
    }),

    CYPRESS_MANIFEST_UNREADABLE: () => ({
      explanation:
        "A Cypress package directory exists but its package.json could not be read, so this installation is damaged.",
      remediation: `Reinstall the package:
  rm -rf node_modules/${CYPRESS_PACKAGE_NAME} && npm install`,
    }),
  };

  return {
    supportedRange,
    recommendedRange,
    documentationAnchor,

    forResult: (result, facts) => {
      // A skip is a statement about order, not a finding about Cypress. Pointing at the blocking check keeps one
      // problem to one instruction, in the finding that actually observed it.
      if (result.status === "skipped") {
        const blockedBy =
          result.prerequisite?.checkId ?? "the Cypress installation check";

        return {
          explanation: `Not evaluated because ${blockedBy} did not establish an installed Cypress package.`,
          remediation: `Resolve ${blockedBy} first — that finding names the exact next step.`,
        };
      }

      if (isDependencyReason(result.reason)) {
        return messages[result.reason](facts);
      }

      // Unknown reasons fall back rather than throwing: a report that admits it cannot name the problem is still
      // usable; one that throws is not.
      return {
        explanation:
          "The Cypress dependency check reported a condition it could not describe.",
        remediation: `Install Cypress locally, then re-run \`qat doctor\`:
  npm install --save-dev ${CYPRESS_PACKAGE_NAME}@${installTarget}${policyPointer}`,
      };
    },
  };
}
