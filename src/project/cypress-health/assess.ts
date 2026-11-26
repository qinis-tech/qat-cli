/**
 * Assessment of Cypress health.
 *
 * Everything observed about Cypress in one project goes in; the three diagnostic conditions come out, each with a
 * status, a severity, a reason and display-safe evidence. This module is **pure**: no filesystem, no process, no clock.
 * Every input arrives on the immutable snapshot, which is what makes each mandatory installation state testable from a
 * fixture without a single mock.
 *
 * The rule this file exists to enforce is the *prerequisite* rule:
 *
 *   A fact whose prerequisite was not established is reported as `skipped` with the prerequisite named — never as
 *   `fail`, and never as `pass`.
 *
 * That matters more than it looks. "Cypress 0.0.0 is incompatible" is a fabricated claim when nothing is installed;
 * "version 13.6.0 is unsupported" is worse still, because it sends someone to change a version they never had. `skipped`
 * says the truth: this question was not answered, and here is the one thing to fix first.
 *
 * Three statuses are kept apart on purpose:
 *
 *   skipped       — a prerequisite was not established, so we did not look.
 *   indeterminate — we looked, and could not establish the fact.
 *   fail          — we looked, and the fact is false.
 *
 * Severity is independent of status, because they answer different questions: status says *what is true*, severity says
 * *how urgent it is*. A ghost install (present but not declared) is genuinely true and worth a warning, not a blocker.
 */

import type {
  CheckPrerequisite,
  CypressBinaryEvidence,
  CypressCondition,
  CypressConditionResult,
  CypressDiagnosticId,
  CypressDiagnosticStatus,
  CypressEvidenceDetail,
  CypressHealthEvidence,
  CypressProblemReason,
  CypressReason,
  CypressResolutionFailure,
  DiagnosticSeverity,
} from "./contracts.js";
import { isFailed, isHealthy, isSkipped } from "./contracts.js";

/* -------------------------------------------------------------------------- */
/* Compatibility evaluation                                                    */
/* -------------------------------------------------------------------------- */

/**
 * What this module needs from version evaluation — nothing more.
 *
 * Narrowed to two fields deliberately. The full verdict type is richer (detected version, requirement provenance), but
 * assessment only decides *which reason and severity follow from the outcome*, so the smaller the surface, the fewer
 * reasons this file has to change when the engine evolves.
 */
export interface CompatibilityEvaluation {
  readonly status: "satisfied" | "unsatisfied" | "indeterminate";
  /** Shared-engine reason, mapped to a Cypress problem reason below. */
  readonly reason: string;
}

/**
 * Compares a detected version against a declared range.
 *
 * Injected with a default so production code reuses the one semver engine the product owns, while tests can drive every
 * branch — including "the declared range itself is unparsable" — without reaching into the engine's internals.
 */
export type CompatibilityEvaluator = (input: {
  readonly range: string;
  readonly version: string;
}) => CompatibilityEvaluation;

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

export interface AssessCypressHealthOptions {
  readonly evaluateCompatibility?: CompatibilityEvaluator;
}

/**
 * Assesses all three Cypress checks from one observation snapshot.
 *
 * Always returns exactly three results, in dependency order. Returning a fixed set — rather than omitting checks that
 * could not run — is what allows a consumer to print "skipped because DEP-003 failed" instead of leaving a silent gap
 * the reader has to notice.
 */
export function assessCypressHealth(
  evidence: CypressHealthEvidence,
  options: AssessCypressHealthOptions = {},
): readonly CypressConditionResult[] {
  const dependencyResult = assessCypressDependency(evidence);
  const compatibilityResult = assessCypressCompatibility(
    evidence,
    options.evaluateCompatibility,
  );

  return Object.freeze([
    dependencyResult,
    compatibilityResult,
    assessCypressBinary(evidence, dependencyResult, compatibilityResult),
  ]);
}

/* -------------------------------------------------------------------------- */
/* DEP-003 — declaration and installation                                      */
/* -------------------------------------------------------------------------- */

/**
 * Answers: does this project declare Cypress, and is the declared package here?
 *
 * Precedence when both answers are awkward:
 *   • Installed but not declared — the project *works*, it is merely inconsistent. Warning, because reporting it as
 *     "not declared" (an error) would overstate it.
 *   • Neither declared nor installed — the actionable blocker: add the dependency, then install.
 *   • Declared but not resolvable — "you have not run the install yet", which is a different instruction from "you never
 *     declared it".
 */
function assessCypressDependency(
  evidence: CypressHealthEvidence,
): CypressConditionResult {
  const { declaration, resolution } = evidence;

  // Ghost install: a package present on disk that no clean install would reproduce.
  if (!declaration.declared && resolution.outcome === "resolved") {
    return toResult({
      checkId: "DEP-003",
      condition: "installed",
      status: "fail",
      severity: "warning", // non-blocking: the project can run today
      reason: "CYPRESS_INSTALLED_BUT_UNDECLARED",
      evidence: {
        ...declarationEvidence(evidence),
        installedVersion: resolution.version,
      },
    });
  }

  if (!declaration.declared) {
    return toResult({
      checkId: "DEP-003",
      condition: "declared",
      status: "fail",
      severity: "error",
      reason: "CYPRESS_NOT_DECLARED",
      evidence: declarationEvidence(evidence),
    });
  }

  if (resolution.outcome === "resolved") {
    return toResult({
      checkId: "DEP-003",
      condition: "installed",
      status: "pass",
      severity: "information",
      reason: "CYPRESS_OK",
      evidence: {
        ...declarationEvidence(evidence),
        packageDirectory: resolution.packageDirectory,
        installedVersion: resolution.version,
      },
    });
  }

  const failure = explainResolutionFailure(resolution.failure);

  return toResult({
    checkId: "DEP-003",
    condition: failure.condition,
    status: "fail",
    severity: failure.severity,
    reason: failure.reason,
    evidence: declarationEvidence(evidence),
  });
}

/**
 * Maps a resolution failure to its message reason.
 *
 * Three failures, three fixes:
 *   not-resolvable               → the install never happened (run it)
 *   rejected-outside-project     → the resolved Cypress is not this project's (fix the resolver or the hoisting)
 *   unreadable-package-manifest  → the install is damaged (reinstall)
 * Deliberately not collapsed into "Cypress missing": each leads to a different action, and wrong remediation is worse
 * than vague remediation.
 */
function explainResolutionFailure(failure: CypressResolutionFailure | null): {
  readonly reason: CypressProblemReason;
  readonly severity: DiagnosticSeverity;
  readonly condition: CypressCondition;
} {
  switch (failure) {
    case "rejected-outside-project":
      return {
        reason: "CYPRESS_RESOLUTION_REJECTED_OUTSIDE_PROJECT",
        severity: "error",
        condition: "installed",
      };

    case "unreadable-package-manifest":
      return {
        reason: "CYPRESS_MANIFEST_UNREADABLE",
        severity: "error",
        condition: "installed",
      };

    case "not-resolvable":
    default:
      return {
        reason: "CYPRESS_DECLARED_NOT_INSTALLED",
        severity: "error",
        condition: "installed",
      };
  }
}

/* -------------------------------------------------------------------------- */
/* DEP-004 — version identified and compatible                                 */
/* -------------------------------------------------------------------------- */

/**
 * Answers: can we read a version, and is it inside the range this adapter supports?
 *
 * Severity split, which is the entire point of this check:
 *   below the minimum  → Error    it cannot work
 *   above the maximum  → Warning  it probably works and nobody has proven it
 *   pre-release        → Warning  support is only claimed for released versions
 * Blocking on an untested-but-newer major would fail QAT for a version that is almost certainly fine; blessing it
 * silently would be a claim we cannot back.
 */
function assessCypressCompatibility(
  evidence: CypressHealthEvidence,
  evaluateCompatibility: CompatibilityEvaluator | undefined,
): CypressConditionResult {
  const { resolution, compatibility } = evidence;

  // Prerequisite: an installed package. Without one there is no version to judge.
  if (resolution.outcome !== "resolved") {
    return skipped(
      "DEP-004",
      "version-identified",
      {
        checkId: "DEP-003",
        // Reuse the *actual* reason the prerequisite failed, so the skip line can read "skipped — DEP-003 not
        // established (Cypress is not installed)".
        reason: prerequisiteReasonFor(evidence),
      },
      { supported: compatibility.supportedRange },
    );
  }

  if (resolution.version === null) {
    return toResult({
      checkId: "DEP-004",
      condition: "version-identified",
      status: "indeterminate",
      severity: "warning",
      reason: "CYPRESS_VERSION_UNKNOWN",
      evidence: {
        packageDirectory: resolution.packageDirectory,
        supported: compatibility.supportedRange,
      },
    });
  }

  const evaluator = evaluateCompatibility ?? defaultCompatibilityEvaluator;
  const evaluation = evaluator({
    range: compatibility.supportedRange,
    version: resolution.version,
  });

  const shared: CypressEvidenceDetail = {
    detected: resolution.version,
    supported: compatibility.supportedRange,
    supportedOrigin: compatibility.origin,
  };

  if (evaluation.status === "indeterminate") {
    // Covers both "the version cannot be parsed" and "the declared range cannot be parsed". Both mean the question was
    // not answered. Never a pass.
    return toResult({
      checkId: "DEP-004",
      condition: "version-compatible",
      status: "indeterminate",
      severity: "warning",
      reason: "CYPRESS_VERSION_UNKNOWN",
      evidence: { ...shared, evaluatorReason: evaluation.reason },
    });
  }

  if (evaluation.status === "satisfied") {
    return toResult({
      checkId: "DEP-004",
      condition: "version-compatible",
      status: "pass",
      severity: "information",
      reason: "CYPRESS_OK",
      evidence: shared,
    });
  }

  const incompatibility = classifyIncompatibility(evaluation.reason);

  return toResult({
    checkId: "DEP-004",
    condition: "version-compatible",
    status: "fail",
    severity: incompatibility.severity,
    reason: incompatibility.reason,
    evidence: { ...shared, evaluatorReason: evaluation.reason },
  });
}

/**
 * Classifies an unsatisfied verdict into a reason and severity.
 *
 * The default is `unknown`-style handling rather than "below minimum": if a future version engine reports a reason we do
 * not recognise, the safe move is to admit we could not classify it — not to guess in the direction that blocks a build.
 */
function classifyIncompatibility(reason: string): {
  readonly reason: CypressProblemReason;
  readonly severity: DiagnosticSeverity;
} {
  switch (reason) {
    case "below-minimum":
      return { reason: "CYPRESS_VERSION_BELOW_MINIMUM", severity: "error" };

    case "above-maximum":
      return {
        reason: "CYPRESS_VERSION_ABOVE_TESTED_MAXIMUM",
        severity: "warning",
      };

    case "pre-release-not-listed":
      return { reason: "CYPRESS_VERSION_PRERELEASE", severity: "warning" };

    default:
      return { reason: "CYPRESS_VERSION_UNKNOWN", severity: "warning" };
  }
}

/* -------------------------------------------------------------------------- */
/* DEP-008 — binary installed and accessible                                   */
/* -------------------------------------------------------------------------- */

/**
 * Answers: is there a binary for this version, and can it be run?
 *
 * The prerequisite is DEP-004's *version*, not DEP-003's package: the Cypress cache is keyed by version, so without a
 * version there is no path to look at. A skip here therefore points at DEP-004, the question that must be answered
 * first.
 *
 * `accessible` from static inspection is a pass, with `verifiedBy` carried in evidence so a reader knows the claim is
 * "the file exists with the right bits" rather than "Cypress started successfully". A probe that could not complete
 * downgrades to indeterminate — never to a pass, never to a fabricated failure.
 */
function assessCypressBinary(
  evidence: CypressHealthEvidence,
  dependency: CypressConditionResult,
  compatibility: CypressConditionResult,
): CypressConditionResult {
  const { resolution, binary } = evidence;

  // An incompatible or unknown version makes binary findings noise: the fix is to change the Cypress version, and that
  // changes the cache path under our feet.
  if (compatibility.status !== "pass") {
    return skipped(
      "DEP-008",
      "binary-installed",
      { checkId: "DEP-004", reason: toProblemReason(compatibility.reason) },
      { installed: resolution.version, ...deploymentHint(dependency) },
    );
  }

  // No evidence gathered: unknown platform, missing profile variable, a relative cache override, or a version that cannot
  // safely be a path segment.
  if (binary === null) {
    return toResult({
      checkId: "DEP-008",
      condition: "binary-installed",
      status: "indeterminate",
      severity: "warning",
      reason: "CYPRESS_BINARY_UNKNOWN",
      evidence: { detected: resolution.version, verifiedBy: null },
    });
  }

  const base = binaryEvidence(binary);

  // A probe ran and did not conclude. Indeterminate, because "could not finish verifying" says nothing about the binary
  // itself.
  if (
    binary.verifiedBy === "cypress-verify" &&
    binary.probeDetail !== null &&
    binary.state !== "not-executable"
  ) {
    return toResult({
      checkId: "DEP-008",
      condition: "binary-accessible",
      status: "indeterminate",
      severity: "warning",
      reason: "CYPRESS_BINARY_UNVERIFIED",
      evidence: base,
    });
  }

  switch (binary.state) {
    case "accessible":
      return toResult({
        checkId: "DEP-008",
        condition: "binary-accessible",
        status: "pass",
        severity: "information",
        reason: "CYPRESS_OK",
        evidence: base,
      });

    case "not-executable":
      return toResult({
        checkId: "DEP-008",
        condition: "binary-accessible",
        status: "fail",
        severity: "error",
        reason: "CYPRESS_BINARY_INACCESSIBLE",
        evidence: base,
      });

    case "absent":
      return toResult({
        checkId: "DEP-008",
        condition: "binary-installed",
        status: "fail",
        severity: "error",
        reason: "CYPRESS_BINARY_NOT_INSTALLED",
        evidence: base,
      });

    case "unknown":
    default:
      return toResult({
        checkId: "DEP-008",
        condition: "binary-installed",
        status: "indeterminate",
        severity: "warning",
        reason: "CYPRESS_BINARY_UNKNOWN",
        evidence: base,
      });
  }
}

/* -------------------------------------------------------------------------- */
/* Aggregation                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The worst status across the three checks.
 *
 * Skips and indeterminate results are *not* collapsed into pass. A summary that reports "2 passed, 1 skipped" while
 * implying health is exactly how an unrun check becomes a green build.
 *
 * An empty set is `indeterminate`, not `pass`: `[].every(isHealthy)` is vacuously true, and a summary of nothing is not a
 * clean bill of health — it is the absence of a verdict.
 */
export function overallCypressStatus(
  results: readonly CypressConditionResult[],
): CypressDiagnosticStatus {
  if (results.length === 0) return "indeterminate";
  if (results.some(isFailed)) return "fail";
  if (results.some(isSkipped)) return "skipped";
  if (results.some((entry) => entry.status === "indeterminate"))
    return "indeterminate";
  if (results.every(isHealthy)) return "pass";

  return "indeterminate";
}

/* -------------------------------------------------------------------------- */
/* Constructors and evidence helpers                                           */
/* -------------------------------------------------------------------------- */

interface ResultInput {
  readonly checkId: CypressDiagnosticId;
  readonly condition: CypressCondition;
  readonly status: CypressDiagnosticStatus;
  readonly severity: DiagnosticSeverity;
  readonly reason: CypressReason;
  readonly evidence: CypressEvidenceDetail;
}

/**
 * Single construction point for a non-skipped result.
 *
 * The object is annotated before freezing so each property is contextually typed by the contract, and the *evidence* is
 * frozen too — not just the result that points at it. A finding is shared with the report, the JSON export and the
 * history store, so a shallow freeze would let one consumer rewrite what the next one reads while every type still said
 * `readonly`.
 *
 * The evidence is frozen as a copy: the object handed out is then not the same object any helper still holds, so a future
 * helper that keeps a reference cannot freeze, extend or mutate what was published.
 */
function toResult(input: ResultInput): CypressConditionResult {
  const assembled: CypressConditionResult = {
    checkId: input.checkId,
    condition: input.condition,
    status: input.status,
    severity: input.severity,
    reason: input.reason,
    prerequisite: null,
    evidence: Object.freeze({ ...input.evidence }),
  };

  return Object.freeze(assembled);
}

/**
 * A condition that was not evaluated because its prerequisite failed.
 *
 * Severity is `information`: a skip is not a finding about the project, it is a statement about the order in which
 * questions could be answered. Giving it a warning severity would count one missing installation twice and inflate the
 * apparent severity of a single problem.
 */
function skipped(
  checkId: CypressDiagnosticId,
  condition: CypressCondition,
  prerequisite: CheckPrerequisite,
  evidence: CypressEvidenceDetail,
): CypressConditionResult {
  const assembled: CypressConditionResult = {
    checkId,
    condition,
    status: "skipped",
    severity: "information",
    reason: "CYPRESS_VERSION_UNKNOWN",
    prerequisite: Object.freeze(prerequisite),
    evidence: Object.freeze({ ...evidence }),
  };

  return Object.freeze(assembled);
}

/**
 * Converts any reason into a problem reason.
 *
 * `CYPRESS_OK` is not a problem, so it can never describe a failed prerequisite; mapping it to "version unknown" keeps
 * the contract total without a type assertion and without a branch that could quietly return "fine".
 */
function toProblemReason(reason: CypressReason): CypressProblemReason {
  return reason === "CYPRESS_OK" ? "CYPRESS_VERSION_UNKNOWN" : reason;
}

/**
 * Why the DEP-003 prerequisite was not established, as a single reason.
 *
 * Derived from the same evidence DEP-003 itself used, so the two findings cannot disagree about what went wrong.
 */
function prerequisiteReasonFor(
  evidence: CypressHealthEvidence,
): CypressProblemReason {
  if (!evidence.declaration.declared) return "CYPRESS_NOT_DECLARED";

  return explainResolutionFailure(evidence.resolution.failure).reason;
}

/**
 * Declaration facts, flattened and display-safe.
 *
 * Only fields the evidence contract guarantees are read here. Richer observation detail — which manifest sections
 * mentioned Cypress, whether the declaration was malformed — lives with the collector and is used by the guidance layer
 * when it composes a message. Assessment decides status and severity; it does not chase optional detail.
 */
function declarationEvidence(
  evidence: CypressHealthEvidence,
): CypressEvidenceDetail {
  const { declaration } = evidence;

  return {
    declared: declaration.declared,
    declaredIn: declaration.declared ? declaration.field : null,
    declaredSpecifier: declaration.declared ? declaration.range : null,
  };
}

/**
 * Binary facts, flattened and display-safe.
 *
 * The key is `detected`, matching DEP-004 and the published evidence contract. It was `version` here once, which meant
 * the finding layer — reading `detected` for every check — published a binary finding with no version at all: a field that
 * exists in the type, is populated in the assessment, and silently disappears at the seam.
 *
 * `verifiedBy` is carried into every binary result because the difference between "a file with execute bits" and "Cypress
 * started it" is precisely the difference a reader needs in order to trust the verdict.
 */
function binaryEvidence(binary: CypressBinaryEvidence): CypressEvidenceDetail {
  return {
    detected: binary.version,
    cacheRoot: binary.cacheRoot,
    expectedPath: binary.expectedPath,
    verifiedBy: binary.verifiedBy,
    probeDetail: binary.probeDetail,
  };
}

/** Points at the failing dependency check when the binary check had to skip. */
function deploymentHint(
  dependency: CypressConditionResult,
): CypressEvidenceDetail {
  return dependency.status === "pass" ? {} : { blockedBy: dependency.checkId };
}

/* -------------------------------------------------------------------------- */
/* Default evaluator                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Default compatibility evaluator.
 *
 * Production wiring replaces this at the composition root with the shared version engine, so "supported range" has
 * exactly one implementation across the runtime, package-manager and Cypress checks. This fallback exists so the module is
 * usable and testable on its own, and it deliberately reports `indeterminate` rather than assuming support: an evaluator
 * that cannot judge must never answer "fine".
 */
export const defaultCompatibilityEvaluator: CompatibilityEvaluator = ({
  version,
}) => {
  // A conservative shape check only. Real range evaluation belongs to the shared engine, and duplicating it here is the
  // technical debt this design avoids.
  const looksLikeSemver = /^\d+\.\d+\.\d+(?:[-+].*)?$/.test(version);

  return looksLikeSemver
    ? { status: "indeterminate", reason: "no-evaluator-configured" }
    : { status: "indeterminate", reason: "version-not-parseable" };
};
