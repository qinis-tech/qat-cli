import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DiagnosticSeverity } from "~/core/application/diagnostics.js";
import {
  isExecutable,
  OperationReadiness,
  QatOperation,
  readinessFor,
  RequirementOutcome,
  ValidationCode,
  ValidationRequirementId,
} from "~/core/application/validation.js";
import {
  isApplicationError,
  type ApplicationError,
} from "~/core/errors/index.js";
import {
  assessDetection,
  assessProject,
  assertReadyFor,
  classifyLayout,
  CYPRESS_VERSION_POLICY,
  detectCypress,
  diagnoseProject,
  diagnosisFrom,
  REQUIREMENTS,
  VALIDATION_GUIDANCE,
} from "~/project/index.js";
import type { ValidationFacts, ValidationInput } from "~/project/index.js";

/**
 * Assessments over real temporary trees.
 *
 * Real trees rather than a mocked filesystem for the same reason as everywhere else in this layer: every question
 * asked is "does this named file exist, and what is in it", and a fake would answer according to the same assumption
 * the implementation makes — so it would agree with a wrong implementation.
 *
 * The rule set is also exercised from values, in `layout-policy.test.ts` and in the catalogue block below, because two
 * of its conditions cannot be reached from a directory at all: an unverified executable, and a version policy stricter
 * than the configuration-format floor. Those are stated as facts about evidence rather than invented as files that
 * pretend to produce them.
 *
 * ## Where a code lives matters to every assertion here
 *
 * An assessment has two places a finding can appear. `assessment.findings` holds **only what validation added**;
 * `assessment.gates[operation].blocking` and `.warnings` hold everything that applies, detection's findings included,
 * because the forwarding requirement puts them there. A `QAT-D` code can only ever be in a gate — asserting one against
 * `assessment.findings` is asserting against a list that cannot contain it.
 */
const CYPRESS_MANIFEST = JSON.stringify({
  name: "cypress",
  version: "13.15.0",
});

let created: string[] = [];

async function makeTree(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "qat-validate-"));
  created.push(root);

  for (const [path, contents] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  }

  return root;
}

function manifest(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ name: "demo", version: "1.0.0", ...extra });
}

/**
 * A project that satisfies every requirement, and varies one thing per test.
 *
 * Deliberately complete — declaration, configuration, install, specs — because most of this suite is about which
 * single change breaks which requirement, and an incomplete baseline would make every assertion ambiguous.
 */
function healthy(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "package.json": manifest({ devDependencies: { cypress: "^13.15.0" } }),
    "cypress.config.ts": "export default {};",
    "cypress/e2e/smoke.cy.ts": "",
    "node_modules/cypress/package.json": CYPRESS_MANIFEST,
    ...extra,
  };
}

async function assessFiles(files: Record<string, string>) {
  const root = await makeTree(files);
  return { root, assessment: await assessProject(root) };
}

/** The codes present, in order, so an assertion states what it is looking for rather than a whole array. */
function codesOf(entries: readonly { readonly code: string }[]): string[] {
  return entries.map((entry) => entry.code);
}

/** The gate for one operation, so a test does not repeat the same path expression four times. */
function gate(
  assessment: Parameters<typeof isExecutable>[0],
  operation: QatOperation,
) {
  return assessment.gates[operation];
}

/**
 * Runs something that should fail, and returns the error it produced.
 *
 * The type guard rather than a cast: if the call starts succeeding, this reads "expected an application error,
 * received undefined" rather than a `TypeError` about reading `code` of undefined three lines later.
 */
function failure(run: () => void): ApplicationError {
  let caught: unknown;

  try {
    run();
  } catch (error) {
    caught = error;
  }

  if (!isApplicationError(caught)) {
    throw new Error(
      `Expected an application error, received ${String(caught)}.`,
    );
  }

  return caught;
}

async function snapshot(root: string): Promise<readonly string[]> {
  const paths = (await readdir(root, { recursive: true })).sort();

  return Promise.all(
    paths.map(async (path) => {
      const stats = await stat(join(root, path));
      return `${path}|${String(stats.size)}|${String(stats.mtimeMs)}`;
    }),
  );
}

afterEach(async () => {
  await Promise.all(
    created.map((path) => rm(path, { recursive: true, force: true })),
  );
  created = [];
});

describe("a supported project", () => {
  it("is ready for both operations and raises nothing", async () => {
    const { assessment } = await assessFiles(healthy());

    expect(readinessFor(assessment, QatOperation.Inspect)).toBe(
      OperationReadiness.Ready,
    );
    expect(readinessFor(assessment, QatOperation.Execute)).toBe(
      OperationReadiness.Ready,
    );
    expect(assessment.findings).toStrictEqual([]);
    expect(
      codesOf(gate(assessment, QatOperation.Execute).blocking),
    ).toStrictEqual([]);
    expect(isExecutable(assessment)).toBe(true);
  });

  it("evaluates every requirement and reports each one by name", async () => {
    const { assessment } = await assessFiles(healthy());
    const evaluated = assessment.requirements.map(
      (result) => result.requirement,
    );

    // The traceability artefact: not "nothing failed" but the set of things that were checked. Asserting against the
    // table rather than a literal list means a requirement added without a fixture fails here rather than passing
    // silently.
    expect(evaluated).toStrictEqual(
      REQUIREMENTS.map((requirement) => requirement.id),
    );
    expect(new Set(evaluated).size).toBe(evaluated.length);
    expect(
      assessment.requirements.every(
        (r) => r.outcome === RequirementOutcome.Satisfied,
      ),
    ).toBe(true);
  });

  it("supports the pre-10 spec layout", async () => {
    const { assessment } = await assessFiles({
      "package.json": manifest({ devDependencies: { cypress: "^13.15.0" } }),
      "cypress.config.ts": "",
      "cypress/smoke.cy.js": "",
      "node_modules/cypress/package.json": CYPRESS_MANIFEST,
    });

    // Specs directly under `cypress/` are driveable, and the legacy fallback must not be mistaken for an unknown
    // layout — the two produce the same `specDirectories` shape and only the classification separates them.
    expect(isExecutable(assessment)).toBe(true);
    expect(codesOf(assessment.findings)).not.toContain(
      ValidationCode.LayoutUnsupported,
    );
  });

  it("agrees with the diagnosis it embeds", async () => {
    const root = await makeTree(healthy());

    const diagnosis = await diagnoseProject(root);
    const assessment = await assessProject(root);

    // One detection pass, two views. A difference here means the two paths read the tree differently, which means one
    // of them stopped delegating to the shared builder.
    expect(assessment.diagnosis).toStrictEqual(diagnosis);
  });

  it("assesses a directory that is not a project at all", async () => {
    const { assessment } = await assessFiles({ "readme.md": "" });

    // Assessment deliberately does not resolve a project root first: describing a directory that is not a project is
    // the case a report most needs to handle, and `discoverProject` would refuse before saying why.
    expect(assessment.diagnosis.detection).toBe("not-detected");
    expect(readinessFor(assessment, QatOperation.Execute)).toBe(
      OperationReadiness.Blocked,
    );
    expect(readinessFor(assessment, QatOperation.Inspect)).toBe(
      OperationReadiness.ReadyWithWarnings,
    );
  });
});

describe("a recognised project that cannot run", () => {
  it("blocks execution when the dependency is declared but not installed", async () => {
    const { assessment } = await assessFiles({
      "package.json": manifest({ devDependencies: { cypress: "^13.15.0" } }),
      "cypress.config.ts": "",
    });

    expect(assessment.diagnosis.detection).toBe("detected");
    expect(readinessFor(assessment, QatOperation.Execute)).toBe(
      OperationReadiness.Blocked,
    );

    // Forwarded from detection unchanged, remedy included. Re-wording it here would put one condition's prose in two
    // catalogues, and the two would drift the first time either was edited.
    const { blocking } = gate(assessment, QatOperation.Execute);
    expect(codesOf(blocking)).toContain("QAT-D005");
    expect(blocking[0]?.remediation).toBeDefined();
  });

  it("blocks execution when the manifest cannot be read, and evaluates nothing", async () => {
    const { assessment } = await assessFiles({
      "package.json": '{ "name": ',
      "cypress.config.ts": "",
    });

    expect(readinessFor(assessment, QatOperation.Execute)).toBe(
      OperationReadiness.Blocked,
    );

    // An empty list says "nothing was checked". A list of passed entries would claim the opposite, and this is the one
    // path where the difference is observable.
    expect(assessment.requirements).toStrictEqual([]);
    expect(assessment.findings).toStrictEqual([]);
    expect(codesOf(gate(assessment, QatOperation.Execute).blocking)).toContain(
      "QAT-D007",
    );
  });
});

describe("conditions detection reports", () => {
  it.each([
    ["nothing identifying Cypress", { "readme.md": "" }, "QAT-D001"],
    [
      "a missing configuration",
      {
        "package.json": manifest({ devDependencies: { cypress: "^13.15.0" } }),
        "node_modules/cypress/package.json": CYPRESS_MANIFEST,
      },
      "QAT-D002",
    ],
    [
      "an ambiguous configuration",
      healthy({ "cypress.config.js": "export default {};" }),
      "QAT-D003",
    ],
    [
      "an unreadable configuration format",
      {
        "package.json": manifest(),
        "cypress.json": "{}",
        "node_modules/cypress/package.json": CYPRESS_MANIFEST,
      },
      "QAT-D004",
    ],
  ])("blocks execution for %s", async (_scenario, files, code) => {
    const { assessment } = await assessFiles(files);

    expect(readinessFor(assessment, QatOperation.Execute)).toBe(
      OperationReadiness.Blocked,
    );
    expect(codesOf(gate(assessment, QatOperation.Execute).blocking)).toContain(
      code,
    );
  });
});

describe("unsupported layouts", () => {
  it("names a configuration that sits inside cypress/", async () => {
    const { assessment } = await assessFiles({
      "package.json": manifest(),
      "cypress/cypress.config.ts": "export default {};",
    });

    const finding = assessment.findings.find(
      (entry) => entry.code === ValidationCode.ConfigurationMisplaced,
    );

    // A specific diagnostic, with the file and the fix. "No configuration found" would be true and useless: the owner
    // is looking at a configuration file.
    expect(finding?.explanation).toContain("cypress/cypress.config.ts");
    expect(finding?.remediation).toContain(
      "Move it to the project root as cypress.config.ts",
    );
    expect(finding?.path).toBe("cypress/cypress.config.ts");
    expect(readinessFor(assessment, QatOperation.Execute)).toBe(
      OperationReadiness.Blocked,
    );
  });

  it("names a directory occupying a configuration filename", async () => {
    const root = await makeTree({
      "package.json": manifest(),
      "cypress/e2e/smoke.cy.ts": "",
    });

    // A directory where Cypress expects a file. Invisible to a file probe, which is why detection correctly reports no
    // configuration and why the reason needs its own evidence.
    await mkdir(join(root, "cypress.config.ts"), { recursive: true });

    const assessment = await assessProject(root);
    const finding = assessment.findings.find(
      (entry) => entry.code === ValidationCode.ConfigurationMisplaced,
    );

    expect(finding?.explanation).toContain("directory occupies");
    expect(finding?.path).toBe("cypress.config.ts");
  });

  it("names a configuration whose specs cannot be located", async () => {
    const { assessment } = await assessFiles({
      "package.json": manifest(),
      "cypress.config.ts": "",
      "tests/everything.cy.ts": "",
      "node_modules/cypress/package.json": CYPRESS_MANIFEST,
    });

    const finding = assessment.findings.find(
      (entry) => entry.code === ValidationCode.LayoutUnsupported,
    );

    expect(finding?.explanation).toContain("No spec location is recognisable");
    // The severity is what makes it a blocker. Asserted on the finding rather than by filtering a list, so the
    // classification is stated where the entry is.
    expect(finding?.severity).toBe(DiagnosticSeverity.Error);
  });

  it("names component testing as the reason, rather than as an unknown layout", async () => {
    const { assessment } = await assessFiles({
      "package.json": manifest(),
      "cypress.config.ts": "",
      "cypress/component/widget.cy.tsx": "",
      "node_modules/cypress/package.json": CYPRESS_MANIFEST,
    });

    const finding = assessment.findings.find(
      (entry) => entry.code === ValidationCode.LayoutUnsupported,
    );

    // A different sentence from "no spec location", because a reader with component tests needs a different next step
    // from one with a custom specPattern.
    expect(finding?.explanation).toContain("cypress/component");
    expect(finding?.path).toBe("cypress/component");
    expect(readinessFor(assessment, QatOperation.Execute)).toBe(
      OperationReadiness.Blocked,
    );
  });

  it("does not ask for a spec location when there is no configuration at all", async () => {
    const { assessment } = await assessFiles({ "readme.md": "" });

    // One condition, one finding. Detection says nothing identifying Cypress was found; a second finding about spec
    // patterns would be advice for a project this directory is not.
    expect(
      codesOf(gate(assessment, QatOperation.Execute).blocking),
    ).toStrictEqual(["QAT-D001"]);
  });
});

describe("version policy", () => {
  it("accepts the minimum and the known-good maximum exactly", async () => {
    const atMinimum = await assessFiles(
      healthy({
        "node_modules/cypress/package.json": JSON.stringify({
          name: "cypress",
          version: `${String(CYPRESS_VERSION_POLICY.minimumSupportedMajor)}.0.0`,
        }),
      }),
    );
    const atMaximum = await assessFiles(
      healthy({
        "node_modules/cypress/package.json": JSON.stringify({
          name: "cypress",
          version: `${String(CYPRESS_VERSION_POLICY.knownGoodMaximumMajor)}.99.0`,
        }),
      }),
    );

    // Boundaries are inclusive on both sides: the floor is supported, and the known-good maximum is not "almost good
    // enough" but the top of the range.
    expect(atMinimum.assessment.findings).toStrictEqual([]);
    expect(atMaximum.assessment.findings).toStrictEqual([]);
    expect(isExecutable(atMinimum.assessment)).toBe(true);
    expect(isExecutable(atMaximum.assessment)).toBe(true);
  });

  it("warns above the known-good major and still allows the run", async () => {
    const { assessment } = await assessFiles(
      healthy({
        "node_modules/cypress/package.json": JSON.stringify({
          name: "cypress",
          version: `${String(CYPRESS_VERSION_POLICY.knownGoodMaximumMajor + 1)}.0.0`,
        }),
      }),
    );

    expect(codesOf(assessment.findings)).toContain(
      ValidationCode.VersionAboveKnownGood,
    );

    // A warning is not a block. Refusing would turn every new Cypress release into an outage, and the first person to
    // hit it would be someone whose tests would have passed.
    expect(readinessFor(assessment, QatOperation.Execute)).toBe(
      OperationReadiness.ReadyWithWarnings,
    );
  });

  it("reports one version condition, not two, where the format floor already covers it", async () => {
    const { assessment } = await assessFiles(
      healthy({
        "node_modules/cypress/package.json": JSON.stringify({
          name: "cypress",
          version: "9.7.0",
        }),
      }),
    );

    // Detection reports a version that cannot read `cypress.config.*`, which is the same fact the policy would report.
    // One condition, one code: the policy requirement defers rather than repeating a sentence with a different number
    // in it.
    const versionCodes = codesOf(
      gate(assessment, QatOperation.Execute).blocking,
    ).filter(
      (code) =>
        code === "QAT-D006" || code === ValidationCode.VersionBelowSupported,
    );

    expect(versionCodes).toStrictEqual(["QAT-D006"]);
    expect(isExecutable(assessment)).toBe(false);
  });

  it("applies the policy where the format floor says nothing", async () => {
    const { assessment } = await assessFiles({
      "package.json": manifest({ devDependencies: { cypress: "^9.7.0" } }),
      "cypress.json": "{}",
      "node_modules/cypress/package.json": JSON.stringify({
        name: "cypress",
        version: "9.7.0",
      }),
    });

    // The format is reported separately, and it is undetermined whether a 9.x install can read anything present — so
    // this is the case only the policy can speak to.
    expect(codesOf(assessment.findings)).toContain(
      ValidationCode.VersionBelowSupported,
    );
    expect(isExecutable(assessment)).toBe(false);
  });

  it("says nothing about a version it cannot read", async () => {
    const { assessment } = await assessFiles(
      healthy({
        "node_modules/cypress/package.json": JSON.stringify({
          name: "cypress",
          version: "beta",
        }),
      }),
    );

    // No policy can judge a string that is not a version. Inventing a verdict would be worse than silence, and the
    // project is still covered by everything detection did manage to establish.
    expect(codesOf(assessment.findings)).not.toContain(
      ValidationCode.VersionBelowSupported,
    );
    expect(isExecutable(assessment)).toBe(true);
  });
});

describe("warnings that do not block", () => {
  it("warns about a missing manifest and still allows the run", async () => {
    const { assessment } = await assessFiles({
      "cypress.config.ts": "",
      "cypress/e2e/smoke.cy.ts": "",
      "node_modules/cypress/package.json": CYPRESS_MANIFEST,
    });

    // A D-code is the diagnosis's, and it reaches the gate through the forwarding requirement.
    // `assessment.findings` deliberately does not repeat it — asserting one there is asserting against a list that
    // cannot contain it.
    expect(codesOf(assessment.findings)).toStrictEqual([]);
    expect(codesOf(gate(assessment, QatOperation.Execute).warnings)).toContain(
      "QAT-D010",
    );
    expect(readinessFor(assessment, QatOperation.Execute)).toBe(
      OperationReadiness.ReadyWithWarnings,
    );
  });

  it("warns when a project root is also a workspace container", async () => {
    const { assessment } = await assessFiles(
      healthy({
        "package.json": manifest({
          workspaces: ["packages/*"],
          devDependencies: { cypress: "^13.15.0" },
        }),
      }),
    );

    const finding = assessment.findings.find(
      (entry) => entry.code === ValidationCode.RootAmbiguous,
    );

    // The patterns are named and never expanded, which is the only thing that makes this warning actionable.
    expect(finding?.explanation).toContain("packages/*");
    expect(finding?.severity).toBe(DiagnosticSeverity.Warning);
    expect(isExecutable(assessment)).toBe(true);
  });

  it("does not warn about a hoisted install in a workspace member", async () => {
    const base = await makeTree({
      "node_modules/cypress/package.json": CYPRESS_MANIFEST,
      "packages/app/package.json": manifest(),
      "packages/app/cypress.config.ts": "",
      "packages/app/cypress/e2e/smoke.cy.ts": "",
    });

    const assessment = await assessProject(join(base, "packages", "app"));

    // Hoisting is the normal shape for a member. A warning here would make the most common monorepo layout the
    // noisiest one, and the installation source already records what happened.
    expect(assessment.diagnosis.framework.installation).toMatchObject({
      source: "workspace",
    });
    expect(assessment.findings).toStrictEqual([]);
    expect(
      codesOf(gate(assessment, QatOperation.Execute).warnings),
    ).toStrictEqual([]);
    expect(isExecutable(assessment)).toBe(true);
  });

  it("warns when the framework is installed locally and not declared", async () => {
    const { assessment } = await assessFiles(
      healthy({ "package.json": manifest() }),
    );

    expect(codesOf(assessment.findings)).toStrictEqual([]);
    expect(codesOf(gate(assessment, QatOperation.Execute).warnings)).toContain(
      "QAT-D012",
    );
    expect(isExecutable(assessment)).toBe(true);
  });
});

describe("what each part of an assessment holds", () => {
  it("keeps detection findings out of the list validation adds", async () => {
    const { assessment } = await assessFiles(
      healthy({ "package.json": manifest() }),
    );

    // The split, asserted where it is easiest to get wrong: one list is this layer's contribution, the other is the
    // per-operation view over both layers. Reading the wrong one is how a warning gets asserted against a list that
    // structurally cannot contain it — which is how two cases in this suite were written the first time.
    expect(codesOf(assessment.findings)).toStrictEqual([]);
    expect(
      codesOf(gate(assessment, QatOperation.Execute).warnings),
    ).toStrictEqual(["QAT-D012"]);
    expect(
      codesOf(gate(assessment, QatOperation.Execute).blocking),
    ).toStrictEqual([]);
    expect(assessment.diagnosis.findings).toHaveLength(1);
  });
});

describe("the binary, where readiness is assessed", () => {
  it("treats an unverified executable as unverified", async () => {
    const { assessment } = await assessFiles(healthy());

    // Nothing looked, so nothing is claimed. `false` would be a statement no check has made — and this is the fixture
    // in which anything that tried to invoke a binary would fail rather than quietly report one.
    expect(assessment.diagnosis.framework.binaryAvailable).toBeUndefined();
    expect(codesOf(assessment.findings)).not.toContain(
      ValidationCode.BinaryUnavailable,
    );
    expect(isExecutable(assessment)).toBe(true);
  });

  it("blocks only on an explicit failure, never on an absent answer", async () => {
    const root = await makeTree(healthy());
    const detection = await detectCypress(root);
    const diagnosis = diagnosisFrom(detection);

    const requirement = REQUIREMENTS.find(
      (entry) => entry.id === ValidationRequirementId.BinaryAvailable,
    );

    if (requirement === undefined)
      throw new Error("the binary requirement is in the table");

    const input = (binaryAvailable: boolean | undefined): ValidationInput => ({
      detection,
      diagnosis: {
        ...diagnosis,
        framework: { ...diagnosis.framework, binaryAvailable },
      },
      layout: classifyLayout(
        detection.layout,
        diagnosis.framework.configuration,
      ),
    });

    // A verification operation would set this field; nothing in passive detection does. Constructing the evidence is
    // how the rule is exercised without pretending something invoked the framework — and it is the only way, because
    // no directory on disk can produce a verified answer.
    expect(requirement.evaluate(input(false))).toStrictEqual({
      codes: [ValidationCode.BinaryUnavailable],
    });
    expect(requirement.evaluate(input(true))).toStrictEqual({});
    expect(requirement.evaluate(input(undefined))).toStrictEqual({});
  });
});

describe("the gate", () => {
  it("never blocks inspection, whatever is wrong", async () => {
    const fixtures = [
      { "readme.md": "" },
      { "package.json": manifest() },
      { "package.json": '{ "name": ', "cypress.config.ts": "" },
      { "package.json": manifest(), "cypress/cypress.config.ts": "" },
      {
        "package.json": manifest(),
        "cypress.config.ts": "",
        "cypress/component/x.cy.tsx": "",
      },
    ];

    for (const files of fixtures) {
      const { assessment } = await assessFiles(files);

      // Inspection exists to report the blockers; refusing it because they exist would be self-defeating. That one
      // sentence is the whole reason readiness is per operation.
      expect(readinessFor(assessment, QatOperation.Inspect)).not.toBe(
        OperationReadiness.Blocked,
      );
      expect(isExecutable(assessment)).toBe(false);
    }
  });

  it("throws a single application error naming the first blocking condition", async () => {
    const { assessment } = await assessFiles({
      "package.json": manifest({ devDependencies: { cypress: "^13.15.0" } }),
      "cypress.config.ts": "",
    });

    const error = failure(() => {
      assertReadyFor(assessment, QatOperation.Execute);
    });

    expect(error.code).toBe("QAT2005");
    expect(error.message).toContain("cannot be used for execute");
    expect(error.context["blocking"]).toContain("QAT-D005");
    expect(error.remediation).toBeDefined();
  });

  it("does not throw for a ready project, or for an inspection", async () => {
    const { assessment } = await assessFiles(healthy());

    expect(() => {
      assertReadyFor(assessment, QatOperation.Execute);
      assertReadyFor(assessment, QatOperation.Inspect);
    }).not.toThrow();
  });

  it("lists blocking findings before warnings", async () => {
    const { assessment } = await assessFiles({ "readme.md": "" });
    const { blocking, warnings } = gate(assessment, QatOperation.Execute);

    // Concrete rather than a sorted-copy comparison, which would pass for two empty arrays.
    expect(codesOf(blocking)).toStrictEqual(["QAT-D001"]);
    expect(codesOf(warnings)).toStrictEqual(["QAT-D010"]);
    expect(blocking.map((entry) => entry.severity)).toStrictEqual([
      DiagnosticSeverity.Error,
    ]);
    expect(warnings.map((entry) => entry.severity)).toStrictEqual([
      DiagnosticSeverity.Warning,
    ]);
  });
});

describe("the catalogue", () => {
  /**
   * Four shapes, each one the engine can actually produce.
   *
   * Declared rather than derived by spreading one base and overriding, because an override like
   * `{ ...base, componentDirectory: undefined }` does not *remove* the property — it sets it, and under
   * `exactOptionalPropertyTypes` a set `undefined` is not the absent value the type promises. Each shape below
   * omits what it does not have.
   */
  const PLACED: ValidationFacts = {
    root: "/project",
    declaredWorkspaces: [],
    installedVersion: "13.15.0",
    configuration: "cypress.config.ts",
    misplacedConfigurations: ["cypress/cypress.config.ts"],
    occupiedConfigurationPaths: [],
    specDirectories: ["cypress/e2e"],
    unsupportedConfigurations: [],
  };

  /** Component tests only: no named spec directory, and a component directory instead. */
  const COMPONENT_ONLY: ValidationFacts = {
    root: "/project",
    declaredWorkspaces: [],
    installedVersion: "13.15.0",
    configuration: "cypress.config.ts",
    misplacedConfigurations: [],
    occupiedConfigurationPaths: [],
    specDirectories: [],
    componentDirectory: "cypress/component",
    unsupportedConfigurations: [],
  };

  /** A directory occupying a configuration filename, with no misplaced file to take precedence. */
  const OCCUPIED: ValidationFacts = {
    ...PLACED,
    misplacedConfigurations: [],
    occupiedConfigurationPaths: ["cypress.config.js"],
  };

  /** No recognisable spec location, and nothing else to explain it — the branch that carries no path. */
  const UNKNOWN_LAYOUT: ValidationFacts = {
    root: "/project",
    declaredWorkspaces: [],
    installedVersion: "13.15.0",
    configuration: "cypress.config.ts",
    misplacedConfigurations: [],
    occupiedConfigurationPaths: [],
    specDirectories: [],
    unsupportedConfigurations: [],
  };

  /** Nothing optional established at all. Only the entries that interpolate an optional are asserted against it. */
  const BARE: ValidationFacts = {
    root: "/project",
    declaredWorkspaces: [],
    misplacedConfigurations: [],
    occupiedConfigurationPaths: [],
    specDirectories: [],
    unsupportedConfigurations: [],
  };

  const SHAPES = [PLACED, COMPONENT_ONLY, OCCUPIED, UNKNOWN_LAYOUT] as const;

  it.each(Object.values(ValidationCode))(
    "%s explains itself in every reachable shape",
    (code) => {
      for (const facts of SHAPES) {
        const text = VALIDATION_GUIDANCE[code].describe(facts);

        // The `Record` guarantee means an entry exists. This asserts the entry says something in each shape, and that no
        // branch of a multi-shape entry fell through with a hole in its sentence — which a template literal
        // interpolating an absent optional produces as the word "undefined".
        expect(text.explanation.length).toBeGreaterThan(0);
        expect(text.explanation).not.toContain("undefined");
      }
    },
  );

  it.each(
    Object.values(ValidationCode).filter(
      (code) => VALIDATION_GUIDANCE[code].severity === DiagnosticSeverity.Error,
    ),
  )("%s offers a remedy, because the reader can act on it", (code) => {
    // An error with no remedy is a dead end: it says the command stopped and gives the reader nothing to do next.
    expect(
      VALIDATION_GUIDANCE[code].describe(PLACED).remediation,
    ).toBeDefined();
  });

  it("describes each shape of a multi-shape entry differently", () => {
    const misplaced =
      VALIDATION_GUIDANCE[ValidationCode.ConfigurationMisplaced];
    const layout = VALIDATION_GUIDANCE[ValidationCode.LayoutUnsupported];

    // Two codes cover two shapes each, and one sentence for both would be accurate about neither: "move this file" and
    // "remove this directory" are different actions, as are "component tests" and "custom spec pattern".
    expect(misplaced.describe(PLACED).explanation).toContain(
      "cypress/cypress.config.ts",
    );
    expect(misplaced.describe(OCCUPIED).explanation).toContain(
      "cypress.config.js",
    );
    expect(layout.describe(COMPONENT_ONLY).explanation).toContain(
      "cypress/component",
    );
    expect(layout.describe(UNKNOWN_LAYOUT).explanation).toContain(
      "No spec location",
    );

    expect(misplaced.describe(PLACED).explanation).not.toBe(
      misplaced.describe(OCCUPIED).explanation,
    );
    expect(layout.describe(COMPONENT_ONLY).explanation).not.toBe(
      layout.describe(UNKNOWN_LAYOUT).explanation,
    );
  });

  it("names the file for each shape that has one", () => {
    const misplaced =
      VALIDATION_GUIDANCE[ValidationCode.ConfigurationMisplaced];

    // The positive half of the absent-path case below: the conditional spread has to produce the property when the
    // element exists, not merely omit it when it does not.
    expect(misplaced.describe(PLACED).path).toBe("cypress/cypress.config.ts");
    expect(misplaced.describe(OCCUPIED).path).toBe("cypress.config.js");
  });

  it("omits a path rather than setting it to undefined", () => {
    const text =
      VALIDATION_GUIDANCE[ValidationCode.LayoutUnsupported].describe(
        UNKNOWN_LAYOUT,
      );

    // Absent, not present-and-undefined: a finding is serialised into `--json`, and a `null` path reads as a fact
    // nobody established. No type check can prove this once the object exists.
    expect("path" in text).toBe(false);
  });

  it("never prints a missing optional as the word undefined", () => {
    for (const code of [
      ValidationCode.BinaryUnavailable,
      ValidationCode.VersionBelowSupported,
      ValidationCode.VersionAboveKnownGood,
    ]) {
      // These three interpolate an installed version, which is absent when nothing is installed. The explicit branch
      // and the `?? 'unknown'` fallbacks exist for exactly this case, and a template literal left to interpolate
      // `undefined` would print the word to a user.
      expect(
        VALIDATION_GUIDANCE[code].describe(BARE).explanation,
      ).not.toContain("undefined");
    }
  });

  it("keeps the supported floor at or above the configuration-format floor", () => {
    // The two numbers answer different questions and coincide today. Whichever way either moves, the tool cannot
    // support a version whose configuration format it cannot read.
    expect(CYPRESS_VERSION_POLICY.minimumSupportedMajor).toBeGreaterThanOrEqual(
      10,
    );
    expect(CYPRESS_VERSION_POLICY.knownGoodMaximumMajor).toBeGreaterThanOrEqual(
      CYPRESS_VERSION_POLICY.minimumSupportedMajor,
    );
  });
});

describe("non-functional behaviour", () => {
  it("does not modify the project tree", async () => {
    const root = await makeTree(healthy({ "package-lock.json": "{}" }));

    const before = await snapshot(root);
    await assessProject(root);

    // Byte-identical, including modification times. A tool that rewrote a configuration while merely describing a
    // project would be untrustworthy even when its description was right.
    expect(await snapshot(root)).toStrictEqual(before);
  });

  it("is deterministic: two assessments of the same tree are deeply equal", async () => {
    const root = await makeTree(healthy());

    expect(await assessProject(root)).toStrictEqual(await assessProject(root));
  });

  it("is deterministic from evidence alone", async () => {
    const root = await makeTree(healthy());
    const detection = await detectCypress(root);

    // The property that makes the rule set cheap to test: assessment is a function of a value, with no filesystem and
    // no clock between it and its answer.
    expect(assessDetection(detection)).toStrictEqual(
      assessDetection(detection),
    );
  });

  it("keeps concurrent assessments independent", async () => {
    const first = await makeTree(healthy());
    const second = await makeTree({
      "package.json": '{ "name": ',
      "cypress.config.ts": "",
    });

    const [ready, broken] = await Promise.all([
      assessProject(first),
      assessProject(second),
    ]);

    // A module-level cache would make one of these report the other's project.
    expect(isExecutable(ready)).toBe(true);
    expect(isExecutable(broken)).toBe(false);
    expect(ready.diagnosis.identity.root).not.toBe(
      broken.diagnosis.identity.root,
    );
  });
});
