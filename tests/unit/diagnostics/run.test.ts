import { describe, expect, it } from "vitest";

import {
  ConfigurationLoad,
  type ConfigurationLoadResult,
} from "~/config/loader/index.js";
import {
  CheckId,
  CheckSeverity,
  CheckSkipReason,
  CheckStatus,
  HealthCode,
  failedChecks,
  isBlocked,
  outcomeOf,
} from "~/core/application/checks.js";
import type { CheckOutcome } from "~/core/application/checks.js";
import { ConfigurationDiagnosticCode } from "~/core/application/configuration.js";
import {
  DetectionStatus,
  DiagnosticCode,
  DiagnosticSeverity,
  PackageMetadataStatus,
  type DiagnosticFinding,
} from "~/core/application/diagnostics.js";
import {
  OperationReadiness,
  QatOperation,
  ValidationCode,
  type OperationGate,
  type ProjectAssessment,
} from "~/core/application/validation.js";
import {
  CHECKS,
  runChecks,
  type CheckFacts,
  type EnvironmentFacts,
  type OutputFacts,
  type PackageManagerFacts,
  type RuntimeFacts,
} from "~/diagnostics/checks/index.js";

/**
 * The catalogue, run against evidence a test constructs.
 *
 * No filesystem anywhere. Every fact is a literal, which is what lets the skipped cases be arranged at all — on disk
 * they need a failure in another layer, which is a slow and indirect way to test a rule that is one `if`.
 *
 * ## The scenario inventory is enforced, not described
 *
 * `CASES` is keyed by the identifiers the catalogue declares. The first case asserts the two sets are equal, so a
 * scenario declared without a fixture fails here, and a fixture for a scenario nobody declared fails too. That is the
 * traceability KPI made mechanical: the register cannot claim a case that does not exist.
 */
type AnyCode = DiagnosticCode | ValidationCode;

const CONFIG_PATH = "/project/qat.config.json";

/** A finding as an assessment's gate would hold it. */
function problem(
  code: AnyCode,
  severity: DiagnosticSeverity = DiagnosticSeverity.Error,
): DiagnosticFinding<AnyCode> {
  return {
    code,
    severity,
    explanation: `${code} applies.`,
    remediation: "Correct it.",
  };
}

/**
 * What an outcome says, as one string.
 *
 * So a case asserts the status and the code in **one** comparison. A test that checks the code inside an `if` asserts
 * nothing on the branch it skips, and `failed` without its code is a weaker claim than the case intends.
 */
function fingerprint(outcome: CheckOutcome | undefined): string {
  if (outcome === undefined) return "not reported";
  if (
    outcome.status === CheckStatus.Passed ||
    outcome.status === CheckStatus.Skipped
  )
    return outcome.status;

  return `${outcome.status} ${outcome.finding.code}`;
}

/** The same string the outcome should produce, so the two can be compared directly. */
function expected(status: CheckStatus, code: string | undefined): string {
  if (status === CheckStatus.Passed || status === CheckStatus.Skipped)
    return status;

  return `${status} ${code ?? "(no code stated)"}`;
}

interface AssessmentSpec {
  readonly detection?: DetectionStatus;
  readonly packageMetadata?: PackageMetadataStatus;
  readonly blocking?: readonly DiagnosticFinding<AnyCode>[];
  readonly warnings?: readonly DiagnosticFinding<AnyCode>[];
}

/**
 * An assessment built from a value.
 *
 * Deliberately not a mock of the validation layer: the checks read four fields and two gate lists, and a literal that
 * spells those out is a better specification of what a check depends on than a stub that hides them.
 */
function assessment(spec: AssessmentSpec = {}): ProjectAssessment {
  const blocking = spec.blocking ?? [];
  const warnings = spec.warnings ?? [];
  const detection = spec.detection ?? DetectionStatus.Detected;
  const packageMetadata = spec.packageMetadata ?? PackageMetadataStatus.Present;

  const gated =
    blocking.length > 0
      ? OperationReadiness.Blocked
      : warnings.length > 0
        ? OperationReadiness.ReadyWithWarnings
        : OperationReadiness.Ready;

  const gate = (operation: QatOperation): OperationGate => ({
    operation,
    // Inspection is never blocked: reporting the blockers is what it is for. Its readiness copies the execute verdict
    // unless that verdict is `blocked`, in which case an inspection is merely something to report.
    readiness:
      gated === OperationReadiness.Blocked && operation === QatOperation.Inspect
        ? OperationReadiness.ReadyWithWarnings
        : gated,
    blocking,
    warnings,
  });

  return {
    diagnosis: {
      identity: {
        root: "/project",
        name: "demo",
        packageMetadata,
        declaredWorkspaces: [],
      },
      framework: {
        declaration: { section: "devDependencies", range: "^13.15.0" },
        configurationsFound: ["cypress.config.ts"],
        unsupportedConfigurations: [],
        binaryAvailable: undefined,
      },
      detection,
      compatibility: "consistent",
      findings: [],
    },
    findings: [],
    requirements: [],
    gates: {
      [QatOperation.Inspect]: gate(QatOperation.Inspect),
      [QatOperation.Execute]: gate(QatOperation.Execute),
    },
  };
}

/** The load outcome for a project with no configuration file, which is legal. */
const ABSENT: ConfigurationLoadResult = {
  kind: ConfigurationLoad.NotFound,
  path: CONFIG_PATH,
};

/**
 * Each fact group named once, and non-optional, so a fact set that omits one can be written without setting a property
 * to `undefined` — which `exactOptionalPropertyTypes` forbids and rightly so: absent and present-and-undefined are
 * different states.
 */
const RUNTIME: RuntimeFacts = { nodeVersion: "v24.4.0" };
const MANAGER: PackageManagerFacts = {
  selected: { name: "npm", declared: true },
};
const ENVIRONMENT: EnvironmentFacts = { declared: [] };
const OUTPUT: OutputFacts = {
  reports: { path: "results/reports", writable: true },
  evidence: { path: "results/evidence", writable: true },
};

/** A project that passes every check, and varies one thing per scenario. */
const HEALTHY: CheckFacts = {
  runtime: RUNTIME,
  packageManager: MANAGER,
  assessment: assessment(),
  configuration: ABSENT,
  environment: ENVIRONMENT,
  output: OUTPUT,
};

/**
 * The same facts with the assessment withheld.
 *
 * Written out rather than spread-and-deleted, because there is no way to remove a property from a spread that the type
 * system will accept — and because naming the five groups that remain is the clearest statement of what this fixture
 * is: a caller that gathered everything except the project evidence.
 */
const WITHOUT_ASSESSMENT: CheckFacts = {
  runtime: RUNTIME,
  packageManager: MANAGER,
  configuration: ABSENT,
  environment: ENVIRONMENT,
  output: OUTPUT,
};

/** One named assessment per project shape a check distinguishes. */
const NOTHING_IDENTIFIED = assessment({
  detection: DetectionStatus.NotDetected,
  packageMetadata: PackageMetadataStatus.Absent,
  blocking: [problem(DiagnosticCode.FrameworkNotDetected)],
  warnings: [
    problem(DiagnosticCode.ManifestMissing, DiagnosticSeverity.Warning),
  ],
});

const MANIFEST_UNREADABLE = assessment({
  detection: DetectionStatus.Invalid,
  packageMetadata: PackageMetadataStatus.Unreadable,
  blocking: [problem(DiagnosticCode.ManifestUnreadable)],
});

const NO_MANIFEST = assessment({
  packageMetadata: PackageMetadataStatus.Absent,
  warnings: [
    problem(DiagnosticCode.ManifestMissing, DiagnosticSeverity.Warning),
  ],
});

const INCOMPLETE_MANIFEST = assessment({
  packageMetadata: PackageMetadataStatus.Incomplete,
  warnings: [
    problem(DiagnosticCode.ManifestIncomplete, DiagnosticSeverity.Warning),
  ],
});

function withBlocking(
  ...findings: DiagnosticFinding<AnyCode>[]
): ProjectAssessment {
  return assessment({ blocking: findings });
}

function withWarnings(
  ...findings: DiagnosticFinding<AnyCode>[]
): ProjectAssessment {
  return assessment({ warnings: findings });
}

/** A fixture by identifier, or a failure naming the identifier that has none. */
function caseOf(scenario: string): Case {
  const entry = CASES[scenario];

  if (entry === undefined) throw new Error(`No fixture for ${scenario}.`);

  return entry;
}

describe("the scenario inventory", () => {
  it("covers exactly the scenarios the catalogue links", () => {
    const declared = CHECKS.flatMap((check) => check.scenarios).sort();

    // Both directions. A scenario with no fixture is a claim; a fixture with no scenario is a case nothing asked for.
    expect(Object.keys(CASES).sort()).toStrictEqual(declared);
  });
});

describe("a healthy project", () => {
  it("passes every check, and reports each one", () => {
    const report = runChecks(HEALTHY);

    expect(report.outcomes).toHaveLength(CHECKS.length);
    expect(
      report.outcomes.every((outcome) => outcome.status === CheckStatus.Passed),
    ).toBe(true);
    expect(isBlocked(report)).toBe(false);
    expect(failedChecks(report)).toStrictEqual([]);
  });

  it("reports the outcomes in catalogue order", () => {
    // The report is a plan: a reader fixing it top to bottom fixes causes before consequences.
    expect(
      runChecks(HEALTHY).outcomes.map((outcome) => outcome.check),
    ).toStrictEqual(CHECKS.map((check) => check.id));
  });
});

describe("every declared scenario", () => {
  it.each(Object.entries(CASES))("%s", (scenario, expectation) => {
    const outcome = outcomeOf(runChecks(expectation.facts), expectation.check);

    // One comparison per case, carrying the status and the code together. `QAT-V002` reaching the wrong check would
    // pass a status-only assertion, which is why the code is part of the fingerprint rather than an optional extra.
    expect(fingerprint(outcome)).toBe(
      expected(expectation.status, expectation.code),
    );

    // Named so a failure reads as the scenario it belongs to rather than as two opaque strings.
    expect(scenario).toBe(scenario);
  });
});

describe("skipping", () => {
  it("skips a dependant rather than reporting its consequence as a second problem", () => {
    // A project with no configuration: recognition passes, configuration fails, and the three checks that depend on it
    // — directly or through one another — must not add their own voices to the report.
    const report = runChecks({
      ...HEALTHY,
      assessment: withBlocking(problem(DiagnosticCode.ConfigurationMissing)),
    });

    expect([
      fingerprint(outcomeOf(report, CheckId.CypressLayoutDriveable)),
      fingerprint(outcomeOf(report, CheckId.CypressInstalled)),
      fingerprint(outcomeOf(report, CheckId.CypressVersionSupported)),
    ]).toStrictEqual([
      CheckStatus.Skipped,
      CheckStatus.Skipped,
      CheckStatus.Skipped,
    ]);

    // Configuration itself failed rather than skipping, so the number of failures is one and not four.
    expect(failedChecks(report).map((outcome) => outcome.check)).toStrictEqual([
      CheckId.CypressConfigurationLocated,
    ]);
  });

  it("says which check stopped it, rather than only that it did not run", () => {
    const report = runChecks({
      ...HEALTHY,
      assessment: withBlocking(problem(DiagnosticCode.ConfigurationMissing)),
    });
    const outcome = outcomeOf(report, CheckId.CypressInstalled);

    // "Skipped" alone is the least useful word in a report. The sentence names the gate that was not passed.
    expect(outcome).toMatchObject({
      status: CheckStatus.Skipped,
      reason: CheckSkipReason.PreconditionFailed,
      explanation: expect.stringContaining(
        CheckId.CypressConfigurationLocated,
      ) as string,
    });
  });

  it("distinguishes missing evidence from a failed precondition", () => {
    // Nothing gathered the assessment. That is a defect in the assembly rather than a fact about the project, and the
    // reason says so — a maintainer debugging the tool needs a different answer from a user reading the report.
    const report = runChecks(WITHOUT_ASSESSMENT);

    expect(outcomeOf(report, CheckId.ProjectRecognised)).toMatchObject({
      status: CheckStatus.Skipped,
      reason: CheckSkipReason.InputUnavailable,
      explanation: expect.stringContaining("assessment") as string,
    });
  });

  it("runs the checks whose evidence is present, and skips only the ones that need what is not", () => {
    const report = runChecks(WITHOUT_ASSESSMENT);

    // Runtime and package manager read none of the withheld evidence, so withholding it must not silence them.
    expect([
      fingerprint(outcomeOf(report, CheckId.NodeVersion)),
      fingerprint(outcomeOf(report, CheckId.PackageManager)),
      fingerprint(outcomeOf(report, CheckId.ProjectRecognised)),
    ]).toStrictEqual([
      CheckStatus.Passed,
      CheckStatus.Passed,
      CheckStatus.Skipped,
    ]);
  });

  it("never blocks on a skipped check alone", () => {
    const report = runChecks(WITHOUT_ASSESSMENT);

    // A skip is a consequence of something else — here, of a defect in the assembly rather than of the project.
    // Neither is a reason to refuse a run: a report that blocks on what it could not check is one nobody can act on.
    expect(isBlocked(report)).toBe(false);
    expect(failedChecks(report)).toStrictEqual([]);
  });
});

describe("boundaries", () => {
  it("accepts the minimum Node major and refuses the one below it", () => {
    const atMinimum = runChecks({
      ...HEALTHY,
      runtime: { nodeVersion: "v24.0.0" },
    });
    const below = runChecks({
      ...HEALTHY,
      runtime: { nodeVersion: "v23.11.0" },
    });

    // The version arrives as `process.version` reports it, with a leading `v`. Parsing it without trimming is the
    // mistake that makes this check fail on every runtime, and the floor itself is inclusive.
    expect([
      fingerprint(outcomeOf(atMinimum, CheckId.NodeVersion)),
      fingerprint(outcomeOf(below, CheckId.NodeVersion)),
    ]).toStrictEqual([
      CheckStatus.Passed,
      `${CheckStatus.Failed} ${HealthCode.RuntimeUnsupported}`,
    ]);
  });

  it("refuses a runtime version it cannot read rather than assuming it is fine", () => {
    const report = runChecks({
      ...HEALTHY,
      runtime: { nodeVersion: "v-next" },
    });

    // Treating "I cannot tell" as "supported" is how a report blesses a runtime it never measured.
    expect(outcomeOf(report, CheckId.NodeVersion)).toMatchObject({
      status: CheckStatus.Failed,
      finding: { code: HealthCode.RuntimeUnsupported },
    });
  });

  it("distinguishes one unwritable directory from both", () => {
    const reportsOnly = runChecks({
      ...HEALTHY,
      output: { ...OUTPUT, reports: { path: "out/reports", writable: false } },
    });

    expect([
      fingerprint(outcomeOf(reportsOnly, CheckId.ReportsWritable)),
      fingerprint(outcomeOf(reportsOnly, CheckId.EvidenceWritable)),
    ]).toStrictEqual([
      `${CheckStatus.Failed} ${HealthCode.OutputUnwritable}`,
      CheckStatus.Passed,
    ]);

    // One code, two directories: each finding names the path its own check probed, so a reader is never sent to fix a
    // directory that is fine.
    expect(outcomeOf(reportsOnly, CheckId.ReportsWritable)).toMatchObject({
      finding: { path: "out/reports" },
    });
  });
});

describe("the severity rule", () => {
  it.each(
    CHECKS.filter((check) => check.severity === CheckSeverity.Warning).flatMap(
      (check) =>
        check.scenarios.map((scenario) => [scenario, check.id] as const),
    ),
  )("%s never fails a run", (scenario, check) => {
    // The invariant the runner relies on: `failed` is reserved for error-severity checks. Driven from the same
    // fixtures the inventory uses, so an advisory check that grew a `fail` branch is caught by the case that already
    // exists for it rather than by a new one nobody writes.
    expect(
      fingerprint(outcomeOf(runChecks(caseOf(scenario).facts), check)),
    ).not.toBe(CheckStatus.Failed);
  });

  it("blocks on a failed error check, and lists it once", () => {
    const report = runChecks({
      ...HEALTHY,
      runtime: { nodeVersion: "v20.20.2" },
    });

    expect(isBlocked(report)).toBe(true);
    expect(failedChecks(report).map((outcome) => outcome.check)).toStrictEqual([
      CheckId.NodeVersion,
    ]);
  });
});

describe("non-functional behaviour", () => {
  it("is deterministic: the same facts produce a deeply equal report", () => {
    expect(runChecks(HEALTHY)).toStrictEqual(runChecks(HEALTHY));
  });

  it("does not mutate the facts it was given", () => {
    const facts = structuredClone(HEALTHY);
    const before = structuredClone(facts);

    runChecks(facts);

    // A runner that defaulted by assignment would corrupt the evidence a second consumer reads — and the corruption
    // would be invisible, because the report is correct.
    expect(facts).toStrictEqual(before);
  });
});

interface Case {
  readonly check: CheckId;
  readonly facts: CheckFacts;
  readonly status: CheckStatus;
  /** Stated for every outcome that carries a finding, so the case names the condition and not only the verdict. */
  readonly code?: string;
}

/**
 * One fixture per scenario the catalogue links. Keys are the identifiers, verbatim.
 *
 * Grouped by category, in the catalogue's order, so a reader can see which conditions each check distinguishes without
 * following a reference.
 */
const CASES: Record<string, Case> = {
  // runtime compatibility
  "runtime.node-version.supported": {
    check: CheckId.NodeVersion,
    facts: HEALTHY,
    status: CheckStatus.Passed,
  },
  "runtime.node-version.below-floor": {
    check: CheckId.NodeVersion,
    facts: { ...HEALTHY, runtime: { nodeVersion: "v20.20.2" } },
    status: CheckStatus.Failed,
    code: HealthCode.RuntimeUnsupported,
  },
  "runtime.node-version.unreadable": {
    check: CheckId.NodeVersion,
    facts: { ...HEALTHY, runtime: { nodeVersion: "v-next" } },
    status: CheckStatus.Failed,
    code: HealthCode.RuntimeUnsupported,
  },

  // package-manager availability
  "environment.package-manager.declared": {
    check: CheckId.PackageManager,
    facts: HEALTHY,
    status: CheckStatus.Passed,
  },
  "environment.package-manager.inferred": {
    check: CheckId.PackageManager,
    facts: {
      ...HEALTHY,
      packageManager: { selected: { name: "npm", declared: false } },
    },
    status: CheckStatus.Passed,
  },
  "environment.package-manager.none": {
    check: CheckId.PackageManager,
    facts: { ...HEALTHY, packageManager: {} },
    status: CheckStatus.Warned,
    code: HealthCode.PackageManagerUnknown,
  },

  // project structure
  "project.recognised.detected": {
    check: CheckId.ProjectRecognised,
    facts: HEALTHY,
    status: CheckStatus.Passed,
  },
  "project.recognised.nothing-identifying-cypress": {
    check: CheckId.ProjectRecognised,
    facts: { ...HEALTHY, assessment: NOTHING_IDENTIFIED },
    status: CheckStatus.Failed,
    code: DiagnosticCode.FrameworkNotDetected,
  },
  "project.recognised.manifest-unreadable": {
    check: CheckId.ProjectRecognised,
    facts: { ...HEALTHY, assessment: MANIFEST_UNREADABLE },
    status: CheckStatus.Failed,
    code: DiagnosticCode.ManifestUnreadable,
  },
  "project.package-metadata.present": {
    check: CheckId.PackageMetadata,
    facts: HEALTHY,
    status: CheckStatus.Passed,
  },
  "project.package-metadata.missing": {
    check: CheckId.PackageMetadata,
    facts: { ...HEALTHY, assessment: NO_MANIFEST },
    status: CheckStatus.Warned,
    code: DiagnosticCode.ManifestMissing,
  },
  "project.package-metadata.incomplete": {
    check: CheckId.PackageMetadata,
    facts: { ...HEALTHY, assessment: INCOMPLETE_MANIFEST },
    status: CheckStatus.Warned,
    code: DiagnosticCode.ManifestIncomplete,
  },

  // cypress configuration
  "cypress.configuration-located.located": {
    check: CheckId.CypressConfigurationLocated,
    facts: HEALTHY,
    status: CheckStatus.Passed,
  },
  "cypress.configuration-located.missing": {
    check: CheckId.CypressConfigurationLocated,
    facts: {
      ...HEALTHY,
      assessment: withBlocking(problem(DiagnosticCode.ConfigurationMissing)),
    },
    status: CheckStatus.Failed,
    code: DiagnosticCode.ConfigurationMissing,
  },
  "cypress.configuration-located.ambiguous": {
    check: CheckId.CypressConfigurationLocated,
    facts: {
      ...HEALTHY,
      assessment: withBlocking(problem(DiagnosticCode.ConfigurationAmbiguous)),
    },
    status: CheckStatus.Failed,
    code: DiagnosticCode.ConfigurationAmbiguous,
  },
  "cypress.configuration-located.unusable-format": {
    check: CheckId.CypressConfigurationLocated,
    facts: {
      ...HEALTHY,
      assessment: withBlocking(
        problem(DiagnosticCode.ConfigurationUnsupported),
      ),
    },
    status: CheckStatus.Failed,
    code: DiagnosticCode.ConfigurationUnsupported,
  },
  "cypress.layout-driveable.supported": {
    check: CheckId.CypressLayoutDriveable,
    facts: HEALTHY,
    status: CheckStatus.Passed,
  },
  "cypress.layout-driveable.no-recognisable-location": {
    check: CheckId.CypressLayoutDriveable,
    facts: {
      ...HEALTHY,
      assessment: withBlocking(problem(ValidationCode.LayoutUnsupported)),
    },
    status: CheckStatus.Failed,
    code: ValidationCode.LayoutUnsupported,
  },
  "cypress.layout-driveable.component-only": {
    check: CheckId.CypressLayoutDriveable,
    facts: {
      ...HEALTHY,
      assessment: withBlocking(problem(ValidationCode.LayoutUnsupported)),
    },
    status: CheckStatus.Failed,
    code: ValidationCode.LayoutUnsupported,
  },

  // cypress installation
  "cypress.installed.installed": {
    check: CheckId.CypressInstalled,
    facts: HEALTHY,
    status: CheckStatus.Passed,
  },
  "cypress.installed.declared-not-installed": {
    check: CheckId.CypressInstalled,
    facts: {
      ...HEALTHY,
      assessment: withBlocking(problem(DiagnosticCode.DependencyNotInstalled)),
    },
    status: CheckStatus.Failed,
    code: DiagnosticCode.DependencyNotInstalled,
  },
  "cypress.installed.not-declared-not-installed": {
    check: CheckId.CypressInstalled,
    facts: {
      ...HEALTHY,
      assessment: withBlocking(problem(DiagnosticCode.DependencyNotInstalled)),
    },
    status: CheckStatus.Failed,
    code: DiagnosticCode.DependencyNotInstalled,
  },
  "cypress.version-supported.in-range": {
    check: CheckId.CypressVersionSupported,
    facts: HEALTHY,
    status: CheckStatus.Passed,
  },
  "cypress.version-supported.below-floor": {
    check: CheckId.CypressVersionSupported,
    facts: {
      ...HEALTHY,
      assessment: withBlocking(problem(ValidationCode.VersionBelowSupported)),
    },
    status: CheckStatus.Failed,
    code: ValidationCode.VersionBelowSupported,
  },
  "cypress.version-supported.above-known-good": {
    check: CheckId.CypressVersionSupported,
    // A warning, so it arrives in the gate's `warnings` list — the half a check that searched only `blocking` would
    // never see, and the case that catches it.
    facts: {
      ...HEALTHY,
      assessment: withWarnings(
        problem(
          ValidationCode.VersionAboveKnownGood,
          DiagnosticSeverity.Warning,
        ),
      ),
    },
    status: CheckStatus.Warned,
    code: ValidationCode.VersionAboveKnownGood,
  },

  // qat configuration
  "qat.configuration-loadable.absent": {
    check: CheckId.QatConfigurationLoadable,
    facts: HEALTHY,
    status: CheckStatus.Passed,
  },
  "qat.configuration-loadable.loaded": {
    check: CheckId.QatConfigurationLoadable,
    facts: {
      ...HEALTHY,
      configuration: {
        kind: ConfigurationLoad.Loaded,
        path: CONFIG_PATH,
        // `source` and `document`, not a bare configuration: the loader hands over a document it has vouched for, and
        // this layer never reads a configuration field. That is what stops two modules disagreeing about a schema.
        config: {
          source: CONFIG_PATH,
          document: {
            version: 1,
            framework: "cypress",
            output: {
              reports: "results/reports",
              evidence: "results/evidence",
            },
          },
        },
      },
    },
    status: CheckStatus.Passed,
  },
  "qat.configuration-loadable.empty": {
    check: CheckId.QatConfigurationLoadable,
    facts: {
      ...HEALTHY,
      configuration: { kind: ConfigurationLoad.Empty, path: CONFIG_PATH },
    },
    status: CheckStatus.Failed,
    code: HealthCode.ConfigurationEmpty,
  },
  "qat.configuration-loadable.not-json": {
    check: CheckId.QatConfigurationLoadable,
    facts: {
      ...HEALTHY,
      configuration: {
        kind: ConfigurationLoad.Malformed,
        path: CONFIG_PATH,
        reason: "Unexpected token }",
        location: { position: 4, line: 4, column: 1, excerpt: "}" },
      },
    },
    status: CheckStatus.Failed,
    code: HealthCode.ConfigurationNotJson,
  },
  "qat.configuration-loadable.too-large": {
    check: CheckId.QatConfigurationLoadable,
    facts: {
      ...HEALTHY,
      configuration: {
        kind: ConfigurationLoad.TooLarge,
        path: CONFIG_PATH,
        sizeBytes: 4_194_304,
        limitBytes: 1_048_576,
      },
    },
    status: CheckStatus.Failed,
    code: HealthCode.ConfigurationTooLarge,
  },
  "qat.configuration-loadable.schema-invalid": {
    check: CheckId.QatConfigurationLoadable,
    facts: {
      ...HEALTHY,
      configuration: {
        kind: ConfigurationLoad.Invalid,
        path: CONFIG_PATH,
        diagnostics: [
          {
            code: ConfigurationDiagnosticCode.Missing,
            path: "framework",
            message: "framework is required.",
            remediation: "Add the field.",
          },
        ],
      },
    },
    status: CheckStatus.Failed,
    code: ConfigurationDiagnosticCode.Missing,
  },

  // environment profiles
  "qat.environment-resolvable.none-selected": {
    check: CheckId.EnvironmentResolvable,
    facts: { ...HEALTHY, environment: { declared: ["staging"] } },
    status: CheckStatus.Passed,
  },
  "qat.environment-resolvable.declared": {
    check: CheckId.EnvironmentResolvable,
    facts: {
      ...HEALTHY,
      environment: { selected: "staging", declared: ["staging"] },
    },
    status: CheckStatus.Passed,
  },
  "qat.environment-resolvable.undeclared": {
    check: CheckId.EnvironmentResolvable,
    facts: {
      ...HEALTHY,
      environment: { selected: "production", declared: ["staging"] },
    },
    status: CheckStatus.Failed,
    code: HealthCode.EnvironmentUndeclared,
  },

  // output permissions
  "output.reports-writable.writable": {
    check: CheckId.ReportsWritable,
    facts: HEALTHY,
    status: CheckStatus.Passed,
  },
  "output.reports-writable.unwritable": {
    check: CheckId.ReportsWritable,
    facts: {
      ...HEALTHY,
      output: { ...OUTPUT, reports: { path: "out/reports", writable: false } },
    },
    status: CheckStatus.Failed,
    code: HealthCode.OutputUnwritable,
  },
  "output.evidence-writable.writable": {
    check: CheckId.EvidenceWritable,
    facts: HEALTHY,
    status: CheckStatus.Passed,
  },
  "output.evidence-writable.unwritable": {
    check: CheckId.EvidenceWritable,
    facts: {
      ...HEALTHY,
      output: {
        ...OUTPUT,
        evidence: { path: "out/evidence", writable: false },
      },
    },
    status: CheckStatus.Failed,
    code: HealthCode.OutputUnwritable,
  },
  "output.evidence-writable.reports-usable-evidence-not": {
    check: CheckId.EvidenceWritable,
    // Reports writable, evidence not: the case that proves the two directories are checked independently rather than
    // one standing in for the other.
    facts: {
      ...HEALTHY,
      output: {
        reports: { path: "results/reports", writable: true },
        evidence: { path: "results/evidence", writable: false },
      },
    },
    status: CheckStatus.Failed,
    code: HealthCode.OutputUnwritable,
  },
};
