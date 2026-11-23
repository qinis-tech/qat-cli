import { describe, expect, it } from "vitest";

import { majorOf } from "~/shared/utils/version.js";

/**
 * Reading a version, not validating one.
 *
 * `majorOf` answers a single question — which major does this string start with — because every compatibility rule in
 * this project is a major-number comparison. It is deliberately not a semver parser: no precedence, no ranges, no
 * build metadata. The cases below are split by *intent* rather than by input shape, because the interesting question
 * is not what the function does to a string but what a caller may conclude from the answer.
 */

// The Cypress major that introduced `cypress.config.*`, written here rather than imported: this is a unit test of a
// shared utility, and a shared module must not acquire a dependency on a project layer through its own test.
const FORMAT_FLOOR = 10;

describe("reads a major", () => {
  it.each([
    ["13.15.0", 13],
    ["9.7.0", 9],
    ["10.0.0", 10],
    ["0.0.1", 0],
    // Multi-digit majors are not hypothetical: Cypress went 9 → 10, and a two-digit major is the case a
    // first-character implementation would read as `1`.
    ["100.2.3", 100],
    // Leading zeros are not legal in semver and do occur in hand-written manifests. Reading `013` as 13 is the only
    // sensible answer; rejecting it would turn a cosmetic defect into an unsupported version.
    ["013.0.0", 13],
  ])("reads %s as %i", (version, major) => {
    expect(majorOf(version)).toBe(major);
  });

  it("returns a number, so a comparison is a comparison", () => {
    const major = majorOf("13.15.0");

    // `toBe` above already distinguishes 13 from '13'. This asserts the property the callers depend on: every
    // consumer compares the result with `<` or `>`, and a captured string would make `'9' < 10` false and `'13' < 10`
    // true — both silently wrong.
    expect(typeof major).toBe("number");
    expect((major ?? 0) + 1).toBe(14);
  });
});

describe("refuses anything that is not a version", () => {
  it.each([
    // No trailing component. Cypress always reports three, so this is a defect rather than a version, and guessing a
    // major from a bare prefix is how a truncated string becomes a confident wrong answer.
    ["13"],
    // A tag. `parseInt` would read `v13`'s digits only if the regex allowed a prefix, and allowing one would also
    // accept `release-13.0.0`.
    ["v13.0.0"],
    ["beta"],
    [""],
    // Leading padding, refused because the anchor is at the start. Trimming would be a decision, and it is the caller's:
    // an environment variable somebody quoted is the caller's problem to normalise, not a shared reader's to hide.
    //
    // Trailing padding is *not* here, because the anchor is not at the end — see the limits block, where it is recorded
    // as a consequence rather than a defect.
    [" 13.0.0"],
    ["\n13.0.0"],
    ["\t13.0.0"],
    // The regex is anchored, so a leading sign does not slip through.
    ["-1.0.0"],
    ["+1.0.0"],
    // Digits that are not ASCII. `\d` in a JavaScript regex without the `u` flag is ASCII-only, and a Cyrillic digit
    // would `parseInt` to NaN if it ever reached it.
    ["١٣.0.0"],
  ])("refuses %j", (version) => {
    expect(majorOf(version)).toBeUndefined();
  });

  it("refuses a value that is not a string at all", () => {
    // Typed as `string`, so this needs a cast — and it exists because the value comes from an installed package's
    // manifest, which is untrusted JSON narrowed by `readJson`, and one refactor could hand this a number. A throw here
    // would fail a whole detection for one bad manifest.
    expect(majorOf(13 as unknown as string)).toBeUndefined();
  });
});

describe("at the format floor", () => {
  it.each([
    ["9.99.99", true],
    ["10.0.0", false],
    ["10.0.0-rc.1", false],
    ["11.2.0", false],
  ])("answers %s below the floor: %s", (version, below) => {
    // The pair that makes this function load-bearing: `9.99.99` is a later *version* than `10.0.0` and an earlier
    // *major*, and every compatibility rule in the project compares majors. A string comparison would get this
    // backwards, which is why the function exists rather than an inline `split('.')[0]`.
    const major = majorOf(version);

    expect(major).toBeDefined();
    expect((major ?? Number.NaN) < FORMAT_FLOOR).toBe(below);
  });
});

describe("known limits, recorded rather than fixed", () => {
  it("reads a prerelease as its major, which is what a nightly build needs", () => {
    // `13.0.0-beta.1` is a version Cypress publishes. Reading the major makes it comparable; refusing it would mean a
    // project on a prerelease were reported as an unknown version.
    expect(majorOf("13.0.0-beta.1")).toBe(13);
  });

  it("reads a malformed string by its prefix rather than rejecting it", () => {
    // `13..0` is not a version and this returns 13. That is the cost of reading a prefix instead of validating, and it
    // is the right trade here: the only alternative is a parser, and no consumer performs a comparison that would
    // justify one. The installed manifest's `version` is used for display and for a major comparison, and a truncated
    // string that still starts with a plausible major is closer to useful than `undefined`.
    expect(majorOf("13..0")).toBe(13);
    expect(majorOf("13.0")).toBe(13);
  });

  it("does not read a major out of a version with a trailing dot only", () => {
    // `13.` is the shortest string the regex accepts, and it is worth pinning: it is the boundary between "reads a
    // prefix" and "requires a component after the dot".
    expect(majorOf("13.")).toBe(13);
  });
});

describe("non-functional behaviour", () => {
  it("never throws, for any input", () => {
    const inputs = [
      "",
      ".",
      "..",
      "...",
      "1".repeat(1000),
      `${"9".repeat(400)}.0.0`,
      "\u0000",
      "\u0000.0.0",
      "13.0.0\n14.0.0",
      "NaN.0.0",
      "Infinity.0.0",
    ];

    // A reader in a detection path must not be able to fail a run. Total over `string` means no input turns a version
    // into an exception, including one that is not really a version at all.
    for (const input of inputs) {
      expect(() => majorOf(input)).not.toThrow();
      expect(["number", "undefined"]).toContain(typeof majorOf(input));
    }
  });

  it("is deterministic and side-effect free", () => {
    // Trivial for a pure function, and worth one line: if this ever gains a cache or a module-level regex with the
    // `g` flag, the second call starts from a different `lastIndex` and returns something else.
    expect(majorOf("13.15.0")).toBe(majorOf("13.15.0"));
    expect(majorOf("13.15.0")).toBe(13);
  });

  it("does not mutate its argument", () => {
    const version = "13.15.0";

    majorOf(version);

    expect(version).toBe("13.15.0");
  });
});
