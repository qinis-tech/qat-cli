/**
 * Unit tests for `core/compatibility/policy.ts`.
 *
 * This is the module every compatibility answer flows through, so the suite has two jobs that are different in kind:
 *
 *   • TABLE CASES   — one row per branch of `evaluateVersionRequirement`, naming the status *and* the reason. The
 *                     reasons are what remediation is written from, so "unsatisfied" alone is a weaker claim than the
 *                     case intends.
 *   • ORDER CASES   — the six steps run in a fixed sequence, and the sequence is the contract. A version that cannot be
 *                     read must be reported as unreadable *before* the policy is consulted, and an unreadable policy must
 *                     be reported *before* any claim of satisfaction. Those are the two orders that, if reversed, turn
 *                     "I could not check" into a pass.
 *
 * Requirements are built through `qatRuntimeRequirement` / `cypressRuntimeRequirement` rather than as object literals:
 * the builders are part of what this file tests, and a hand-written literal would let the two disagree about the shape
 * without anything noticing.
 */
import { describe, expect, it } from "vitest";

import {
  CYPRESS_REQUIREMENT_ORIGIN,
  QAT_REQUIREMENT_ORIGIN,
  cypressRuntimeRequirement,
  evaluateVersionRequirement,
  isIndeterminate,
  isSatisfied,
  isUnsatisfied,
  qatRuntimeRequirement,
  statusOf,
  type CompatibilityVerdict,
  type VersionRequirement,
} from "../../../../src/core/compatibility/index.js";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/** A QAT requirement declaring the given range, exactly as the manifest would. */
function qat(range: string): VersionRequirement {
  return qatRuntimeRequirement({ engines: { node: range } });
}

/** Evaluates one version against one declared range. */
function evaluate(
  range: string,
  version: string | undefined,
): CompatibilityVerdict {
  return evaluateVersionRequirement(qat(range), version);
}

/**
 * Every combination the suite cares about, used by the cross-cutting invariants below.
 *
 * Kept as one list so a new branch added to `evaluateVersionRequirement` that is not represented here shows up as a
 * scenario the invariant tests do not cover — which is the closest thing to "every reason is exercised" that a unit
 * suite can assert about itself.
 */
const SCENARIOS: readonly { range: string; version: string | undefined }[] = [
  { range: ">=20.11.0 <21.0.0", version: "20.11.0" },
  { range: ">=20.11.0 <21.0.0", version: "20.10.9" },
  { range: ">=20.11.0 <21.0.0", version: "21.0.0" },
  { range: "<19.0.0 || >=22.0.0", version: "20.0.0" },
  { range: ">=24.0.0 <25.0.0", version: "24.0.0-rc.1" },
  { range: ">=24.0.0-rc.1 <24.0.0", version: "24.0.0-rc.1" },
  { range: "", version: "20.11.0" },
  { range: ">=20", version: "20.11.0" },
  { range: ">=20.11.0 <21.0.0", version: "v-next" },
  { range: ">=20.11.0 <21.0.0", version: "" },
  { range: ">=20.11.0 <21.0.0", version: undefined },
];

/* -------------------------------------------------------------------------- */
/* Requirement resolution                                                     */
/* -------------------------------------------------------------------------- */

describe("qatRuntimeRequirement", () => {
  it("reads the declared range, trimmed, with its provenance", () => {
    const requirement = qatRuntimeRequirement({
      engines: { node: "  >=20.11.0 <21.0.0  " },
    });

    expect(requirement).toStrictEqual({
      source: "qat",
      range: ">=20.11.0 <21.0.0",
      origin: QAT_REQUIREMENT_ORIGIN,
      severityWhenUnsatisfied: "error",
    });
  });

  it("is frozen, because one value is shared by every consumer in the run", () => {
    const requirement = qatRuntimeRequirement({
      engines: { node: ">=20.11.0" },
    });

    expect(Object.isFrozen(requirement)).toBe(true);
  });

  it.each([
    { manifest: undefined, because: "the manifest could not be read" },
    { manifest: {}, because: "no engines field" },
    { manifest: { engines: {} }, because: "engines declares nothing" },
    { manifest: { engines: { node: "" } }, because: "an empty declaration" },
    {
      manifest: { engines: { node: "   " } },
      because: "a whitespace-only declaration",
    },
    { manifest: { engines: null }, because: "engines is not an object" },
  ])("declares an empty range when $because", ({ manifest }) => {
    // Empty rather than absent, and never a default: an installation that declares nothing must be *reported* as
    // declaring nothing. Substituting a fallback here would replace a visible warning with a silent assumption.
    const requirement = qatRuntimeRequirement(manifest as never);

    expect(requirement.range).toBe("");
    expect(requirement.origin).toBe(QAT_REQUIREMENT_ORIGIN);
  });

  it("refuses a declaration that is not a string without throwing", () => {
    const requirement = qatRuntimeRequirement({
      engines: { node: 42 as unknown as string },
    });

    expect(requirement.range).toBe("");
  });

  it("never throws, whatever the manifest looks like", () => {
    // The one command a user runs *because* their installation is broken must not be the command that crashes.
    for (const manifest of [
      undefined,
      {},
      { engines: {} },
      { engines: null },
      { engines: { node: null } },
    ]) {
      expect(() => qatRuntimeRequirement(manifest as never)).not.toThrow();
    }
  });
});

describe("cypressRuntimeRequirement", () => {
  it("builds an advisory requirement, with its own provenance", () => {
    expect(cypressRuntimeRequirement("  >=22.0.0 <25.0.0  ")).toStrictEqual({
      source: "cypress",
      range: ">=22.0.0 <25.0.0",
      origin: CYPRESS_REQUIREMENT_ORIGIN,
      severityWhenUnsatisfied: "warning",
    });
  });

  it("is frozen", () => {
    expect(Object.isFrozen(cypressRuntimeRequirement(">=22.0.0"))).toBe(true);
  });

  it.each([
    { declared: undefined, because: "nothing was declared" },
    { declared: "", because: "the declaration is empty" },
    { declared: "   ", because: "the declaration is whitespace" },
  ])("returns undefined when $because", ({ declared }) => {
    // Absence of evidence must not become a fabricated finding: no declaration means no advisory, not a warning about a
    // requirement that does not exist.
    expect(cypressRuntimeRequirement(declared)).toBeUndefined();
  });

  it("keeps the two sources distinguishable", () => {
    // The whole reason there are two requirements: a reader must be able to tell whose bound they missed.
    expect(qat(">=20.11.0").origin).not.toBe(
      cypressRuntimeRequirement(">=20.11.0")?.origin,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Evaluation                                                                 */
/* -------------------------------------------------------------------------- */

describe("evaluateVersionRequirement", () => {
  describe("reports the status and the reason together", () => {
    it.each([
      {
        range: ">=20.11.0 <21.0.0",
        version: "20.11.0",
        status: "satisfied",
        reason: "within-range",
      },
      {
        range: ">=20.11.0 <21.0.0",
        version: "20.999.999",
        status: "satisfied",
        reason: "within-range",
      },
      {
        range: ">=20.11.0 <21.0.0",
        version: "20.10.9",
        status: "unsatisfied",
        reason: "below-minimum",
      },
      {
        range: ">=20.11.0 <21.0.0",
        version: "21.0.0",
        status: "unsatisfied",
        reason: "above-maximum",
      },
      {
        range: "<19.0.0 || >=22.0.0",
        version: "20.0.0",
        status: "unsatisfied",
        reason: "outside-range",
      },
      {
        range: ">=24.0.0 <25.0.0",
        version: "24.0.0-rc.1",
        status: "unsatisfied",
        reason: "pre-release-not-listed",
      },
      {
        range: ">=24.0.0-rc.1 <24.0.0",
        version: "24.0.0-rc.1",
        status: "satisfied",
        reason: "within-range",
      },
      {
        range: ">=20.11.0 <21.0.0",
        version: undefined,
        status: "indeterminate",
        reason: "runtime-version-missing",
      },
      {
        range: ">=20.11.0 <21.0.0",
        version: "",
        status: "indeterminate",
        reason: "runtime-version-missing",
      },
      {
        range: ">=20.11.0 <21.0.0",
        version: "   ",
        status: "indeterminate",
        reason: "runtime-version-missing",
      },
      {
        range: ">=20.11.0 <21.0.0",
        version: "v-next",
        status: "indeterminate",
        reason: "runtime-version-unreadable",
      },
      {
        range: ">=20.11.0 <21.0.0",
        version: "20.11",
        status: "indeterminate",
        reason: "runtime-version-unreadable",
      },
      {
        range: "",
        version: "20.11.0",
        status: "indeterminate",
        reason: "policy-range-unreadable",
      },
      {
        range: ">=20",
        version: "20.11.0",
        status: "indeterminate",
        reason: "policy-range-unreadable",
      },
      {
        range: "20.x",
        version: "20.11.0",
        status: "indeterminate",
        reason: "policy-range-unreadable",
      },
    ])(
      "$version against $range → $status / $reason",
      ({ range, version, status, reason }) => {
        const verdict = evaluate(range, version);

        expect(verdict.status).toBe(status);
        expect(verdict.reason).toBe(reason);
      },
    );
  });

  describe("runs its six steps in a fixed order", () => {
    it("reports an unreadable version before consulting the policy", () => {
      // Both are unreadable here. The version is checked first, because "I could not read the runtime" is a fact about
      // the machine the reader can act on, while "I could not read the policy" is a fact about the installation. If the
      // order were reversed, a mangled version would be reported as a broken policy and the reader would reinstall the
      // wrong thing.
      expect(evaluate("", "v-next").reason).toBe("runtime-version-unreadable");
    });

    it("reports an unreadable policy before claiming satisfaction", () => {
      // The version is fine and would satisfy most ranges. It must still not be reported as supported, because there is
      // no rule that says so.
      const verdict = evaluate(">=20", "20.11.0");

      expect(verdict.status).toBe("indeterminate");
      expect(verdict.reason).toBe("policy-range-unreadable");
    });

    it("reports a pre-release as its own reason rather than as a plain mismatch", () => {
      // Distinguished from `below-minimum` so the remedy can say "use a released version" instead of "you are too old",
      // which is a different instruction.
      const verdict = evaluate(">=24.0.0 <25.0.0", "24.0.0-rc.1");

      expect(verdict.reason).toBe("pre-release-not-listed");
    });
  });

  describe("carries the evidence a caller needs", () => {
    it("keeps the detected version whenever it was read", () => {
      const verdict = evaluate(">=20.11.0 <21.0.0", "  v20.10.9  ");

      expect(verdict.detected?.raw).toBe("v20.10.9");
      expect(verdict.detected?.major).toBe(20);
    });

    it("leaves the detected version undefined only when the version was the unreadable part", () => {
      // Property rather than example: `policy-range-unreadable` still shows the user which runtime is running, which is
      // half the evidence even when the other half cannot be read.
      for (const { range, version } of SCENARIOS) {
        const verdict = evaluate(range, version);
        const versionWasUnreadable =
          verdict.reason === "runtime-version-missing" ||
          verdict.reason === "runtime-version-unreadable";

        expect(verdict.detected === undefined).toBe(versionWasUnreadable);
      }
    });

    it("passes the requirement through by identity, so attribution cannot drift", () => {
      const requirement = qat(">=20.11.0 <21.0.0");
      const verdict = evaluateVersionRequirement(requirement, "20.10.9");

      expect(verdict.requirement).toBe(requirement);
    });

    it("returns a frozen verdict", () => {
      const verdict = evaluate(">=20.11.0 <21.0.0", "20.11.0");

      expect(Object.isFrozen(verdict)).toBe(true);
      expect(() => {
        (verdict as { status: string }).status = "unsatisfied";
      }).toThrow(TypeError);
    });
  });

  describe("agrees with the reason → status authority", () => {
    it.each(SCENARIOS)("$version against $range", ({ range, version }) => {
      // The discriminated union is the compile-time guard and `REASON_STATUS` is the runtime one. If they ever disagree,
      // aggregation would classify a verdict differently from how it was built — the subtlest possible reporting defect.
      const verdict = evaluate(range, version);

      expect(statusOf(verdict.reason)).toBe(verdict.status);
    });

    it.each(SCENARIOS)(
      "narrows $version against $range consistently",
      ({ range, version }) => {
        const verdict = evaluate(range, version);

        expect(isSatisfied(verdict)).toBe(verdict.status === "satisfied");
        expect(isUnsatisfied(verdict)).toBe(verdict.status === "unsatisfied");
        expect(isIndeterminate(verdict)).toBe(
          verdict.status === "indeterminate",
        );
      },
    );
  });

  describe("is total and pure", () => {
    it("never throws, whatever it is handed", () => {
      // The caller converts a verdict into a finding; a throw here would abort the whole check and hide the sibling
      // checks that would have run.
      for (const range of [
        "",
        " ",
        "||",
        ">=",
        "\u0000",
        ">=20.11.0 <21.0.0",
      ]) {
        for (const version of [
          undefined,
          "",
          " ",
          "\u0000",
          "v-next",
          "20.11.1",
        ]) {
          expect(() => evaluate(range, version)).not.toThrow();
        }
      }
    });

    it("returns deeply equal verdicts for equal inputs", () => {
      // A clock, a counter or a cache would show up here: the verdict is a decision, not a record of when it was made.
      const first = evaluate(">=20.11.0 <21.0.0", "20.11.1");
      const second = evaluate(">=20.11.0 <21.0.0", "20.11.1");

      expect(first).toStrictEqual(second);
    });

    it("does not mutate the requirement it was given", () => {
      const requirement = qat(">=20.11.0 <21.0.0");
      const before = { ...requirement };

      evaluateVersionRequirement(requirement, "20.10.9");

      expect(requirement).toStrictEqual(before);
    });

    it("stays fast enough to run per check rather than per command", () => {
      // A loose bound, and deliberately so: this is not a benchmark, it is a guard against a range being re-parsed in a
      // way that turns microseconds into milliseconds — for example by reading the manifest inside the comparison.
      const started = performance.now();

      for (let index = 0; index < 10_000; index += 1) {
        evaluate(">=20.11.0 <21.0.0", "20.11.1");
      }

      expect(performance.now() - started).toBeLessThan(1_000);
    });
  });
});
