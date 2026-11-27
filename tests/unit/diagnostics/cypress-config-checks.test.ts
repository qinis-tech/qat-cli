/**
 * The two configuration checks, in isolation.
 *
 * `run.test.ts` already drives every scenario through the runner, which is where statuses and skipping belong. This
 * file asserts the things the runner cannot: the rules' own metadata, the totality of the reason → code mapping, the
 * fact that the two checks own disjoint code sets, and the loud failure they produce when a caller hands them a fact set
 * missing the group they declared.
 *
 * That last case is why this file exists at all. Through the runner the group is always present — `requires` guarantees
 * it — so `present()`'s throw is unreachable from `run.test.ts` and would otherwise be untested code guarding a defect
 * message nobody has read.
 */

import { describe, expect, it } from "vitest";

import {
  CheckCategory,
  CheckId,
  HealthCode,
} from "~/core/application/checks.js";
import { DiagnosticSeverity } from "~/core/application/diagnostics.js";
import {
  CHECKS,
  type CheckDefinition,
  type CheckFacts,
} from "~/diagnostics/checks/index.js";
import type {
  ConfigDiscovery,
  ConfigValidation,
} from "~/project/cypress-config/index.js";

/**
 * What a check returns, derived rather than imported.
 *
 * `CheckVerdict` belongs to `./contracts.js` and the barrel deliberately does not re-export it — a definition is reached
 * by identifier, not by naming its return type. Deriving it means this file cannot drift from the definition's own
 * signature, and it reads better too: "whatever a check returns" is exactly what the helper below takes.
 */
type Verdict = ReturnType<CheckDefinition["evaluate"]>;

const FILE = "cypress.config.ts";

/**
 * A definition found by identifier, because the barrel does not export rule definitions.
 *
 * That is its stated policy: a definition reachable a second way is a definition that can be registered twice or in the
 * wrong order. Finding it the way the runner finds it means this test and the product agree about where a check comes
 * from.
 */
function checkFor(id: CheckId): CheckDefinition {
  const found = CHECKS.find((check) => check.id === id);

  if (found === undefined) throw new Error(`No check with identifier ${id}.`);

  return found;
}

const LOCATED = checkFor(CheckId.CypressConfigurationLocated);
const VALIDATABLE = checkFor(CheckId.CypressConfigurationValidatable);

/** Validation is irrelevant to the location check, so one value serves every location case. */
const ANY_VALIDATION: ConfigValidation = {
  reason: "CYPRESS_CONFIG_SKIPPED",
  outcome: "skipped",
  prerequisite: "CFG-003",
  detail: "Nothing was validated.",
};

/** Folding a decided pair into the fact set a rule reads. */
function factsOf(
  location: ConfigDiscovery,
  validation: ConfigValidation = ANY_VALIDATION,
): CheckFacts {
  return { cypressConfiguration: { location, validation } };
}

/** The code a verdict reports, or `undefined` for a pass — which is the whole of what a pass says. */
function codeOf(verdict: Verdict): string | undefined {
  return verdict.verdict === "pass" ? undefined : verdict.finding.code;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Verdicts, one per reason the two unions can carry
 * ───────────────────────────────────────────────────────────────────────────── */

const FOUND: ConfigDiscovery = {
  reason: "CYPRESS_CONFIG_FOUND",
  outcome: "pass",
  file: FILE,
  format: "executable",
  sizeBytes: 512,
};

const NOT_APPLICABLE: ConfigDiscovery = {
  reason: "CYPRESS_CONFIG_NOT_APPLICABLE",
  outcome: "skipped",
  detail: "No Cypress configuration is expected in this project.",
};

const SKIPPED: ConfigValidation = {
  reason: "CYPRESS_CONFIG_SKIPPED",
  outcome: "skipped",
  prerequisite: "CFG-003",
  detail:
    "The configuration could not be located, so there is nothing to validate.",
};

/**
 * Every reporting reason, with the code it must produce.
 *
 * Written as data because the map in the rule is data: this is the same table, and a reason whose entry is deleted or
 * re-pointed fails here rather than surfacing as a finding with no sentence behind it.
 */
const LOCATION_CODES = [
  [
    "missing",
    {
      reason: "CYPRESS_CONFIG_MISSING",
      outcome: "fail",
      context: "cypress-evidenced",
    },
    HealthCode.CypressConfigurationMissing,
  ],
  [
    "ambiguous",
    {
      reason: "CYPRESS_CONFIG_AMBIGUOUS",
      outcome: "fail",
      files: ["cypress.config.js", FILE],
    },
    HealthCode.CypressConfigurationAmbiguous,
  ],
  [
    "unsupported-name",
    {
      reason: "CYPRESS_CONFIG_UNSUPPORTED_NAME",
      outcome: "fail",
      files: ["cypress.config.yaml"],
    },
    HealthCode.CypressConfigurationUnsupportedFormat,
  ],
  [
    "misplaced",
    {
      reason: "CYPRESS_CONFIG_MISPLACED",
      outcome: "warning",
      files: [`cypress/${FILE}`],
    },
    HealthCode.CypressConfigurationMisplaced,
  ],
  [
    "path-occupied",
    {
      reason: "CYPRESS_CONFIG_PATH_OCCUPIED",
      outcome: "fail",
      paths: [FILE],
    },
    HealthCode.CypressConfigurationPathNotAFile,
  ],
  [
    "not-a-file",
    {
      reason: "CYPRESS_CONFIG_NOT_A_FILE",
      outcome: "fail",
      file: FILE,
    },
    HealthCode.CypressConfigurationPathNotAFile,
  ],
  [
    "outside-project",
    {
      reason: "CYPRESS_CONFIG_OUTSIDE_PROJECT",
      outcome: "fail",
      file: FILE,
      resolvedPath: "/shared/cypress.config.ts",
      projectRoot: "/project",
    },
    HealthCode.CypressConfigurationOutsideProject,
  ],
  [
    "unreadable",
    {
      reason: "CYPRESS_CONFIG_UNREADABLE",
      outcome: "fail",
      file: FILE,
      cause: "permissions",
    },
    HealthCode.CypressConfigurationUnreadable,
  ],
  [
    "empty",
    {
      reason: "CYPRESS_CONFIG_EMPTY",
      outcome: "fail",
      file: FILE,
    },
    HealthCode.CypressConfigurationEmpty,
  ],
  [
    "legacy-format",
    {
      reason: "CYPRESS_CONFIG_LEGACY_FORMAT",
      outcome: "warning",
      file: "cypress.json",
      sizeBytes: 120,
    },
    HealthCode.CypressConfigurationLegacyFormat,
  ],
  [
    "not-inspected",
    {
      reason: "CYPRESS_CONFIG_NOT_INSPECTED",
      outcome: "indeterminate",
      file: FILE,
    },
    HealthCode.CypressConfigurationNotInspected,
  ],
] as const satisfies readonly (readonly [
  string,
  ConfigDiscovery,
  HealthCode,
])[];

describe("the register", () => {
  it("keeps the permanent identifiers, not the diagnostic codes", () => {
    // The identifier names a question and is quoted in scenario names and stored reports; the code names a condition and
    // lives on the finding. Confusing the two is how a report ends up labelled `CFG-003` while the register looks for a
    // slug nothing can match.
    expect(LOCATED.id).toBe(CheckId.CypressConfigurationLocated);
    expect(VALIDATABLE.id).toBe(CheckId.CypressConfigurationValidatable);
  });

  it("groups both under the configuration category", () => {
    // A reader fixing a configuration works through both in one sitting, so they must appear in one section of the
    // report rather than asking them to scroll between two halves of one answer.
    expect(LOCATED.category).toBe(CheckCategory.CypressConfiguration);
    expect(VALIDATABLE.category).toBe(CheckCategory.CypressConfiguration);
  });

  it("declares a blocking severity on both, because one severity cannot be per-condition", () => {
    // Both conclude as warnings for three conditions and failures for the rest. That is the status varying by condition
    // over a severity declared once — which is only coherent if the declared value is the blocking one.
    expect(LOCATED.severity).toBe(DiagnosticSeverity.Error);
    expect(VALIDATABLE.severity).toBe(DiagnosticSeverity.Error);
  });

  it("declares exactly the one group it reads", () => {
    // The label, not the property: `requires` is what the runner looks up, and it is what a skip message prints.
    expect(LOCATED.requires).toStrictEqual(["cypress-configuration"]);
    expect(VALIDATABLE.requires).toStrictEqual(["cypress-configuration"]);

    // Both checks read the same group because both verdicts came from one capture of one file. A check that listed a
    // group it never touched would make the declaration untrustworthy for the ones that do.
    expect(LOCATED.requires).toStrictEqual(VALIDATABLE.requires);
  });

  it("makes validity depend on location", () => {
    // Nothing can be validated until something was located, and the runner expresses that as a skip rather than as a
    // second failure describing a consequence of the first.
    expect(LOCATED.precondition).toBe(CheckId.ProjectRecognised);
    expect(VALIDATABLE.precondition).toBe(LOCATED.id);
  });

  it("names a scenario per reason, all prefixed by its own identifier", () => {
    for (const check of [LOCATED, VALIDATABLE]) {
      expect(check.scenarios.length).toBeGreaterThan(0);

      for (const scenario of check.scenarios) {
        // The prefix is what makes a scenario readable on its own, and the separator is a contract rather than a style:
        // the behaviour suite keys its fixtures by these exact strings.
        expect(scenario.startsWith(`${check.id}.`)).toBe(true);
        expect(scenario.length).toBeGreaterThan(check.id.length + 1);
      }
    }
  });
});

describe("the location check", () => {
  it.each(LOCATION_CODES)(
    "reports %s with its own code",
    (_label, location, code) => {
      const verdict = LOCATED.evaluate(factsOf(location));

      expect(codeOf(verdict)).toBe(code);
    },
  );

  it("derives the verdict from the outcome rather than choosing per reason", () => {
    // The one rule that covers both tables: a `fail` outcome blocks, and everything else — a warning, an indeterminate —
    // reports without stopping. Stated as a property so a new reason cannot pick a status by hand.
    for (const [, location, code] of LOCATION_CODES) {
      const verdict = LOCATED.evaluate(factsOf(location));

      expect(codeOf(verdict)).toBe(code);
      expect(verdict.verdict).toBe(
        location.outcome === "fail" ? "fail" : "warn",
      );
    }
  });

  it("reports nothing for a configuration it accepted", () => {
    // A pass carries no finding at all, which is why the report has no row to filter out for a healthy project.
    expect(LOCATED.evaluate(factsOf(FOUND))).toStrictEqual({ verdict: "pass" });
  });

  it("reports nothing for a project that never claimed to be a Cypress project", () => {
    // Warning here would train readers to ignore the check: a repository with no Cypress has no configuration to be
    // missing, and the precondition means this branch is normally never reached anyway.
    expect(LOCATED.evaluate(factsOf(NOT_APPLICABLE))).toStrictEqual({
      verdict: "pass",
    });
  });

  it("gives two reasons one code when they share a remedy", () => {
    const occupied = LOCATION_CODES.find(
      ([label]) => label === "path-occupied",
    );
    const notAFile = LOCATION_CODES.find(([label]) => label === "not-a-file");

    // A directory on the path and an entry that is not a regular file both end in "put a regular file there". A second
    // code would be a second permanent identifier that eventually disagrees with the first.
    expect(occupied?.[2]).toBe(notAFile?.[2]);
  });

  it("never reports a code the validity check owns", () => {
    // Widened to `string` deliberately: the inferred union would be exactly the ten location codes, and asking it about
    // a validity code would be a type error rather than the assertion the case is making.
    const codes = new Set<string>(LOCATION_CODES.map(([, , code]) => code));

    expect(codes.has(HealthCode.CypressConfigurationInvalid)).toBe(false);
    expect(codes.has(HealthCode.CypressConfigurationUnverified)).toBe(false);
  });
});

describe("the validity check", () => {
  const JSON_VALIDATED: ConfigValidation = {
    reason: "CYPRESS_CONFIG_VALIDATED",
    outcome: "pass",
    file: "cypress.json",
    tier: "T1-json",
  };

  const INVALID: ConfigValidation = {
    reason: "CYPRESS_CONFIG_INVALID",
    outcome: "fail",
    file: FILE,
    tier: "T2-cypress",
    failure: { kind: "load", message: "defineConfig is not a function" },
    durationMs: 640,
  };

  const UNVERIFIED: ConfigValidation = {
    reason: "CYPRESS_CONFIG_NOT_VALIDATED",
    outcome: "indeterminate",
    file: FILE,
    tier: "T0-text",
    cause: "deep-validation-disabled",
  };

  it("passes when a mechanism vouched for the file", () => {
    expect(VALIDATABLE.evaluate(factsOf(FOUND, JSON_VALIDATED))).toStrictEqual({
      verdict: "pass",
    });
  });

  it("fails only when a mechanism established invalidity", () => {
    const verdict = VALIDATABLE.evaluate(factsOf(FOUND, INVALID));

    // The entire justification for the declared Error severity: this branch is unreachable unless a parser or the
    // project's own loader said no.
    expect(verdict).toMatchObject({
      verdict: "fail",
      finding: { code: HealthCode.CypressConfigurationInvalid },
    });
  });

  it("warns when nothing was entitled to a verdict", () => {
    const verdict = VALIDATABLE.evaluate(factsOf(FOUND, UNVERIFIED));

    // Never a pass: silence must not read as consent. Never a failure: a question we failed to answer must not block
    // work we can still perform.
    expect(verdict).toMatchObject({
      verdict: "warn",
      finding: { code: HealthCode.CypressConfigurationUnverified },
    });
  });

  it("passes when there was nothing to validate", () => {
    // The regression this case exists for: this verdict once threw, on the assumption that the precondition made it
    // unreachable. It does not — the precondition skips the check only when location did *not* pass, so a located and
    // not-applicable project arrives here holding a skipped verdict from a passed location check.
    expect(VALIDATABLE.evaluate(factsOf(FOUND, SKIPPED))).toStrictEqual({
      verdict: "pass",
    });
  });

  it("does not read the location verdict at all", () => {
    // It cannot: the precondition has already established that something was located. A second opinion here would be a
    // check re-litigating a decision another check is responsible for.
    const withMissing = VALIDATABLE.evaluate(
      factsOf(
        {
          reason: "CYPRESS_CONFIG_MISSING",
          outcome: "fail",
          context: "no-cypress-evidence",
        },
        INVALID,
      ),
    );
    const withFound = VALIDATABLE.evaluate(factsOf(FOUND, INVALID));

    expect(withMissing).toStrictEqual(withFound);
  });
});

describe("the two code sets are disjoint", () => {
  it("so a finding's code names which of the two questions answered", () => {
    // With no evidence bag on a finding, the code *is* the detail. If the two checks could emit the same code, a stored
    // report could not tell "the file is not a file" from "the file is invalid" — which are different fixes.
    const located = new Set<string>(LOCATION_CODES.map(([, , code]) => code));

    const validity = new Set<string>([
      HealthCode.CypressConfigurationInvalid,
      HealthCode.CypressConfigurationUnverified,
    ]);

    for (const code of validity) {
      expect(located.has(code)).toBe(false);
    }
  });
});

describe("defects this layer refuses to hide", () => {
  it("throws when the group it declared was never gathered", () => {
    // A caller that assembles facts by hand can satisfy the type without going through the runner. Reporting this as a
    // finding would put a programmer's mistake into a user's terminal; passing would let the check claim something it
    // never examined. The message has to name the omission, because the reader is whoever wrote the assembly.
    expect(() => LOCATED.evaluate({})).toThrow(/requires/u);
    expect(() => VALIDATABLE.evaluate({})).toThrow(/requires/u);
  });

  it("does not turn that defect into a finding", () => {
    // The distinction that matters: a throw is loud and lands in a stack trace with a file and a line; a finding would
    // be indistinguishable from a project condition and would appear in a user's report.
    let verdict: Verdict | undefined;

    try {
      verdict = LOCATED.evaluate({});
    } catch {
      verdict = undefined;
    }

    expect(verdict).toBeUndefined();
  });
});

describe("properties of the rules", () => {
  it("evaluates synchronously, which is what keeps a check out of the filesystem", () => {
    for (const check of [LOCATED, VALIDATABLE]) {
      const verdict = check.evaluate(factsOf(FOUND, SKIPPED));

      // The type says a verdict, not a promise of one. Asserted at runtime too, because a rule that could await would
      // eventually reach for a disk — and `evaluate` returning a promise is the first symptom of that.
      expect(verdict).not.toBeInstanceOf(Promise);
      expect((verdict as { then?: unknown }).then).toBeUndefined();
    }
  });

  it("does not mutate the facts it was given", () => {
    const facts = factsOf(FOUND);
    const before = structuredClone(facts);

    LOCATED.evaluate(facts);
    VALIDATABLE.evaluate(factsOf(FOUND, SKIPPED));

    // The gatherer may hand the same object to several checks; one that sorted or annotated in place would corrupt the
    // evidence a later check reads, and the corruption would be invisible because its own report is correct.
    expect(facts).toStrictEqual(before);
  });

  it("works on a deeply frozen fact set", () => {
    const facts = Object.freeze({
      cypressConfiguration: Object.freeze({
        location: Object.freeze(FOUND),
        validation: Object.freeze(SKIPPED),
      }),
    });

    // Frozen in a test is the strictest available statement that nothing is written: any assignment in strict mode
    // throws rather than silently no-op-ing.
    expect(LOCATED.evaluate(facts)).toStrictEqual({ verdict: "pass" });
    expect(VALIDATABLE.evaluate(facts)).toStrictEqual({ verdict: "pass" });
  });

  it("is deterministic for the same facts", () => {
    expect(LOCATED.evaluate(factsOf(FOUND))).toStrictEqual(
      LOCATED.evaluate(factsOf(FOUND)),
    );
    expect(VALIDATABLE.evaluate(factsOf(FOUND, SKIPPED))).toStrictEqual(
      VALIDATABLE.evaluate(factsOf(FOUND, SKIPPED)),
    );
  });
});
