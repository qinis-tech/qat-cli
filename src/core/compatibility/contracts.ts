/**
 * Contracts for version compatibility — runtimes and tooling alike.
 *
 * This module is the module's VOCABULARY: the shared nouns every other file speaks —
 * the requirement, the parsed version, the verdict. It contains no parsing, no policy
 * and — deliberately — no imports at all.
 *
 * Why zero imports is a rule and not an accident:
 *
 *   • It cannot fail to resolve. The most common way a leaf type module breaks is an
 *     unresolved import, which the compiler then reports as a confusing `any` complaint
 *     several lines later instead of naming the missing module. A leaf module has no
 *     such failure mode.
 *   • It cannot create an import cycle, now or after any later refactor. Every other
 *     file in this module points at this one, so the graph can only ever run one way.
 *   • It keeps the vocabulary in a single place. If the shape of a parsed version
 *     changes, it changes here, and the compiler walks the dependants.
 *
 * The design rule this file enforces:
 *
 *   A compatibility decision has THREE outcomes — satisfied, unsatisfied and
 *   indeterminate — and it is impossible to represent a fourth, contradictory one.
 *   "I could not read the version" is a first-class outcome, because treating it as
 *   success is how a green build ships on an untested runtime.
 *
 * Requirements come from more than one owner, and owners are never merged. The runtime
 * QAT itself needs and a runtime bound declared for the project's Cypress release have
 * different owners and different urgency; so does the version of a package-manager
 * executable. Each source produces its own requirement, its own decision and its own
 * finding, even though one comparison engine serves them all.
 *
 * Nothing in here knows about diagnostic identifiers, severities or output formatting —
 * those are reporting concerns. The domain decides; the reporter renders.
 */

/* -------------------------------------------------------------------------- */
/* Parsed version                                                             */
/* -------------------------------------------------------------------------- */

/**
 * A parsed version.
 *
 * Declared here rather than alongside the parser because it is the value every other
 * file passes around: contracts describes it, `version.ts` builds and orders it,
 * `range.ts` compares against it, `policy.ts` reports it. Keeping the declaration
 * dependency-free is what makes that sharing safe.
 *
 * `raw` is retained deliberately. A diagnostic that reports "20.11.1" when the
 * interpreter actually said "v20.11.1-rc.1" is a diagnostic people stop trusting, and
 * the original text is also what a user will paste into a search engine or an issue
 * tracker.
 *
 * Field names are runtime-flavoured (`major`, `minor`, `patch`, `prerelease`) but the
 * shape is deliberately generic: a package-manager version such as `9.1.0` has exactly
 * the same anatomy, so one parser and one comparator serve every source.
 */
export interface NodeVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /**
   * Pre-release identifiers, e.g. `["rc", 1]` for `21.0.0-rc.1`.
   *
   * Empty for a released version. Numeric identifiers are stored as numbers so that
   * comparison is numeric rather than lexical — `"10" < "9"` as text, which is the
   * classic reason hand-rolled version checks accept the wrong version.
   */
  readonly prerelease: readonly (string | number)[];
  /** The input exactly as received (trimmed), for evidence and attribution. */
  readonly raw: string;
}

/* -------------------------------------------------------------------------- */
/* Requirement                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Who owns a requirement.
 *
 * Kept explicit because attribution is the difference between a blocker the operator
 * can fix, a project decision the team must make, and a toolchain installation:
 *
 *   qat               the runtime QAT itself needs — blocking, we rely on it
 *   cypress           a runtime bound declared for the project's Cypress release
 *   package-manager   the version of the installer executable the project expects
 *
 * Adding a source here is a deliberate act: every consumer that switches on the source
 * will fail to compile until it decides how to attribute the new one, which is exactly
 * the review conversation we want to have.
 */
export type VersionRequirementSource = "qat" | "cypress" | "package-manager";

/**
 * @deprecated Use {@link VersionRequirementSource}. Retained so existing call sites keep
 * compiling while the vocabulary widens beyond runtimes.
 */
export type RuntimeRequirementSource = VersionRequirementSource;

/**
 * Severity of a failed requirement, as approved by policy.
 *
 * Attached to the *requirement* rather than decided by the check, so that changing how
 * strict we are is a policy edit rather than a code edit. QAT's own runtime is blocking
 * (`error`); a project Cypress advisory, and a package-manager version mismatch, are
 * `warning` until those bounds are formally approved.
 *
 * Deliberately narrower than the diagnostic severity union: policy may choose to block
 * or to warn, and nothing else. Informational outcomes are already covered by the
 * `indeterminate` status.
 */
export type UnsatisfiedSeverity = "error" | "warning";

/**
 * A single, immutable statement of support: "versions matching `range` are supported,
 * and failing that is `severityWhenUnsatisfied`".
 *
 * Instances are produced once per source and frozen by the resolver; treat them as
 * values, never as mutable configuration. A requirement carries its own provenance so
 * that every downstream message can point at the authority the user can go and read.
 */
export interface VersionRequirement {
  /** Owner of the requirement. Decides attribution and default severity. */
  readonly source: VersionRequirementSource;

  /**
   * The supported range, exactly as its owner declared it.
   *
   * Never re-typed, normalised or inlined by a consumer: if this string and the
   * authority ever disagree, one of them is lying, and the only way to notice is to keep
   * the original text in the evidence trail.
   *
   * An empty string is meaningful, not a bug to be patched: it means the authority
   * declared nothing, and it is reported as an unreadable policy rather than silently
   * replaced by a default.
   */
  readonly range: string;

  /**
   * Where `range` came from, in a form a user can act on — for example
   * `package.json#engines.node` or `package.json#packageManager`. Never empty; it is the
   * answer to "says who?".
   */
  readonly origin: string;

  /** Approved consequence of not satisfying this requirement. */
  readonly severityWhenUnsatisfied: UnsatisfiedSeverity;
}

/**
 * @deprecated Use {@link VersionRequirement}. Retained as an alias so the runtime check
 * keeps compiling unchanged after the vocabulary widened.
 */
export type RuntimeRequirement = VersionRequirement;

/* -------------------------------------------------------------------------- */
/* Decision                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Reasons that imply a satisfied requirement.
 *
 * Declared as a frozen tuple and derived into a union rather than written as a bare
 * union: the tuple is iterable, so documentation parity tests and coverage reports can
 * enumerate every reason the engine can produce, and the union cannot drift from the
 * list a test walks.
 */
export const SATISFIED_REASONS = ["within-range"] as const;

/**
 * Reasons that imply an unsatisfied requirement.
 *
 * The three "unsatisfied" variants exist so remediation can say "your version is too
 * old", "too new" or "this line is not supported at all" instead of the technically true
 * but useless "not in range". A user cannot choose between three different fixes from
 * one message.
 *
 * Reason names are shared across sources; the reporter supplies the wording ("Node.js",
 * "pnpm", …). One reason vocabulary is what stops each new source inventing its own
 * near-identical set of failure modes.
 */
export const UNSATISFIED_REASONS = [
  /** Detected version is lower than every supported alternative. */
  "below-minimum",
  /** Detected version is higher than every supported alternative. */
  "above-maximum",
  /**
   * Version sits between supported alternatives without matching any of them, e.g.
   * `<19 || >=22` evaluated at 20.0.0.
   *
   * Distinct from the two cases above because the fix differs: neither "upgrade" nor
   * "go back to LTS" is the answer — the supported lines are explicitly non-contiguous,
   * so the user must move onto one of the tested lines rather than simply to "a newer
   * version".
   */
  "outside-range",
  /** Version is a pre-release, and the policy names no pre-release it accepts. */
  "pre-release-not-listed",
] as const;

/**
 * Reasons that imply the question could not be answered.
 *
 * These are not errors and not passes. Grouping them separately makes the distinction
 * available to every consumer without each one re-deriving it from strings.
 */
export const INDETERMINATE_REASONS = [
  /** No version was reported at all (the adapter returned nothing). */
  "runtime-version-missing",
  /** A version was reported but is not a MAJOR.MINOR.PATCH tuple we can trust. */
  "runtime-version-unreadable",
  /** The policy itself could not be interpreted, so no comparison is meaningful. */
  "policy-range-unreadable",
] as const;

export type SatisfiedReason = (typeof SATISFIED_REASONS)[number];
export type UnsatisfiedReason = (typeof UNSATISFIED_REASONS)[number];
export type IndeterminateReason = (typeof INDETERMINATE_REASONS)[number];

/**
 * Every reason the engine can produce, in status order.
 *
 * Single source for the union, and the list a documentation-parity test walks: every
 * entry needs a documented explanation and a remediation, in the same way every
 * diagnostic needs one.
 */
export const COMPATIBILITY_REASONS = [
  ...SATISFIED_REASONS,
  ...UNSATISFIED_REASONS,
  ...INDETERMINATE_REASONS,
] as const;

export type CompatibilityReason = (typeof COMPATIBILITY_REASONS)[number];

/**
 * Outcome of a comparison.
 *
 * `indeterminate` is not an error and not a pass: it means the question could not be
 * answered. It is reported so the user knows, and it never counts as a clean result,
 * because silence must not be mistaken for consent.
 */
export type CompatibilityStatus = "satisfied" | "unsatisfied" | "indeterminate";

/** The detected version matches the requirement. */
export interface SatisfiedVerdict {
  readonly status: "satisfied";
  readonly reason: SatisfiedReason;
  /** The requirement that was evaluated, carried through for attribution. */
  readonly requirement: VersionRequirement;
  /** Always present here: we could not claim a match without having read it. */
  readonly detected: NodeVersion;
}

/** The version was read and does not match the requirement. */
export interface UnsatisfiedVerdict {
  readonly status: "unsatisfied";
  readonly reason: UnsatisfiedReason;
  readonly requirement: VersionRequirement;
  /** Always present: "does not match" requires a value to have been read. */
  readonly detected: NodeVersion;
}

/**
 * The question could not be answered.
 *
 * `detected` is present only when the version was readable but the *policy* was not — the
 * user still benefits from seeing which version is in play. The optionality is the type
 * doing real work: it is what forces every consumer to handle "we never saw a version"
 * instead of assuming one into existence.
 */
export interface IndeterminateVerdict {
  readonly status: "indeterminate";
  readonly reason: IndeterminateReason;
  readonly requirement: VersionRequirement;
  readonly detected?: NodeVersion;
}

/**
 * The result of evaluating one requirement against one detected version.
 *
 * Discriminated by `status`, so consumers must handle all three outcomes and the
 * compiler rejects impossible combinations such as "satisfied, because it is too old".
 * Each verdict is immutable: a decision is evidence, and evidence that can be edited
 * after the fact is not evidence.
 */
export type CompatibilityVerdict =
  SatisfiedVerdict | UnsatisfiedVerdict | IndeterminateVerdict;

/* -------------------------------------------------------------------------- */
/* Reason → status authority                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The single authority mapping a reason to the status it implies.
 *
 * Kept as a `satisfies`-checked record so that adding a new reason is a compile error
 * until its status is decided. That is the whole point: the earlier we are forced to
 * answer "is this a pass, a failure, or an unknown?", the less likely a new reason
 * quietly lands in the wrong bucket. It is also why adding a reason to a tuple above
 * cannot be forgotten here — the compiler refuses to build until this table agrees.
 *
 * Frozen at runtime as well as typed as literals: this table decides how the product
 * classifies support, so it must not be mutable by a stray import.
 *
 * Lives beside the reason vocabulary rather than in the policy module because the two
 * must change together; splitting them would reintroduce exactly the drift this table
 * exists to prevent.
 */
export const REASON_STATUS = Object.freeze({
  "within-range": "satisfied",
  "below-minimum": "unsatisfied",
  "above-maximum": "unsatisfied",
  "outside-range": "unsatisfied",
  "pre-release-not-listed": "unsatisfied",
  "runtime-version-missing": "indeterminate",
  "runtime-version-unreadable": "indeterminate",
  "policy-range-unreadable": "indeterminate",
} as const satisfies Record<CompatibilityReason, CompatibilityStatus>);

/**
 * Classifies a reason.
 *
 * Callers normally build verdicts through the evaluator, which is the one place that
 * decides; this helper exists so the classifier itself and the tests can derive status
 * from reason rather than duplicating a lookup table.
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
 * They look trivial, but they keep every consumer (exit-code mapping, JSON rendering,
 * summary aggregation) reading the same names instead of comparing string literals in a
 * dozen places — and they make adding a status a compile error at each switch that forgot
 * about it.
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
