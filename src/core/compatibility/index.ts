/**
 * Public surface of the version compatibility module.
 *
 * Everything QAT needs to answer "is this version supported?" is reachable from here, and nothing else is. The
 * re-exports are written out explicitly rather than collapsed into `export *`, for two reasons that both protect the
 * module boundary:
 *
 *   1. Adding an internal helper must never silently widen the public API. With `export *`, a new function in
 *      `range.ts` becomes something other modules can depend on the moment it is written.
 *   2. The list is the documentation. Reading this file tells a reviewer exactly what the rest of the codebase is
 *      permitted to use, and a diff here is a deliberate, visible API change rather than an accidental one.
 *
 * Types and runtime values are separated because types disappear at compile time: keeping them in their own export
 * statements lets a consumer import a type without implying a runtime dependency on this module.
 *
 * Consumers import from `core/compatibility` and never from the individual files inside it. The individual files are
 * implementation detail and may be split or merged freely as long as this contract holds.
 *
 * ## The widened vocabulary, and why the old names are gone from this list
 *
 * One comparison engine now answers three questions: the runtime QAT requires, the bound a project's framework release
 * declares, and the version a project pins for its package manager. The types were renamed to say that — a
 * `VersionRequirement` is a statement about a version, whoever owns it.
 *
 * The runtime-era names survive in `contracts.ts` as deprecated aliases, and this file deliberately does **not**
 * re-export them. Re-exporting a deprecated symbol is itself a use of it, so listing them here would keep the module's
 * own surface issuing the warning it exists to retire — and a reader would see two names for one type in the one place
 * that is supposed to be the definitive list.
 *
 * Deleting them outright is the same decision taken one step further, and it is the right one while the only consumers
 * are in this repository: the compiler names every call site that has not migrated, which is exactly the migration
 * checklist. The paragraph at the bottom of this file says what to keep instead if these types are ever published.
 */

/* -------------------------------------------------------------------------- */
/* Contracts — the vocabulary of a compatibility decision                     */
/* -------------------------------------------------------------------------- */

export type {
  /**
   * Who owns a requirement: QAT itself, a project's framework release, or a project's package-manager pin.
   *
   * The owner decides attribution and default severity, which is why the union is closed rather than a free string: a
   * new source is a compile error at every switch that must now decide how to attribute it.
   */
  VersionRequirementSource,
  /** Approved consequence of a failed requirement: blocking or advisory. */
  UnsatisfiedSeverity,
  /**
   * An immutable statement of "versions matching `range` are supported", for any version source.
   *
   * Structurally identical to the former runtime-only type, which is why the rename was an alias rather than a
   * conversion — but the *name* is what stops three checks inventing three vocabularies for one idea.
   */
  VersionRequirement,
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
 * Exported because aggregation and reporting must derive "is this a pass?" from the same table the decision used, instead
 * of re-listing known reasons.
 */
export { REASON_STATUS, statusOf } from "./contracts.js";

/**
 * Narrowing helpers.
 *
 * Exported so every consumer switches on the same names rather than comparing string literals in a dozen places.
 */
export { isSatisfied, isUnsatisfied, isIndeterminate } from "./contracts.js";

/* -------------------------------------------------------------------------- */
/* Version primitive — parsing and ordering                                   */
/* -------------------------------------------------------------------------- */

export type { NodeVersion } from "./version.js";

export {
  /** Parses a version; returns `undefined` rather than throwing. */
  parseNodeVersion,
  /** Semantic-version precedence as a comparator, for sorting and thresholds. */
  compareNodeVersions,
  /** True when two versions share MAJOR.MINOR.PATCH. */
  hasSameCore,
  /** True when the version carries pre-release identifiers. */
  isPrerelease,
  /** Canonical `MAJOR.MINOR.PATCH[-prerelease]` form, for evidence and messages. */
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
  /**
   * The one comparison every compatibility answer flows through.
   *
   * Unchanged by the widening, and deliberately not renamed: the name says what it takes — two requirements go in, one
   * verdict comes out — and never said "runtime". A rename here would be churn in every call site for no gain in
   * clarity, which is the opposite of what the type rename achieved.
   */
  evaluateVersionRequirement,
  /** Resolves QAT's requirement from the installed package manifest. */
  qatRuntimeRequirement,
  /** Builds the optional, advisory Cypress requirement; `undefined` if undeclared. */
  cypressRuntimeRequirement,
} from "./policy.js";

/**
 * If these types ever become a published API — a plugin SDK, an adapter contract someone else implements — add a
 * deprecation window here instead of deleting the aliases:
 *
 * ```typescript
 * /** @deprecated Use {@link VersionRequirement}. *\/
 * export type { RuntimeRequirement } from './contracts.js';
 * ```
 *
 * That block will emit the warning above, in this file, every time the module is loaded. That is the correct trade for a
 * published surface: one visible, dated reminder at the boundary beats silently breaking third-party code. It is the
 * wrong trade while every consumer is in this repository, because the compiler already reports the same thing more
 * precisely at each site that forgot to migrate.
 */
