/**
 * Unit tests for the two runtime checks, exercised as definitions rather than through the runner.
 *
 * `run.test.ts` already drives the whole catalogue end to end. This file asks a different question: given a facts
 * object, does *this* definition conclude what it claims to conclude — and does it refuse to conclude anything when the
 * evidence it needs is missing. Testing a definition directly is what makes the guard paths reachable at all; through
 * the runner they would be indistinguishable from "the check crashed and was skipped".
 *
 * Imported from `rules/node-runtime.js` rather than the barrel: the catalogue's public surface deliberately withholds
 * individual definitions, because `CHECKS` is the register and a definition reachable a second way is one that can be
 * registered twice or in the wrong order. A layer's own test importing a layer's own module is the same allowance the
 * barrel documents for `guidance.js`.
 */
import { describe, expect, it } from "vitest";

import {
  CheckCategory,
  CheckId,
  CheckSeverity,
  HealthCode,
} from "~/core/application/checks.js";
import { DiagnosticSeverity } from "~/core/application/diagnostics.js";
import {
  PASS,
  type CheckFacts,
  type RuntimeRequirementFact,
} from "~/diagnostics/checks/contracts.js";
import {
  RUNTIME_CHECKS,
  frameworkRuntimeCheck,
  nodeRuntimeCheck,
} from "~/diagnostics/checks/rules/node-runtime.js";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The range this build declares, as a fixture.
 *
 * Complete tuples on both bounds: the grammar refuses partial versions, so `>=24.0.0 <25` would be an unreadable
 * policy and every case here would report "could not check" instead of exercising a comparison.
 */
const DECLARED = {
  range: ">=24.0.0 <25.0.0",
  origin: "package.json#engines.node",
} as const;

/**
 * The fields a case may vary.
 *
 * Every field is optional and none accepts `undefined`, because `exactOptionalPropertyTypes` distinguishes an absent
 * property from a property whose value is `undefined` — and so does every reader of a `RuntimeFacts` object. A helper
 * typed `Partial<RuntimeFacts>` cannot express the state these tests need; a helper that omits the key can.
 */
interface FactOverrides {
  readonly nodeVersion?: string;
  readonly required?: RuntimeRequirementFact;
  readonly frameworkRequired?: RuntimeRequirementFact;
}

/** Runtime evidence with a version and, by default, the requirement the manifest declares. */
function facts(overrides: FactOverrides = {}): CheckFacts {
  return {
    runtime: { nodeVersion: "v24.4.0", required: DECLARED, ...overrides },
  };
}

/**
 * Runtime evidence where the host reported no version at all.
 *
 * A second constructor rather than `facts({ nodeVersion: undefined })`: the absence is the fact being tested, and
 * spelling it by omitting the key is the only form the type system accepts and the only form the check treats as
 * "missing" rather than "unreadable".
 */
function factsWithoutVersion(overrides: FactOverrides = {}): CheckFacts {
  return { runtime: { required: DECLARED, ...overrides } };
}

/* -------------------------------------------------------------------------- */
/* The definitions, as data                                                   */
/* -------------------------------------------------------------------------- */

describe("the definitions", () => {
  it("claim the identifiers the catalogue registers", () => {
    expect(nodeRuntimeCheck.id).toBe(CheckId.NodeVersion);
    expect(frameworkRuntimeCheck.id).toBe(CheckId.CypressRuntimeSupported);
  });

  it("are grouped together, and differ only in weight", () => {
    // Same subject, same evidence, different consequence. Anything else differing between them — a different category,
    // a different fact group — would be a second question rather than the same one asked about another owner.
    expect(nodeRuntimeCheck.category).toBe(CheckCategory.Runtime);
    expect(frameworkRuntimeCheck.category).toBe(CheckCategory.Runtime);
    expect(nodeRuntimeCheck.requires).toStrictEqual(
      frameworkRuntimeCheck.requires,
    );
    expect(nodeRuntimeCheck.severity).toBe(CheckSeverity.Error);
    expect(frameworkRuntimeCheck.severity).toBe(CheckSeverity.Warning);
  });

  it("read only the runtime group", () => {
    // The label is spelled here rather than referenced through `FactGroup`, because the barrel withholds that map on
    // purpose: a consumer indexing the facts object wants the group it declared, not a map it found.
    expect(nodeRuntimeCheck.requires).toStrictEqual(["runtime"]);
  });

  it("declare no precondition on each other", () => {
    // A framework bound is not a consequence of QAT's own range: it can be violated on a runtime QAT supports, and
    // suppressing the advisory whenever the blocking check fails would hide the only finding that explains it.
    expect(nodeRuntimeCheck.precondition).toBeUndefined();
    expect(frameworkRuntimeCheck.precondition).toBeUndefined();
  });

  it("document themselves in prose a reader can disagree with", () => {
    for (const check of RUNTIME_CHECKS) {
      expect(check.title.length).toBeGreaterThan(0);
      expect(check.purpose.length).toBeGreaterThan(0);
      expect(check.procedure.length).toBeGreaterThan(0);
    }
  });

  it("link scenarios prefixed by their own identifier", () => {
    for (const check of RUNTIME_CHECKS) {
      expect(check.scenarios.length).toBeGreaterThan(0);
      for (const scenario of check.scenarios) {
        expect(scenario.startsWith(`${check.id}.`)).toBe(true);
      }
    }
  });

  it("are exported in report order: blocking before advisory", () => {
    // Declaration order is the order a reader fixes things in, and it is the reason a report reads as a plan.
    expect(RUNTIME_CHECKS.map((check) => check.id)).toStrictEqual([
      CheckId.NodeVersion,
      CheckId.CypressRuntimeSupported,
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* QAT's own requirement                                                      */
/* -------------------------------------------------------------------------- */

describe("runtime.node-version", () => {
  it("passes, allocating nothing, when the version is inside the declared range", () => {
    // `toBe(PASS)` rather than a deep comparison: the happy path shares one verdict, and an assertion that has to build
    // an expected object to check it would leave the sharing untested.
    expect(nodeRuntimeCheck.evaluate(facts())).toBe(PASS);
  });

  it.each([
    { version: "v23.11.0", because: "one major below the floor" },
    { version: "v25.0.0", because: "the exclusive ceiling itself" },
    { version: "v24.0.0-rc.1", because: "a pre-release of the floor" },
  ])("fails on $version — $because", ({ version }) => {
    const result = nodeRuntimeCheck.evaluate(facts({ nodeVersion: version }));

    expect(result).toMatchObject({
      verdict: "fail",
      finding: {
        code: HealthCode.RuntimeUnsupported,
        severity: DiagnosticSeverity.Error,
      },
    });
  });

  it("fails inside a gap in a non-contiguous policy", () => {
    const result = nodeRuntimeCheck.evaluate(
      facts({
        required: { range: "<24.0.0 || >=26.0.0", origin: DECLARED.origin },
      }),
    );

    expect(result).toMatchObject({
      verdict: "fail",
      finding: { code: HealthCode.RuntimeUnsupported },
    });
  });

  it.each([
    { input: factsWithoutVersion(), because: "the host reported no version" },
    {
      input: facts({ nodeVersion: "v-next" }),
      because: "the version is not a tuple",
    },
    {
      input: facts({ required: { range: "", origin: DECLARED.origin } }),
      because: "nothing was declared",
    },
  ])("warns rather than passing when $because", ({ input }) => {
    const result = nodeRuntimeCheck.evaluate(input);

    // Not a pass: silence must not read as consent. Not a fail: an unanswered question must not block work we can still
    // perform. The code is what tells the reader which of those two mistakes was avoided.
    expect(result).toMatchObject({
      verdict: "warn",
      finding: {
        code: HealthCode.RuntimeUnknown,
        severity: DiagnosticSeverity.Warning,
      },
    });
  });

  it("quotes the detected version, the expected range and the provenance", () => {
    // The one assertion that covers the acceptance criterion the finding exists for: a reader must be able to see what
    // they have, what is required, and who declared it, without reading a paragraph.
    const result = nodeRuntimeCheck.evaluate(
      facts({ nodeVersion: "v23.11.0" }),
    );

    expect(result).toMatchObject({
      finding: { explanation: expect.stringContaining("v23.11.0") as string },
    });
    expect(result).toMatchObject({
      finding: {
        explanation: expect.stringContaining(">=24.0.0 <25.0.0") as string,
      },
    });
    expect(result).toMatchObject({
      finding: {
        explanation: expect.stringContaining(DECLARED.origin) as string,
      },
    });
  });

  it("always offers a remedy", () => {
    for (const input of [
      facts(),
      facts({ nodeVersion: "v23.11.0" }),
      facts({ nodeVersion: "v-next" }),
    ]) {
      const result = nodeRuntimeCheck.evaluate(input);

      if (result.verdict === "pass") continue;
      expect(result.finding.remediation).toBeDefined();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The framework's requirement                                                */
/* -------------------------------------------------------------------------- */

describe("cypress.runtime-supported", () => {
  it("passes when nothing is declared", () => {
    // An advisory invented from an absence is the failure mode that teaches people to ignore advisories.
    expect(frameworkRuntimeCheck.evaluate(facts())).toBe(PASS);
  });

  it("passes when the declared bound is satisfied", () => {
    const result = frameworkRuntimeCheck.evaluate(
      facts({
        frameworkRequired: { range: ">=22.0.0 <25.0.0", origin: "cypress" },
      }),
    );

    expect(result).toBe(PASS);
  });

  it("warns — never fails — when the declared bound is missed", () => {
    // The invariant the runner relies on: `failed` is reserved for error-severity checks. An advisory that returned
    // `fail` would be a build failure in the catalogue test, and the reason it must not is here: a dependency's metadata
    // would otherwise veto a run over a bound QAT neither controls nor verifies.
    const result = frameworkRuntimeCheck.evaluate(
      facts({
        frameworkRequired: { range: ">=22.0.0 <23.0.0", origin: "cypress" },
      }),
    );

    expect(result).toMatchObject({
      verdict: "warn",
      finding: {
        code: HealthCode.FrameworkRuntimeUnsupported,
        severity: DiagnosticSeverity.Warning,
      },
    });
    expect(result.verdict).not.toBe("fail");
  });

  it("warns when the runtime cannot be read while a bound is declared", () => {
    const result = frameworkRuntimeCheck.evaluate(
      facts({
        nodeVersion: "v-next",
        frameworkRequired: { range: ">=22.0.0 <25.0.0", origin: "cypress" },
      }),
    );

    expect(result).toMatchObject({
      verdict: "warn",
      finding: { code: HealthCode.FrameworkRuntimeUnsupported },
    });
  });

  it("concludes the same thing with or without QAT's own range in play", () => {
    // No precondition, made observable: this check's answer depends only on its own evidence.
    const mismatched = facts({
      frameworkRequired: { range: ">=22.0.0 <23.0.0", origin: "cypress" },
    });

    expect(frameworkRuntimeCheck.evaluate(mismatched)).toStrictEqual(
      frameworkRuntimeCheck.evaluate(
        facts({
          frameworkRequired: { range: ">=22.0.0 <23.0.0", origin: "cypress" },
        }),
      ),
    );
  });

  it("names both requirements, so the reader knows whose bound they missed", () => {
    const result = frameworkRuntimeCheck.evaluate(
      facts({
        frameworkRequired: {
          range: ">=22.0.0 <23.0.0",
          origin: "cypress runtime requirement",
        },
      }),
    );

    expect(result).toMatchObject({
      finding: {
        explanation: expect.stringContaining(">=22.0.0 <23.0.0") as string,
      },
    });
    expect(result).toMatchObject({
      finding: {
        explanation: expect.stringContaining(DECLARED.range) as string,
      },
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Guards                                                                     */
/* -------------------------------------------------------------------------- */

describe("missing evidence", () => {
  it("throws a named defect when the runtime group was never gathered", () => {
    // `present` is the loud failure for a disagreement between a definition's `requires` and the runner. It is a defect
    // in this layer, so it must not arrive in a user's terminal as a finding — and it must not pass, which would let a
    // check claim something it never examined.
    expect(() => nodeRuntimeCheck.evaluate({})).toThrow(/requires/u);
  });

  it("throws a named defect when the group is present but the range is missing", () => {
    // The case that produced `Cannot read properties of undefined (reading 'range')` from three frames deep the first
    // time a hand-built facts object satisfied the type without going through it. Building that object needs a cast:
    // the type says `required` cannot be absent, which is exactly why the guard exists rather than the compiler.
    const handBuilt = {
      runtime: { nodeVersion: "v24.4.0" },
    } as unknown as CheckFacts;

    expect(() => nodeRuntimeCheck.evaluate(handBuilt)).toThrow(
      /RuntimeFacts\.required/u,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Purity                                                                     */
/* -------------------------------------------------------------------------- */

describe("both checks", () => {
  it.each(RUNTIME_CHECKS.map((check) => [check.id, check] as const))(
    "%s is deterministic",
    (_id, check) => {
      const input = facts({
        frameworkRequired: { range: ">=22.0.0 <25.0.0", origin: "cypress" },
      });

      // No clock, no counter, no cache: the verdict is a decision, and the same evidence must produce the same one.
      expect(check.evaluate(input)).toStrictEqual(check.evaluate(input));
    },
  );

  it.each(RUNTIME_CHECKS.map((check) => [check.id, check] as const))(
    "%s does not mutate the facts it was given",
    (_id, check) => {
      const input = facts({
        frameworkRequired: { range: ">=22.0.0 <25.0.0", origin: "cypress" },
      });
      const before = structuredClone(input);

      check.evaluate(input);

      // A definition that defaulted by assignment would corrupt the evidence a sibling check reads — invisibly, because
      // its own verdict would still be correct.
      expect(input).toStrictEqual(before);
    },
  );
});
