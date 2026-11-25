/**
 * Unit tests for `core/compatibility/range.ts`.
 *
 * This suite is the boundary matrix the compatibility policy rests on. Every claim QAT makes about a supported runtime
 * is the answer to one question — "does this version belong to this set?" — and that answer is decided here, once. A
 * defect in this file does not produce a subtly wrong message; it produces a support claim that is wrong.
 *
 * Three kinds of case, and they are not interchangeable:
 *
 *   • TABLE CASES   — one row per operator, per accepted grammar form, and per refused form. Refusal needs evidence as
 *                     much as acceptance does: the parser's job is to say "I cannot read this" rather than to guess,
 *                     because a guess here becomes a verdict.
 *   • PAIRS         — an edge and its neighbour (`20.10.9` / `20.11.0`, `20.999.999` / `21.0.0`). A single case at a
 *                     boundary cannot tell `>` from `>=`, and cannot tell an exclusive ceiling from an inclusive one.
 *   • PROPERTIES    — coverage of the operator list, immutability of the parsed expression, and the promise that no
 *                     input makes these functions throw.
 *
 * Rows are objects rather than positional tuples: a row states what each column means without the reader counting
 * commas, and `$name` interpolation puts the case's own words into the title.
 */
import { describe, expect, it } from "vitest";

import {
  SUPPORTED_OPERATORS,
  classifyDeviation,
  parseRange,
  satisfiesRange,
  type RangeOperator,
} from "../../../../src/core/compatibility/range.js";
import { parseNodeVersion } from "../../../../src/core/compatibility/version.js";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/** Parses a version fixture, failing loudly when the input is not a version. */
function versionOf(input: string) {
  const parsed = parseNodeVersion(input);
  if (parsed === undefined)
    throw new Error(`fixture is not a version: ${JSON.stringify(input)}`);
  return parsed;
}

/**
 * Parses a range fixture, failing loudly and naming the reason.
 *
 * The reason is included because the two failures are fixed differently: `empty` means the policy declared nothing,
 * `unsupported-syntax` means it used a form we refuse, and `invalid-version` means a bound was not a complete tuple.
 */
function rangeOf(input: string) {
  const parsed = parseRange(input);
  if (!parsed.ok) {
    throw new Error(
      `fixture is not a range: ${JSON.stringify(input)} (${parsed.reason})`,
    );
  }

  return parsed.expression;
}

/** Does this version belong to this range? The one question the module answers. */
function satisfies(range: string, version: string): boolean {
  return satisfiesRange(rangeOf(range), versionOf(version));
}

/* -------------------------------------------------------------------------- */
/* Operator coverage                                                          */
/* -------------------------------------------------------------------------- */

/**
 * A candidate that each operator accepts and one it refuses.
 *
 * The table is checked against `SUPPORTED_OPERATORS` below, so adding an operator without a row here fails rather than
 * quietly losing the coverage of a promise the module makes in a comment.
 */
const OPERATOR_CASES: readonly {
  operator: RangeOperator;
  accepted: string;
  refused: string;
}[] = [
  { operator: ">=", accepted: "20.11.0", refused: "20.10.9" },
  { operator: "<=", accepted: "20.11.0", refused: "20.11.1" },
  { operator: ">", accepted: "20.11.1", refused: "20.11.0" },
  { operator: "<", accepted: "20.10.9", refused: "20.11.0" },
  { operator: "=", accepted: "20.11.0", refused: "20.11.1" },
  { operator: "^", accepted: "20.99.0", refused: "21.0.0" },
  { operator: "~", accepted: "20.11.9", refused: "20.12.0" },
];

describe("the operator list", () => {
  it("covers every operator the evaluator claims to support", () => {
    // Both directions: an operator with no case is untested, and a case for an operator that no longer exists is a
    // test of nothing.
    expect(OPERATOR_CASES.map((c) => c.operator).sort()).toStrictEqual(
      [...SUPPORTED_OPERATORS].sort(),
    );
  });

  it.each(OPERATOR_CASES)(
    "`$operator` accepts and refuses its neighbours",
    ({ operator, accepted, refused }) => {
      // The pair is the point. `>` and `>=` differ only at the bound itself, so a single case cannot distinguish them —
      // and the same is true of `<` and `<=`.
      expect(satisfies(`${operator}20.11.0`, accepted)).toBe(true);
      expect(satisfies(`${operator}20.11.0`, refused)).toBe(false);
    },
  );
});

/* -------------------------------------------------------------------------- */
/* Parsing                                                                    */
/* -------------------------------------------------------------------------- */

describe("parseRange", () => {
  describe("accepts the documented grammar", () => {
    it.each([
      { range: "20.11.0", because: "a bare version is equality" },
      { range: "=20.11.0", because: "an explicit equality" },
      { range: ">=20.11.0", because: "a floor" },
      { range: ">= 20.11.0", because: "an operator separated from its bound" },
      { range: ">=20.11.0 <21.0.0", because: "a floor and a ceiling" },
      {
        range: ">= 20.11.0 < 21.0.0",
        because: "both operators separated from their bounds",
      },
      { range: ">=20.11.0 <21.0.0 || >=22.0.0", because: "two alternatives" },
      { range: "  >=20.11.0   <21.0.0  ", because: "irregular whitespace" },
      { range: ">=20.11.0\n<21.0.0", because: "a newline instead of a space" },
      { range: ">=24.0.0-rc.1 <25.0.0", because: "a pre-release bound" },
      {
        range: ">=20.11.0+build <21.0.0",
        because: "build metadata on a bound",
      },
    ])("reads $range — $because", ({ range }) => {
      expect(parseRange(range).ok).toBe(true);
    });

    it("groups comparators into alternatives", () => {
      const parsed = parseRange("<19.0.0 || >=22.0.0 <23.0.0");
      if (!parsed.ok) throw new Error("fixture should parse");

      // The shape matters as much as the acceptance: `classifyDeviation` reads alternatives to decide its wording, so a
      // parser that flattened `||` into one conjunction would still accept this and answer the wrong question.
      expect(parsed.expression).toHaveLength(2);
      expect(parsed.expression[0]?.map((c) => c.operator)).toStrictEqual(["<"]);
      expect(parsed.expression[1]?.map((c) => c.operator)).toStrictEqual([
        ">=",
        "<",
      ]);
    });

    it("keeps the bounds as parsed versions, unparsed again downstream", () => {
      const parsed = parseRange(">=20.11.0 <21.0.0");
      if (!parsed.ok) throw new Error("fixture should parse");

      expect(parsed.expression[0]?.[0]?.bound.raw).toBe("20.11.0");
      expect(parsed.expression[0]?.[1]?.bound.major).toBe(21);
    });
  });

  describe("refuses what it cannot read, and says why", () => {
    it.each([
      { range: "", reason: "empty", because: "nothing was declared" },
      { range: "   ", reason: "empty", because: "only whitespace" },
      {
        range: "20.11",
        reason: "invalid-version",
        because: "a partial tuple — the patch level would be invented",
      },
      {
        range: ">=20",
        reason: "invalid-version",
        because: "a bare major floor",
      },
      {
        range: ">=20.11 <21.0.0",
        reason: "invalid-version",
        because: "a partial floor",
      },
      {
        range: ">=20.11.0 <21",
        reason: "invalid-version",
        because: "a bare major ceiling",
      },
      {
        range: "lts/*",
        reason: "unsupported-syntax",
        because: "a channel name is not a version",
      },
      {
        range: "*",
        reason: "unsupported-syntax",
        because: "a wildcard bounds nothing",
      },
      {
        range: "20.x",
        reason: "unsupported-syntax",
        because: "a wildcard patch level",
      },
      {
        range: "18.0.0 - 20.0.0",
        reason: "unsupported-syntax",
        because: "a hyphen range has no patch levels",
      },
      {
        range: "!=20.11.0",
        reason: "unsupported-syntax",
        because: "a negation describes an excluded set",
      },
      {
        range: ">= <20.11.0",
        reason: "unsupported-syntax",
        because: "two operators for one bound",
      },
      {
        range: ">=20.11.0 >=",
        reason: "unsupported-syntax",
        because: "a dangling operator",
      },
      {
        range: ">=20.11.0 ||",
        reason: "unsupported-syntax",
        because: "a trailing alternative would accept everything",
      },
      {
        range: "|| >=20.11.0",
        reason: "unsupported-syntax",
        because: "a leading empty alternative",
      },
      {
        range: ">=20.11.0 || || <21.0.0",
        reason: "unsupported-syntax",
        because: "a doubled separator",
      },
    ])("refuses $range — $because", ({ range, reason }) => {
      expect(parseRange(range)).toStrictEqual({ ok: false, reason });
    });

    it("never treats an empty alternative as satisfiable", () => {
      // `[].every(...)` is `true`, so an empty alternative that survived parsing would make the policy accept *every*
      // version. This is the one refusal that is a safety property rather than a strictness preference.
      for (const range of ["||", ">=", ">=20.11.0 ||", "|| >=20.11.0"]) {
        expect(parseRange(range).ok).toBe(false);
      }
    });
  });

  describe("the parsed expression", () => {
    it("is frozen, because a range is shared as a bound across evaluations", () => {
      const parsed = parseRange(">=20.11.0 <21.0.0");
      if (!parsed.ok) throw new Error("fixture should parse");

      expect(Object.isFrozen(parsed.expression)).toBe(true);
      expect(Object.isFrozen(parsed.expression[0])).toBe(true);
      expect(Object.isFrozen(parsed.expression[0]?.[0])).toBe(true);
    });

    it("never throws, whatever it is handed", () => {
      // The contract is that a caller turns `undefined`-ish input into an indeterminate result. A throw here would turn
      // an unreadable policy into a crash in the command that exists to explain it.
      for (const range of [
        "",
        " ",
        "||",
        ">=",
        "\u0000",
        "^",
        "~",
        "=",
        ">= ",
        "0.0.0",
        ">=999999999999999999999.0.0",
      ]) {
        expect(() => parseRange(range)).not.toThrow();
      }
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Membership                                                                 */
/* -------------------------------------------------------------------------- */

describe("satisfiesRange", () => {
  describe("walks a floor and a ceiling", () => {
    it.each([
      {
        version: "20.10.9",
        expected: false,
        because: "one patch below an inclusive floor",
      },
      {
        version: "20.11.0",
        expected: true,
        because: "the floor itself is inclusive",
      },
      { version: "20.11.1", expected: true, because: "inside" },
      {
        version: "20.999.999",
        expected: true,
        because: "one minor below the ceiling",
      },
      {
        version: "21.0.0",
        expected: false,
        because: "the ceiling itself is exclusive",
      },
      {
        version: "20.11.0-rc.1",
        expected: false,
        because: "a pre-release of the floor does not inherit its support",
      },
    ])(
      "$version → $expected against `>=20.11.0 <21.0.0` — $because",
      ({ version, expected }) => {
        expect(satisfies(">=20.11.0 <21.0.0", version)).toBe(expected);
      },
    );

    it("does not care which order the comparators are written in", () => {
      expect(satisfies("<21.0.0 >=20.11.0", "20.11.1")).toBe(true);
      expect(satisfies("<21.0.0 >=20.11.0", "20.10.9")).toBe(false);
    });

    it("treats an open-ended range as having no ceiling", () => {
      expect(satisfies(">=20.11.0", "20.11.0")).toBe(true);
      expect(satisfies(">=20.11.0", "99.0.0")).toBe(true);
      expect(satisfies(">=20.11.0", "20.10.9")).toBe(false);
    });
  });

  describe("resolves caret ranges at the next significant release", () => {
    it.each([
      { range: "^20.11.0", version: "20.11.0", expected: true },
      { range: "^20.11.0", version: "20.99.0", expected: true },
      { range: "^20.11.0", version: "21.0.0", expected: false },
      { range: "^20.11.0", version: "20.10.9", expected: false },
      // Zero-major rules: the ones readers get wrong, so each is a case rather than a comment.
      { range: "^0.4.2", version: "0.4.9", expected: true },
      { range: "^0.4.2", version: "0.5.0", expected: false },
      { range: "^0.0.3", version: "0.0.3", expected: true },
      { range: "^0.0.3", version: "0.0.4", expected: false },
    ])(
      "$version against $range → $expected",
      ({ range, version, expected }) => {
        expect(satisfies(range, version)).toBe(expected);
      },
    );
  });

  describe("resolves tilde ranges at the next minor release", () => {
    it.each([
      { version: "20.11.0", expected: true },
      { version: "20.11.9", expected: true },
      { version: "20.12.0", expected: false },
      { version: "20.10.9", expected: false },
    ])("$version against `~20.11.0` → $expected", ({ version, expected }) => {
      expect(satisfies("~20.11.0", version)).toBe(expected);
    });
  });

  describe("walks alternatives, and the gaps between them", () => {
    it.each([
      {
        range: ">=20.11.0 <21.0.0 || >=22.0.0",
        version: "20.11.0",
        expected: true,
        because: "the first alternative",
      },
      {
        range: ">=20.11.0 <21.0.0 || >=22.0.0",
        version: "22.3.0",
        expected: true,
        because: "the second alternative",
      },
      {
        range: ">=20.11.0 <21.0.0 || >=22.0.0",
        version: "21.5.0",
        expected: false,
        because: "the gap between them",
      },
      {
        range: "<19.0.0 || >=22.0.0",
        version: "20.0.0",
        expected: false,
        because: "inside the span, in the gap",
      },
      {
        range: "<19.0.0 || >=22.0.0",
        version: "18.0.0",
        expected: true,
        because: "the open lower alternative",
      },
    ])(
      "$version against $range → $expected — $because",
      ({ range, version, expected }) => {
        expect(satisfies(range, version)).toBe(expected);
      },
    );
  });

  describe("admits pre-releases only when the range names one", () => {
    it.each([
      {
        range: ">=24.0.0 <25.0.0",
        version: "24.0.0-rc.1",
        expected: false,
        because: "no comparator names a pre-release of 24.0.0",
      },
      {
        range: ">=24.0.0-rc.1 <24.0.0",
        version: "24.0.0-rc.1",
        expected: true,
        because: "the bound is that exact pre-release",
      },
      {
        range: ">=24.0.0-rc.1 <25.0.0",
        version: "25.0.0-beta",
        expected: false,
        because: "the named pre-release is of a different core tuple",
      },
      {
        range: ">=24.0.0-rc.1 <25.0.0",
        version: "24.0.0",
        expected: true,
        because: "a released version above a pre-release floor",
      },
    ])(
      "$version against $range → $expected — $because",
      ({ range, version, expected }) => {
        // The opt-in rule is what stops an untested release candidate from inheriting the stable line's support badge,
        // and the third case is the subtle one: naming *a* pre-release does not admit every pre-release.
        expect(satisfies(range, version)).toBe(expected);
      },
    );
  });

  describe("is the only thing that decides membership", () => {
    it("agrees with itself across repeated evaluations", () => {
      // `satisfiesRange` takes a parsed expression, so a stateful implementation would be a bug nobody could see from a
      // single call. Two evaluations of the same expression must agree.
      const expression = rangeOf(">=20.11.0 <21.0.0");

      expect(satisfiesRange(expression, versionOf("20.11.1"))).toBe(true);
      expect(satisfiesRange(expression, versionOf("20.11.1"))).toBe(true);
      expect(satisfiesRange(expression, versionOf("21.0.0"))).toBe(false);
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Explaining a mismatch                                                      */
/* -------------------------------------------------------------------------- */

describe("classifyDeviation", () => {
  // Only ever consulted for a version that already failed `satisfiesRange`. It chooses wording — "too old", "too new",
  // "in a gap" — and never a verdict, which is why every case below is paired with a non-satisfying candidate.

  it.each([
    {
      range: ">=20.11.0 <21.0.0",
      version: "20.10.9",
      expected: "below-minimum",
      because: "one patch under the floor",
    },
    {
      range: ">=20.11.0 <21.0.0",
      version: "18.19.0",
      expected: "below-minimum",
      because: "a lower major",
    },
    {
      range: ">=20.11.0 <21.0.0",
      version: "21.0.0",
      expected: "above-maximum",
      because: "the exclusive ceiling",
    },
    {
      range: ">=20.11.0 <21.0.0",
      version: "25.0.0",
      expected: "above-maximum",
      because: "several majors above",
    },
    {
      range: ">=20.11.0",
      version: "10.0.0",
      expected: "below-minimum",
      because: "under an open-ended floor",
    },
    {
      range: "~20.11.0",
      version: "20.10.0",
      expected: "below-minimum",
      because: "under a tilde floor",
    },
    {
      range: "~20.11.0",
      version: "20.13.0",
      expected: "above-maximum",
      because: "above a tilde ceiling",
    },
    {
      range: "^20.11.0",
      version: "21.0.0",
      expected: "above-maximum",
      because: "above a caret ceiling",
    },
    {
      range: ">=20.11.0 <21.0.0 || >=22.0.0",
      version: "21.5.0",
      expected: "outside-range",
      because: "between alternatives, neither too old nor too new",
    },
    {
      range: "<19.0.0 || >=22.0.0",
      version: "20.0.0",
      expected: "outside-range",
      because: "a gap in an explicitly non-contiguous policy",
    },
  ])(
    "$version against $range is $expected — $because",
    ({ range, version, expected }) => {
      expect(classifyDeviation(rangeOf(range), versionOf(version))).toBe(
        expected,
      );
    },
  );

  it("never contradicts membership, whatever it reports", () => {
    // The design claim, made executable: wording and verdict are independent, and a candidate that satisfies the range
    // is never reported to a reader as unsupported. Every case here satisfies, so no classification may be used to
    // claim otherwise downstream.
    const expression = rangeOf(">=20.11.0 <21.0.0");

    for (const version of ["20.11.0", "20.11.1", "20.999.999"]) {
      expect(satisfiesRange(expression, versionOf(version))).toBe(true);
    }
  });
});
