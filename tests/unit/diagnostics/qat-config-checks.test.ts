/**
 * The two configuration rules, evaluated from facts.
 *
 * A rule is data with one input, so these cases call `evaluate` directly rather than going through the runner: what is
 * under test is the mapping from an inspection state to a verdict and a code. Ordering, skipping and aggregation are the
 * runner's contract and live in `run.test.ts` — the one thing repeated here is the *throw* for a state the precondition
 * should have excluded, because that is this layer's own guard rather than the runner's.
 *
 * The codes are asserted, the prose is not. Prose belongs to the guidance catalogue and has its own cases; what these
 * ones check is that the right entry was selected, which is the only decision the rules make.
 */
import { describe, expect, it } from "vitest";

import type { ConfigInspection } from "~/config/index.js";
import {
  CheckCategory,
  CheckId,
  CheckSeverity,
  HealthCode,
  type CheckFinding,
} from "~/core/application/checks.js";
import {
  FactGroup,
  type CheckDefinition,
  type CheckFacts,
  type CheckVerdict,
} from "~/diagnostics/checks/contracts.js";
import { qatConfigDiscoveryCheck } from "~/diagnostics/checks/rules/qat-config-discovery.js";
import { qatConfigSchemaCheck } from "~/diagnostics/checks/rules/qat-config-schema.js";

/* ------------------------------------------------------------------------- *
 * Fixtures
 * ------------------------------------------------------------------------- */

const PATH = "qat.config.json";

function issue(
  path: readonly (string | number)[],
  code = "custom",
): { path: readonly (string | number)[]; code: string; message: string } {
  return { path, code, message: `${path.join(".") || "<root>"} was refused.` };
}

const VALID: ConfigInspection = {
  state: "valid",
  path: PATH,
  version: 1,
  config: { framework: "cypress" },
};
const ABSENT: ConfigInspection = { state: "missing", searchedAt: PATH };
const UNREADABLE: ConfigInspection = {
  state: "inaccessible",
  path: PATH,
  code: "EACCES",
};
const OVERSIZE: ConfigInspection = {
  state: "inaccessible",
  path: PATH,
  code: "TOO_LARGE",
};
const MALFORMED: ConfigInspection = {
  state: "malformed",
  path: PATH,
  line: 4,
  column: 17,
};
const EMPTY: ConfigInspection = { state: "malformed", path: PATH };
const UNSUPPORTED: ConfigInspection = {
  state: "version-unsupported",
  path: PATH,
  declared: 7,
  supported: [1],
};

function schemaInvalid(
  issues: readonly {
    path: readonly (string | number)[];
    code: string;
    message: string;
  }[],
  version = 1,
): ConfigInspection {
  return { state: "schema-invalid", path: PATH, version, issues };
}

/* ------------------------------------------------------------------------- *
 * Harness
 * ------------------------------------------------------------------------- */

/**
 * Evaluates a rule against one fact group.
 *
 * The optional group is built rather than spread — `{ configuration: undefined }` is a different object from `{}` under
 * `exactOptionalPropertyTypes`, and the difference is exactly what the absent-group case is about.
 */
function run(
  definition: CheckDefinition,
  configuration: ConfigInspection | undefined,
): CheckVerdict {
  const facts: CheckFacts =
    configuration === undefined ? {} : { configuration };
  return definition.evaluate(facts);
}

/**
 * The finding a verdict carries, or a failure naming what came back instead.
 *
 * Typed as `CheckFinding` rather than as an inline shape: the finding's `remediation` is optional, and a hand-written
 * type that required it would be describing a stricter contract than the one the runner hands to a renderer. A guard
 * rather than a cast, so a wrong verdict fails with a message that says whether the rule passed.
 */
function findingOf(verdict: CheckVerdict): CheckFinding {
  if (verdict.verdict === "pass")
    throw new Error("expected a finding, received a pass");
  return verdict.finding;
}

/* ------------------------------------------------------------------------- *
 * CFG-001 — readability
 * ------------------------------------------------------------------------- */

describe("qat.configuration-loadable — declaration", () => {
  it("declares itself as the readability half of the pair", () => {
    expect(qatConfigDiscoveryCheck.id).toBe(CheckId.QatConfigurationLoadable);
    expect(qatConfigDiscoveryCheck.category).toBe(
      CheckCategory.QatConfiguration,
    );
    expect(qatConfigDiscoveryCheck.severity).toBe(CheckSeverity.Error);
    // Mandatory: there is no earlier question that could make "can this file be read?" unanswerable.
    expect(qatConfigDiscoveryCheck.precondition).toBeUndefined();
    expect(qatConfigDiscoveryCheck.requires).toContain(FactGroup.Configuration);
  });

  it("names its scenarios with its own identifier", () => {
    // The prefix is what lets the behaviour suite key its fixtures by the catalogue's exact strings. A separator change
    // here would make a rule and its verification disagree while both read correctly in isolation.
    for (const scenario of qatConfigDiscoveryCheck.scenarios) {
      expect(scenario.startsWith(`${qatConfigDiscoveryCheck.id}.`)).toBe(true);
    }
  });
});

describe("qat.configuration-loadable — passes", () => {
  it.each([
    ["a readable document", VALID],
    ["an absent file, where the defaults apply", ABSENT],
    [
      "a document the schema rejected",
      schemaInvalid([issue(["environments"])]),
    ],
    ["a document from a schema we do not read", UNSUPPORTED],
  ])("passes on %s", (_label, configuration) => {
    // The last two are the boundary this check exists to respect: the bytes arrived and became a document, so
    // readability is satisfied. Whether that document can be *interpreted* is the other check's question, and answering
    // it here as well would put one condition on two rows of the report.
    //
    // Asserted by strict equality on the whole verdict, which also proves no `finding` came with the pass: an
    // implementation that returned both would make `finding` look optional to every consumer, and "we passed, but here
    // is a problem" is how a green row ends up hiding one.
    expect(run(qatConfigDiscoveryCheck, configuration)).toStrictEqual({
      verdict: "pass",
    });
  });
});

describe("qat.configuration-loadable — failures", () => {
  it("reports an unreadable file with its own code", () => {
    const finding = findingOf(run(qatConfigDiscoveryCheck, UNREADABLE));

    expect(finding.code).toBe(HealthCode.ConfigurationUnreadable);
    expect(finding.severity).toBe("error");
    // The path travels, because "a file could not be read" without naming it is a sentence about no file in particular.
    expect(finding.path).toBe(PATH);
  });

  it("reports oversize with its own code rather than as a read failure", () => {
    // Two codes, not one: "the file is bigger than we read" is something a reader can shrink, while a permission is
    // fixed outside the file. The inspection already decided which; this rule only chooses the sentence.
    expect(findingOf(run(qatConfigDiscoveryCheck, OVERSIZE)).code).toBe(
      HealthCode.ConfigurationTooLarge,
    );
  });

  it.each(["UNKNOWN", "AMBIGUOUS"] as const)(
    "keeps a %s access code in the unreadable family",
    (code) => {
      // Only TOO_LARGE has a code of its own. Everything else ends in the same instruction — make the file readable —
      // and inventing a code per errno would be six identifiers with one remedy.
      const finding = findingOf(
        run(qatConfigDiscoveryCheck, {
          state: "inaccessible",
          path: PATH,
          code,
        }),
      );

      expect(finding.code).toBe(HealthCode.ConfigurationUnreadable);
    },
  );

  it("reports a malformed document at the position the loader established", () => {
    const finding = findingOf(run(qatConfigDiscoveryCheck, MALFORMED));

    expect(finding.code).toBe(HealthCode.ConfigurationNotJson);
    // The position, not an excerpt: a line of a configuration file can hold an environment value.
    expect(finding.explanation).toContain("line 4");
  });

  it("reports an empty document as malformed, not as a code of its own", () => {
    // `QAT-H004` is reachable only where a loader distinguishes an empty document from a malformed one. Today an empty
    // file arrives as `malformed`, and this case pins that: an empty file is not a JSON document, and inventing a
    // seventh state for zero bytes would put a distinction in the state machine that only one loader could observe.
    expect(findingOf(run(qatConfigDiscoveryCheck, EMPTY)).code).toBe(
      HealthCode.ConfigurationNotJson,
    );
  });
});

/* ------------------------------------------------------------------------- *
 * CFG-002 — validity
 * ------------------------------------------------------------------------- */

describe("qat.configuration-valid — declaration", () => {
  it("declares itself as the validity half of the pair", () => {
    expect(qatConfigSchemaCheck.id).toBe(CheckId.QatConfigurationValid);
    expect(qatConfigSchemaCheck.category).toBe(CheckCategory.QatConfiguration);
    // Error throughout: every answer this check gives is a document we cannot interpret or fields the schema refused.
    // There is no advisory middle case worth softening.
    expect(qatConfigSchemaCheck.severity).toBe(CheckSeverity.Error);
    expect(qatConfigSchemaCheck.requires).toContain(FactGroup.Configuration);
  });

  it("declares readability as its precondition", () => {
    // Not decorative: it is what makes the runner skip rather than let this check invent a schema verdict about bytes
    // nobody parsed.
    expect(qatConfigSchemaCheck.precondition).toBe(
      CheckId.QatConfigurationLoadable,
    );
  });
});

describe("qat.configuration-valid — passes", () => {
  it("passes on a valid document", () => {
    expect(run(qatConfigSchemaCheck, VALID)).toStrictEqual({ verdict: "pass" });
  });

  it("passes when there is no document at all", () => {
    // A pass rather than a skip: the precondition held — discovery found nothing and said so — and there is genuinely
    // nothing wrong. Whether a command may proceed is that command's preflight.
    expect(run(qatConfigSchemaCheck, ABSENT)).toStrictEqual({
      verdict: "pass",
    });
  });
});

describe("qat.configuration-valid — failures", () => {
  it("reports an unsupported schema version on its own", () => {
    const finding = findingOf(run(qatConfigSchemaCheck, UNSUPPORTED));

    expect(finding.code).toBe(HealthCode.ConfigurationVersionUnsupported);
    expect(finding.severity).toBe("error");
    // Declared and supported both reach the sentence, so a reader can tell whether to move QAT or edit the file.
    expect(finding.explanation).toContain("7");
    expect(finding.explanation).toContain("1");
  });

  it.each([
    ["schemaVersion", HealthCode.ConfigurationVersionInvalid],
    ["framework", HealthCode.ConfigurationFrameworkUnsupported],
    ["output.reports", HealthCode.ConfigurationOutputPathInvalid],
    ["environments", HealthCode.ConfigurationSchemaInvalid],
  ] as const)("reports a rejected %s with the matching code", (path, code) => {
    // Four codes from one state, because each ends in a different action: correct a version, set a framework, fix a
    // path shape, or correct the reported fields.
    const finding = findingOf(
      run(qatConfigSchemaCheck, schemaInvalid([issue(path.split("."))])),
    );

    expect(finding.code).toBe(code);
  });

  it("picks the version when several fields were rejected", () => {
    // The primary-reason ordering is the schema layer's decision, imported rather than restated. Nothing about a field
    // can be trusted while the version is wrong, so that is the one worth leading with.
    const finding = findingOf(
      run(
        qatConfigSchemaCheck,
        schemaInvalid([
          issue(["framework"]),
          issue(["output", "reports"]),
          issue(["schemaVersion"]),
        ]),
      ),
    );

    expect(finding.code).toBe(HealthCode.ConfigurationVersionInvalid);
  });

  it("picks the framework when a path problem is also present", () => {
    const finding = findingOf(
      run(
        qatConfigSchemaCheck,
        schemaInvalid([issue(["output", "reports"]), issue(["framework"])]),
      ),
    );

    expect(finding.code).toBe(HealthCode.ConfigurationFrameworkUnsupported);
  });

  it("still names the version when the file supplied no usable one", () => {
    // The facade marks that case with `-1`, and the version-specific sentence is still the right one: `"1"` where a
    // number belongs is a one-character fix, and reporting it as the general field failure would bury that.
    const finding = findingOf(
      run(
        qatConfigSchemaCheck,
        schemaInvalid([issue(["schemaVersion"], "invalid_type")], -1),
      ),
    );

    expect(finding.code).toBe(HealthCode.ConfigurationVersionInvalid);
  });
});

describe("qat.configuration-valid — states the precondition excludes", () => {
  it.each([
    ["unreadable", UNREADABLE],
    ["malformed", MALFORMED],
  ])("throws when evaluated against a %s document", (_label, configuration) => {
    // Unreachable through the runner, which skips this check when readability failed. Reaching it means the catalogue and
    // the runner disagree — a defect in this layer, not a condition of a project — so it is loud in both directions:
    // reporting it would put a programmer's mistake in a user's terminal, and passing would let the check claim a verdict
    // about bytes nobody parsed.
    expect(() => run(qatConfigSchemaCheck, configuration)).toThrow(
      /precondition should have skipped it/u,
    );
  });
});

/* ------------------------------------------------------------------------- *
 * The pair
 * ------------------------------------------------------------------------- */

describe("the pair", () => {
  it.each([
    ["valid", VALID],
    ["absent", ABSENT],
    ["unsupported version", UNSUPPORTED],
    ["schema-invalid", schemaInvalid([issue(["environments"])])],
  ])("never reports one condition twice for %s", (_label, configuration) => {
    // *At most* one, not exactly one. Two of these states are healthy and must produce nothing, so the property is an
    // upper bound: two findings for one inspection would show a reader two problems where there is one — the collapse
    // the whole diagnostics chain is arranged to prevent.
    const failures = [
      run(qatConfigDiscoveryCheck, configuration),
      run(qatConfigSchemaCheck, configuration),
    ].filter((verdict) => verdict.verdict !== "pass");

    expect(failures.length).toBeLessThanOrEqual(1);
  });

  it.each([
    ["an unsupported version", UNSUPPORTED],
    ["a schema rejection", schemaInvalid([issue(["environments"])])],
  ])("reports %s through exactly one of the two", (_label, configuration) => {
    // The companion assertion, and the reason it is separate: `<= 1` on its own would be satisfied by a pair that never
    // failed at all — including by two rules that had been accidentally wired to the same check. This is what makes the
    // invariant above non-vacuous, and it is stated only over the states that must fail.
    const failures = [
      run(qatConfigDiscoveryCheck, configuration),
      run(qatConfigSchemaCheck, configuration),
    ].filter((verdict) => verdict.verdict !== "pass");

    expect(failures).toHaveLength(1);
  });

  it("leaves the readability check silent exactly when the validity check speaks", () => {
    // Stated as a pair rather than as two separate expectations, because it is the split itself that matters: silence is
    // how a pass is expressed here, and a row that only ever says "fine" costs a reader attention on every run.
    const readability = run(qatConfigDiscoveryCheck, UNSUPPORTED);
    const validity = run(qatConfigSchemaCheck, UNSUPPORTED);

    expect(readability.verdict).toBe("pass");
    expect(validity.verdict).toBe("fail");
  });

  it("throws for either rule when its fact group was never gathered", () => {
    // `input-unavailable` is the runner's answer; reaching `present` with an absent group means a check read something it
    // never declared, which is a defect in this layer rather than a fact about a project.
    expect(() => run(qatConfigDiscoveryCheck, undefined)).toThrow(
      /did not declare/u,
    );
    expect(() => run(qatConfigSchemaCheck, undefined)).toThrow(
      /did not declare/u,
    );
  });
});
