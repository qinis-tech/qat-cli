/**
 * Unit tests for the three Cypress check definitions.
 *
 * These rules are the seam between the assessment (pure, value in / value out) and the reporting contract (a finding with
 * a code, a severity and words). So the tests assert exactly that seam: what verdict each condition produces, which code
 * and severity the finding carries, and that the wording names the thing the reader has to fix — `npx cypress install`,
 * `CYPRESS_CACHE_FOLDER`, `cypress verify` — rather than a generic "Cypress problem".
 *
 * No fixture project, no collector, no clock: a check is data with one input, so every case here is a literal
 * `CheckFacts` value. That is the property `evaluate(facts)` was designed for.
 *
 * ## What the finding contract does and does not carry
 *
 * `CheckFinding` is a `DiagnosticFinding<DoctorDiagnosticCode>`: a code, a severity, an explanation and an *optional*
 * remediation. It has no `evidence` field, so nothing here asserts one — the observation a rule made reaches the reader
 * through the sentence, which is why the assertions below look for the version, the cache path and the blocking check id
 * *inside* that sentence.
 *
 * ## Assumptions about the modules under test
 *
 * Each rule is a factory taking the identity the catalogue owns plus, where relevant, presentation policy:
 *
 *   createCypressDependencyCheck(identity, { recommendedRange?, supportedRange?, documentationAnchor? })
 *   createCypressCompatibilityCheck(identity, { recommendedRange?, documentationAnchor? })
 *   createCypressBinaryCheck(identity)
 *
 * The identity is injected because `CheckId`, `CheckCategory` and the diagnostic code set are closed vocabularies owned by
 * the catalogue — a rule that hardcoded them would compile only while its guess matched the registry. Here that means two
 * explicit casts, which is the price of testing a rule without standing up the whole catalogue.
 */

import { describe, expect, it } from "vitest";

import type {
  CheckCategory,
  CheckFinding,
  CheckId,
} from "~/core/application/checks.js";
import type {
  CheckDefinition,
  CheckFacts,
  CheckVerdict,
} from "~/diagnostics/checks/contracts.js";
import { FactGroup, PASS, present } from "~/diagnostics/checks/contracts.js";
import { createCypressBinaryCheck } from "~/diagnostics/checks/rules/cypress-binary.js";
import { createCypressCompatibilityCheck } from "~/diagnostics/checks/rules/cypress-compatibility.js";
import { createCypressDependencyCheck } from "~/diagnostics/checks/rules/cypress-dependency.js";
import type { CypressConditionResult } from "~/project/cypress-health/index.js";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

interface Identity {
  readonly id: CheckId;
  readonly category: CheckCategory;
  /** `CheckSeverity` is the diagnostic severity vocabulary, so a plain literal is the right thing here. */
  readonly severity: CheckFinding["severity"];
  readonly code: CheckFinding["code"];
  readonly precondition?: CheckId;
}

/**
 * A stub identity.
 *
 * Two casts, deliberately: `CheckId` and the diagnostic code set are closed unions managed by the catalogue, and this test
 * must not import it. Everything the rules do with these values is pass-through, and the assertions check the pass-through
 * rather than the registry.
 */
function identity(overrides: Partial<Identity> = {}): Identity {
  return {
    id: "test.cypress" as CheckId,
    category: "test" as CheckCategory,
    severity: "error",
    code: "TEST-CYPRESS" as CheckFinding["code"],
    ...overrides,
  };
}

const DEPENDENCY = identity({ id: "check.cypress-installed" as CheckId });
const COMPATIBILITY = identity({
  id: "check.cypress-version" as CheckId,
  precondition: DEPENDENCY.id,
});
const BINARY = identity({
  id: "check.cypress-binary" as CheckId,
  precondition: COMPATIBILITY.id,
});

/** A condition result with sane defaults, so each test overrides only the fact it is about. */
function condition(
  overrides: Partial<CypressConditionResult> = {},
): CypressConditionResult {
  return {
    checkId: "DEP-003",
    condition: "installed",
    status: "pass",
    severity: "information",
    reason: "CYPRESS_OK",
    prerequisite: null,
    evidence: {},
    ...overrides,
  };
}

/** Wraps the results the gatherer produced into the fact group the rules read. */
function facts(...results: readonly CypressConditionResult[]): CheckFacts {
  return { cypress: { results } };
}

/** The finding of a verdict that has one, with a failure that names the actual verdict otherwise. */
function findingOf(verdict: CheckVerdict): CheckFinding {
  if (verdict.verdict === "pass")
    throw new Error("Expected a finding, got a pass");

  return verdict.finding;
}

/**
 * The remediation, asserted present.
 *
 * `CheckFinding.remediation` is optional in the contract because some layer may report a condition with nothing to do
 * about it. Every Cypress finding *does* have a next step, so this helper turns that expectation into an assertion
 * instead of a non-null assertion: a finding that tells a reader nothing is a dead end, and it would otherwise pass a type
 * check while being useless.
 */
function remediationOf(finding: CheckFinding): string {
  if (finding.remediation === undefined) {
    throw new Error(`Expected a remediation for ${finding.code}, found none`);
  }

  return finding.remediation;
}

/* -------------------------------------------------------------------------- */
/* DEP-003 — dependency installed                                             */
/* -------------------------------------------------------------------------- */

describe("createCypressDependencyCheck", () => {
  const check = createCypressDependencyCheck(DEPENDENCY, {
    recommendedRange: "^13",
    supportedRange: ">=12.0.0 <14",
    documentationAnchor: "docs/architecture/cypress-health-checks.md",
  });

  it("declares the fact group it reads", () => {
    expect(check.requires).toStrictEqual([FactGroup.Cypress]);
  });

  it("has no precondition, because it is the first Cypress question", () => {
    expect(check.precondition).toBeUndefined();
  });

  it("carries a non-empty, unique set of scenarios", () => {
    expect(check.scenarios.length).toBeGreaterThan(0);
    expect(new Set(check.scenarios).size).toBe(check.scenarios.length);
    expect(check.scenarios.every((scenario) => scenario.length > 0)).toBe(true);
  });

  it("returns the shared PASS value when the installation is sound", () => {
    // Identity, not merely shape: the happy path must allocate nothing and there must be exactly one representation of
    // "fine".
    expect(check.evaluate(facts(condition()))).toBe(PASS);
  });

  it("fails with the catalogue code when nothing declares Cypress", () => {
    const verdict = check.evaluate(
      facts(
        condition({
          status: "fail",
          severity: "error",
          reason: "CYPRESS_NOT_DECLARED",
        }),
      ),
    );
    const finding = findingOf(verdict);

    expect(verdict.verdict).toBe("fail");
    expect(finding.code).toBe(DEPENDENCY.code);
    expect(finding.explanation).toContain("not declared");
    expect(remediationOf(finding)).toContain(
      "npm install --save-dev cypress@^13",
    );
  });

  it("quotes the specifier and the section when the package is declared but missing", () => {
    const finding = findingOf(
      check.evaluate(
        facts(
          condition({
            status: "fail",
            severity: "error",
            reason: "CYPRESS_DECLARED_NOT_INSTALLED",
            evidence: {
              declaredIn: "devDependencies",
              declaredSpecifier: "^13.6.0",
            },
          }),
        ),
      ),
    );

    expect(finding.explanation).toContain("devDependencies");
    expect(finding.explanation).toContain("^13.6.0");
  });

  it("keeps a ghost install at warning severity", () => {
    // The assessment decides this; the rule must not upgrade it. A finding that re-derived severity would be a second
    // authority for "does this block a build".
    const finding = findingOf(
      check.evaluate(
        facts(
          condition({
            status: "fail",
            severity: "warning",
            reason: "CYPRESS_INSTALLED_BUT_UNDECLARED",
            evidence: { installedVersion: "13.6.0" },
          }),
        ),
      ),
    );

    expect(finding.severity).toBe("warning");
    expect(finding.explanation).toContain("13.6.0");
  });

  it("warns rather than fails when the result was skipped", () => {
    // The verdict vocabulary has three values, so a skip arrives as a warning that names the blocker — never as a
    // failure, which would double-count one problem across two checks.
    const verdict = check.evaluate(
      facts(
        condition({
          status: "skipped",
          severity: "information",
          prerequisite: { checkId: "DEP-003", reason: "CYPRESS_NOT_DECLARED" },
        }),
      ),
    );

    expect(verdict.verdict).toBe("warn");
    expect(remediationOf(findingOf(verdict))).toContain("first");
  });

  it("falls back rather than throwing on a reason it does not recognise", () => {
    const verdict = check.evaluate(
      facts(
        condition({
          status: "fail",
          reason:
            "A_REASON_FROM_THE_FUTURE" as CypressConditionResult["reason"],
        }),
      ),
    );

    expect(verdict.verdict).toBe("fail");
    expect(findingOf(verdict).explanation).toContain("could not describe");
  });

  it("reports the observed facts in the sentence, never as a path", () => {
    // `CheckFinding` has no evidence field, so the sentence is the only place an observation reaches the reader. That
    // makes it worth asserting that the quoted facts are the display-safe ones the collector supplied.
    const finding = findingOf(
      check.evaluate(
        facts(
          condition({
            status: "fail",
            severity: "warning",
            reason: "CYPRESS_INSTALLED_BUT_UNDECLARED",
            evidence: { installedVersion: "13.6.0" },
          }),
        ),
      ),
    );

    expect(finding.explanation).toContain("13.6.0");
    expect(finding.explanation).not.toContain("/home/");
  });
});

/* -------------------------------------------------------------------------- */
/* DEP-004 — version compatibility                                            */
/* -------------------------------------------------------------------------- */

describe("createCypressCompatibilityCheck", () => {
  const check = createCypressCompatibilityCheck(COMPATIBILITY, {
    recommendedRange: "^13",
    documentationAnchor: "docs/architecture/cypress-health-checks.md",
  });

  it("declares its fact group and its precondition", () => {
    // The precondition is the mechanism that turns "no package installed" into a skip here rather than a second failure.
    expect(check.requires).toStrictEqual([FactGroup.Cypress]);
    expect(check.precondition).toBe(COMPATIBILITY.precondition);
  });

  it("returns PASS for a supported version", () => {
    expect(check.evaluate(facts(condition({ checkId: "DEP-004" })))).toBe(PASS);
  });

  it("fails with an error below the minimum", () => {
    const finding = findingOf(
      check.evaluate(
        facts(
          condition({
            checkId: "DEP-004",
            status: "fail",
            severity: "error",
            reason: "CYPRESS_VERSION_BELOW_MINIMUM",
            evidence: { detected: "11.2.0", supported: ">=12.0.0 <14" },
          }),
        ),
      ),
    );

    expect(finding.severity).toBe("error");
    expect(finding.explanation).toContain("11.2.0");
    expect(finding.explanation).toContain(">=12.0.0 <14");
    expect(remediationOf(finding)).toContain(
      "npm install --save-dev cypress@^13",
    );
  });

  it('fails with a warning above the tested maximum and says "unproven", not "unsupported"', () => {
    const finding = findingOf(
      check.evaluate(
        facts(
          condition({
            checkId: "DEP-004",
            status: "fail",
            severity: "warning",
            reason: "CYPRESS_VERSION_ABOVE_TESTED_MAXIMUM",
            evidence: { detected: "14.0.0", supported: ">=12.0.0 <14" },
          }),
        ),
      ),
    );

    expect(finding.severity).toBe("warning");
    expect(finding.explanation).toMatch(/newer|not been tested/u);
    expect(finding.explanation).not.toMatch(/unsupported/u);
  });

  it("warns when a version could not be established", () => {
    const verdict = check.evaluate(
      facts(
        condition({
          checkId: "DEP-004",
          status: "indeterminate",
          severity: "warning",
          reason: "CYPRESS_VERSION_UNKNOWN",
        }),
      ),
    );

    expect(verdict.verdict).toBe("warn");
    expect(findingOf(verdict).explanation).toMatch(/could not/u);
  });

  it("points at the blocking check when skipped, without repeating its instructions", () => {
    const finding = findingOf(
      check.evaluate(
        facts(
          condition({
            checkId: "DEP-004",
            status: "skipped",
            severity: "information",
            prerequisite: {
              checkId: "DEP-003",
              reason: "CYPRESS_NOT_DECLARED",
            },
          }),
        ),
      ),
    );

    expect(finding.explanation).toContain("DEP-003");
    expect(remediationOf(finding)).toContain("DEP-003");
    // One problem, one instruction: the install advice belongs to the finding that observed it.
    expect(remediationOf(finding)).not.toContain("npm install");
  });

  it("does not restate a version the policy did not supply", () => {
    // With no recommended range the remediation must describe the range rather than invent a number.
    const withoutPolicy = createCypressCompatibilityCheck(COMPATIBILITY);
    const finding = findingOf(
      withoutPolicy.evaluate(
        facts(
          condition({
            checkId: "DEP-004",
            status: "fail",
            severity: "error",
            reason: "CYPRESS_VERSION_BELOW_MINIMUM",
            evidence: { detected: "11.2.0", supported: ">=12.0.0 <14" },
          }),
        ),
      ),
    );

    expect(remediationOf(finding)).not.toMatch(/\^1[0-9]/u);
  });
});

/* -------------------------------------------------------------------------- */
/* DEP-008 — binary availability                                              */
/* -------------------------------------------------------------------------- */

describe("createCypressBinaryCheck", () => {
  const check = createCypressBinaryCheck(BINARY);

  it("declares its fact group and its precondition", () => {
    expect(check.requires).toStrictEqual([FactGroup.Cypress]);
    expect(check.precondition).toBe(BINARY.precondition);
  });

  it("returns PASS for an executable binary", () => {
    expect(check.evaluate(facts(condition({ checkId: "DEP-008" })))).toBe(PASS);
  });

  it("sends the reader to the install command when no binary is present", () => {
    const finding = findingOf(
      check.evaluate(
        facts(
          condition({
            checkId: "DEP-008",
            status: "fail",
            severity: "error",
            reason: "CYPRESS_BINARY_NOT_INSTALLED",
            evidence: { detected: "13.6.0", cacheRoot: "~/.cache/Cypress" },
          }),
        ),
      ),
    );

    expect(finding.severity).toBe("error");
    expect(finding.explanation).toContain("~/.cache/Cypress");
    expect(remediationOf(finding)).toContain("npx cypress install");
  });

  it("names the plausible causes when the binary exists but cannot run", () => {
    const finding = findingOf(
      check.evaluate(
        facts(
          condition({
            checkId: "DEP-008",
            status: "fail",
            severity: "error",
            reason: "CYPRESS_BINARY_INACCESSIBLE",
            evidence: {
              detected: "13.6.0",
              expectedPath: "~/.cache/Cypress/13.6.0/Cypress/Cypress",
            },
          }),
        ),
      ),
    );

    expect(finding.explanation).toContain(
      "~/.cache/Cypress/13.6.0/Cypress/Cypress",
    );
    expect(finding.explanation).toMatch(/permission|architecture|quarantine/u);
    expect(remediationOf(finding)).toContain("npx cypress install --force");
  });

  it("warns — never fails — when verification could not conclude", () => {
    const verdict = check.evaluate(
      facts(
        condition({
          checkId: "DEP-008",
          status: "indeterminate",
          severity: "warning",
          reason: "CYPRESS_BINARY_UNVERIFIED",
          evidence: {
            detected: "13.6.0",
            probeDetail: "verification did not finish within 30000 ms",
          },
        }),
      ),
    );

    expect(verdict.verdict).toBe("warn");
    expect(findingOf(verdict).explanation).toContain("could not");
  });

  it("explains how to make the cache location determinable", () => {
    const finding = findingOf(
      check.evaluate(
        facts(
          condition({
            checkId: "DEP-008",
            status: "indeterminate",
            severity: "warning",
            reason: "CYPRESS_BINARY_UNKNOWN",
          }),
        ),
      ),
    );

    expect(remediationOf(finding)).toContain("CYPRESS_CACHE_FOLDER");
  });

  it("points at the version check when skipped", () => {
    const finding = findingOf(
      check.evaluate(
        facts(
          condition({
            checkId: "DEP-008",
            status: "skipped",
            severity: "information",
            prerequisite: {
              checkId: "DEP-004",
              reason: "CYPRESS_VERSION_UNKNOWN",
            },
          }),
        ),
      ),
    );

    expect(finding.explanation).toContain("DEP-004");
    expect(remediationOf(finding)).toContain("DEP-004");
  });

  it("quotes the version it is talking about", () => {
    // Regression guard for the assessment's `detected` key. Reading `version` here produced "(installed version)" in
    // every binary message: a finding that never named the version it was about, and nothing failed but this.
    const finding = findingOf(
      check.evaluate(
        facts(
          condition({
            checkId: "DEP-008",
            status: "indeterminate",
            severity: "warning",
            reason: "CYPRESS_BINARY_UNVERIFIED",
            evidence: { detected: "13.6.0", verifiedBy: "cypress-verify" },
          }),
        ),
      ),
    );

    expect(finding.explanation).toContain("13.6.0");
    expect(finding.explanation).not.toContain("(installed version)");
    expect(remediationOf(finding)).toContain("cypress verify");
  });
});

/* -------------------------------------------------------------------------- */
/* Shared behaviour                                                           */
/* -------------------------------------------------------------------------- */

describe("Cypress check definitions — shared contract", () => {
  /**
   * Each definition paired with the check id whose condition it consumes.
   *
   * The id is part of the fixture because a check reads *its own* result out of the gathered list: handing DEP-004 a
   * DEP-003 condition is not a near miss, it is the "assessment did not cover it" defect the rules are supposed to throw
   * on.
   */
  const checks: readonly [
    string,
    CheckDefinition,
    CypressConditionResult["checkId"],
  ][] = [
    ["DEP-003", createCypressDependencyCheck(DEPENDENCY), "DEP-003"],
    ["DEP-004", createCypressCompatibilityCheck(COMPATIBILITY), "DEP-004"],
    ["DEP-008", createCypressBinaryCheck(BINARY), "DEP-008"],
  ];

  it.each(checks)("%s evaluates synchronously", (_label, check, checkId) => {
    // Not a style preference: a synchronous `evaluate` is what makes it impossible for a check to acquire I/O and still
    // be testable with literals.
    const verdict = check.evaluate(facts(condition({ checkId })));

    expect(verdict).not.toBeInstanceOf(Promise);
    expect(typeof verdict).toBe("object");
  });

  it.each(checks)(
    "%s throws when its fact group was not gathered",
    (_label, check) => {
      // An absent group is a defect in the gatherer, not a project condition: it must be loud rather than reported as a
      // finding, or a programmer's mistake reaches a user's terminal.
      expect(() => check.evaluate({})).toThrow(
        /did not declare in `requires`/u,
      );
    },
  );

  it.each(checks)(
    "%s throws when the assessment did not cover it",
    (_label, check) => {
      // An empty result list stands for a gatherer that ran but forgot this check.
      expect(() => check.evaluate(facts())).toThrow();
    },
  );

  it.each(checks)("%s returns a frozen finding", (_label, check, checkId) => {
    const verdict = check.evaluate(
      facts(
        condition({ checkId, status: "fail", reason: "CYPRESS_NOT_DECLARED" }),
      ),
    );

    if (verdict.verdict === "pass") return;

    expect(Object.isFrozen(verdict.finding)).toBe(true);
  });

  it.each(checks)(
    "%s fills every required finding field",
    (_label, check, checkId) => {
      // A code, a severity, a non-empty explanation and a remediation: a finding that cannot say what to do next is a dead
      // end, and in this catalogue every Cypress condition has an action.
      const verdict = check.evaluate(
        facts(
          condition({
            checkId,
            status: "skipped",
            severity: "information",
            prerequisite: {
              checkId: "DEP-003",
              reason: "CYPRESS_NOT_DECLARED",
            },
          }),
        ),
      );
      const finding = findingOf(verdict);

      expect(finding.code).toBeTypeOf("string");
      expect(finding.severity).toBeTypeOf("string");
      expect(finding.explanation.length).toBeGreaterThan(0);
      expect(remediationOf(finding).length).toBeGreaterThan(0);
    },
  );

  it("exposes a helper that narrows a gathered group", () => {
    // `present` is used by every rule; asserting it here keeps a failure inside the shared contract rather than looking
    // like three unrelated rule failures.
    expect(present(facts().cypress)).toStrictEqual({ results: [] });
    expect(() => present(undefined)).toThrow();
  });
});
