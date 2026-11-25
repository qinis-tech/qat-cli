/**
 * Parsing and evaluation of supported-version range expressions.
 *
 * A range expression answers one question: "does this runtime version belong to
 * the set of versions we support?". This module answers it, and nothing else.
 * It contains no policy, no I/O and no severity decisions — mapping an answer to
 * "blocking" or "advisory" is the caller's job, which is what keeps the same
 * answer usable by the doctor, by `init` and by a future `run` preflight.
 *
 * Supported grammar (deliberately small, and documented so it can be reviewed):
 *
 *   range       := alternative ( "||" alternative )*
 *   alternative := comparator+
 *   comparator  := operator? version
 *   operator    := ">=" | "<=" | ">" | "<" | "=" | "^" | "~"   (default "=")
 *
 *   ">=20.11.0 <21"          a floor and an exclusive ceiling
 *   "^20.11.0"               [20.11.0, 21.0.0)
 *   "~20.11.0"               [20.11.0, 20.12.0)
 *   ">=20.11.0 <21 || >=22.0.0"
 *
 * Everything outside that grammar is REFUSED rather than guessed at: `20.x`,
 * `*`, `18 - 20`, `>=20` and `!=20` all return a parse failure. A range we
 * cannot read means we cannot claim support, and the caller reports that as an
 * indeterminate result instead of a pass. Guessing here would be the single
 * easiest way to ship a green build on an untested runtime.
 *
 * Written to compile with `noUncheckedIndexedAccess` enabled: a value that might
 * be absent is narrowed by an explicit branch, never asserted away.
 */

import {
  compareNodeVersions,
  hasSameCore,
  isPrerelease,
  parseNodeVersion,
  type NodeVersion,
} from "./version.js";

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

/** Operators this evaluator understands. Exported so tests can prove coverage. */
export type RangeOperator = ">=" | "<=" | ">" | "<" | "=" | "^" | "~";

/**
 * The complete operator list, in documentation order.
 *
 * Exported because the boundary test suite iterates it: if someone adds an
 * operator without adding cases, the suite fails rather than quietly losing
 * coverage of the thing we just promised to support.
 */
export const SUPPORTED_OPERATORS: readonly RangeOperator[] = Object.freeze([
  ">=",
  "<=",
  ">",
  "<",
  "=",
  "^",
  "~",
]);

/** One "operator + bound" test, e.g. `>= 20.11.0`. */
export interface Comparator {
  readonly operator: RangeOperator;
  readonly bound: NodeVersion;
}

/** Comparators that must ALL hold (logical AND). */
export type ComparatorSet = readonly Comparator[];

/** Alternatives where at least ONE must hold (logical OR). */
export type RangeExpression = readonly ComparatorSet[];

export type RangeParseReason =
  /** Nothing was supplied, or only whitespace. */
  | "empty"
  /** The text uses syntax this evaluator does not implement (wildcards, hyphen ranges…). */
  | "unsupported-syntax"
  /** A version-shaped token was found but is not a complete MAJOR.MINOR.PATCH. */
  | "invalid-version";

export type RangeParseResult =
  | { readonly ok: true; readonly expression: RangeExpression }
  | { readonly ok: false; readonly reason: RangeParseReason };

/* -------------------------------------------------------------------------- */
/* Parsing                                                                    */
/* -------------------------------------------------------------------------- */

/** Detects a range written in hyphen form, e.g. `18 - 20`. */
const HYPHEN_RANGE = /^[^\s|]+\s+-\s+[^\s|]+$/;

/** Splits a single comparator into an (optional) operator and a version part. */
const COMPARATOR = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/;

/**
 * Parses a range expression.
 *
 * Never throws: a caller must be able to turn a malformed policy into a reported
 * indeterminate result rather than an exception that aborts the whole check.
 *
 * Cost is a few microseconds and the result is immutable, so the sensible
 * placement is to parse once per requirement at composition time and reuse the
 * expression; parsing per evaluation would be correct but wasteful.
 */
export function parseRange(range: string): RangeParseResult {
  if (typeof range !== "string" || range.trim() === "") {
    return { ok: false, reason: "empty" };
  }

  const alternatives: ComparatorSet[] = [];

  for (const group of range.split("||")) {
    const trimmed = group.trim();

    // An empty alternative is the dangerous case: `[].every(...)` is `true`, so
    // ">=20 ||" would be satisfied by *every* version. A trailing or doubled
    // "||" is a typo in the policy, and this is the only place it can be caught.
    if (trimmed === "") return { ok: false, reason: "unsupported-syntax" };

    if (HYPHEN_RANGE.test(trimmed))
      return { ok: false, reason: "unsupported-syntax" };

    const tokens = trimmed.split(/\s+/);

    const comparators: Comparator[] = [];
    // Holds an operator that appeared as its own token, so that the equally
    // valid spellings ">=20.11.0" and ">= 20.11.0" both parse.
    let pendingOperator: RangeOperator | undefined;

    for (const token of tokens) {
      if (isOperator(token)) {
        // ">= <20.11.0" — two operators for one bound is a mistake, not a range.
        if (pendingOperator !== undefined)
          return { ok: false, reason: "unsupported-syntax" };
        pendingOperator = token;
        continue;
      }

      const parsed = parseComparator(token, pendingOperator);
      if (!parsed.ok) return parsed;

      comparators.push(Object.freeze(parsed.comparator));
      pendingOperator = undefined;
    }

    // A dangling operator ("20.11.0 >=") must not be silently dropped.
    if (pendingOperator !== undefined)
      return { ok: false, reason: "unsupported-syntax" };

    alternatives.push(Object.freeze(comparators));
  }

  return { ok: true, expression: Object.freeze(alternatives) };
}

/** Parses one comparator token, given an operator captured from a previous token. */
function parseComparator(
  token: string,
  pendingOperator: RangeOperator | undefined,
):
  | { ok: true; comparator: Comparator }
  | { ok: false; reason: RangeParseReason } {
  // "!=" and friends: a negation does not describe a supported set, only an
  // excluded one, and supporting it would blur "supported" with "merely allowed".
  if (token.startsWith("!")) return { ok: false, reason: "unsupported-syntax" };

  const match = COMPARATOR.exec(token);
  if (match === null) return { ok: false, reason: "unsupported-syntax" };

  const [, inlineOperator, versionText] = match;

  // The version part is mandatory in COMPARATOR, but a capture group read by
  // index is typed as possibly absent. Rather than assert that it exists — a
  // claim that would silently rot if the pattern were ever edited — the absence
  // is handled as the parse failure it would represent.
  if (versionText === undefined)
    return { ok: false, reason: "unsupported-syntax" };

  // Resolve the operator through the same guard the rest of the module uses, so
  // an unrecognised operator is refused instead of being downgraded to "="
  // (which would quietly widen the set of versions we claim to support).
  let operator: RangeOperator = "=";
  if (inlineOperator !== undefined) {
    if (!isOperator(inlineOperator))
      return { ok: false, reason: "unsupported-syntax" };
    // ">= >20" — the operator was already given by a separate token.
    if (pendingOperator !== undefined)
      return { ok: false, reason: "unsupported-syntax" };
    operator = inlineOperator;
  } else if (pendingOperator !== undefined) {
    operator = pendingOperator;
  }

  // Wildcards describe a set we cannot bound precisely ("20.x" hides a patch
  // level). Only the core tuple is inspected, so a pre-release identifier that
  // happens to contain "x" is not mistaken for a wildcard.
  const core = versionText.split(/[-+]/, 1)[0] ?? "";
  if (/[*xX]/.test(core)) return { ok: false, reason: "unsupported-syntax" };

  const bound = parseNodeVersion(versionText);
  // Partial versions such as ">=20" or ">=20.11" land here too: we refuse to
  // invent the patch level, because every later comparison would rest on a guess.
  if (bound === undefined) return { ok: false, reason: "invalid-version" };

  return { ok: true, comparator: { operator, bound } };
}

/**
 * Type guard over the documented operator list.
 *
 * Implemented with `some` rather than `(SUPPORTED_OPERATORS as …).includes` so
 * there is no assertion in the file: the guard narrows `string` to
 * `RangeOperator` by actually checking membership, and the compiler trusts the
 * check rather than our claim.
 */
function isOperator(token: string): token is RangeOperator {
  return SUPPORTED_OPERATORS.some((operator) => operator === token);
}

/* -------------------------------------------------------------------------- */
/* Evaluation                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * True when the candidate version belongs to the supported set.
 *
 * This is the only function that decides membership. Everything else in this
 * module exists to support it or to explain its answer, so a caller never has to
 * re-derive the rule.
 */
export function satisfiesRange(
  expression: RangeExpression,
  candidate: NodeVersion,
): boolean {
  return expression.some((set) => satisfiesComparatorSet(set, candidate));
}

function satisfiesComparatorSet(
  set: ComparatorSet,
  candidate: NodeVersion,
): boolean {
  // Pre-releases are opt-in. A candidate like 21.0.0-rc.1 only satisfies a set
  // that explicitly names a pre-release of the same 21.0.0 tuple. Otherwise an
  // untested release candidate would inherit the "supported" badge of its stable
  // line, which is exactly the assumption a compatibility policy exists to stop.
  if (isPrerelease(candidate) && !namesPrereleaseOf(set, candidate))
    return false;

  return set.every((comparator) => holds(comparator, candidate));
}

function namesPrereleaseOf(
  set: ComparatorSet,
  candidate: NodeVersion,
): boolean {
  return set.some(
    ({ bound }) => isPrerelease(bound) && hasSameCore(bound, candidate),
  );
}

/** Evaluates one comparator. Exhaustive by construction: no default branch. */
function holds(comparator: Comparator, candidate: NodeVersion): boolean {
  const order = compareNodeVersions(candidate, comparator.bound);

  switch (comparator.operator) {
    case "=":
      return order === 0;
    case ">":
      return order > 0;
    case ">=":
      return order >= 0;
    case "<":
      return order < 0;
    case "<=":
      return order <= 0;
    // "Compatible with": at least the bound, below the next significant release.
    case "^":
      return (
        order >= 0 &&
        compareNodeVersions(candidate, caretCeiling(comparator.bound)) < 0
      );
    // "Approximately": at least the bound, below the next minor release.
    case "~":
      return (
        order >= 0 &&
        compareNodeVersions(candidate, tildeCeiling(comparator.bound)) < 0
      );
  }
}

/**
 * Exclusive upper bound implied by a caret range:
 *
 *   ^20.11.0 → 21.0.0   (major above zero: never cross a major)
 *   ^0.4.2   → 0.5.0    (major zero: never cross a minor)
 *   ^0.0.3   → 0.0.4    (major and minor zero: never cross a patch)
 *
 * The zero-major rules are the ones readers get wrong, so they are written out
 * rather than folded into an arithmetic expression.
 */
function caretCeiling(bound: NodeVersion): NodeVersion {
  if (bound.major > 0) return ceilingOf(bound.major + 1, 0, 0);
  if (bound.minor > 0) return ceilingOf(0, bound.minor + 1, 0);
  return ceilingOf(0, 0, bound.patch + 1);
}

/** Exclusive upper bound implied by a tilde range: ~20.11.0 → 20.12.0 */
function tildeCeiling(bound: NodeVersion): NodeVersion {
  return ceilingOf(bound.major, bound.minor + 1, 0);
}

/**
 * Builds a released ceiling version.
 *
 * `prerelease` is empty on purpose: a ceiling describes a released boundary, and
 * pre-release admission is handled once, centrally, by the opt-in gate above.
 */
function ceilingOf(major: number, minor: number, patch: number): NodeVersion {
  return { major, minor, patch, prerelease: [], raw: "" };
}

/* -------------------------------------------------------------------------- */
/* Explanation                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Where a non-satisfying version sits relative to the supported set.
 *
 * This is a MESSAGING classification, never a correctness one: membership is
 * always decided by `satisfiesRange`. It exists because "not in range" cannot
 * tell a user whether to upgrade or to come back to LTS, and that difference is
 * the whole value of the remediation text.
 */
export type RangeDeviation =
  /** Lower than every alternative — the "your Node is too old" case. */
  | "below-minimum"
  /** Higher than every alternative — the "newer is not automatically compatible" case. */
  | "above-maximum"
  /** Inside the span but in a gap, e.g. `<19 || >=22` evaluated at 20.0.0. */
  | "outside-range";

/**
 * Classifies a deviation using the bounds each alternative implies.
 *
 * Bounds are derived only from operators that have an obvious one; an operator
 * with no derivable bound is treated as "unknown in that direction", which makes
 * the classifier fall back to `outside-range`. Inaccurate wording is acceptable
 * here; an inaccurate *verdict* would not be, and this function never returns one.
 */
export function classifyDeviation(
  expression: RangeExpression,
  candidate: NodeVersion,
): RangeDeviation {
  const bounds = expression.map(setBounds);

  const belowEveryAlternative = bounds.every(
    ({ floor }) =>
      floor !== undefined && compareNodeVersions(candidate, floor) < 0,
  );
  if (belowEveryAlternative) return "below-minimum";

  const aboveEveryAlternative = bounds.every(
    ({ ceiling, ceilingExclusive }) => {
      if (ceiling === undefined) return false;

      const order = compareNodeVersions(candidate, ceiling);
      // An exclusive ceiling is "above" from the bound itself: `<21.0.0` does not admit 21.0.0, so 21.0.0 is too new.
      return ceilingExclusive ? order >= 0 : order > 0;
    },
  );
  if (aboveEveryAlternative) return "above-maximum";

  return "outside-range";
}

interface SetBounds {
  /** The lowest version the alternative could admit, if it has one. */
  readonly floor: NodeVersion | undefined;
  /** The highest version the alternative could admit, if it has one. */
  readonly ceiling: NodeVersion | undefined;
  /**
   * Whether a version equal to `ceiling` is admitted.
   *
   * `<=21.0.0` admits 21.0.0; `<21.0.0` and the ceilings implied by `^`/`~` do not. Without this, "above the ceiling"
   * would be false for a version sitting exactly on an exclusive bound — which is the most ordinary "too new" case
   * there is, and it would be reported as a gap in the policy instead.
   */
  readonly ceilingExclusive: boolean;
}

/** Lowest and highest version a single comparator set could ever admit. */
function setBounds(set: ComparatorSet): SetBounds {
  let floor: NodeVersion | undefined;
  let ceiling: NodeVersion | undefined;
  let ceilingExclusive = false;

  // Keeps the highest ceiling, because that is the loosest upper bound the alternative could admit — and on a tie the
  // stricter reading wins, since `<=21.0.0 <21.0.0` is `<21.0.0` whichever order it was written in.
  const raiseCeiling = (candidate: NodeVersion, exclusive: boolean): void => {
    if (ceiling === undefined) {
      ceiling = candidate;
      ceilingExclusive = exclusive;
      return;
    }

    const order = compareNodeVersions(candidate, ceiling);
    if (order > 0) {
      ceiling = candidate;
      ceilingExclusive = exclusive;
    } else if (order === 0 && exclusive) {
      ceilingExclusive = true;
    }
  };

  for (const comparator of set) {
    switch (comparator.operator) {
      case ">=":
      case ">":
      case "^":
      case "~":
      case "=":
        floor = lowest(floor, comparator.bound);
        break;
      case "<=":
        raiseCeiling(comparator.bound, false);
        break;
      case "<":
        raiseCeiling(comparator.bound, true);
        break;
    }

    // ^ and ~ imply an exclusive ceiling as well as a floor.
    if (comparator.operator === "^")
      raiseCeiling(caretCeiling(comparator.bound), true);
    if (comparator.operator === "~")
      raiseCeiling(tildeCeiling(comparator.bound), true);
  }

  return { floor, ceiling, ceilingExclusive };
}

function lowest(
  current: NodeVersion | undefined,
  candidate: NodeVersion,
): NodeVersion {
  if (current === undefined) return candidate;
  return compareNodeVersions(candidate, current) < 0 ? candidate : current;
}
