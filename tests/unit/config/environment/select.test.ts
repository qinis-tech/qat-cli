/**
 * Unit tests for environment selection.
 *
 * The whole contract this file protects is one sentence: **the first supplied candidate wins, and
 * "supplied" is not the same as "usable".** Everything surprising about `selectEnvironment` follows from
 * that, and everything it prevents follows from the same place — an empty `--env ""` must not quietly
 * fall through to a configured default, because that would run an environment nobody asked for.
 *
 * The tests are grouped by the question they answer rather than by function, because the interesting
 * cases are the ones where two of those questions meet: trimming versus emptiness, a non-string input
 * versus an absent one, a supplied value versus a usable one.
 */

import { describe, expect, it } from "vitest";

import {
  isUsableName,
  MAX_ENVIRONMENT_NAME_LENGTH,
  SELECTION_PRECEDENCE,
  selectEnvironment,
} from "~/config/environment/select.js";

describe("SELECTION_PRECEDENCE", () => {
  it("is the order the documentation states", () => {
    // Quoted by `docs/architecture/environment-diagnostics.md` and asserted here rather than trusted:
    // a precedence table that exists in two places is a precedence table that will disagree with itself.
    expect(SELECTION_PRECEDENCE).toStrictEqual([
      "explicit-cli",
      "process-environment",
      "configuration-default",
    ]);
  });

  it("is frozen", () => {
    // Exported, so anything could push to it. A mutated precedence list would change behaviour in
    // every later test in the same process, which is the worst kind of test-order dependency.
    expect(Object.isFrozen(SELECTION_PRECEDENCE)).toBe(true);
  });
});

describe("selectEnvironment — precedence", () => {
  it("uses the configured default when nothing else is supplied", () => {
    expect(
      selectEnvironment({ fromConfiguration: "development" }),
    ).toStrictEqual({
      origin: "configuration-default",
      name: "development",
    });
  });

  it("prefers the process environment over the configured default", () => {
    expect(
      selectEnvironment({
        fromProcess: "local",
        fromConfiguration: "development",
      }),
    ).toStrictEqual({ origin: "process-environment", name: "local" });
  });

  it("prefers an explicit selection over the process environment", () => {
    expect(
      selectEnvironment({
        explicit: "staging",
        fromProcess: "local",
        fromConfiguration: "development",
      }),
    ).toStrictEqual({ origin: "explicit-cli", name: "staging" });
  });

  it("reports the origin of the winner, not of every candidate", () => {
    // The origin is what makes a finding explainable. Reporting all three would leave the reader to
    // work out which one actually applied.
    const selection = selectEnvironment({
      fromProcess: "local",
      fromConfiguration: "development",
    });

    expect(selection.origin).toBe("process-environment");
  });

  it("reports `none` when nothing is supplied anywhere", () => {
    expect(selectEnvironment({})).toStrictEqual({ origin: "none" });
  });

  it("returns a shared frozen value for the no-selection case", () => {
    // Shared rather than rebuilt so the happy path allocates nothing; frozen so a caller cannot make
    // one test's mutation visible to the next.
    expect(Object.isFrozen(selectEnvironment({}))).toBe(true);
  });
});

describe("selectEnvironment — supplied is not the same as usable", () => {
  it.each([
    ["empty", ""],
    ["whitespace only", "   "],
    ["a tab", "\t"],
  ])(
    "returns an unusable selection for %s input rather than falling through",
    (_label, value) => {
      // The single most important behaviour in this module. Falling through here would silently run
      // against `development` when the user asked for something they mistyped as nothing.
      expect(
        selectEnvironment({
          explicit: value,
          fromConfiguration: "development",
        }),
      ).toStrictEqual({
        origin: "explicit-cli",
        name: "",
      });
    },
  );

  it("does not fall through when the process environment supplies an empty value", () => {
    expect(
      selectEnvironment({ fromProcess: "", fromConfiguration: "development" }),
    ).toStrictEqual({
      origin: "process-environment",
      name: "",
    });
  });

  it("trims surrounding whitespace from a usable selection", () => {
    // `--env " staging "` is a shell artefact and worth forgiving. Interior whitespace is not, and
    // `isUsableName` rejects it below.
    expect(selectEnvironment({ explicit: "  staging \n" })).toStrictEqual({
      origin: "explicit-cli",
      name: "staging",
    });
  });

  it("preserves case", () => {
    // `Staging` and `staging` are different profiles. Lower-casing here would make the selector agree
    // with a matcher that does not exist and hide a typo the user can see.
    expect(selectEnvironment({ explicit: "Staging" })).toStrictEqual({
      origin: "explicit-cli",
      name: "Staging",
    });
  });
});

describe("selectEnvironment — defensive input", () => {
  it.each([
    ["a number", 42],
    ["null", null],
    ["an object", { name: "staging" }],
  ])("treats %s as not supplied", (_label, value) => {
    // Callers pass values that originate outside TypeScript — CLI argv, process.env — so a non-string
    // is a real possibility. Coercing it would turn `--env 42` into the profile named "42".
    expect(
      selectEnvironment({
        explicit: value as unknown as string,
        fromConfiguration: "development",
      }),
    ).toStrictEqual({ origin: "configuration-default", name: "development" });
  });

  it("does not mutate the input", () => {
    const input = Object.freeze({ explicit: " staging " });

    expect(() => selectEnvironment(input)).not.toThrow();
  });

  it("does not consult the process environment itself", () => {
    // Selection is a pure function of its argument. If it read `QAT_ENV` on its own, a test could not
    // control selection without mutating the real environment — and the caller that decided the
    // precedence would be a second, invisible one.
    const before = process.env["QAT_ENV"];
    process.env["QAT_ENV"] = "staging";

    try {
      expect(selectEnvironment({})).toStrictEqual({ origin: "none" });
    } finally {
      if (before === undefined) delete process.env["QAT_ENV"];
      else process.env["QAT_ENV"] = before;
    }
  });
});

describe("selectEnvironment — determinism", () => {
  it("returns the same selection for the same input, every time", () => {
    // Environment resolution is required to be deterministic; selection is the half of it that could
    // accidentally depend on iteration order or on the clock.
    const input = {
      explicit: "staging",
      fromProcess: "local",
      fromConfiguration: "development",
    };
    const first = selectEnvironment(input);

    for (let index = 0; index < 1_000; index += 1) {
      expect(selectEnvironment(input)).toStrictEqual(first);
    }
  });
});

describe("isUsableName", () => {
  it.each([
    ["a single letter", "a"],
    ["a lowercase word", "staging"],
    ["a hyphenated name", "staging-eu"],
    ["a dotted name", "prod.eu"],
    ["a leading digit", "9lives"],
    ["mixed case", "StagingEU"],
  ])("accepts %s", (_label, name) => {
    expect(isUsableName(name)).toBe(true);
  });

  it.each([
    ["the empty string", ""],
    ["a single space", " "],
    ["leading whitespace", " staging"],
    ["trailing whitespace", "staging "],
    ["interior whitespace", "sta ging"],
    ["a leading hyphen", "-staging"],
    ["a leading dot", ".staging"],
    ["a leading underscore", "_staging"],
    ["a path separator", "staging/eu"],
    ["a newline", "staging\neu"],
    ["a NUL byte", "staging\u0000"],
    ["an at sign", "staging@eu"],
    ["a colon", "staging:eu"],
  ])("rejects %s", (_label, name) => {
    // Everything rejected here would need quoting or escaping somewhere downstream — a CLI argument, a
    // JSON key, a rendered finding — and a name that has to be escaped in one place and not another is
    // a name QAT should not accept at all.
    expect(isUsableName(name)).toBe(false);
  });

  it("accepts an underscore, matching the characters the remediation lists", () => {
    // Settled in favour of the guidance sentence. `QAT-H040`'s remediation lists "letters, digits, dots,
    // dashes and underscores", and a pattern that disagreed with the sentence a user reads is the worse
    // of the two failures — the reader is told a name is valid and the selector refuses it.
    //
    // `_staging` is still rejected by the table above, and that is not an inconsistency: the first
    // character must be a letter or a digit. The rule is about where a name may begin, not about which
    // characters may follow.
    expect(isUsableName("staging_eu")).toBe(true);
  });

  it("accepts a name of exactly the maximum length", () => {
    expect(isUsableName("a".repeat(MAX_ENVIRONMENT_NAME_LENGTH))).toBe(true);
  });

  it("rejects a name one character longer than the maximum", () => {
    // A bound, not a preference: names appear in arguments and in rendered output, and an unbounded one
    // turns a typo into an unreadable report.
    expect(isUsableName("a".repeat(MAX_ENVIRONMENT_NAME_LENGTH + 1))).toBe(
      false,
    );
  });

  it("accepts the shortest possible name", () => {
    expect(isUsableName("a")).toBe(true);
  });
});

describe("MAX_ENVIRONMENT_NAME_LENGTH", () => {
  it("is the bound the selector and the matcher both use", () => {
    // Posted so a caller that validates a name before passing it does not restate the number. A
    // restated bound is a bound that eventually admits a name the selector rejects.
    expect(MAX_ENVIRONMENT_NAME_LENGTH).toBe(64);
  });
});
