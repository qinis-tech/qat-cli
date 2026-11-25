/**
 * Contracts for runtime (engine) compatibility.
 *
 * This module is the module's VOCABULARY: the shared nouns every other file
 * speaks — the requirement, the parsed version, the verdict. It contains no
 * parsing, no policy and — deliberately — no imports at all.
 *
 * Why zero imports is a rule and not an accident:
 *
 *   • It cannot fail to resolve. The most common way this file breaks is an
 *     unresolved type import, which the compiler then reports as a confusing
 *     union/`any` complaint several lines later instead of naming the missing
 *     module. A leaf module has no such failure mode.
 *   • It cannot create an import cycle, now or after any later refactor. Every
 *     other file in `core/compatibility` points at this one, so the graph can
 *     only ever run in one direction.
 *   • It keeps the vocabulary in a single place. If the shape of a parsed
 *     version changes, it changes here, and the compiler walks the dependants.
 *
 * The design rule this file enforces:
 *
 *   A compatibility decision has THREE outcomes — satisfied, unsatisfied and
 *   indeterminate — and it is impossible to represent a fourth, contradictory
 *   one. "I could not read the version" is a first-class outcome, because
 *   treating it as success is how a green build ships on an untested runtime.
 *
 * Two requirement SOURCES exist and are never merged: the runtime QAT itself
 * needs, and any additional runtime requirement declared by the project's
 * Cypress release. They have different owners and different urgency, so each
 * produces its own decision and its own finding.
 *
 * Nothing in here knows about diagnostic identifiers, severities or output
 * formatting — those are reporting concerns. The domain decides; the reporter
 * renders.
 */

/* -------------------------------------------------------------------------- */
/* Parsed runtime version                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A parsed Node.js runtime version.
 *
 * Declared here rather than alongside the parser because it is the value every
 * other file in this module passes around: contracts describes it, `version.ts`
 * builds and orders it, `range.ts` compares against it, `policy.ts` reports it.
 * Keeping the declaration dependency-free is what makes that sharing safe.
 *
 * `raw` is retained deliberately. A diagnostic that reports "20.11.1" when the
 * interpreter actually said "v20.11.1-rc.1" is a diagnostic people stop
 * trusting, and the original text is also what a user will paste into a search
 * engine or an issue tracker.
 */
export interface NodeVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /**
   * Pre-release identifiers, e.g. `["rc", 1]` for `21.0.0-rc.1`.
   * Empty for a released version. Numeric identifiers are stored as numbers so
   * that comparison is numeric rather than lexical.
   */
  readonly prerelease: readonly (string | number)[];
  /** The input exactly as received (trimmed), for evidence and attribution. */
  readonly raw: string;
}

/* -------------------------------------------------------------------------- */
/* Requirement                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Who owns a runtime requirement.
 *
 * Used to keep decisions attributable: a QAT blocker is fixed by the operator
 * (or by us), whereas a Cypress mismatch is a project-level decision.
 */
export type RuntimeRequirementSource = "qat" | "cypress";

/**
 * Severity of a failed requirement, as approved by policy.
 *
 * Attached to the *requirement* rather than decided by the check, so that
 * changing how strict we are is a policy edit rather than a code edit. QAT's own
 * runtime is blocking (`error`); a project Cypress advisory is `warning` until
 * those bounds are formally approved.
 *
 * Deliberately narrower than the diagnostic severity union: policy may choose to
 * block or to warn, and nothing else. Informational outcomes are already covered
 * by the `indeterminate` status.
 */
export type UnsatisfiedSeverity = "error" | "warning";

/**
 * A single, immutable statement of support: "versions matching `range` are
 * supported, and failing that is `severityWhenUnsatisfied`".
 *
 * Instances are produced once per source and frozen by the resolver; treat them
 * as values, never as mutable configuration. A requirement carries its own
 * provenance so that every downstream message can point at the authority the
 * user can go and read.
 */
export interface RuntimeRequirement {
  /** Owner of the requirement. Decides attribution and default severity. */
  readonly source: RuntimeRequirementSource;

  /**
   * The supported range, exactly as its owner declared it.
   *
   * Never re-typed, normalised or inlined by a consumer: if this string and the
   * authority ever disagree, one of them is lying, and the only way to notice is
   * to keep the original text in the evidence trail.
   *
   * An empty string is meaningful, not a bug to be patched: it means the
   * authority declared nothing, and it is reported as an unreadable policy
   * rather than silently replaced by a default.
   */
  readonly range: string;

  /**
   * Where `range` came from, in a form a user can act on — for example
   * `package.json#engines.node`. Never empty; it is the answer to "says who?".
   */
  readonly origin: string;

  /** Approved consequence of not satisfying this requirement. */
  readonly severityWhenUnsatisfied: UnsatisfiedSeverity;
}

/* -------------------------------------------------------------------------- */
/* Decision                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Why a decision was reached.
 *
 * Reasons are grouped by the status they imply, and the grouping is deliberate:
 * `below-minimum`, `above-maximum` and `outside-range` exist so remediation can
 * say "your runtime is too old", "too new" or "this line is not supported at all"
 * instead of the technically true but useless "not in range". A user cannot
 * choose between three different fixes from one message.
 */
export type SatisfiedReason = "within-range";

export type UnsatisfiedReason =
  /** Detected version is lower than every supported alternative. */
  | "below-minimum"
  /** Detected version is higher than every supported alternative. */
  | "above-maximum"
  /**
   * Version sits between supported alternatives without matching any of them,
   * e.g. `<19 || >=22` evaluated at 20.0.0.
   *
   * Distinct from the two cases above because the fix differs: neither
   * "upgrade" nor "go back to LTS" is the answer — the supported lines are
   * explicitly non-contiguous, so the user has to move onto one of the tested
   * lines rather than simply to "a newer version".
   */
  | "outside-range"
  /** Version is a pre-release, and the policy names no pre-release it accepts. */
  | "pre-release-not-listed";

export type IndeterminateReason =
  /** No version was reported at all (adapter returned nothing). */
  | "runtime-version-missing"
  /** A version was reported but is not a MAJOR.MINOR.PATCH tuple we can trust. */
  | "runtime-version-unreadable"
  /** The policy itself could not be interpreted, so no comparison is meaningful. */
  | "policy-range-unreadable";

export type CompatibilityReason =
  SatisfiedReason | UnsatisfiedReason | IndeterminateReason;

/**
 * Outcome of a comparison.
 *
 * `indeterminate` is not an error and not a pass: it means the question could
 * not be answered. It is reported so the user knows, and it never counts as a
 * clean result, because silence must not be mistaken for consent.
 */
export type CompatibilityStatus = "satisfied" | "unsatisfied" | "indeterminate";

/** The runtime matches the requirement. */
export interface SatisfiedVerdict {
  readonly status: "satisfied";
  readonly reason: SatisfiedReason;
  /** The requirement that was evaluated, carried through for attribution. */
  readonly requirement: RuntimeRequirement;
  /** Always present here: we could not claim a match without having read it. */
  readonly detected: NodeVersion;
}

/** The runtime was read and does not match the requirement. */
export interface UnsatisfiedVerdict {
  readonly status: "unsatisfied";
  readonly reason: UnsatisfiedReason;
  readonly requirement: RuntimeRequirement;
  /** Always present: "does not match" requires a value to have been read. */
  readonly detected: NodeVersion;
}

/**
 * The question could not be answered.
 *
 * `detected` is present only when the version was readable but the *policy* was
 * not — the user still benefits from seeing which runtime is running. The
 * optionality is the type doing real work: it is what forces every consumer to
 * handle "we never saw a version" instead of assuming one into existence.
 */
export interface IndeterminateVerdict {
  readonly status: "indeterminate";
  readonly reason: IndeterminateReason;
  readonly requirement: RuntimeRequirement;
  readonly detected: NodeVersion | undefined;
}

/**
 * The result of evaluating one requirement against one runtime.
 *
 * Discriminated by `status`, so consumers must handle all three outcomes and the
 * compiler rejects impossible combinations such as "satisfied, because it is too
 * old". Each verdict is immutable: a decision is evidence, and evidence that can
 * be edited after the fact is not evidence.
 */
export type CompatibilityVerdict =
  SatisfiedVerdict | UnsatisfiedVerdict | IndeterminateVerdict;

/* -------------------------------------------------------------------------- */
/* Reason → status authority                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The single authority mapping a reason to the status it implies.
 *
 * Kept as a `satisfies`-checked record so that adding a new reason is a compile
 * error until its status is decided. That is the whole point: the earlier we are
 * forced to answer "is this a pass, a failure, or an unknown?", the less likely a
 * new reason quietly lands in the wrong bucket. It is also why adding
 * `outside-range` to the reason union cannot be forgotten here — the compiler
 * refuses to build until this table agrees.
 */
export const REASON_STATUS = {
  "within-range": "satisfied",
  "below-minimum": "unsatisfied",
  "above-maximum": "unsatisfied",
  "outside-range": "unsatisfied",
  "pre-release-not-listed": "unsatisfied",
  "runtime-version-missing": "indeterminate",
  "runtime-version-unreadable": "indeterminate",
  "policy-range-unreadable": "indeterminate",
} as const satisfies Record<CompatibilityReason, CompatibilityStatus>;

/**
 * Classifies a reason.
 *
 * Callers should normally build verdicts through `evaluateRequirement`, which is
 * the one place that decides; this helper exists so the classifier itself and the
 * tests can derive status from reason rather than duplicating a lookup table.
 */
export function statusOf(reason: CompatibilityReason): CompatibilityStatus {
  return REASON_STATUS[reason];
}

/* -------------------------------------------------------------------------- */
/* Narrowing helpers                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Narrowing helpers.
 *
 * They look trivial, but they keep every consumer (exit-code mapping, JSON
 * rendering, summary aggregation) reading the same names instead of comparing
 * string literals in a dozen places — and they make adding a status a compile
 * error at each switch that forgot about it.
 */
export function isSatisfied(
  verdict: CompatibilityVerdict,
): verdict is SatisfiedVerdict {
  return verdict.status === "satisfied";
}

export function isUnsatisfied(
  verdict: CompatibilityVerdict,
): verdict is UnsatisfiedVerdict {
  return verdict.status === "unsatisfied";
}

export function isIndeterminate(
  verdict: CompatibilityVerdict,
): verdict is IndeterminateVerdict {
  return verdict.status === "indeterminate";
}
