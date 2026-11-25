/**
 * Public surface of the runtime compatibility module.
 *
 * Everything QAT needs to answer "is this runtime supported?" is reachable from
 * here, and nothing else is. The re-exports are written out explicitly rather
 * than collapsed into `export *`, for two reasons that both protect the module
 * boundary:
 *
 *   1. Adding an internal helper must never silently widen the public API.
 *      With `export *`, a new function in `range.ts` becomes something other
 *      modules can depend on the moment it is written.
 *   2. The list is the documentation. Reading this file tells a reviewer exactly
 *      what the rest of the codebase is permitted to use, and a diff here is a
 *      deliberate, visible API change rather than an accidental one.
 *
 * Types and runtime values are separated because types disappear at compile
 * time: keeping them in their own export statements lets a consumer import a
 * type without implying a runtime dependency on this module.
 *
 * Consumers import from `core/compatibility` and never from the individual files
 * inside it. The individual files are implementation detail and may be split or
 * merged freely as long as this contract holds.
 */

/* -------------------------------------------------------------------------- */
/* Contracts — the vocabulary of a compatibility decision                     */
/* -------------------------------------------------------------------------- */

export type {
  /** Who owns a requirement: QAT itself, or the project's Cypress release. */
  RuntimeRequirementSource,
  /** Approved consequence of a failed requirement: blocking or advisory. */
  UnsatisfiedSeverity,
  /** An immutable statement of "versions matching `range` are supported". */
  RuntimeRequirement,
  /** Why a decision came out the way it did, grouped by implied status. */
  SatisfiedReason,
  UnsatisfiedReason,
  IndeterminateReason,
  CompatibilityReason,
  /** The three outcomes: satisfied, unsatisfied, indeterminate. */
  CompatibilityStatus,
  /** Discriminated verdict members; the union prevents impossible pairings. */
  SatisfiedVerdict,
  UnsatisfiedVerdict,
  IndeterminateVerdict,
  CompatibilityVerdict,
} from "./contracts.js";

/**
 * Reason → status authority.
 *
 * Exported because aggregation and reporting must derive "is this a pass?" from
 * the same table the decision used, instead of re-listing known reasons.
 */
export { REASON_STATUS, statusOf } from "./contracts.js";

/**
 * Narrowing helpers.
 *
 * Exported so every consumer switches on the same names rather than comparing
 * string literals in a dozen places.
 */
export { isSatisfied, isUnsatisfied, isIndeterminate } from "./contracts.js";

/* -------------------------------------------------------------------------- */
/* Version primitive — parsing and ordering                                   */
/* -------------------------------------------------------------------------- */

export type { NodeVersion } from "./version.js";

export {
  /** Parses a runtime version; returns `undefined` rather than throwing. */
  parseNodeVersion,
  /** Semantic-version precedence as a comparator, for sorting and thresholds. */
  compareNodeVersions,
  /** True when two versions share MAJOR.MINOR.PATCH. */
  hasSameCore,
  /** True when the version carries pre-release identifiers. */
  isPrerelease,
  /** Canonial `MAJOR.MINOR.PATCH[-prerelease]` form, for evidence and messages. */
  formatNodeVersion,
} from "./version.js";

/* -------------------------------------------------------------------------- */
/* Range — the supported-version grammar                                      */
/* -------------------------------------------------------------------------- */

export type {
  /** Operators this evaluator implements. */
  RangeOperator,
  /** One "operator + bound" test. */
  Comparator,
  /** Comparators that must all hold. */
  ComparatorSet,
  /** Alternatives where at least one must hold. */
  RangeExpression,
  /** Why a range could not be read. */
  RangeParseReason,
  RangeParseResult,
  /** Where a non-matching version sits: too old, too new, or in a gap. */
  RangeDeviation,
} from "./range.js";

export {
  /** The complete operator list; exported so tests can prove coverage. */
  SUPPORTED_OPERATORS,
  /** Parses a range expression; never throws. */
  parseRange,
  /** The only function that decides membership. */
  satisfiesRange,
  /** Explains a non-matching version without ever deciding membership itself. */
  classifyDeviation,
} from "./range.js";

/* -------------------------------------------------------------------------- */
/* Decision — the single point every caller uses                              */
/* -------------------------------------------------------------------------- */

export {
  /** Canonical provenance pointer for QAT's own declared range. */
  QAT_REQUIREMENT_ORIGIN,
  /** Provenance pointer for a project-level Cypress runtime requirement. */
  CYPRESS_REQUIREMENT_ORIGIN,
  /** The one comparison every compatibility answer flows through. */
  evaluateRequirement,
  /** Resolves QAT's requirement from the installed package manifest. */
  qatRuntimeRequirement,
  /** Builds the optional, advisory Cypress requirement; `undefined` if undeclared. */
  cypressRuntimeRequirement,
} from "./policy.js";
