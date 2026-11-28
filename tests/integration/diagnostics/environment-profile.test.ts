/**
 * Integration tests for the environment feature.
 *
 * The unit suites test each layer against a hand-built value: `inspect` against a fabricated selection, `classify`
 * against a fabricated inspection, each rule against a fabricated diagnostic. What none of them can prove is that the
 * *layers agree* — and every environment defect found so far lived exactly there, at a seam:
 *
 *  - a classifier that treated "nothing to report" as "no verdict", which only appears when a pass flows into a rule;
 *  - a rule that rejected the informational weight the classifier actually emits, which only appears end to end;
 *  - a rule that threw because the lookup filtered on a reason instead of an identifier.
 *
 * So this file drives the real pipeline — `selectEnvironment` → `inspectEnvironment` → `classifyEnvironment` →
 * `environmentProfileCheck` / `environmentVariablesCheck` — and fakes only the two boundaries it must:
 *
 *  - **The configuration bytes.** A profile catalogue is a literal, because building a `qat.config.json` and running
 *    discovery through it is `tests/integration/config`'s job, and it would add a filesystem to a test about verdicts.
 *  - **The process environment.** A plain record stands in for `process.env`; the reader over it is the *real*
 *    `probeVariablePresence`, so the empty-versus-whitespace-versus-absent distinction is exercised rather than
 *    stubbed.
 *
 * Everything in between is the code that ships.
 */

import { describe, expect, it } from "vitest";

import {
  buildEnvironmentEvidence,
  classifyEnvironment,
  inspectEnvironment,
  selectEnvironment,
  type EnvironmentDiagnostic,
  type EnvironmentEvidence,
  type EnvironmentInspection,
  type InspectEnvironmentDependencies,
  type PathStatus,
  type ProfileIssue,
  type VariableReference,
} from "~/config/environment/index.js";
import { HealthCode } from "~/core/application/checks.js";
import {
  probeVariablePresence,
  type EnvironmentSource,
} from "~/core/environment/index.js";
import type {
  CheckFacts,
  CheckVerdict,
} from "~/diagnostics/checks/contracts.js";
import { environmentProfileCheck } from "~/diagnostics/checks/rules/environment-profile.js";
import { environmentVariablesCheck } from "~/diagnostics/checks/rules/environment-variables.js";

// ─── A project, as data ──────────────────────────────────────────────────────

interface FakePath {
  /** The field the profile declared, e.g. `fixtures.directory`. */
  readonly field: string;
  /** The value the profile wrote, carried only so an unresolved verdict can quote it. */
  readonly declared: string;
  /** Where resolution landed: inside the project, or outside it. */
  readonly resolved: boolean;
}

interface FakeProfile {
  readonly issues?: readonly ProfileIssue[];
  readonly variables?: readonly VariableReference[];
  readonly paths?: readonly FakePath[];
}

interface FakeProject {
  readonly profiles: Record<string, FakeProfile>;
  readonly defaultEnvironment?: string;
}

/** The project every case starts from: one usable profile referencing one present variable. */
const HEALTHY_PROJECT: FakeProject = {
  defaultEnvironment: "staging",
  profiles: {
    staging: {
      variables: [
        { name: "API_TOKEN", source: "env", requirement: "required" },
      ],
      paths: [
        {
          field: "fixtures.directory",
          declared: "./cypress/fixtures",
          resolved: true,
        },
      ],
    },
  },
};

/** The host, for the healthy case. */
const HEALTHY_HOST: EnvironmentSource = {
  API_TOKEN: "sk_live_INTEGRATION_SENTINEL",
};

/**
 * The dependencies the configuration layer would supply in production.
 *
 * Deliberately a real adapter rather than a stub: it reads a project-shaped literal the way the configuration module
 * reads a resolved document, so the inspection is exercised with a catalogue it did not construct. The one cast is
 * bounded — the profile's value is opaque to `inspect`, which is the whole point of that parameter being `unknown`.
 */
function dependenciesFor(
  project: FakeProject,
  source: EnvironmentSource,
): InspectEnvironmentDependencies {
  const profiles = new Map<string, unknown>(Object.entries(project.profiles));

  return {
    profiles,

    validateProfile: (name) => {
      const declared = profiles.get(name) as FakeProfile | undefined;
      return declared?.issues ?? [];
    },

    readVariables: (name) => project.profiles[name]?.variables ?? [],

    resolvePaths: (name): readonly PathStatus[] =>
      (project.profiles[name]?.paths ?? []).map((path) =>
        path.resolved
          ? { reason: "ENV_PATH_RESOLVED", field: path.field }
          : {
              reason: "ENV_PATH_OUTSIDE_PROJECT",
              field: path.field,
              declared: path.declared,
            },
      ),

    // The real reader over a fake source. This is the seam composition uses, so the semantics under test are the
    // shipped ones: empty and whitespace-only are `blank`, absent is `unset`, and nothing returns a value.
    presence: { probe: (name) => probeVariablePresence(name, source) },

    configPath: "/project/qat.config.json",
  };
}

// ─── Running the pipeline ────────────────────────────────────────────────────

interface RunOptions {
  readonly project?: FakeProject;
  readonly host?: EnvironmentSource;
  readonly explicit?: string;
  readonly fromProcess?: string;
  /** Whether the invoking command needs an environment. `doctor` does not. */
  readonly required?: boolean;
}

interface RunResult {
  readonly inspection: EnvironmentInspection;
  readonly diagnostics: readonly EnvironmentDiagnostic[];
  readonly evidence: EnvironmentEvidence;
  readonly profileVerdict: CheckVerdict;
  readonly variablesVerdict: CheckVerdict;
}

/**
 * The selection input, built from the *resolved* project.
 *
 * The project is a parameter rather than read from `options`, because `run` defaults it: passing `options` alone
 * meant a caller who supplied no project at all got no `fromConfiguration`, so every healthy case silently ran with
 * nothing selected. The argument is the fix; the type is what would have prevented it.
 *
 * `exactOptionalPropertyTypes` distinguishes an absent property from one set to `undefined`, and every field here is
 * optional, so each is spread conditionally rather than assigned a possibly-undefined value.
 */
function candidates(
  options: RunOptions,
  project: FakeProject,
): Parameters<typeof selectEnvironment>[0] {
  return {
    ...(options.explicit === undefined ? {} : { explicit: options.explicit }),
    ...(options.fromProcess === undefined
      ? {}
      : { fromProcess: options.fromProcess }),
    ...(project.defaultEnvironment === undefined
      ? {}
      : { fromConfiguration: project.defaultEnvironment }),
  };
}

/** Runs the feature the way the command workflow does, with literals at the two boundaries. */
function run(options: RunOptions = {}): RunResult {
  const project = options.project ?? HEALTHY_PROJECT;
  const host = options.host ?? HEALTHY_HOST;
  const required = options.required ?? false;

  const selection = selectEnvironment(candidates(options, project));
  const inspection = inspectEnvironment(
    selection,
    dependenciesFor(project, host),
  );

  const declared = Object.keys(project.profiles).sort();
  const facts: CheckFacts = {
    environment: { inspection, requiredForOperation: required, declared },
  };

  const diagnostics = classifyEnvironment(inspection, { required });

  return {
    inspection,
    diagnostics,
    evidence: buildEnvironmentEvidence({
      inspection,
      diagnostics,
      projectRoot: "/project",
      configPath: "/project/qat.config.json",
    }),
    profileVerdict: environmentProfileCheck.evaluate(facts),
    variablesVerdict: environmentVariablesCheck.evaluate(facts),
  };
}

/** Every finding the run produced, from either check. */
function findingsOf(result: RunResult): readonly { code: string }[] {
  return [result.profileVerdict, result.variablesVerdict]
    .filter((verdict) => verdict.verdict !== "pass")
    .map((verdict) => (verdict as { finding: { code: string } }).finding);
}

/** The code a verdict reports, or `undefined` when it passed. */
function codeOf(verdict: CheckVerdict): string | undefined {
  return verdict.verdict === "pass" ? undefined : verdict.finding.code;
}

// ─── The healthy path ───────────────────────────────────────────────────────

describe("a project whose environment is usable", () => {
  it("passes both checks", () => {
    const result = run();

    // The case that broke first, and the reason it is asserted as a pair: a `pass` from the classifier once crashed the
    // references rule, because the rule read a null reason as an absent verdict.
    expect(result.profileVerdict.verdict).toBe("pass");
    expect(result.variablesVerdict.verdict).toBe("pass");
    expect(findingsOf(result)).toStrictEqual([]);
  });

  it("examines exactly the references the profile declares", () => {
    const result = run();

    // Names only, and the name the profile declared. This is the evidence a reader uses to answer "what did you
    // actually check?".
    expect(result.evidence.variables).toStrictEqual(["API_TOKEN"]);
    expect(result.evidence.profile).toBe("staging");
    expect(result.evidence.selectionOrigin).toBe("configuration-default");
    expect(result.evidence.configPath).toBe("qat.config.json");
  });

  it("reports no issue for a pass", () => {
    // A pass is not counted as a problem. An issue count that included passes would make a clean project look like it
    // had findings and train readers to ignore the number.
    expect(run().evidence.issueCount).toBe(0);
  });
});

// ─── The host's answer ─────────────────────────────────────────────────────

describe("a reference the host does not provide", () => {
  it("fails the references check and leaves the profile check alone", () => {
    const result = run({ host: {} });

    // The ownership split through the whole pipeline: the profile is fine, the reference is not, and only one row
    // carries the finding.
    expect(result.profileVerdict.verdict).toBe("pass");
    expect(codeOf(result.variablesVerdict)).toBe(
      HealthCode.EnvironmentVariableMissing,
    );
  });

  it("names the variable without quoting what it does not have", () => {
    const result = run({ host: {} });

    expect(result.variablesVerdict.verdict).not.toBe("pass");

    const finding = (
      result.variablesVerdict as {
        finding: { explanation: string; remediation: string };
      }
    ).finding;

    expect(finding.explanation).toContain("API_TOKEN");
    expect(finding.remediation).toContain("API_TOKEN");
    expect(finding.remediation).toContain("never reads or prints it");
  });

  it("distinguishes a blank value from an absent one", () => {
    // The distinction the whole presence vocabulary exists for, driven through the real reader: a value of spaces is
    // `blank`, not `unset`, and the two produce different sentences for the same variable.
    const present = run({ host: { API_TOKEN: "   " } });
    const absent = run({ host: {} });

    expect(codeOf(present.variablesVerdict)).toBe(
      HealthCode.EnvironmentVariableBlank,
    );
    expect(codeOf(absent.variablesVerdict)).toBe(
      HealthCode.EnvironmentVariableMissing,
    );
  });

  it("warns rather than blocking when the profile states no requirement", () => {
    const project: FakeProject = {
      defaultEnvironment: "staging",
      profiles: {
        staging: {
          variables: [
            { name: "API_TOKEN", source: "env", requirement: "unspecified" },
          ],
        },
      },
    };

    const result = run({ project, host: {} });

    // The conditional-severity rule from end to end: the declaration decided the weight, and the weight decided the
    // verdict. A `fail` here would refuse a run over a requirement nobody stated.
    expect(result.variablesVerdict.verdict).toBe("warn");
    expect(codeOf(result.variablesVerdict)).toBe(
      HealthCode.EnvironmentVariableMissingUnconfirmed,
    );
  });

  it("reports nothing for a variable the profile marks optional", () => {
    const project: FakeProject = {
      defaultEnvironment: "staging",
      profiles: {
        staging: {
          variables: [{ name: "FLAG", source: "env", requirement: "optional" }],
        },
      },
    };

    expect(run({ project, host: {} }).variablesVerdict.verdict).toBe("pass");
  });
});

// ─── Which profile applies ─────────────────────────────────────────────────

describe("a selection that names no declared profile", () => {
  it("reports a dangling default when the configuration named it", () => {
    const project: FakeProject = {
      defaultEnvironment: "production",
      profiles: { staging: {} },
    };

    // The origin travelled through three layers: selected as `configuration-default`, inspected into
    // `profile-not-found`, classified as a dangling reference rather than a missing request. A file naming something
    // is a different bug from a person naming something, and it strands every command rather than one.
    expect(codeOf(run({ project }).profileVerdict)).toBe(
      HealthCode.EnvironmentReferenceDangling,
    );
  });

  it("reports an undeclared profile when the command named it", () => {
    const result = run({ explicit: "qa" });

    expect(codeOf(result.profileVerdict)).toBe(
      HealthCode.EnvironmentUndeclared,
    );
    expect(result.evidence.selectionOrigin).toBe("explicit-cli");
  });

  it("prefers the Command over the file, and says so", () => {
    const result = run({ explicit: "staging" });

    // `staging` is declared, so this passes — and the evidence records that the command chose it rather than the
    // default, which is what makes the report answerable when someone asks "which environment did that run use?".
    expect(result.profileVerdict.verdict).toBe("pass");
    expect(result.evidence.selectionOrigin).toBe("explicit-cli");
  });
});

describe("no selection at all", () => {
  const project: FakeProject = { profiles: { staging: {} } };

  it("passes both checks when nothing required an environment", () => {
    const result = run({ project });

    expect(result.profileVerdict.verdict).toBe("pass");
    expect(result.variablesVerdict.verdict).toBe("pass");
    expect(result.evidence.profile).toBeNull();
    expect(result.evidence.selectionOrigin).toBe("none");
  });

  it("blocks when the command required one", () => {
    const result = run({ project, required: true });

    expect(codeOf(result.profileVerdict)).toBe(
      HealthCode.EnvironmentNotSelectedRequired,
    );
  });
});

// ─── A profile the schema refused ──────────────────────────────────────────

describe("a profile the schema refused", () => {
  const project: FakeProject = {
    defaultEnvironment: "staging",
    profiles: {
      staging: {
        issues: [
          {
            path: "baseUrl",
            code: "invalid_string",
            expected: "an absolute URL",
          },
        ],
        variables: [
          { name: "API_TOKEN", source: "env", requirement: "required" },
        ],
      },
    },
  };

  it("reports the profile, and nothing about its references", () => {
    const result = run({ project, host: {} });

    // The reference is genuinely missing, and saying so would report a consequence as a second problem: the profile
    // was never accepted, so its references were never really declared. In the report the second row is `skipped`; here
    // the rule is called directly, so it must decline on its own.
    expect(codeOf(result.profileVerdict)).toBe(
      HealthCode.EnvironmentProfileInvalid,
    );
    expect(result.variablesVerdict.verdict).toBe("pass");
  });

  it("records no variables as examined", () => {
    const result = run({ project });

    // Evidence must not claim work that did not happen: nothing read a reference out of a profile that failed.
    expect(result.evidence.variables).toStrictEqual([]);
    expect(result.evidence.issueCount).toBe(1);
  });
});

// ─── Paths ────────────────────────────────────────────────────────────────

describe("a path that escapes the project", () => {
  it("fails the profile check without affecting the references", () => {
    const project: FakeProject = {
      defaultEnvironment: "staging",
      profiles: {
        staging: {
          variables: [
            { name: "API_TOKEN", source: "env", requirement: "required" },
          ],
          paths: [
            {
              field: "fixtures.directory",
              declared: "../../shared/fixtures",
              resolved: false,
            },
          ],
        },
      },
    };

    const result = run({ project });

    expect(codeOf(result.profileVerdict)).toBe(
      HealthCode.EnvironmentPathInvalid,
    );
    expect(result.variablesVerdict.verdict).toBe("pass");
    expect(result.evidence.paths).toStrictEqual(["fixtures.directory"]);
  });

  it("does not echo the declared path into the finding", () => {
    const project: FakeProject = {
      defaultEnvironment: "staging",
      profiles: {
        staging: {
          paths: [
            {
              field: "fixtures.directory",
              declared: "/home/someone/shared",
              resolved: false,
            },
          ],
        },
      },
    };

    const result = run({ project });
    const finding = (
      result.profileVerdict as {
        finding: { explanation: string; remediation: string };
      }
    ).finding;

    // A path on a developer machine routinely contains a username. The remedy describes a shape; the evidence names
    // the field. Neither prints what was written.
    expect(finding.explanation).not.toContain("/home/someone");
    expect(finding.remediation).not.toContain("/home/someone");
    expect(JSON.stringify(result.evidence)).not.toContain("/home/someone");
  });
});

// ─── Secrecy, determinism, purity ─────────────────────────────────────────

describe("what the run is allowed to say", () => {
  it("never puts a present secret into any finding or into the evidence", () => {
    const project: FakeProject = {
      defaultEnvironment: "staging",
      profiles: {
        staging: {
          variables: [
            { name: "API_TOKEN", source: "env", requirement: "required" },
            { name: "MISSING_TOKEN", source: "env", requirement: "required" },
          ],
        },
      },
    };

    // A present secret in the host, and a finding produced in the same run — so the assertion is not vacuous.
    const result = run({
      project,
      host: { API_TOKEN: "sk_live_INTEGRATION_SENTINEL" },
    });

    expect(result.variablesVerdict.verdict).toBe("fail");

    const everything = JSON.stringify({
      findings: findingsOf(result),
      evidence: result.evidence,
    });

    // The structural guarantee, asserted end to end: the value never entered the pipeline, so there is nothing here for
    // a redaction step to have hidden.
    expect(everything).not.toContain("sk_live_INTEGRATION_SENTINEL");
  });

  it("produces the same result for the same project and host", () => {
    expect(run()).toStrictEqual(run());
  });

  it("does not mutate the project or the host it was given", () => {
    const project: FakeProject = Object.freeze({
      defaultEnvironment: "staging",
      profiles: Object.freeze({
        staging: Object.freeze({
          variables: Object.freeze([
            Object.freeze({
              name: "API_TOKEN",
              source: "env",
              requirement: "required" as const,
            }),
          ]),
        }),
      }),
    });
    const host: EnvironmentSource = Object.freeze({ API_TOKEN: "value" });

    // Frozen on purpose: a stage that sorted or defaulted in place would throw here rather than quietly changing the
    // evidence a second consumer reads.
    expect(() => run({ project, host })).not.toThrow();
  });
});
