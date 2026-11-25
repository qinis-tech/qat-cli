/**
 * Unit tests for `core/compatibility/version.ts`.
 *
 * What this suite is guarding, in one sentence: the difference between a version string we can reason about and one we
 * merely recognise. Every boundary in the compatibility policy is expressed as a comparison between two parsed values,
 * so an error here does not surface as a wrong comparison — it surfaces as a runtime nobody tested being reported as
 * supported.
 *
 * Three kinds of case appear below, and they are not interchangeable:
 *
 *   • TABLE CASES   — one row per accepted or rejected form. A rejected form is as important as an accepted one: the
 *                     parser's job is to refuse, not to coerce, so "refuses" needs evidence too.
 *   • PAIRS         — an edge and its neighbour (`20.10.9` / `20.11.0`, 64 characters / 65). A single case at the
 *                     boundary cannot tell an inclusive rule from an exclusive one.
 *   • PROPERTIES    — reflexivity, antisymmetry, transitivity and sortability over a matrix of versions. These catch
 *                     the class of defect a table cannot: an ordering that is locally plausible and globally wrong.
 *
 * Tables are written as object rows rather than positional tuples. Two reasons: a row states what each column means
 * without the reader counting commas, and `$name` interpolation puts the case's own words into the test title.
 */
import { describe, expect, it } from "vitest";

import {
  compareNodeVersions,
  formatNodeVersion,
  hasSameCore,
  isPrerelease,
  parseNodeVersion,
} from "../../../../src/core/compatibility/version.js";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Parses a fixture, failing loudly when the input is not a version.
 *
 * The alternative — `parseNodeVersion(x)!` throughout the suite — would turn a broken fixture into "comparison of
 * undefined", which reports as a confusing assertion failure two lines later instead of naming the fixture that was
 * wrong.
 */
function parse(input: string) {
  const parsed = parseNodeVersion(input);
  if (parsed === undefined)
    throw new Error(`fixture is not a version: ${JSON.stringify(input)}`);
  return parsed;
}

/**
 * `Math.sign` without the sign of zero.
 *
 * `Math.sign(0)` is `0` and `-Math.sign(0)` is `-0`, and `Object.is(0, -0)` is false — so a negated comparison fails on
 * the diagonal of an antisymmetry matrix, where both versions are identical. That is a fact about IEEE-754, not about
 * ordering, and an assertion about ordering should not depend on it.
 */
const sign = (value: number): -1 | 0 | 1 =>
  value < 0 ? -1 : value > 0 ? 1 : 0;

/** A spread of versions used by the property tests: releases, pre-releases, and both sides of several boundaries. */
const SAMPLES = [
  "0.0.1",
  "0.4.2",
  "0.5.0",
  "1.0.0-alpha",
  "1.0.0-alpha.1",
  "1.0.0-beta",
  "1.0.0",
  "9.0.0",
  "10.0.0",
  "20.10.9",
  "20.11.0",
  "20.11.1",
  "20.999.999",
  "21.0.0-rc.1",
  "21.0.0",
  "22.1.0",
] as const;

/* -------------------------------------------------------------------------- */
/* Parsing                                                                    */
/* -------------------------------------------------------------------------- */

describe("parseNodeVersion", () => {
  describe("accepts a complete tuple", () => {
    it.each([
      { input: "20.11.1", major: 20, minor: 11, patch: 1, note: "plain" },
      {
        input: "v20.11.1",
        major: 20,
        minor: 11,
        patch: 1,
        note: "`node --version` form",
      },
      {
        input: "V20.11.1",
        major: 20,
        minor: 11,
        patch: 1,
        note: "capitalised prefix",
      },
      { input: "0.0.0", major: 0, minor: 0, patch: 0, note: "all zeroes" },
      {
        input: "999.999.999",
        major: 999,
        minor: 999,
        patch: 999,
        note: "multi-digit components",
      },
      {
        input: "20.11.0+20240101",
        major: 20,
        minor: 11,
        patch: 0,
        note: "build metadata is ignored",
      },
    ])("reads $input — $note", ({ input, major, minor, patch }) => {
      const parsed = parse(input);

      expect(parsed.major).toBe(major);
      expect(parsed.minor).toBe(minor);
      expect(parsed.patch).toBe(patch);
      expect(parsed.prerelease).toStrictEqual([]);
    });
  });

  describe("rejects anything that is not a complete MAJOR.MINOR.PATCH tuple", () => {
    it.each([
      { input: undefined, note: "absent" },
      { input: null, note: "null" },
      { input: "", note: "empty" },
      { input: "   ", note: "whitespace only" },
      { input: "twenty", note: "not a version" },
      { input: "20", note: "major only" },
      {
        input: "20.11",
        note: "partial tuple — the patch level would have to be invented",
      },
      { input: "20.11.1.2", note: "four components" },
      { input: "20..1", note: "empty component" },
      { input: "v", note: "prefix with no version" },
      { input: "20.11.1-", note: "trailing hyphen with no identifiers" },
      {
        input: "20.11.0-01",
        note: "pre-release identifier with a leading zero",
      },
      { input: "020.11.1", note: "leading zero in a core component" },
      { input: " 20.11.1 extra", note: "trailing content" },
    ])("returns undefined for $note", ({ input }) => {
      expect(parseNodeVersion(input)).toBeUndefined();
    });

    it("rejects components beyond Number.MAX_SAFE_INTEGER rather than rounding them", () => {
      // The string is one past the safe range: `Number` would round it to 9007199254740992, and every comparison
      // afterwards would be against a number that is not the one that was reported.
      expect(parseNodeVersion("9007199254740993.0.0")).toBeUndefined();
    });

    it("accepts Number.MAX_SAFE_INTEGER itself", () => {
      expect(parseNodeVersion("9007199254740991.0.0")?.major).toBe(
        Number.MAX_SAFE_INTEGER,
      );
    });
  });

  describe("pre-release identifiers", () => {
    it.each([
      { input: "21.0.0-rc.1", identifiers: ["rc", 1] },
      { input: "1.0.0-alpha", identifiers: ["alpha"] },
      { input: "1.0.0-alpha.1", identifiers: ["alpha", 1] },
      { input: "1.0.0-0", identifiers: [0] },
      { input: "1.0.0-x.7.z.92", identifiers: ["x", 7, "z", 92] },
    ])("splits $input into identifiers", ({ input, identifiers }) => {
      expect(parse(input).prerelease).toStrictEqual(identifiers);
    });

    it("stores numeric identifiers as numbers so comparison is numeric", () => {
      const parsed = parse("1.0.0-beta.11");

      expect(parsed.prerelease).toStrictEqual(["beta", 11]);
      expect(typeof parsed.prerelease[1]).toBe("number");
    });
  });

  describe("the parsed value", () => {
    it("keeps the raw text as received, trimmed", () => {
      // Retention is the reason a message can echo what the user's own terminal shows; trimming is the reason it does
      // not echo the whitespace a wrapper script added.
      expect(parseNodeVersion("  v20.11.1  ")?.raw).toBe("v20.11.1");
    });

    it("returns a frozen value, because parsed versions are shared as range bounds", () => {
      const parsed = parse("20.11.1");

      expect(Object.isFrozen(parsed)).toBe(true);
      expect(Object.isFrozen(parsed.prerelease)).toBe(true);
      expect(() => {
        (parsed as { major: number }).major = 99;
      }).toThrow(TypeError);
    });

    it("bounds the work it does on absurd input", () => {
      // Boundary pair: the cap is 64 characters, and these two strings sit on either side of it.
      const atLimit = `1.0.0-${"a".repeat(58)}`;
      const overLimit = `1.0.0-${"a".repeat(59)}`;

      expect(atLimit).toHaveLength(64);
      expect(overLimit).toHaveLength(65);
      expect(parseNodeVersion(atLimit)).toBeDefined();
      expect(parseNodeVersion(overLimit)).toBeUndefined();
    });

    it("never throws, whatever it is handed", () => {
      // The contract is that a caller converts `undefined` into an indeterminate result. A throw here would turn an
      // environmental oddity into a crash in the command that exists to explain the environment.
      for (const input of [
        undefined,
        null,
        "",
        "x",
        "-1.0.0",
        "1.0.0-",
        "\u0000",
      ]) {
        expect(() => parseNodeVersion(input)).not.toThrow();
      }
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Ordering                                                                   */
/* -------------------------------------------------------------------------- */

describe("compareNodeVersions", () => {
  describe("orders by the core tuple", () => {
    it.each([
      { lower: "20.10.9", higher: "20.11.0" },
      { lower: "20.11.0", higher: "20.11.1" },
      { lower: "20.11.1", higher: "21.0.0" },
      { lower: "0.0.1", higher: "1.0.0" },
    ])("$lower is lower than $higher", ({ lower, higher }) => {
      expect(compareNodeVersions(parse(lower), parse(higher))).toBeLessThan(0);
      expect(compareNodeVersions(parse(higher), parse(lower))).toBeGreaterThan(
        0,
      );
    });

    it("compares numerically rather than lexically", () => {
      // The classic hand-rolled-version-check defect: "9" > "10" as text. If this ever regresses, a runtime that is
      // too old is reported as supported.
      expect(compareNodeVersions(parse("9.0.0"), parse("10.0.0"))).toBeLessThan(
        0,
      );
      expect(
        compareNodeVersions(parse("1.0.0-beta.2"), parse("1.0.0-beta.11")),
      ).toBeLessThan(0);
    });

    it("returns zero for the same version written differently", () => {
      expect(compareNodeVersions(parse("20.11.1"), parse("v20.11.1"))).toBe(0);
      expect(
        compareNodeVersions(parse("20.11.0+build.1"), parse("20.11.0+build.2")),
      ).toBe(0);
    });
  });

  describe("ranks a release above its own pre-releases", () => {
    it.each(["21.0.0-rc.1", "21.0.0-beta", "21.0.0-0"])(
      "%s ranks below 21.0.0",
      (prerelease) => {
        expect(
          compareNodeVersions(parse(prerelease), parse("21.0.0")),
        ).toBeLessThan(0);
        expect(
          compareNodeVersions(parse("21.0.0"), parse(prerelease)),
        ).toBeGreaterThan(0);
      },
    );
  });

  describe("orders pre-release identifiers per the specification", () => {
    // The canonical precedence chain: the lower version on the left.
    it.each([
      {
        lower: "1.0.0-alpha",
        higher: "1.0.0-alpha.1",
        because: "a shorter list ranks below a longer one with the same prefix",
      },
      {
        lower: "1.0.0-alpha.1",
        higher: "1.0.0-alpha.beta",
        because: "numeric identifiers rank below alphanumeric ones",
      },
      {
        lower: "1.0.0-alpha.beta",
        higher: "1.0.0-beta",
        because: "alphanumeric identifiers compare ordinally",
      },
      {
        lower: "1.0.0-beta",
        higher: "1.0.0-beta.2",
        because: "shorter list, again",
      },
      {
        lower: "1.0.0-beta.2",
        higher: "1.0.0-beta.11",
        because: "numeric comparison of identifiers",
      },
      {
        lower: "1.0.0-beta.11",
        higher: "1.0.0-rc.1",
        because: "ordinal comparison of identifiers",
      },
      {
        lower: "1.0.0-rc.1",
        higher: "1.0.0",
        because: "a pre-release ranks below its release",
      },
    ])("$lower is lower than $higher — $because", ({ lower, higher }) => {
      expect(compareNodeVersions(parse(lower), parse(higher))).toBeLessThan(0);
      expect(compareNodeVersions(parse(higher), parse(lower))).toBeGreaterThan(
        0,
      );
    });
  });

  describe("behaves as a total order over the sample matrix", () => {
    const parsed = SAMPLES.map(parse);

    it("is reflexive", () => {
      for (const version of parsed) {
        expect(compareNodeVersions(version, version)).toBe(0);
      }
    });

    it("is antisymmetric over every pair", () => {
      // Summed signs, not a negated one. Antisymmetry is `sign(a,b) + sign(b,a) === 0`, which holds on the diagonal
      // (`0 + 0 = 0`) as well as everywhere else (`1 + -1 = 0`). Written as `sign(a,b) === -sign(b,a)` the same
      // property is true and fails on identical pairs, because the expectation becomes `-0` and `Object.is` says that
      // is not `0`. A comparator that returned 1 in both directions would pass neither form, which is the defect this
      // property exists to catch.
      for (const left of parsed) {
        for (const right of parsed) {
          expect(
            sign(compareNodeVersions(left, right)) +
              sign(compareNodeVersions(right, left)),
          ).toBe(0);
        }
      }
    });

    it("is transitive across the sorted order", () => {
      const sorted = [...parsed].sort(compareNodeVersions);

      for (let index = 0; index < sorted.length - 1; index += 1) {
        const left = sorted[index];
        const right = sorted[index + 1];
        if (left === undefined || right === undefined) continue;

        expect(compareNodeVersions(left, right)).toBeLessThanOrEqual(0);
      }
    });

    it("sorts a shuffled list into precedence order", () => {
      const shuffled = [...SAMPLES].reverse();

      expect(
        shuffled.sort((a, b) => compareNodeVersions(parse(a), parse(b))),
      ).toStrictEqual([
        "0.0.1",
        "0.4.2",
        "0.5.0",
        "1.0.0-alpha",
        "1.0.0-alpha.1",
        "1.0.0-beta",
        "1.0.0",
        "9.0.0",
        "10.0.0",
        "20.10.9",
        "20.11.0",
        "20.11.1",
        "20.999.999",
        "21.0.0-rc.1",
        "21.0.0",
        "22.1.0",
      ]);
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

describe("hasSameCore", () => {
  it("is true for versions that differ only in pre-release or build metadata", () => {
    expect(hasSameCore(parse("21.0.0-rc.1"), parse("21.0.0"))).toBe(true);
    expect(hasSameCore(parse("20.11.0+build"), parse("20.11.0"))).toBe(true);
  });

  it("is false when any core component differs", () => {
    // Used by the range evaluator's pre-release opt-in rule, where a false positive would admit an untested candidate.
    expect(hasSameCore(parse("21.0.0-rc.1"), parse("22.0.0"))).toBe(false);
    expect(hasSameCore(parse("20.11.0"), parse("20.12.0"))).toBe(false);
    expect(hasSameCore(parse("20.11.0"), parse("20.11.1"))).toBe(false);
  });
});

describe("isPrerelease", () => {
  it("distinguishes a release candidate from a release", () => {
    expect(isPrerelease(parse("21.0.0-rc.1"))).toBe(true);
    expect(isPrerelease(parse("21.0.0"))).toBe(false);
    // Build metadata is not a pre-release: it carries no precedence and must not be treated as an RC.
    expect(isPrerelease(parse("21.0.0+build.1"))).toBe(false);
  });
});

describe("formatNodeVersion", () => {
  it("is the inverse of parsing for the canonical form", () => {
    for (const sample of SAMPLES) {
      expect(formatNodeVersion(parse(sample))).toBe(sample);
    }
  });

  it("drops the prefix and build metadata, and keeps the pre-release", () => {
    expect(formatNodeVersion(parse("v20.11.1"))).toBe("20.11.1");
    expect(formatNodeVersion(parse("20.11.0+build.9"))).toBe("20.11.0");
    expect(formatNodeVersion(parse("21.0.0-rc.1"))).toBe("21.0.0-rc.1");
  });
});
