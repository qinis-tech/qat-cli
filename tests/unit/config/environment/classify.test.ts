/**
 * Unit tests for environment classification.
 *
 * `classifyEnvironment` is where a fact becomes a finding: it decides which of the two checks owns each
 * condition, what status it carries, and how strongly it is weighted. Everything the report prints comes
 * from here, so what these tests protect is not "does it return two objects" but three properties that
 * fail quietly:
 *
 *  - **Every inspection produces exactly two diagnostics, ENV-002 first.** Consumers index by identifier
 *    and the report renders in array order, so a missing entry looks like a check that passed and a
 *    reordered pair reads as consequences before causes.
 *  - **Severity follows the declaration, not QAT's opinion.** A variable whose requirement the profile
 *    never stated is a warning; the same absence in a profile that said "required" is blocking. The
 *    difference is the whole point of the feature and it is one function call deep.
 *  - **The worst condition wins, deterministically.** Several problems coexist routinely, and the choice
 *    among them is a ranking — so a tie must resolve the same way every run, or two reports of one
 *    project disagree.
 *
 * ## Invariants are asserted as empty collections, never inside a conditional
 *
 * A lint rule forbids `expect` in a conditional, and it is right to: an assertion on the branch a loop
 * skips asserts nothing, and the loop reports success. Every invariant below therefore builds a list of
 * violations and asserts the list is empty — which also means a failure names *all* the offenders at once
 * rather than the first one iteration 3 happened to reach.
 */

import { describe, expect, it } from "vitest";

import {
  classifyEnvironment,
  type EnvironmentDiagnostic,
  type EnvironmentDiagnosticId,
  type EnvironmentInspection,
  type VariableStatus,
} from "~/config/environment/index.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

type ProfileValid = Extract<EnvironmentInspection, { state: "profile-valid" }>;
type PathFact = ProfileValid["paths"][number];

/** A resolved path, so a fixture that is not about paths does not accidentally fail on one. */
const RESOLVED_PATH: PathFact = {
  reason: "ENV_PATH_RESOLVED",
  field: "fixtures.directory",
};

/** A usable profile, with exactly the references a case wants examined. */
function profileValid(overrides: Partial<ProfileValid> = {}): ProfileValid {
  return {
    state: "profile-valid",
    origin: "configuration-default",
    name: "staging",
    variables: [],
    paths: [RESOLVED_PATH],
    ...overrides,
  };
}

/** Convenience: a profile carrying one variable verdict. */
function withVariable(variable: VariableStatus): ProfileValid {
  return profileValid({ variables: [variable] });
}

/** Classifies with the doctor's own assumption: nothing requires an environment. */
function classify(
  inspection: EnvironmentInspection,
  required = false,
): readonly EnvironmentDiagnostic[] {
  return classifyEnvironment(inspection, { required });
}

/**
 * The diagnostic for one identifier.
 *
 * Absence fails here with the identifier in the message, rather than surfacing three assertions later as
 * an undefined member.
 */
function byId(
  diagnostics: readonly EnvironmentDiagnostic[],
  id: EnvironmentDiagnosticId,
): EnvironmentDiagnostic {
  const found = diagnostics.find((diagnostic) => diagnostic.id === id);

  if (found === undefined) {
    const message = `No diagnostic for ${id}. Found: ${diagnostics.map((d) => d.id).join(", ")}`;
    throw new Error(message);
  }

  return found;
}

/**
 * One labelled row per reachable shape of the inspection.
 *
 * Shared by the shape cases and the invariant cases so the two cannot drift: an invariant proved over a
 * narrower table than the one the shape cases use is an invariant nobody extended when a state was added.
 */
const INSPECTIONS: readonly (readonly [string, EnvironmentInspection])[] = [
  ["nothing selected", { state: "not-selected", origin: "none" }],
  [
    "an unusable selection",
    { state: "selection-invalid", origin: "explicit-cli", raw: "  " },
  ],
  [
    "an undeclared profile, explicitly requested",
    {
      state: "profile-not-found",
      origin: "explicit-cli",
      name: "production",
      available: ["staging"],
    },
  ],
  [
    "an undeclared profile, named by the configuration",
    {
      state: "profile-not-found",
      origin: "configuration-default",
      name: "staging",
      available: [],
    },
  ],
  [
    "an invalid profile",
    {
      state: "profile-invalid",
      origin: "configuration-default",
      name: "staging",
      issues: [{ code: "custom" }],
    },
  ],
  ["a usable profile", profileValid()],
  [
    "a usable profile with a required variable missing",
    profileValid({
      variables: [
        {
          reason: "ENV_VARIABLE_MISSING",
          name: "API_TOKEN",
          requirement: "required",
        },
      ],
    }),
  ],
  [
    "a usable profile with an unverifiable variable",
    profileValid({
      variables: [{ reason: "ENV_VARIABLE_UNVERIFIABLE", name: "API_TOKEN" }],
    }),
  ],
  [
    "a usable profile with an unusable path",
    profileValid({
      paths: [
        {
          reason: "ENV_PATH_INVALID",
          field: "fixtures.directory",
          declared: "",
        },
      ],
    }),
  ],
];

/**
 * Every diagnostic every fixture produces, labelled by the inspection it came from.
 *
 * The label is what makes a failed invariant readable: "an unusable selection → ENV-001 is skipped with
 * severity information" is a sentence, whereas "expected false to be true" is a puzzle.
 */
function everyDiagnostic(
  inspections: readonly (readonly [string, EnvironmentInspection])[],
): readonly {
  readonly label: string;
  readonly diagnostic: EnvironmentDiagnostic;
}[] {
  return inspections.flatMap(([label, inspection]) =>
    classify(inspection).map((diagnostic) => ({ label, diagnostic })),
  );
}

// ─── Result shape ────────────────────────────────────────────────────────────

describe("the shape of a classification", () => {
  it.each(INSPECTIONS)(
    "emits both identifiers for %s, profile first",
    (_label, inspection) => {
      // Consumers look up their own identifier; the report renders in array order. A missing entry reads as
      // a passing check, and a reversed pair reads as consequences before causes.
      expect(
        classify(inspection).map((diagnostic) => diagnostic.id),
      ).toStrictEqual(["ENV-002", "ENV-001"]);
    },
  );

  it.each(INSPECTIONS)(
    "freezes each diagnostic and its detail for %s",
    (label, inspection) => {
      const unfrozen = classify(inspection)
        .filter(
          (diagnostic) =>
            !Object.isFrozen(diagnostic) || !Object.isFrozen(diagnostic.detail),
        )
        .map((diagnostic) => `${label} → ${diagnostic.id}`);

      // A rule downstream must not be able to mutate evidence a second consumer reads. Freezing makes that a
      // throw in development rather than a corrupted report in production.
      expect(unfrozen).toStrictEqual([]);
    },
  );
});

// ─── Nothing selected ────────────────────────────────────────────────────────

describe("nothing selected", () => {
  const inspection: EnvironmentInspection = {
    state: "not-selected",
    origin: "none",
  };

  it("reports an informational indeterminate when no environment was required", () => {
    const diagnostic = byId(classify(inspection, false), "ENV-002");

    // Not a pass: nothing was verified, and a pass would claim otherwise. Not a failure either: most
    // projects have no environment-specific settings at all.
    expect(diagnostic).toMatchObject({
      status: "indeterminate",
      severity: "information",
      reason: "ENV_NO_SELECTION",
      profile: null,
      origin: "none",
    });
    expect(diagnostic.detail["required"]).toBe("no");
  });

  it("reports a blocking failure when the operation requires an environment", () => {
    const diagnostic = byId(classify(inspection, true), "ENV-002");

    // The same fact, a different weight, because the caller said it could not proceed without one. This is
    // the only place `required` changes anything, and it changes a pass into a failure.
    expect(diagnostic).toMatchObject({
      status: "fail",
      severity: "error",
      reason: "ENV_NO_SELECTION",
    });
    expect(diagnostic.detail["required"]).toBe("yes");
  });

  it("skips the references check with ENV-002 named as the prerequisite", () => {
    const diagnostic = byId(classify(inspection), "ENV-001");

    expect(diagnostic).toMatchObject({
      status: "skipped",
      severity: "information",
      reason: null,
    });
    expect(diagnostic.detail["prerequisite"]).toBe("ENV-002");
  });
});

// ─── An unusable selection ───────────────────────────────────────────────────

describe("an unusable selection", () => {
  it("reports what was supplied, and blocks", () => {
    const diagnostic = byId(
      classify({ state: "selection-invalid", origin: "explicit-cli", raw: "" }),
      "ENV-002",
    );

    // `supplied` travels so the finding can quote the caller's own text back. An empty flag is reported
    // rather than replaced, because falling through to a default would run a different environment than the
    // one asked for.
    expect(diagnostic).toMatchObject({
      status: "fail",
      severity: "error",
      reason: "ENV_SELECTION_INVALID",
      profile: null,
      origin: "explicit-cli",
    });
    expect(diagnostic.detail["supplied"]).toBe("");
  });

  it("skips the references check", () => {
    const diagnostics = classify({
      state: "selection-invalid",
      origin: "process-environment",
      raw: "   ",
    });

    expect(byId(diagnostics, "ENV-001")).toMatchObject({
      status: "skipped",
      detail: { prerequisite: "ENV-002" },
    });
  });
});

// ─── An undeclared profile ───────────────────────────────────────────────────

describe("an undeclared profile", () => {
  it("reports a request for something absent when a person or a variable named it", () => {
    const diagnostic = byId(
      classify({
        state: "profile-not-found",
        origin: "explicit-cli",
        name: "production",
        available: ["staging"],
      }),
      "ENV-002",
    );

    expect(diagnostic).toMatchObject({
      status: "fail",
      severity: "error",
      reason: "ENV_PROFILE_NOT_FOUND",
      profile: "production",
    });
    expect(diagnostic.detail["available"]).toStrictEqual(["staging"]);
  });

  it("reports a dangling default when the configuration named it", () => {
    const diagnostic = byId(
      classify({
        state: "profile-not-found",
        origin: "configuration-default",
        name: "staging",
        available: ["development"],
      }),
      "ENV-002",
    );

    // Same inspection state, different owner. A person naming something is fixed by changing a command; a
    // file naming something is fixed by changing a committed default — and it strands every command, not one.
    expect(diagnostic).toMatchObject({
      status: "fail",
      severity: "error",
      reason: "ENV_REFERENCE_DANGLING",
    });
  });

  it("keeps the origin so the sentence can say who asked", () => {
    const fromProcess = byId(
      classify({
        state: "profile-not-found",
        origin: "process-environment",
        name: "local",
        available: [],
      }),
      "ENV-002",
    );

    expect(fromProcess.origin).toBe("process-environment");
  });

  it("skips the references check", () => {
    const diagnostics = classify({
      state: "profile-not-found",
      origin: "explicit-cli",
      name: "production",
      available: [],
    });

    expect(byId(diagnostics, "ENV-001").status).toBe("skipped");
  });
});

// ─── An invalid profile ──────────────────────────────────────────────────────

describe("an invalid profile", () => {
  it("carries field paths and issue codes, and blocks", () => {
    const diagnostic = byId(
      classify({
        state: "profile-invalid",
        origin: "configuration-default",
        name: "staging",
        issues: [
          {
            path: "baseUrl",
            code: "invalid_string",
            expected: "an absolute URL",
          },
          { code: "unrecognized_keys" },
        ],
      }),
      "ENV-002",
    );

    expect(diagnostic).toMatchObject({
      status: "fail",
      severity: "error",
      reason: "ENV_PROFILE_INVALID",
      profile: "staging",
    });
    expect(diagnostic.detail["fields"]).toStrictEqual(["baseUrl", "<profile>"]);
    expect(diagnostic.detail["codes"]).toStrictEqual([
      "invalid_string",
      "unrecognized_keys",
    ]);
    expect(diagnostic.detail["issueCount"]).toBe(2);
  });

  it("names the profile itself when an issue carries no path", () => {
    const diagnostic = byId(
      classify({
        state: "profile-invalid",
        origin: "configuration-default",
        name: "staging",
        issues: [{ code: "custom" }],
      }),
      "ENV-002",
    );

    // A placeholder rather than an empty string: `fields: [""]` renders as a rejected field with no name,
    // which reads as a bug in QAT rather than as a problem with the profile.
    expect(diagnostic.detail["fields"]).toStrictEqual(["<profile>"]);
  });

  it("skips the references check, because an unparsed profile has no references to judge", () => {
    const diagnostics = classify({
      state: "profile-invalid",
      origin: "configuration-default",
      name: "staging",
      issues: [{ path: "baseUrl", code: "invalid_string" }],
    });

    expect(byId(diagnostics, "ENV-001")).toMatchObject({
      status: "skipped",
      detail: { prerequisite: "ENV-002" },
    });
  });
});

// ─── A usable profile: paths ────────────────────────────────────────────────

describe("a usable profile — paths", () => {
  it("passes silently when every declared path resolved", () => {
    const diagnostic = byId(classify(profileValid()), "ENV-002");

    // A pass with no reason: there is nothing to fix and nothing worth saying. `reason: null` is what the
    // rule layer reads as a bare pass.
    expect(diagnostic).toMatchObject({
      status: "pass",
      severity: "information",
      reason: null,
      profile: "staging",
    });
    expect(diagnostic.detail["pathsChecked"]).toBe(1);
  });

  it("fails and names the fields when a path did not resolve", () => {
    const diagnostics = classify(
      profileValid({
        paths: [
          { reason: "ENV_PATH_RESOLVED", field: "fixtures.directory" },
          {
            reason: "ENV_PATH_OUTSIDE_PROJECT",
            field: "reports.directory",
            declared: "../../out",
          },
        ],
      }),
    );
    const diagnostic = byId(diagnostics, "ENV-002");

    expect(diagnostic).toMatchObject({
      status: "fail",
      severity: "error",
      reason: "ENV_PATH_INVALID",
    });

    // The field and the kind, never the declared value: a path on a developer machine routinely contains a
    // username, and the remedy is a shape rather than the path they happened to write.
    expect(diagnostic.detail["fields"]).toStrictEqual(["reports.directory"]);
    expect(diagnostic.detail["kinds"]).toStrictEqual([
      "ENV_PATH_OUTSIDE_PROJECT",
    ]);
  });

  it("does not let a path problem suppress the reference verdict", () => {
    // Two independent questions: a profile with an unusable path can still have all its variables present,
    // and collapsing them into one finding would hide one of the two answers.
    const diagnostics = classify(
      profileValid({
        paths: [
          {
            reason: "ENV_PATH_ABSOLUTE",
            field: "reports.directory",
            declared: "/tmp/out",
          },
        ],
        variables: [{ reason: "ENV_VARIABLE_PRESENT", name: "API_TOKEN" }],
      }),
    );

    expect(byId(diagnostics, "ENV-002").status).toBe("fail");
    expect(byId(diagnostics, "ENV-001").status).toBe("pass");
  });
});

// ─── A usable profile: references ──────────────────────────────────────────

describe("a usable profile — references", () => {
  it("passes when every reference is usable", () => {
    const diagnostic = byId(
      classify(
        withVariable({ reason: "ENV_VARIABLE_PRESENT", name: "API_TOKEN" }),
      ),
      "ENV-001",
    );

    expect(diagnostic).toMatchObject({
      status: "pass",
      severity: "information",
      reason: null,
    });
    expect(diagnostic.detail["checked"]).toBe(1);
  });

  it("passes when the profile declares no references at all", () => {
    const diagnostic = byId(
      classify(profileValid({ variables: [] })),
      "ENV-001",
    );

    // A profile that references nothing has nothing to be missing. Silence is correct here rather than
    // incomplete.
    expect(diagnostic.status).toBe("pass");
    expect(diagnostic.detail["checked"]).toBe(0);
  });

  it.each([
    ["required", "fail", "error", "ENV_VARIABLE_MISSING"],
    ["unspecified", "fail", "warning", "ENV_VARIABLE_MISSING"],
  ] as const)(
    "reports a %s variable that is missing at %s/%s (%s)",
    (requirement, status, severity, reason) => {
      const diagnostic = byId(
        classify(
          withVariable({
            reason: "ENV_VARIABLE_MISSING",
            name: "API_TOKEN",
            requirement,
          }),
        ),
        "ENV-001",
      );

      // The conditional-severity rule, at the one place it is decided. The profile stated the requirement,
      // so this function does not have to infer it — and the two outcomes are a blocking failure and an
      // advisory warning, not two strengths of one verdict.
      expect(diagnostic).toMatchObject({ status, severity, reason });
      expect(diagnostic.detail["reported"]).toBe("API_TOKEN");
    },
  );

  it("reports a blank required variable at the same weight as a missing one", () => {
    const diagnostic = byId(
      classify(
        withVariable({
          reason: "ENV_VARIABLE_BLANK",
          name: "API_TOKEN",
          requirement: "required",
        }),
      ),
      "ENV-001",
    );

    // Different reason, same weight: the profile said required, and an empty value authenticates exactly as
    // badly as an absent one — while being a different sentence for the reader.
    expect(diagnostic).toMatchObject({
      status: "fail",
      severity: "error",
      reason: "ENV_VARIABLE_BLANK",
    });
  });

  it("reports nothing for a variable the profile marked optional", () => {
    const diagnostic = byId(
      classify(
        withVariable({
          reason: "ENV_VARIABLE_MISSING",
          name: "FLAG",
          requirement: "optional",
        }),
      ),
      "ENV-001",
    );

    // The absence of a finding is the assertion. An optional variable that is absent is the documented
    // default, and reporting it would teach readers that this check produces noise.
    expect(diagnostic).toMatchObject({ status: "pass", reason: null });
    expect(diagnostic.detail["missing"]).toStrictEqual(["FLAG"]);
  });

  it.each([
    [
      "an unapproved source",
      {
        reason: "ENV_REFERENCE_SOURCE_NOT_APPROVED",
        name: "API_TOKEN",
        source: "file",
      } as const,
      "ENV_REFERENCE_SOURCE_NOT_APPROVED",
    ],
    [
      "an unusable name",
      { reason: "ENV_REFERENCE_NAME_INVALID", name: "api-token" } as const,
      "ENV_REFERENCE_NAME_INVALID",
    ],
  ])("blocks on %s", (_label, variable, reason) => {
    const diagnostic = byId(classify(withVariable(variable)), "ENV-001");

    // Policy failures are never advisory: a reference QAT will not honour is a declaration that looks
    // correct and cannot work.
    expect(diagnostic).toMatchObject({
      status: "fail",
      severity: "error",
      reason,
    });
  });

  it("warns, never passes, when presence could not be established", () => {
    const diagnostic = byId(
      classify(
        withVariable({
          reason: "ENV_VARIABLE_UNVERIFIABLE",
          name: "API_TOKEN",
        }),
      ),
      "ENV-001",
    );

    // "I could not look" is neither "it is not set" nor "it is fine". It is reported and it does not block —
    // but a pass here would read as consent for something nobody checked.
    expect(diagnostic).toMatchObject({
      status: "indeterminate",
      severity: "warning",
      reason: "ENV_VARIABLE_UNVERIFIABLE",
    });
  });

  it("summarises every category in the detail, whether or not it produced a finding", () => {
    const diagnostic = byId(
      classify(
        profileValid({
          variables: [
            { reason: "ENV_VARIABLE_PRESENT", name: "ALPHA_TOKEN" },
            {
              reason: "ENV_VARIABLE_BLANK",
              name: "BETA_TOKEN",
              requirement: "optional",
            },
            {
              reason: "ENV_VARIABLE_MISSING",
              name: "GAMMA_TOKEN",
              requirement: "required",
            },
            { reason: "ENV_REFERENCE_NAME_INVALID", name: "delta-token" },
            { reason: "ENV_VARIABLE_UNVERIFIABLE", name: "EPSILON_TOKEN" },
          ],
        }),
      ),
      "ENV-001",
    );

    // The counts are evidence: a reader can see how much was examined, not only what failed. Without them
    // "one variable is missing" is indistinguishable from "one variable was declared".
    expect(diagnostic.detail["checked"]).toBe(5);
    expect(diagnostic.detail["missing"]).toStrictEqual(["GAMMA_TOKEN"]);
    expect(diagnostic.detail["blank"]).toStrictEqual(["BETA_TOKEN"]);
    expect(diagnostic.detail["rejected"]).toStrictEqual(["delta-token"]);
    expect(diagnostic.detail["unverifiable"]).toStrictEqual(["EPSILON_TOKEN"]);
  });
});

// ─── Choosing the worst condition ──────────────────────────────────────────

describe("choosing the worst condition", () => {
  it("prefers an established failure over an unanswered question", () => {
    const diagnostic = byId(
      classify(
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
      "ENV-001",
    );

    // A failure beats an unknown because a failure is actionable: the reader can fix it without waiting for
    // the machine to answer anything. The unknown stays visible in `unverifiable`, so nothing is lost.
    expect(diagnostic).toMatchObject({
      status: "fail",
      severity: "error",
      reason: "ENV_VARIABLE_MISSING",
    });
    expect(diagnostic.detail["unverifiable"]).toStrictEqual(["ALPHA_TOKEN"]);
  });

  it("prefers an established advisory failure over an unknown of the same weight", () => {
    const build = (variables: readonly VariableStatus[]) =>
      classify(profileValid({ variables }));

    const missingFirst = build([
      {
        reason: "ENV_VARIABLE_MISSING",
        name: "ALPHA_TOKEN",
        requirement: "unspecified",
      },
      { reason: "ENV_VARIABLE_UNVERIFIABLE", name: "BETA_TOKEN" },
    ]);
    const unknownFirst = build([
      { reason: "ENV_VARIABLE_UNVERIFIABLE", name: "BETA_TOKEN" },
      {
        reason: "ENV_VARIABLE_MISSING",
        name: "ALPHA_TOKEN",
        requirement: "unspecified",
      },
    ]);

    // Status outranks severity, so an advisory failure still beats an unknown — both are warnings by weight,
    // and "it is missing" is a fact while "I could not look" is a gap. That the result is identical whichever
    // order they were declared in is the part worth asserting: the ranking must not depend on iteration.
    for (const diagnostics of [missingFirst, unknownFirst]) {
      expect(byId(diagnostics, "ENV-001")).toMatchObject({
        status: "fail",
        severity: "warning",
        reason: "ENV_VARIABLE_MISSING",
      });
      expect(byId(diagnostics, "ENV-001").detail["unverifiable"]).toStrictEqual(
        ["BETA_TOKEN"],
      );
    }
  });

  it("prefers the heavier weight when two conditions are established", () => {
    const build = (variables: readonly VariableStatus[]) =>
      classify(profileValid({ variables }));

    const requiredFirst = build([
      {
        reason: "ENV_VARIABLE_MISSING",
        name: "ALPHA_TOKEN",
        requirement: "required",
      },
      {
        reason: "ENV_VARIABLE_MISSING",
        name: "BETA_TOKEN",
        requirement: "unspecified",
      },
    ]);
    const unstatedFirst = build([
      {
        reason: "ENV_VARIABLE_MISSING",
        name: "BETA_TOKEN",
        requirement: "unspecified",
      },
      {
        reason: "ENV_VARIABLE_MISSING",
        name: "ALPHA_TOKEN",
        requirement: "required",
      },
    ]);

    // Same status, so severity decides: the blocking condition is reported and the advisory one stays visible
    // in `missing`. A report that led with the advisory would leave the reader's actual blocker two sentences
    // further down.
    for (const diagnostics of [requiredFirst, unstatedFirst]) {
      expect(byId(diagnostics, "ENV-001")).toMatchObject({
        status: "fail",
        severity: "error",
      });
      expect(byId(diagnostics, "ENV-001").detail["reported"]).toBe(
        "ALPHA_TOKEN",
      );
      expect(byId(diagnostics, "ENV-001").detail["missing"]).toStrictEqual([
        "ALPHA_TOKEN",
        "BETA_TOKEN",
      ]);
    }
  });

  it("keeps the first on a tie, so the choice does not depend on iteration luck", () => {
    const diagnostic = byId(
      classify(
        profileValid({
          variables: [
            {
              reason: "ENV_VARIABLE_MISSING",
              name: "ALPHA_TOKEN",
              requirement: "required",
            },
            {
              reason: "ENV_VARIABLE_MISSING",
              name: "BETA_TOKEN",
              requirement: "required",
            },
          ],
        }),
      ),
      "ENV-001",
    );

    // `isWorse` is strict, so equal concerns keep the incumbent. `inspectEnvironment` sorts references by
    // name before this function ever sees them, which makes "the incumbent" the alphabetically first — and
    // therefore stable across runs and across processes.
    expect(diagnostic.detail["reported"]).toBe("ALPHA_TOKEN");
    expect(diagnostic.detail["missing"]).toStrictEqual([
      "ALPHA_TOKEN",
      "BETA_TOKEN",
    ]);
  });
});

// ─── Invariants across every state ─────────────────────────────────────────

describe("invariants that hold whatever the inspection says", () => {
  it("gives every reporting diagnostic a reason", () => {
    const offenders = everyDiagnostic(INSPECTIONS)
      .filter(
        ({ diagnostic }) =>
          (diagnostic.status === "fail" ||
            diagnostic.status === "indeterminate") &&
          diagnostic.reason === null,
      )
      .map(
        ({ label, diagnostic }) =>
          `${label} → ${diagnostic.id} is ${diagnostic.status} with no reason`,
      );

    // A failure with nothing to report is a finding no remediation catalogue can key. The classifier's own
    // invariant, asserted across every reachable state rather than trusted.
    expect(offenders).toStrictEqual([]);
  });

  it("never weights an unknown as blocking", () => {
    const offenders = everyDiagnostic(INSPECTIONS)
      .filter(
        ({ diagnostic }) =>
          diagnostic.status === "indeterminate" &&
          diagnostic.severity === "error",
      )
      .map(
        ({ label, diagnostic }) =>
          `${label} → ${diagnostic.id} blocks on an unanswered question`,
      );

    // "I could not establish it" must not refuse a run. If this ever failed, the check would block on a
    // question nobody answered — including one it chose not to ask.
    expect(offenders).toStrictEqual([]);
  });

  it("reports silence as a pass or a skip, never as a warning", () => {
    const offenders = everyDiagnostic(INSPECTIONS)
      .filter(
        ({ diagnostic }) =>
          diagnostic.reason === null &&
          diagnostic.status !== "pass" &&
          diagnostic.status !== "skipped",
      )
      .map(
        ({ label, diagnostic }) =>
          `${label} → ${diagnostic.id} is ${diagnostic.status} with no reason`,
      );

    // A null reason means there is nothing to fix, so the only honest statuses are "fine" and "not asked". A
    // warning with no reason would be a finding whose remediation entry does not exist.
    expect(offenders).toStrictEqual([]);
  });

  it("keeps a skipped check silent, information-weighted, and named", () => {
    const offenders = everyDiagnostic(INSPECTIONS)
      .filter(({ diagnostic }) => diagnostic.status === "skipped")
      .filter(
        ({ diagnostic }) =>
          diagnostic.severity !== "information" ||
          diagnostic.detail["prerequisite"] !== "ENV-002",
      )
      .map(
        ({ label, diagnostic }) =>
          `${label} → ${diagnostic.id} is skipped without naming ENV-002`,
      );

    // A skip is a statement about ordering, not about the project. It must never influence the exit status,
    // and it must always name what it was waiting for.
    expect(offenders).toStrictEqual([]);
  });

  it("does not mutate the inspection it was given", () => {
    const inspection = Object.freeze(
      profileValid({
        variables: Object.freeze([
          Object.freeze({
            reason: "ENV_VARIABLE_MISSING" as const,
            name: "API_TOKEN",
            requirement: "required" as const,
          }),
        ]),
        paths: Object.freeze([Object.freeze(RESOLVED_PATH)]),
      }),
    );

    // Frozen all the way down: a classifier that sorted or filtered in place would throw here rather than
    // quietly reordering evidence a second consumer reads.
    expect(() => classify(inspection)).not.toThrow();
  });

  it("produces a deeply equal result for equal inputs", () => {
    const build = () =>
      profileValid({
        variables: [
          {
            reason: "ENV_VARIABLE_MISSING",
            name: "API_TOKEN",
            requirement: "required",
          },
        ],
        paths: [
          {
            reason: "ENV_PATH_INVALID",
            field: "reports.directory",
            declared: "/tmp",
          },
        ],
      });

    const first = classify(build());

    // A loop rather than a `for` with an assertion inside a conditional: `expect` at the top level means the
    // rule that flagged the previous version has nothing to object to, and the failure — if one ever occurs —
    // names the iteration that diverged.
    expect(Array.from({ length: 50 }, () => classify(build()))).toStrictEqual(
      Array.from({ length: 50 }, () => first),
    );
  });
});
