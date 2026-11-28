/**
 * Unit tests for the two environment rules.
 *
 * These call `evaluate` directly with a constructed fact set — no runner, no catalogue, no fixture project. That is
 * the whole point of the contract this layer is built on: a check is a pure function of evidence, so the awkward
 * cases (an unusable selection, a profile the schema refused, a variable nobody could look for) are literals rather
 * than directories somebody has to build.
 *
 * Three things are asserted here that the behaviour suite in `run.test.ts` cannot see, because it drives the rules
 * through the runner:
 *
 *  - **Ownership.** A profile problem is reported by ENV-002 and *not* by ENV-001, and a reference problem by ENV-001
 *    only. That split is the reason the pair exists, and it is invisible in a report where the second row is skipped.
 *  - **Weight discipline.** A failure at warning weight must produce a `warn` verdict, and the code it names must be
 *    one the guidance table weights the same way. Nothing in the type system joins those two decisions, so the test
 *    is the join.
 *  - **Prose that survives no facts.** Every finding this layer can emit is checked for the word `undefined` in its
 *    explanation, which is how a missing `?.` in a guidance entry surfaces.
 */

import { describe, expect, it } from "vitest";

import {
  classifyEnvironment,
  type EnvironmentInspection,
  type VariableStatus,
} from "~/config/environment/index.js";
import {
  CheckCategory,
  CheckId,
  CheckSeverity,
  HealthCode,
} from "~/core/application/checks.js";
import type { CheckFinding } from "~/core/application/checks.js";
// `FactGroup`, `CheckFacts` and `CheckVerdict` are the contract's own vocabulary, so they come from the module that
// declares them rather than from the barrel. A test about a contract imports the contract: the barrel is a curated
// surface whose export list is somebody else's decision, and it currently withholds two of these three.
import {
  FactGroup,
  type CheckFacts,
  type CheckVerdict,
} from "~/diagnostics/checks/contracts.js";
import { HEALTH_GUIDANCE } from "~/diagnostics/checks/index.js";
import { environmentProfileCheck } from "~/diagnostics/checks/rules/environment-profile.js";
import { environmentVariablesCheck } from "~/diagnostics/checks/rules/environment-variables.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

type ProfileValid = Extract<EnvironmentInspection, { state: "profile-valid" }>;

const RESOLVED_PATH = {
  reason: "ENV_PATH_RESOLVED",
  field: "fixtures.directory",
} as const;

function profileValid(overrides: Partial<ProfileValid> = {}): ProfileValid {
  return {
    state: "profile-valid",
    origin: "configuration-default",
    name: "staging",
    variables: [{ reason: "ENV_VARIABLE_PRESENT", name: "API_TOKEN" }],
    paths: [RESOLVED_PATH],
    ...overrides,
  };
}

function withVariable(variable: VariableStatus): ProfileValid {
  return profileValid({ variables: [variable] });
}

/** A fact set carrying one environment inspection, and nothing else. */
function facts(
  inspection: EnvironmentInspection,
  options: { readonly required?: boolean } = {},
): CheckFacts {
  return {
    environment: {
      inspection,
      requiredForOperation: options.required ?? false,
      declared: ["staging", "production"],
    },
  };
}

/** Narrows a verdict that carries a finding, failing loudly when it does not. */
function findingOf(verdict: CheckVerdict): CheckFinding {
  if (verdict.verdict === "pass") {
    throw new Error(
      "Expected a verdict carrying a finding, received a bare pass.",
    );
  }

  return verdict.finding;
}

/**
 * Asserts that the guidance entry for a finding agrees with the weight the finding carries.
 *
 * The classifier decides a failure's weight from the profile's declaration; the guidance table decides what code
 * that weight maps to. Nothing forces the two to agree at compile time — a guidance entry could be re-weighted
 * tomorrow and every rule would still build — so the agreement is asserted where the verdict is produced.
 */
function expectGuidanceAgrees(finding: CheckFinding): void {
  // The cast is local and bounded: these rules only ever emit `HealthCode` members, but the finding's code type is
  // the wider union because other checks forward `QAT-D` and `QAT-V` codes.
  const guidance = HEALTH_GUIDANCE[finding.code as HealthCode];

  expect(guidance).toBeDefined();
  expect(guidance.severity).toBe(finding.severity);
}

/** Every finding must read as a sentence, with no template hole left unfilled. */
function expectReadable(finding: CheckFinding): void {
  expect(finding.explanation.length).toBeGreaterThan(0);
  expect(finding.explanation).not.toContain("undefined");
  expect(finding.remediation ?? "").not.toContain("undefined");
}

// ─── Both definitions ────────────────────────────────────────────────────────

describe("the two environment definitions", () => {
  it.each([
    ["ENV-002", environmentProfileCheck, CheckId.EnvironmentResolvable],
    ["ENV-001", environmentVariablesCheck, CheckId.EnvironmentVariablesPresent],
  ] as const)(
    "%s declares the identity the catalogue expects",
    (_label, check, id) => {
      expect(check.id).toBe(id);
      expect(check.category).toBe(CheckCategory.EnvironmentProfiles);
      expect(check.severity).toBe(CheckSeverity.Error);
      expect(check.requires).toStrictEqual([FactGroup.Environment]);
    },
  );

  it("puts the profile check before the references check", () => {
    // Declaration order is not cosmetic: the runner resolves skips in a single forward pass, so a dependant declared
    // before its precondition throws the first time a project is diagnosed.
    expect(environmentVariablesCheck.precondition).toBe(
      environmentProfileCheck.id,
    );
    expect(environmentProfileCheck.precondition).toBe(
      CheckId.QatConfigurationLoadable,
    );
  });

  it.each([
    ["ENV-002", environmentProfileCheck],
    ["ENV-001", environmentVariablesCheck],
  ] as const)("%s refuses to run without its fact group", (_label, check) => {
    // A check that read a group it did not declare is a defect in this layer, and the loud failure is deliberate:
    // passing would let a check claim something it never examined.
    expect(() => check.evaluate({})).toThrow(/fact group/u);
  });
});

// ─── ENV-002: the profile ───────────────────────────────────────────────────

describe("ENV-002 — environment profile validity", () => {
  it("passes when nothing was selected and nothing required one", () => {
    // A pass, because most projects have no environment-specific settings and the documented defaults apply.
    expect(
      environmentProfileCheck.evaluate(
        facts({ state: "not-selected", origin: "none" }),
      ).verdict,
    ).toBe("pass");
  });

  it("reports the informational observation as a bare pass, because the verdict type has no slot for it", () => {
    const verdict = environmentProfileCheck.evaluate(
      facts({ state: "not-selected", origin: "none" }),
    );

    // `QAT-H038` is computed by the classifier and dropped here: `CheckVerdict`'s pass arm carries no finding, so
    // `CheckPassed.finding` — declared with the invariant "an informational observation attached to a pass" — has no
    // producer. When the verdict type gains the slot, this assertion becomes:
    //
    //     expect(findingOf(verdict).code).toBe(HealthCode.EnvironmentNotSelected);
    //
    // and the observation becomes visible. Until then the code is declared, documented and unreachable, which is
    // recorded as a known limit rather than asserted as a requirement.
    expect(verdict.verdict).toBe("pass");
  });

  it("fails when the operation required an environment and none was selected", () => {
    const verdict = environmentProfileCheck.evaluate(
      facts({ state: "not-selected", origin: "none" }, { required: true }),
    );

    // The same fact at a different weight, decided by the caller rather than inferred here. This is the only place
    // `requiredForOperation` changes a verdict, and it changes a pass into a blocking failure.
    expect(verdict.verdict).toBe("fail");
    expect(findingOf(verdict).code).toBe(
      HealthCode.EnvironmentNotSelectedRequired,
    );
  });

  it.each([
    [
      "an unusable selection",
      { state: "selection-invalid", origin: "explicit-cli", raw: "" } as const,
      HealthCode.EnvironmentSelectionInvalid,
    ],
    [
      "an undeclared profile a person named",
      {
        state: "profile-not-found",
        origin: "explicit-cli",
        name: "qa",
        available: ["staging"],
      } as const,
      HealthCode.EnvironmentUndeclared,
    ],
    [
      "an undeclared profile the configuration named",
      {
        state: "profile-not-found",
        origin: "configuration-default",
        name: "staging",
        available: [],
      } as const,
      HealthCode.EnvironmentReferenceDangling,
    ],
    [
      "a profile the schema refused",
      {
        state: "profile-invalid",
        origin: "configuration-default",
        name: "staging",
        issues: [{ path: "baseUrl", code: "custom" }],
      } as const,
      HealthCode.EnvironmentProfileInvalid,
    ],
    [
      "a usable profile with an unusable path",
      profileValid({
        paths: [
          {
            reason: "ENV_PATH_ABSOLUTE",
            field: "reports.directory",
            declared: "/tmp/out",
          },
        ],
      }),
      HealthCode.EnvironmentPathInvalid,
    ],
  ])("fails with its own code for %s", (_label, inspection, code) => {
    // Five conditions, five codes: each ends in a different action — pass a name, declare a profile, correct a
    // committed default, correct the fields, move a path inside the project.
    const verdict = environmentProfileCheck.evaluate(facts(inspection));

    expect(verdict.verdict).toBe("fail");

    const finding = findingOf(verdict);
    expect(finding.code).toBe(code);
    expect(finding.severity).toBe("error");
    expectGuidanceAgrees(finding);
    expectReadable(finding);
  });

  it("passes for a usable profile whose paths all resolved", () => {
    expect(
      environmentProfileCheck.evaluate(facts(profileValid())).verdict,
    ).toBe("pass");
  });

  it("does not report a reference condition, even when references are missing", () => {
    // The ownership split, asserted where it is decidable. A missing variable is ENV-001's finding; ENV-002 answers
    // only about the profile, and a report that showed both would give the reader two problems for one cause.
    const verdict = environmentProfileCheck.evaluate(
      facts(
        withVariable({
          reason: "ENV_VARIABLE_MISSING",
          name: "API_TOKEN",
          requirement: "required",
        }),
      ),
    );

    expect(verdict.verdict).toBe("pass");
  });
});

// ─── ENV-001: the references ────────────────────────────────────────────────

describe("ENV-001 — required environment variables present", () => {
  it("passes when every reference is usable", () => {
    expect(
      environmentVariablesCheck.evaluate(facts(profileValid())).verdict,
    ).toBe("pass");
  });

  it("passes when the profile declares nothing", () => {
    expect(
      environmentVariablesCheck.evaluate(facts(profileValid({ variables: [] })))
        .verdict,
    ).toBe("pass");
  });

  it("passes when an optional variable is absent", () => {
    // No finding at all: an absent optional value is the documented default, and advice nobody can act on is how a
    // doctor teaches its readers to skim.
    expect(
      environmentVariablesCheck.evaluate(
        facts(
          withVariable({
            reason: "ENV_VARIABLE_MISSING",
            name: "FLAG",
            requirement: "optional",
          }),
        ),
      ).verdict,
    ).toBe("pass");
  });

  it.each([
    [
      "a required variable is missing",
      {
        reason: "ENV_VARIABLE_MISSING",
        name: "API_TOKEN",
        requirement: "required",
      } as const,
      "fail",
      HealthCode.EnvironmentVariableMissing,
    ],
    [
      "a required variable is blank",
      {
        reason: "ENV_VARIABLE_BLANK",
        name: "API_TOKEN",
        requirement: "required",
      } as const,
      "fail",
      HealthCode.EnvironmentVariableBlank,
    ],
    [
      "a reference names an unapproved source",
      {
        reason: "ENV_REFERENCE_SOURCE_NOT_APPROVED",
        name: "API_TOKEN",
        source: "file",
      } as const,
      "fail",
      HealthCode.EnvironmentVariableSourceUnapproved,
    ],
    [
      "a declared name cannot be passed faithfully",
      { reason: "ENV_REFERENCE_NAME_INVALID", name: "api-token" } as const,
      "fail",
      HealthCode.EnvironmentVariableNameInvalid,
    ],
  ])("blocks when %s", (_label, variable, status, code) => {
    const verdict = environmentVariablesCheck.evaluate(
      facts(withVariable(variable)),
    );

    expect(verdict.verdict).toBe(status);

    const finding = findingOf(verdict);
    expect(finding.code).toBe(code);
    expect(finding.severity).toBe("error");
    expectGuidanceAgrees(finding);
    expectReadable(finding);
  });

  it.each([
    [
      "the profile does not state a requirement",
      {
        reason: "ENV_VARIABLE_MISSING",
        name: "API_TOKEN",
        requirement: "unspecified",
      } as const,
      HealthCode.EnvironmentVariableMissingUnconfirmed,
    ],
    [
      "presence could not be established",
      { reason: "ENV_VARIABLE_UNVERIFIABLE", name: "API_TOKEN" } as const,
      HealthCode.EnvironmentVariableUnverifiable,
    ],
  ])("warns — and never fails — when %s", (_label, variable, code) => {
    const verdict = environmentVariablesCheck.evaluate(
      facts(withVariable(variable)),
    );

    // The invariant the runner relies on: `failed` is reserved for error-severity checks. A warning-weight condition
    // that returned `fail` would refuse a run over advice.
    expect(verdict.verdict).toBe("warn");

    const finding = findingOf(verdict);
    expect(finding.code).toBe(code);
    expect(finding.severity).toBe("warning");
    expectGuidanceAgrees(finding);
    expectReadable(finding);
  });

  it("passes rather than fails when the profile itself is unusable", () => {
    // The skip belongs to the runner, through `precondition`. Called directly — as a preflight might call it — the
    // rule sees a reason-less diagnostic and says nothing, rather than judging references out of a profile that
    // failed the schema.
    const verdict = environmentVariablesCheck.evaluate(
      facts({
        state: "profile-invalid",
        origin: "configuration-default",
        name: "staging",
        issues: [{ path: "baseUrl", code: "custom" }],
      }),
    );

    expect(verdict.verdict).toBe("pass");
  });

  it("passes when nothing was selected", () => {
    expect(
      environmentVariablesCheck.evaluate(
        facts({ state: "not-selected", origin: "none" }),
      ).verdict,
    ).toBe("pass");
  });

  it("does not report a profile condition, even when the profile is unusable", () => {
    // The other half of the ownership split: ENV-001 answers about references, and a profile problem is ENV-002's
    // finding. Two rows for one cause is what the pair exists to prevent.
    const verdict = environmentVariablesCheck.evaluate(
      facts({
        state: "profile-not-found",
        origin: "explicit-cli",
        name: "qa",
        available: ["staging"],
      }),
    );

    expect(verdict.verdict).toBe("pass");
  });

  it("reports the worst condition, and keeps the rest visible in the detail", () => {
    const verdict = environmentVariablesCheck.evaluate(
      facts(
        profileValid({
          variables: [
            { reason: "ENV_VARIABLE_UNVERIFIABLE", name: "ALPHA_TOKEN" },
            {
              reason: "ENV_VARIABLE_MISSING",
              name: "BETA_TOKEN",
              requirement: "required",
            },
          ],
        }),
      ),
    );

    // An established condition outranks an unanswered question, so the reader's first sentence is the one they can
    // act on — and the unknown has not been discarded, only demoted.
    const finding = findingOf(verdict);
    expect(finding.code).toBe(HealthCode.EnvironmentVariableMissing);
    expectReadable(finding);
  });
});

// ─── The finding these rules produce ───────────────────────────────────────

describe("the finding a verdict carries", () => {
  /**
   * One verdict, and the name its explanation must mention.
   *
   * The subject differs by case, and that difference is the finding's meaning: an undeclared profile is about the
   * name that was *asked for* (`qa`), while a reference finding is about the profile that *declared* the variable
   * (`staging`). A single expected string has to be wrong for one of them — which the first version of this test was,
   * and it caught itself.
   */
  const cases: readonly (readonly [string, CheckVerdict, string])[] = [
    [
      "an undeclared profile",
      environmentProfileCheck.evaluate(
        facts({
          state: "profile-not-found",
          origin: "explicit-cli",
          name: "qa",
          available: ["staging"],
        }),
      ),
      "qa",
    ],
    [
      "a missing required variable",
      environmentVariablesCheck.evaluate(
        facts(
          withVariable({
            reason: "ENV_VARIABLE_MISSING",
            name: "API_TOKEN",
            requirement: "required",
          }),
        ),
      ),
      "staging",
    ],
    [
      "an unverifiable variable",
      environmentVariablesCheck.evaluate(
        facts(
          withVariable({
            reason: "ENV_VARIABLE_UNVERIFIABLE",
            name: "API_TOKEN",
          }),
        ),
      ),
      "staging",
    ],
  ];

  it.each(cases)("is a readable sentence for %s", (_label, verdict) => {
    const finding = findingOf(verdict);

    // Written out rather than delegated, so the assertions are visible in the test that makes them — and so the lint
    // rule that counts `expect` calls sees a test that asserts something.
    expect(finding.explanation.length).toBeGreaterThan(0);
    expect(finding.explanation).not.toContain("undefined");
    expect((finding.remediation ?? "").length).toBeGreaterThan(0);
    expect(HEALTH_GUIDANCE[finding.code as HealthCode].severity).toBe(
      finding.severity,
    );
  });

  it.each(cases)(
    "names the profile the finding is about for %s",
    (_label, verdict, subject) => {
      const finding = findingOf(verdict);

      // A finding that could not say what it concerned would leave the reader opening a configuration file to find out
      // — which is the work the doctor exists to save.
      expect(finding.explanation).toContain(subject);
    },
  );

  it.each(cases)("carries a remediation for %s", (_label, verdict) => {
    const finding = findingOf(verdict);

    // `remediation` is required on the finding type, and the assertion is on its content: an empty string satisfies
    // the type and tells the reader nothing.
    expect(finding.remediation).toBeDefined();
    expect((finding.remediation ?? "").length).toBeGreaterThan(0);
  });
});

// ─── The classifier contract these rules rely on ───────────────────────────

describe("the classification both rules read", () => {
  it("is consistent with what the rules expect for every state", () => {
    const inspections: readonly EnvironmentInspection[] = [
      { state: "not-selected", origin: "none" },
      { state: "selection-invalid", origin: "explicit-cli", raw: "" },
      {
        state: "profile-not-found",
        origin: "explicit-cli",
        name: "qa",
        available: [],
      },
      {
        state: "profile-invalid",
        origin: "configuration-default",
        name: "staging",
        issues: [],
      },
      profileValid(),
    ];

    // Both rules look up their own identifier and cannot function without it. Asserting the classifier's shape here,
    // beside the consumers, makes a missing entry fail in the file that would have to handle it.
    for (const inspection of inspections) {
      const diagnostics = classifyEnvironment(inspection, { required: false });

      expect(diagnostics.map((diagnostic) => diagnostic.id)).toStrictEqual([
        "ENV-002",
        "ENV-001",
      ]);

      for (const diagnostic of diagnostics) {
        // A rule branches on status and on reason; a fourth status or a reason this layer has not seen would fall
        // through silently without this assertion keeping the shape honest.
        expect(["pass", "fail", "indeterminate", "skipped"]).toContain(
          diagnostic.status,
        );
        expect(["error", "warning", "information"]).toContain(
          diagnostic.severity,
        );
      }
    }
  });
});
