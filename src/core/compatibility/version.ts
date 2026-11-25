/**
 * Parsing and ordering of Node.js runtime versions.
 *
 * This module has exactly one job: turn the version string an interpreter
 * reports into a value we can compare confidently, and define what "compare"
 * means. It contains no policy, no ranges and no I/O, which is what makes the
 * whole compatibility boundary matrix testable with plain strings.
 *
 * Guarantees it makes to its callers:
 *
 *   • PURE          — same input, same output, always. No clock, no globals, no
 *                     environment, no filesystem.
 *   • TOTAL         — never throws. Unparsable input returns `undefined`, because
 *                     "I could not read this" is a legitimate outcome the caller
 *                     must report, not an exception that aborts a check.
 *   • DETERMINISTIC — ordering never depends on the host locale, ICU data or
 *                     collation rules; only on semantic-version precedence.
 *
 * Why not use a semver library: the grammar we must accept is small and fully
 * documented below, and a parser we own can *refuse* ambiguous input. A parser
 * that silently coerces "20" or "lts/*" into something comparable is precisely
 * how a runtime nobody tested ends up looking supported.
 *
 * The module is written to compile unchanged with `noUncheckedIndexedAccess`
 * enabled: nothing here assumes a capture group or an array slot exists, and
 * "absent" is always represented as `undefined` rather than asserted away.
 */

/**
 * A parsed Node.js runtime version.
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

/**
 * Upper bound on accepted input length.
 *
 * Not a ReDoS defence (the pattern below is linear), but a check that reads a
 * string from the environment should not do unbounded work on a value a broken
 * wrapper script could have mangled. Anything longer is not a version.
 */
const MAX_VERSION_LENGTH = 64;

/**
 * Numeric identifier without a leading zero, per semantic-versioning rules:
 * `0`, `20`, `999` are valid; `020` and `007` are not.
 *
 * Rejecting leading zeros is the safe direction to err in: the worst case is
 * that an exotic build reports a warning instead of a pass. Coercing it would
 * risk the opposite — a pass for a version we never actually understood.
 */
const NUMERIC_IDENTIFIER = "(?:0|[1-9]\\d*)";

/**
 * Node reports `MAJOR.MINOR.PATCH` and may prefix it with `v` (`node --version`
 * prints the prefix, `process.versions.node` does not, so we accept both).
 * Build metadata after `+` is accepted and then ignored for ordering, because it
 * carries no precedence.
 *
 * Partial inputs such as `20` or `20.11` do NOT match. Accepting them would mean
 * inventing a patch level we never observed, and every later comparison would
 * rest on a guess.
 */
const RUNTIME_VERSION = new RegExp(
  "^[vV]?" +
    `(${NUMERIC_IDENTIFIER})\\.(${NUMERIC_IDENTIFIER})\\.(${NUMERIC_IDENTIFIER})` +
    "(?:-([0-9A-Za-z.-]+))?" +
    "(?:\\+[0-9A-Za-z.-]+)?$",
);

/**
 * Parses a runtime version string.
 *
 * @returns the parsed version, or `undefined` when the input is absent, empty or
 *          not a complete MAJOR.MINOR.PATCH tuple. Never throws — callers are
 *          expected to surface `undefined` as an indeterminate result rather
 *          than to catch an error.
 */
export function parseNodeVersion(
  input: string | undefined | null,
): NodeVersion | undefined {
  if (typeof input !== "string") return undefined;

  const candidate = input.trim();
  if (candidate === "" || candidate.length > MAX_VERSION_LENGTH)
    return undefined;

  const match = RUNTIME_VERSION.exec(candidate);
  if (match === null) return undefined;

  // Capture groups are guaranteed by the pattern, but the compiler cannot know
  // that (see `noUncheckedIndexedAccess`). Each value is therefore treated as
  // possibly absent and validated individually: a defensive `undefined` return
  // here is strictly better than a non-null assertion that would silently become
  // wrong the day someone edits the regex.
  const [, major, minor, patch, prerelease] = match;

  const parsedMajor = toSafeInteger(major);
  const parsedMinor = toSafeInteger(minor);
  const parsedPatch = toSafeInteger(patch);
  if (
    parsedMajor === undefined ||
    parsedMinor === undefined ||
    parsedPatch === undefined
  ) {
    return undefined;
  }

  const parsedPrerelease = parsePrerelease(prerelease);
  if (parsedPrerelease === undefined) return undefined;

  // Frozen because parsed versions are shared as range boundaries across many
  // evaluations; a mutated bound would silently change what "supported" means.
  return Object.freeze({
    major: parsedMajor,
    minor: parsedMinor,
    patch: parsedPatch,
    prerelease: Object.freeze(parsedPrerelease),
    raw: candidate,
  });
}

/**
 * Splits a pre-release suffix into identifiers.
 *
 * Returns `undefined` for a malformed suffix (`a..b`, empty, numeric with a
 * leading zero) so that the whole version is rejected rather than partly
 * understood. A half-parsed version is worse than no version: it looks usable.
 */
function parsePrerelease(
  value: string | undefined,
): readonly (string | number)[] | undefined {
  if (value === undefined || value === "") return [];

  const identifiers: (string | number)[] = [];

  for (const identifier of value.split(".")) {
    if (identifier === "") return undefined;

    if (/^\d+$/.test(identifier)) {
      const numeric = toSafeInteger(identifier);
      // `toSafeInteger` also rejects leading zeros, keeping numeric identifiers
      // canonical so that two spellings can never compare unequal by accident.
      if (numeric === undefined) return undefined;
      identifiers.push(numeric);
      continue;
    }

    identifiers.push(identifier);
  }

  return identifiers;
}

/**
 * Converts a decimal string to a safe integer.
 *
 * Accepts `undefined` because it is fed directly from regex capture groups,
 * which the compiler must treat as possibly absent. Rejects leading zeros and
 * values beyond `Number.MAX_SAFE_INTEGER`, since a silently rounded major or
 * patch number would make every comparison downstream meaningless.
 */
function toSafeInteger(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^(?:0|[1-9]\d*)$/.test(value)) return undefined;

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/**
 * Total ordering with semantic-version precedence.
 *
 * Returns a negative number, zero, or a positive number, so it can be handed
 * straight to `Array.prototype.sort`. Comparing numbers rather than strings
 * matters: `"9" > "10"` lexically, which is the classic reason a hand-rolled
 * version check accepts a runtime that is actually too old.
 */
export function compareNodeVersions(a: NodeVersion, b: NodeVersion): number {
  const core = a.major - b.major || a.minor - b.minor || a.patch - b.patch;
  if (core !== 0) return core;

  // A released version always outranks a pre-release of the same tuple:
  // 21.0.0 > 21.0.0-rc.1 > 21.0.0-beta.2
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;

  return comparePrerelease(a.prerelease, b.prerelease);
}

/**
 * Compares identifier by identifier, left to right, per the specification:
 * numeric identifiers compare numerically, alphanumeric ones lexically, numeric
 * always ranks below alphanumeric, and a shorter list ranks below a longer one
 * when all shared identifiers are equal.
 *
 * `typeof` checks are applied directly to the values rather than captured in
 * boolean aliases. That keeps the narrowing visible to the compiler at the exact
 * point it is needed, so the final `left < right` is a comparison of two strings
 * rather than of two `string | number` unions.
 *
 * Strings are compared with `<` / `>` — never `localeCompare`, whose result
 * depends on the host locale and would make the same check pass on one machine
 * and fail on another.
 */
function comparePrerelease(
  a: readonly (string | number)[],
  b: readonly (string | number)[],
): number {
  const length = Math.max(a.length, b.length);

  for (let index = 0; index < length; index += 1) {
    const left = a[index];
    const right = b[index];

    // A shorter list ranks below a longer one once all shared identifiers match.
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left === right) continue;

    if (typeof left === "number" && typeof right === "number")
      return left - right;

    // Numeric identifiers always rank below alphanumeric ones.
    if (typeof left === "number") return -1;
    if (typeof right === "number") return 1;

    // Both are alphanumeric here; ordinal comparison keeps the result identical
    // on every machine, which a locale-aware comparison would not.
    return left < right ? -1 : 1;
  }

  return 0;
}

/**
 * True when both versions share MAJOR.MINOR.PATCH.
 *
 * Exposed because the range evaluator needs it for the pre-release opt-in rule:
 * a pre-release may only satisfy a range that explicitly names a pre-release of
 * the same core tuple. Defining it once, here, keeps that rule from being
 * re-derived (and re-broken) in the range module.
 */
export function hasSameCore(a: NodeVersion, b: NodeVersion): boolean {
  return a.major === b.major && a.minor === b.minor && a.patch === b.patch;
}

/** True when the version carries pre-release identifiers. */
export function isPrerelease(version: NodeVersion): boolean {
  return version.prerelease.length > 0;
}

/**
 * Renders the canonical `MAJOR.MINOR.PATCH[-prerelease]` form.
 *
 * Used for evidence and messages because `raw` may carry a `v` prefix or build
 * metadata; humans compare normalised numbers, and so should our output.
 */
export function formatNodeVersion(version: NodeVersion): string {
  const core = `${version.major}.${version.minor}.${version.patch}`;
  return isPrerelease(version)
    ? `${core}-${version.prerelease.join(".")}`
    : core;
}
