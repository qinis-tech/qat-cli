/**
 * DEP-008 — Cypress binary availability.
 *
 * This rule reports the fourth and fifth Cypress facts: is there a downloaded binary for the
 * installed version, and can it actually be run?
 *
 * It exists because this is the failure that most often gets misdiagnosed. `npm ci` succeeds,
 * `node_modules/cypress` is present, and the ~150 MB binary is missing anyway — it lives in a
 * version-keyed cache outside the project, is fetched by a post-install step that is routinely
 * skipped (`--ignore-scripts`, read-only CI caches, offline images), and is platform-specific.
 * The error Cypress then produces reads like a Cypress bug, so people reinstall Node, upgrade
 * Cypress, or blame CI.
 *
 * Structural guarantees, not promises:
 *
 *  • This file cannot execute anything. It has no process dependency, no child-process import and
 *    no filesystem port, and `evaluate` is synchronous by contract. Verification already happened
 *    while facts were gathered; a rule that could spawn is a rule someone will eventually point at
 *    a test suite.
 *  • It never re-verifies and never re-inspects. It maps one already-decided condition to one
 *    finding, so the report cannot disagree with the evidence it was built from.
 *
 * ## The one invariant that shapes the types below
 *
 * A satisfied condition returns the shared `PASS` verdict, which carries no finding — so a finding
 * exists *only* for a condition that needs attention, and every such condition has something to say.
 * `FindingText.remediation` is therefore non-nullable, and a satisfied check needs no "nothing to
 * fix" sentence because nothing is emitted at all.
 *
 * ## Why the identity is injected
 *
 * A check's identifier, category, severity and diagnostic code are members of closed vocabularies
 * owned by the catalogue (`CheckId`, `CheckCategory`, `CheckFinding['code']`). They are not strings a
 * rule may invent: a rule that hardcoded them would compile only while its guess matched the
 * registry, and would report under a code nobody filters on. Injecting them keeps both halves honest —
 * the catalogue decides what a check *is called*, this file decides what it *finds* — and makes the
 * definition constructible in a unit test with a literal identity and no container.
 *
 * What it deliberately does NOT do: install the binary, delete a cache entry, or change an
 * environment variable. Downloads belong to the user's Cypress install; a diagnostic that repairs
 * what it finds is a treatment wearing a stethoscope, and it would make `qat doctor` a mutating
 * command on machines we were only invited to inspect.
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
import { readEvidenceText } from "../../models/cypress-health.js";
import type {
  CheckDefinition,
  CheckFacts,
  CheckVerdict,
  CypressFacts,
} from "../contracts.js";
import { FactGroup, PASS, present } from "../contracts.js";

/* -------------------------------------------------------------------------- */
/* Identity                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The registered facts about this check.
 *
 * Supplied by the catalogue, never derived here. `code` is typed as the finding's own code rather
 * than as a bare string, so whatever vocabulary the reporting layer uses is enforced at the one place
 * that supplies a value.
 */
export interface CypressBinaryCheckIdentity {
  readonly id: CheckId;
  readonly category: CheckCategory;
  /** What an unfavourable answer means. Declared once, with every other check. */
  readonly severity: CheckSeverity;
  /** The diagnostic code a finding from this check reports under. */
  readonly code: CheckFinding["code"];
  /** The check that must have passed for this one to be meaningful, when one exists. */
  readonly precondition?: CheckId;
}

/* -------------------------------------------------------------------------- */
/* Reasons this check reports                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The subset of problem reasons DEP-008 owns.
 *
 * Four states, four different fixes — which is the entire reason this check is not a boolean:
 *   NOT_INSTALLED  → download the binary
 *   INACCESSIBLE   → the binary is there but unusable (permissions, architecture, quarantine)
 *   UNVERIFIED     → we could not finish checking; nothing is known about the binary
 *   UNKNOWN        → we could not even determine where the cache is
 *
 * Held as a frozen list as well as a type, so the narrowing helper below proves membership without a
 * cast: narrowing by assertion would let a future reason slip into the fallback silently.
 */
const BINARY_REASONS = [
  "CYPRESS_BINARY_NOT_INSTALLED",
  "CYPRESS_BINARY_INACCESSIBLE",
  "CYPRESS_BINARY_UNVERIFIED",
  "CYPRESS_BINARY_UNKNOWN",
] as const satisfies readonly CypressProblemReason[];

type BinaryReason = (typeof BINARY_REASONS)[number];

function isBinaryReason(reason: string): reason is BinaryReason {
  return BINARY_REASONS.some((candidate) => candidate === reason);
}

/**
 * The facts a message may quote.
 *
 * Paths arrive already abbreviated to `~` by the binary module, so quoting them cannot publish a home
 * directory into a shared CI log. `probeDetail` is trimmed and length-capped upstream for the same
 * reason: it is Cypress's own output, and a diagnostic quotes it rather than dumping it.
 *
 * Everything is `string | null` rather than optional. A published finding is serialised to JSON, where
 * `undefined` disappears and erases the difference between "we looked and found nothing" and "the
 * field was never set".
 */
interface BinaryFacts {
  readonly version: string | null;
  readonly cacheRoot: string | null;
  readonly expectedPath: string | null;
  readonly verifiedBy: string | null;
  readonly probeDetail: string | null;
  /** Set only for skipped results: the check that must be fixed first. */
  readonly blockedBy: string | null;
}

/* -------------------------------------------------------------------------- */
/* The check, as data                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Builds the definition.
 *
 * No collector, no clock, no port: the check needs one fact group and answers from it. That is what
 * "a check is data" buys — the definition can be constructed in a test with a literal identity and
 * asserted against with no container.
 *
 * `precondition` expresses the ordering the skip message used to explain in prose. A binary cache is
 * keyed by version, so a version that could not be established leaves nothing to inspect; the runner
 * turns a failed or skipped predecessor into a skip here, and this check is never asked to report a
 * consequence as a second problem.
 */
export function createCypressBinaryCheck(
  identity: CypressBinaryCheckIdentity,
): CheckDefinition {
  return {
    id: identity.id,
    category: identity.category,
    title: "Cypress binary availability",
    purpose:
      "Confirm that a downloadable Cypress binary exists for the installed version and can be executed.",
    procedure:
      "Inspect the Cypress cache for the installed version and report its usability.",
    requires: [FactGroup.Cypress],
    ...(identity.precondition === undefined
      ? {}
      : { precondition: identity.precondition }),
    severity: identity.severity,
    scenarios: [
      "binary-present",
      "binary-absent",
      "binary-not-executable",
      "verification-inconclusive",
      "cache-location-unknown",
      "precondition-unsatisfied",
    ],
    evaluate: (facts: CheckFacts) =>
      evaluateBinary(present(facts.cypress), identity),
  };
}

/**
 * Maps the gathered conditions to a verdict.
 *
 * One finding per run. A binary is either usable, missing, unusable or unknown; emitting one finding
 * per state would let a user fix the loudest one and assume the rest.
 */
function evaluateBinary(
  facts: CypressFacts,
  identity: CypressBinaryCheckIdentity,
): CheckVerdict {
  const result = pickBinaryResult(facts.results);

  // The happy path: the shared value, allocated once at module load, and no finding to word. Returning
  // here is also what makes every finding below guaranteed to have a remediation.
  if (result.status === "pass") return PASS;

  const binaryFacts: BinaryFacts = {
    version: readEvidenceText(result, "detected"),
    cacheRoot: readEvidenceText(result, "cacheRoot"),
    expectedPath: readEvidenceText(result, "expectedPath"),
    verifiedBy: readEvidenceText(result, "verifiedBy"),
    probeDetail: readEvidenceText(result, "probeDetail"),
    blockedBy: result.prerequisite?.checkId ?? null,
  };

  const text = guidance.forResult(result, binaryFacts);

  // `fail` is the only verdict that names a broken condition. Everything else — could not establish, or
  // not evaluated because a prerequisite failed — is a `warn`, because a question we failed to answer
  // must not block work we can still perform. The finding says which of the two it was.
  return {
    verdict: result.status === "fail" ? "fail" : "warn",
    finding: toFinding(result, text, binaryFacts, identity),
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
function pickBinaryResult(
  results: readonly CypressConditionResult[],
): CypressConditionResult {
  const own = results.find((candidate) => candidate.checkId === "DEP-008");

  if (own === undefined) {
    throw new Error(
      "Cypress health assessment did not return a DEP-008 result",
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
 * Three properties come from the reporting contract: `code` (from the injected identity, so the finding
 * is filed under a code the catalogue and the filters know), `severity` (the check's declared severity —
 * one authority for "how badly does this matter"), and `explanation` (the sentence a person reads).
 * `remediation` is required and non-nullable, which the type system now guarantees rather than this
 * function hoping for it: only non-pass conditions reach here, and each of those has a next step.
 *
 * Evidence is allowlisted rather than spread. The fields below are the ones a reader needs in order to
 * act (which version, which cache, which path, verified how) plus the blocker for a skipped result — and
 * nothing else leaves the process, because the internal contract will keep growing and each growth
 * deserves its own decision.
 */
function toFinding(
  result: CypressConditionResult,
  text: FindingText,
  facts: BinaryFacts,
  identity: CypressBinaryCheckIdentity,
): CheckFinding {
  return Object.freeze({
    code: identity.code,
    severity: identity.severity,
    explanation: text.explanation,
    remediation: text.remediation,
    evidence: Object.freeze({
      detected: facts.version,
      cacheRoot: facts.cacheRoot,
      expectedPath: facts.expectedPath,
      // "static-cache-inspection" versus "cypress-verify" is the difference between "the file has
      // execute bits" and "Cypress started it". Publishing it keeps the claim calibrated instead of
      // overstating what was proven.
      verifiedBy: facts.verifiedBy,
      probeDetail: facts.probeDetail,
      blockedBy: facts.blockedBy,
      blockedByReason: result.prerequisite?.reason ?? null,
    }),
  });
}

/* -------------------------------------------------------------------------- */
/* Guidance                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Wording for a finding.
 *
 * `remediation` is non-nullable on purpose: a finding exists only when something needs attention, and a
 * finding that cannot tell the reader what to do is a dead end. The "satisfied check stays quiet" case
 * is not a quiet finding — it is no finding at all, returned as `PASS` before any wording is produced.
 */
interface FindingText {
  readonly explanation: string;
  readonly remediation: string;
}

interface BinaryGuidance {
  readonly forResult: (
    result: CypressConditionResult,
    facts: BinaryFacts,
  ) => FindingText;
}

/**
 * Optional sentence fragments.
 *
 * Each carries its own leading space, because call sites splice them directly after a word:
 * `present${atPath(...)}` must read "present at /x". Keeping the space here, once, is what stops the
 * same formatting bug reappearing at every call site.
 */
const atPath = (path: string | null): string =>
  path === null ? "" : ` at ${path}`;
const inCache = (cacheRoot: string | null): string =>
  cacheRoot === null ? "" : ` (${cacheRoot})`;
const detailSuffix = (detail: string | null, style: ":" | "("): string => {
  if (detail === null) return "";
  return style === ":" ? `: ${detail}` : ` (${detail})`;
};

/**
 * The wording, keyed by *reason* rather than by finding.
 *
 * The same state deserves the same next step everywhere, and different states must never receive the
 * same sentence. The map is a total `Record` over the reasons this check owns, so adding a reason
 * without writing its message is a compile error instead of a vague fallback reaching users.
 *
 * Every remediation is a command the user runs themselves. None is executed by QAT, and none mutates a
 * cache silently.
 */
const messages: Record<BinaryReason, (facts: BinaryFacts) => FindingText> = {
  CYPRESS_BINARY_NOT_INSTALLED: (facts) => ({
    explanation: `Cypress ${facts.version ?? "(installed version)"} is installed as a package, but no binary for that version exists in the Cypress cache${inCache(facts.cacheRoot)}. The package and its binary are downloaded separately, so this is usually a skipped post-install step or an offline, read-only CI image.`,
    remediation: `Download the binary for the installed version, then re-run \`qat doctor\`:
  npx cypress install
If the cache location is not writable in this environment, point it somewhere writable first:
  export CYPRESS_CACHE_FOLDER="$HOME/.cache/cypress-cache"`,
  }),

  CYPRESS_BINARY_INACCESSIBLE: (facts) => ({
    explanation: `A Cypress binary for ${facts.version ?? "(installed version)"} exists${atPath(facts.expectedPath)} but cannot be executed${detailSuffix(facts.probeDetail, ":")}. The usual causes are a missing execute permission, a binary built for a different CPU architecture (for example arm64 versus x64), or an operating-system security quarantine.`,
    remediation: `Reinstall the binary for this platform:
  npx cypress install --force
If it still fails, confirm the platform the binary was built for matches this machine:
  node -p process.arch
On macOS a quarantined bundle may also need:
  xattr -dr com.apple.quarantine "${facts.expectedPath ?? "~/.cache/Cypress/<version>/Cypress.app"}"`,
  }),

  // "Could not finish checking" says nothing about the binary. Presenting this as a failure would be a
  // fabricated finding, and fabricated findings are how a doctor loses its audience.
  CYPRESS_BINARY_UNVERIFIED: (facts) => ({
    explanation: `A Cypress binary for ${facts.version ?? "(installed version)"} appears to be present${atPath(facts.expectedPath)}, but verification could not complete${detailSuffix(facts.probeDetail, "(")}. QAT cannot confirm the binary is usable, and it will not guess.`,
    remediation: `Run the verification directly to see the full output, then re-run \`qat doctor\`:
  npx cypress verify`,
  }),

  CYPRESS_BINARY_UNKNOWN: (facts) => ({
    explanation: `QAT could not determine where Cypress stores binaries in this environment, so no binary could be inspected for ${facts.version ?? "the installed version"}. This usually means the platform is unrecognised, the profile directory is unset, or the cache override is a relative path.`,
    remediation: `Set the cache folder to an absolute path, then re-run \`qat doctor\`:
  export CYPRESS_CACHE_FOLDER="$HOME/.cache/Cypress"`,
  }),
};

const guidance: BinaryGuidance = {
  forResult: (result, facts) => {
    // A skip is a statement about order, not a finding about Cypress. Pointing at the blocking check
    // keeps one problem to one instruction, in the finding that actually observed it.
    if (result.status === "skipped") {
      const blockedBy = facts.blockedBy ?? "DEP-004";

      return {
        explanation: `Not evaluated because ${blockedBy} could not establish a usable Cypress version. The binary cache is keyed by version, so there is no path to inspect yet.`,
        remediation: `Resolve ${blockedBy} first — that finding names the exact next step.`,
      };
    }

    if (isBinaryReason(result.reason)) {
      return messages[result.reason](facts);
    }

    // Unknown reasons fall back rather than throwing: the condition's status still tells the reader how
    // serious it is, and a report that admits it cannot describe the problem is more useful than a
    // crash.
    return {
      explanation:
        "The Cypress binary check reported a condition it could not describe.",
      remediation:
        "Verify the installation manually, then re-run `qat doctor`:\n  npx cypress verify",
    };
  },
};
