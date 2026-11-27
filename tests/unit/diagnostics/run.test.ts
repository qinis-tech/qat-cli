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
  type CypressConfigurationFacts,
  type EnvironmentFacts,
  type OutputFacts,
  type PackageManagerFacts,
  type RuntimeFacts,
} from "~/diagnostics/checks/index.js";
import type {
  ConfigDiscovery,
  ConfigValidation,
  ConfigValidationGapCause,
} from "~/project/cypress-config/index.js";

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
 *
 * ## Fact groups are built by factories, never by literals in a spread
 *
 * `runtimeFacts` and `managerFacts` exist because a spread that replaces a whole group silently drops members the type
 * requires: `{ ...facts, runtime: { nodeVersion } }` compiled, and then the comparison read `required.range` from
 * `undefined`. A spread's result is never checked field-by-field, so nothing catches it — a factory is where the
 * required members live, and an override can replace them but never omit them.
 *
 * The configuration group has the same property for a different reason: its two members were decided from one capture of
 * one file, so `decided()` takes both. A fixture that supplied only the location would compile into a validity verdict
 * nobody made.
 */
type AnyCode = DiagnosticCode | ValidationCode;

const CONFIG_PATH = "/project/qat.config.json";

/** The Cypress configuration file the doctor is reporting on. */
const CONFIG_FILE = "cypress.config.ts";

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

/**
 * The load outcome for a project with no configuration file, which is legal.
 */
const ABSENT: ConfigurationLoadResult = {
  kind: ConfigurationLoad.NotFound,
  path: CONFIG_PATH,
};

/**
 * The range this build declares, as a fixture.
 *
 * Shared by every runtime case, so a scenario varies exactly one thing. The shape mirrors what the manifest produces;
 * nothing here is read from disk, and nothing here is parsed by the test — the check does that, once, in one place.
 *
 * Both bounds are complete `MAJOR.MINOR.PATCH` tuples, and that is a requirement rather than a preference: the range
 * grammar refuses partial versions instead of completing them, so a fixture written `>=24.0.0 <25` is an *unreadable*
 * policy. Every runtime case would then report `QAT-H008` — indeterminate — without ever comparing a version, which
 * looks like a broken check and is actually a broken fixture.
 */
const DECLARED = {
  range: ">=24.0.0 <25.0.0",
  origin: "package.json#engines.node",
} as const;

/**
 * Runtime evidence with the requirement always present.
 *
 * A constructor rather than object literals, because `required` is the field whose omission produced
 * `Cannot read properties of undefined (reading 'range')` from inside the comparison: each case replaced the whole
 * `runtime` group in a spread and silently dropped it, and nothing caught it because a spread's result is never
 * checked field-by-field against the type it satisfies.
 *
 * One function means one place that can be wrong — and this one cannot be, because `required` comes first and can be
 * replaced but never omitted.
 */
function runtimeFacts(overrides: Partial<RuntimeFacts> = {}): RuntimeFacts {
  return { nodeVersion: "v24.4.0", required: DECLARED, ...overrides };
}

/**
 * Package-manager evidence, in the shape the catalogue reads.
 *
 * The group is a discriminated selection plus three independent facts, so a literal is easy to write incompletely and
 * the compiler's complaint ("missing `selection`, `lockfiles`, `installState`") arrives three errors down from the
 * fixture that caused it. The factory makes the healthy default explicit and lets a case vary exactly one rung.
 *
 * The default carries a resolved executable because the ladder requires it once a manager is identified: a gatherer
 * that named a manager and never looked for its binary is an assembly defect, and the rule says so loudly rather than
 * reporting health it did not examine. Rungs *above* the tooling step return before that member is read, so carrying
 * it there is inert rather than wrong.
 */
function managerFacts(
  overrides: Partial<PackageManagerFacts> = {},
): PackageManagerFacts {
  return {
    selection: { status: "identified", name: "npm", declared: true },
    lockfiles: ["package-lock.json"],
    executable: { resolved: true },
    installState: "installed",
    ...overrides,
  };
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Configuration verdicts
 *
 * One constant per reason the location and validation verdicts can carry, named after the scenario that uses it. A
 * fixture is then a fact set plus one of these, which is the same shape the doc's traceability table has.
 * ───────────────────────────────────────────────────────────────────────────── */

/** Exactly one supported configuration, and it is a regular readable file. */
const LOCATED: ConfigDiscovery = {
  reason: "CYPRESS_CONFIG_FOUND",
  outcome: "pass",
  file: CONFIG_FILE,
  format: "executable",
  sizeBytes: 512,
};

const MISSING: ConfigDiscovery = {
  reason: "CYPRESS_CONFIG_MISSING",
  outcome: "fail",
  context: "cypress-evidenced",
};

const AMBIGUOUS: ConfigDiscovery = {
  reason: "CYPRESS_CONFIG_AMBIGUOUS",
  outcome: "fail",
  files: ["cypress.config.js", CONFIG_FILE],
};

const UNSUPPORTED_NAME: ConfigDiscovery = {
  reason: "CYPRESS_CONFIG_UNSUPPORTED_NAME",
  outcome: "fail",
  files: ["cypress.config.yaml"],
};

const MISPLACED: ConfigDiscovery = {
  reason: "CYPRESS_CONFIG_MISPLACED",
  outcome: "warning",
  files: [`cypress/${CONFIG_FILE}`],
};

const PATH_OCCUPIED: ConfigDiscovery = {
  reason: "CYPRESS_CONFIG_PATH_OCCUPIED",
  outcome: "fail",
  paths: [CONFIG_FILE],
};

const NOT_A_FILE: ConfigDiscovery = {
  reason: "CYPRESS_CONFIG_NOT_A_FILE",
  outcome: "fail",
  file: CONFIG_FILE,
};

const OUTSIDE_PROJECT: ConfigDiscovery = {
  reason: "CYPRESS_CONFIG_OUTSIDE_PROJECT",
  outcome: "fail",
  file: CONFIG_FILE,
  resolvedPath: "/shared/cypress.config.ts",
  projectRoot: "/project",
};

const UNREADABLE: ConfigDiscovery = {
  reason: "CYPRESS_CONFIG_UNREADABLE",
  outcome: "fail",
  file: CONFIG_FILE,
  cause: "permissions",
};

const EMPTY: ConfigDiscovery = {
  reason: "CYPRESS_CONFIG_EMPTY",
  outcome: "fail",
  file: CONFIG_FILE,
};

const LEGACY: ConfigDiscovery = {
  reason: "CYPRESS_CONFIG_LEGACY_FORMAT",
  outcome: "warning",
  file: "cypress.json",
  sizeBytes: 120,
};

const NOT_INSPECTED: ConfigDiscovery = {
  reason: "CYPRESS_CONFIG_NOT_INSPECTED",
  outcome: "indeterminate",
  file: CONFIG_FILE,
};

const NOT_APPLICABLE: ConfigDiscovery = {
  reason: "CYPRESS_CONFIG_NOT_APPLICABLE",
  outcome: "skipped",
  detail: "No Cypress configuration is expected in this project.",
};

/** A mechanism spoke and was satisfied. */
const VALIDATED_JSON: ConfigValidation = {
  reason: "CYPRESS_CONFIG_VALIDATED",
  outcome: "pass",
  file: "cypress.json",
  tier: "T1-json",
};

const VALIDATED_LOADER: ConfigValidation = {
  reason: "CYPRESS_CONFIG_VALIDATED",
  outcome: "pass",
  file: CONFIG_FILE,
  tier: "T2-cypress",
  durationMs: 812,
};

const INVALID_SYNTAX: ConfigValidation = {
  reason: "CYPRESS_CONFIG_INVALID",
  outcome: "fail",
  file: "cypress.json",
  tier: "T1-json",
  failure: { kind: "syntax", message: "Unexpected token }", line: 4 },
};

const INVALID_SHAPE: ConfigValidation = {
  reason: "CYPRESS_CONFIG_INVALID",
  outcome: "fail",
  file: "cypress.json",
  tier: "T1-json",
  failure: { kind: "shape", message: "The configuration must be an object." },
};

const INVALID_LOAD: ConfigValidation = {
  reason: "CYPRESS_CONFIG_INVALID",
  outcome: "fail",
  file: CONFIG_FILE,
  tier: "T2-cypress",
  failure: { kind: "load", message: "defineConfig is not a function" },
  durationMs: 640,
};

/**
 * A gap, by cause.
 *
 * One code covers all six, so the case names the cause rather than a code — which is exactly the distinction the
 * guidance entry makes in prose.
 */
function gap(cause: ConfigValidationGapCause): ConfigValidation {
  return {
    reason: "CYPRESS_CONFIG_NOT_VALIDATED",
    outcome: "indeterminate",
    file: CONFIG_FILE,
    tier: "T0-text",
    cause,
  };
}

/** The verdict a gatherer produces when nothing was located and validity was never asked. */
const VALIDATION_SKIPPED: ConfigValidation = {
  reason: "CYPRESS_CONFIG_SKIPPED",
  outcome: "skipped",
  prerequisite: "CFG-003",
  detail:
    "The configuration could not be located, so there is nothing to validate.",
};

/**
 * The decided configuration pair.
 *
 * Both members, always: they were decided from one capture of one file, so a fixture that supplied only the location
 * would let a check report a validity verdict about a file it never located. The default validation is the one a healthy
 * project produces, so a location case varies exactly one thing.
 */
function decided(
  location: ConfigDiscovery,
  validation: ConfigValidation = VALIDATED_LOADER,
): CypressConfigurationFacts {
  return { location, validation };
}

/**
 * Each fact group named once, and non-optional, so a fact set that omits one can be written without setting a property
 * to `undefined` — which `exactOptionalPropertyTypes` forbids and rightly so: absent and present-and-undefined are
 * different states.
 */
const RUNTIME: RuntimeFacts = runtimeFacts();
const MANAGER: PackageManagerFacts = managerFacts();
const ENVIRONMENT: EnvironmentFacts = { declared: [] };
const OUTPUT: OutputFacts = {
  reports: { path: "results/reports", writable: true },
  evidence: { path: "results/evidence", writable: true },
};
const CONFIGURATION: CypressConfigurationFacts = decided(LOCATED);

/** A project that passes every check, and varies one thing per scenario. */
const HEALTHY: CheckFacts = {
  runtime: RUNTIME,
  packageManager: MANAGER,
  assessment: assessment(),
  configuration: ABSENT,
  environment: ENVIRONMENT,
  output: OUTPUT,
  cypressConfiguration: CONFIGURATION,
};

/**
 * The same facts with the assessment withheld.
 *
 * Written out rather than spread-and-deleted, because there is no way to remove a property from a spread that the type
 * system will accept — and because naming the groups that remain is the clearest statement of what this fixture is: a
 * caller that gathered everything except the project evidence.
 */
const WITHOUT_ASSESSMENT: CheckFacts = {
  runtime: RUNTIME,
  packageManager: MANAGER,
  configuration: ABSENT,
  environment: ENVIRONMENT,
  output: OUTPUT,
  cypressConfiguration: CONFIGURATION,
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
  // The scenario name reaches the title through `%s`, so the first parameter is unused in the body and carries the `_`
  // prefix the lint rules require. The second is used, so it has no prefix.
  it.each(Object.entries(CASES))("%s", (_scenario, expectation) => {
    const outcome = outcomeOf(runChecks(expectation.facts), expectation.check);

    // One comparison per case, carrying the status and the code together. `QAT-V002` reaching the wrong check would
    // pass a status-only assertion, which is why the code is part of the fingerprint rather than an optional extra.
    expect(fingerprint(outcome)).toBe(
      expected(expectation.status, expectation.code),
    );
  });
});

describe("skipping", () => {
  it("skips a dependant rather than reporting its consequence as a second problem", () => {
    // A project with no configuration: recognition passes, the location check fails, and the four checks that depend on
    // it — directly or through one another — must not add their own voices to the report.
    const report = runChecks({
      ...HEALTHY,
      cypressConfiguration: decided(MISSING, VALIDATION_SKIPPED),
    });

    expect([
      fingerprint(outcomeOf(report, CheckId.CypressConfigurationValidatable)),
      fingerprint(outcomeOf(report, CheckId.CypressLayoutDriveable)),
      fingerprint(outcomeOf(report, CheckId.CypressInstalled)),
      fingerprint(outcomeOf(report, CheckId.CypressVersionSupported)),
    ]).toStrictEqual([
      CheckStatus.Skipped,
      CheckStatus.Skipped,
      CheckStatus.Skipped,
      CheckStatus.Skipped,
    ]);

    // Configuration itself failed rather than skipping, so the number of failures is one and not five.
    expect(failedChecks(report).map((outcome) => outcome.check)).toStrictEqual([
      CheckId.CypressConfigurationLocated,
    ]);
  });

  it("says which check stopped it, rather than only that it did not run", () => {
    const report = runChecks({
      ...HEALTHY,
      cypressConfiguration: decided(MISSING, VALIDATION_SKIPPED),
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
  it("accepts the inclusive floor and refuses the version below it", () => {
    // A pair, because one case at the floor cannot tell `>=` from `>`. The version arrives as `process.version` reports
    // it, with a leading `v`, which is also what the parser has to tolerate.
    const atFloor = runChecks({
      ...HEALTHY,
      runtime: runtimeFacts({ nodeVersion: "v24.0.0" }),
    });
    const belowFloor = runChecks({
      ...HEALTHY,
      runtime: runtimeFacts({ nodeVersion: "v23.11.0" }),
    });

    expect([
      fingerprint(outcomeOf(atFloor, CheckId.NodeVersion)),
      fingerprint(outcomeOf(belowFloor, CheckId.NodeVersion)),
    ]).toStrictEqual([
      CheckStatus.Passed,
      `${CheckStatus.Failed} ${HealthCode.RuntimeUnsupported}`,
    ]);
  });

  it("accepts the top of the range and refuses the exclusive ceiling", () => {
    const atTop = runChecks({
      ...HEALTHY,
      runtime: runtimeFacts({ nodeVersion: "v24.999.999" }),
    });
    const atCeiling = runChecks({
      ...HEALTHY,
      runtime: runtimeFacts({ nodeVersion: "v25.0.0" }),
    });

    expect([
      fingerprint(outcomeOf(atTop, CheckId.NodeVersion)),
      fingerprint(outcomeOf(atCeiling, CheckId.NodeVersion)),
    ]).toStrictEqual([
      CheckStatus.Passed,
      `${CheckStatus.Failed} ${HealthCode.RuntimeUnsupported}`,
    ]);
  });

  it("warns on a runtime it cannot read, rather than assuming it is fine", () => {
    const report = runChecks({
      ...HEALTHY,
      runtime: runtimeFacts({ nodeVersion: "v-next" }),
    });

    // "I could not read the version" is neither a pass nor a failure. Treating it as supported blesses a runtime we
    // never measured; treating it as unsupported refuses work on the strength of an unanswered question. It warns,
    // which is visible and does not block — and it carries its own code, because the reader's next step differs from
    // the step for a measured mismatch.
    expect(outcomeOf(report, CheckId.NodeVersion)).toMatchObject({
      status: CheckStatus.Warned,
      finding: { code: HealthCode.RuntimeUnknown },
    });
    expect(isBlocked(report)).toBe(false);
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

describe("the package-manager ladder", () => {
  it("reports the first applicable rung, not every rung that could be reached", () => {
    // A manager whose binary is missing *and* whose dependencies were never installed. Both are true, and only the
    // first is useful: telling someone to install dependencies with a tool they do not have is advice they cannot act
    // on. The ladder order is the fix order.
    const report = runChecks({
      ...HEALTHY,
      packageManager: managerFacts({
        executable: { resolved: false },
        installState: "absent",
      }),
    });

    expect(outcomeOf(report, CheckId.PackageManager)).toMatchObject({
      finding: { code: HealthCode.PackageManagerExecutableMissing },
    });
  });

  it("does not report a version it chose not to read", () => {
    // `not-probed` means nobody asked, or the platform needs a shell we refuse to enable. It is not a defect, and
    // reporting it as "unverified" would teach readers to ignore the code that does matter.
    const report = runChecks({
      ...HEALTHY,
      packageManager: managerFacts({
        executable: { resolved: true, reason: "not-probed" },
        required: {
          range: ">=9.1.0 <10.0.0",
          origin: "package.json#engines.npm",
        },
      }),
    });

    expect(outcomeOf(report, CheckId.PackageManager)?.status).toBe(
      CheckStatus.Passed,
    );
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
      runtime: runtimeFacts({ nodeVersion: "v23.11.0" }),
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
 *
 * The package-manager group is ordered as the ladder is ordered — identification, agreement, tooling, version,
 * installation — because that is the order in which a rung becomes reachable. Reading down the list is reading the
 * check. The configuration group is the same idea across two checks: location first, then the validity that can only be
 * asked once something was located.
 */
const CASES: Record<string, Case> = {
  // runtime compatibility — what QAT itself requires
  "runtime.node-version.supported": {
    check: CheckId.NodeVersion,
    facts: HEALTHY,
    status: CheckStatus.Passed,
  },
  "runtime.node-version.below-floor": {
    check: CheckId.NodeVersion,
    facts: { ...HEALTHY, runtime: runtimeFacts({ nodeVersion: "v23.11.0" }) },
    status: CheckStatus.Failed,
    code: HealthCode.RuntimeUnsupported,
  },
  "runtime.node-version.above-ceiling": {
    check: CheckId.NodeVersion,
    facts: { ...HEALTHY, runtime: runtimeFacts({ nodeVersion: "v25.0.0" }) },
    status: CheckStatus.Failed,
    code: HealthCode.RuntimeUnsupported,
  },
  "runtime.node-version.between-lines": {
    check: CheckId.NodeVersion,
    // A declared policy with a gap: 24.4.0 is inside the span but matches neither alternative. Distinct from "too old"
    // and "too new" because neither upgrade nor downgrade is the answer — the reader has to move onto a supported line.
    facts: {
      ...HEALTHY,
      runtime: runtimeFacts({
        required: {
          range: "<24.0.0 || >=26.0.0",
          origin: "package.json#engines.node",
        },
      }),
    },
    status: CheckStatus.Failed,
    code: HealthCode.RuntimeUnsupported,
  },
  "runtime.node-version.pre-release": {
    check: CheckId.NodeVersion,
    // A release candidate does not inherit the stable line's support: no comparator names a pre-release of 24.0.0.
    facts: {
      ...HEALTHY,
      runtime: runtimeFacts({ nodeVersion: "v24.0.0-rc.1" }),
    },
    status: CheckStatus.Failed,
    code: HealthCode.RuntimeUnsupported,
  },
  "runtime.node-version.version-unreadable": {
    check: CheckId.NodeVersion,
    facts: { ...HEALTHY, runtime: runtimeFacts({ nodeVersion: "v-next" }) },
    status: CheckStatus.Warned,
    code: HealthCode.RuntimeUnknown,
  },
  "runtime.node-version.policy-unreadable": {
    check: CheckId.NodeVersion,
    // The empty range is exactly what a broken installation produces. Reported, never replaced with a default.
    facts: {
      ...HEALTHY,
      runtime: runtimeFacts({
        required: { range: "", origin: "package.json#engines.node" },
      }),
    },
    status: CheckStatus.Warned,
    code: HealthCode.RuntimeUnknown,
  },

  // runtime compatibility — what the project's framework requires
  "cypress.runtime-supported.satisfied": {
    check: CheckId.CypressRuntimeSupported,
    facts: {
      ...HEALTHY,
      runtime: runtimeFacts({
        frameworkRequired: {
          range: ">=22.0.0 <25.0.0",
          origin: "cypress runtime requirement",
        },
      }),
    },
    status: CheckStatus.Passed,
  },
  "cypress.runtime-supported.unsatisfied": {
    check: CheckId.CypressRuntimeSupported,
    facts: {
      ...HEALTHY,
      runtime: runtimeFacts({
        frameworkRequired: {
          range: ">=22.0.0 <24.0.0",
          origin: "cypress runtime requirement",
        },
      }),
    },
    // Advisory, so `warned` and not `failed`: the runner reserves `failed` for error-severity checks, and a
    // dependency's metadata must not veto a run over a bound QAT neither controls nor verifies.
    status: CheckStatus.Warned,
    code: HealthCode.FrameworkRuntimeUnsupported,
  },
  "cypress.runtime-supported.not-declared": {
    check: CheckId.CypressRuntimeSupported,
    facts: HEALTHY,
    // Nothing declared means nothing to violate. A warning here would fabricate an advisory from an absence, which is
    // how people learn to ignore advisories.
    status: CheckStatus.Passed,
  },
  "cypress.runtime-supported.version-unreadable": {
    check: CheckId.CypressRuntimeSupported,
    facts: {
      ...HEALTHY,
      runtime: runtimeFacts({
        nodeVersion: "v-next",
        frameworkRequired: {
          range: ">=22.0.0 <25.0.0",
          origin: "cypress runtime requirement",
        },
      }),
    },
    status: CheckStatus.Warned,
    code: HealthCode.FrameworkRuntimeUnsupported,
  },

  // package manager — identification
  "environment.package-manager.declared": {
    check: CheckId.PackageManager,
    facts: HEALTHY,
    status: CheckStatus.Passed,
  },
  "environment.package-manager.inferred": {
    check: CheckId.PackageManager,
    facts: {
      ...HEALTHY,
      packageManager: managerFacts({
        selection: { status: "identified", name: "npm", declared: false },
      }),
    },
    // Inferred from a lockfile is a pass: the evidence is weaker than a declaration, but the answer is the same one a
    // reader needs.
    status: CheckStatus.Passed,
  },
  "environment.package-manager.none": {
    check: CheckId.PackageManager,
    facts: {
      ...HEALTHY,
      packageManager: managerFacts({
        selection: { status: "undeclared" },
        lockfiles: [],
        installState: "unknown",
      }),
    },
    status: CheckStatus.Warned,
    code: HealthCode.PackageManagerUnknown,
  },
  "environment.package-manager.declaration-invalid": {
    check: CheckId.PackageManager,
    facts: {
      ...HEALTHY,
      packageManager: managerFacts({
        selection: {
          status: "undeclared",
          declaration: { raw: "npm", problem: "missing-version" },
        },
        lockfiles: [],
        installState: "unknown",
      }),
    },
    // Distinct from `none`: the project tried to declare its tool, so the message quotes what the reader wrote and the
    // fix is one field rather than a decision.
    status: CheckStatus.Warned,
    code: HealthCode.PackageManagerDeclarationInvalid,
  },
  "environment.package-manager.unsupported": {
    check: CheckId.PackageManager,
    facts: {
      ...HEALTHY,
      packageManager: managerFacts({
        selection: { status: "unsupported", name: "bun" },
        lockfiles: ["bun.lockb"],
      }),
    },
    // Identified, not unidentified. Saying "no manager found" to a Bun user sends them looking for a file that is
    // present.
    status: CheckStatus.Warned,
    code: HealthCode.PackageManagerUnsupported,
  },

  // package manager — agreement
  "environment.package-manager.conflicting": {
    check: CheckId.PackageManager,
    facts: {
      ...HEALTHY,
      packageManager: managerFacts({
        selection: {
          status: "conflicting",
          managers: ["npm", "pnpm"],
          lockfiles: ["package-lock.json", "pnpm-lock.yaml"],
        },
        lockfiles: ["package-lock.json", "pnpm-lock.yaml"],
      }),
    },
    // Reported before anything about the tool, because with two candidates "is pnpm installed" is true and irrelevant.
    status: CheckStatus.Warned,
    code: HealthCode.PackageManagerConflicting,
  },

  // package manager — tooling
  "environment.package-manager.executable-missing": {
    check: CheckId.PackageManager,
    facts: {
      ...HEALTHY,
      packageManager: managerFacts({ executable: { resolved: false } }),
    },
    status: CheckStatus.Warned,
    code: HealthCode.PackageManagerExecutableMissing,
  },

  // package manager — version
  "environment.package-manager.version-mismatch": {
    check: CheckId.PackageManager,
    facts: {
      ...HEALTHY,
      packageManager: managerFacts({
        executable: { resolved: true, version: "9.0.9" },
        required: {
          range: ">=9.1.0 <10.0.0",
          origin: "package.json#engines.npm",
        },
      }),
    },
    status: CheckStatus.Warned,
    code: HealthCode.PackageManagerVersionMismatch,
  },
  "environment.package-manager.version-unverified": {
    check: CheckId.PackageManager,
    facts: {
      ...HEALTHY,
      packageManager: managerFacts({
        executable: { resolved: true, reason: "timeout" },
        required: {
          range: ">=9.1.0 <10.0.0",
          origin: "package.json#engines.npm",
        },
      }),
    },
    // A version was expected and the binary would not answer. Reported rather than passed: an unread comparison is not
    // an agreement.
    status: CheckStatus.Warned,
    code: HealthCode.PackageManagerVersionUnverified,
  },

  // package manager — installation
  "environment.package-manager.not-installed": {
    check: CheckId.PackageManager,
    facts: {
      ...HEALTHY,
      packageManager: managerFacts({ installState: "absent" }),
    },
    status: CheckStatus.Warned,
    code: HealthCode.PackageManagerNotInstalled,
  },
  "environment.package-manager.foreign-install": {
    check: CheckId.PackageManager,
    facts: {
      ...HEALTHY,
      packageManager: managerFacts({
        installState: "foreign",
        foreignMarker: {
          marker: "node_modules/.package-lock.json",
          createdBy: "npm",
        },
      }),
    },
    // Everything looks installed, so this is the case that would otherwise surface much later as a resolution error
    // naming a package nobody edited.
    status: CheckStatus.Warned,
    code: HealthCode.PackageManagerForeignInstall,
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

  // cypress configuration — location
  //
  // Thirteen reasons, each with its own remedy, which is why they are thirteen cases and not one "configuration
  // problem". The code is part of every expectation: with no evidence bag on a finding, the code *is* the detail.
  "cypress.configuration-located.found": {
    check: CheckId.CypressConfigurationLocated,
    facts: HEALTHY,
    status: CheckStatus.Passed,
  },
  "cypress.configuration-located.missing": {
    check: CheckId.CypressConfigurationLocated,
    facts: {
      ...HEALTHY,
      cypressConfiguration: decided(MISSING, VALIDATION_SKIPPED),
    },
    status: CheckStatus.Failed,
    code: HealthCode.CypressConfigurationMissing,
  },
  "cypress.configuration-located.ambiguous": {
    check: CheckId.CypressConfigurationLocated,
    facts: {
      ...HEALTHY,
      cypressConfiguration: decided(AMBIGUOUS, VALIDATION_SKIPPED),
    },
    // Two files is an error, not a warning: Cypress refuses to start, so a warning would contradict the tool.
    status: CheckStatus.Failed,
    code: HealthCode.CypressConfigurationAmbiguous,
  },
  "cypress.configuration-located.unsupported-name": {
    check: CheckId.CypressConfigurationLocated,
    facts: {
      ...HEALTHY,
      cypressConfiguration: decided(UNSUPPORTED_NAME, VALIDATION_SKIPPED),
    },
    status: CheckStatus.Failed,
    code: HealthCode.CypressConfigurationUnsupportedFormat,
  },
  "cypress.configuration-located.misplaced": {
    check: CheckId.CypressConfigurationLocated,
    facts: {
      ...HEALTHY,
      cypressConfiguration: decided(MISPLACED, VALIDATION_SKIPPED),
    },
    // Advisory: the fix is to move a file, and a project mid-migration still runs.
    status: CheckStatus.Warned,
    code: HealthCode.CypressConfigurationMisplaced,
  },
  "cypress.configuration-located.path-occupied": {
    check: CheckId.CypressConfigurationLocated,
    facts: {
      ...HEALTHY,
      cypressConfiguration: decided(PATH_OCCUPIED, VALIDATION_SKIPPED),
    },
    // The one fact that turns a baffling "no configuration found" into something a reader can act on.
    status: CheckStatus.Failed,
    code: HealthCode.CypressConfigurationPathNotAFile,
  },
  "cypress.configuration-located.not-a-file": {
    check: CheckId.CypressConfigurationLocated,
    facts: {
      ...HEALTHY,
      cypressConfiguration: decided(NOT_A_FILE, VALIDATION_SKIPPED),
    },
    // A different filesystem situation from the case above and the same code, because both end in "put a regular file
    // there".
    status: CheckStatus.Failed,
    code: HealthCode.CypressConfigurationPathNotAFile,
  },
  "cypress.configuration-located.outside-project": {
    check: CheckId.CypressConfigurationLocated,
    facts: {
      ...HEALTHY,
      cypressConfiguration: decided(OUTSIDE_PROJECT, VALIDATION_SKIPPED),
    },
    // A boundary, not a preference: a file outside the project does not describe this project.
    status: CheckStatus.Failed,
    code: HealthCode.CypressConfigurationOutsideProject,
  },
  "cypress.configuration-located.unreadable": {
    check: CheckId.CypressConfigurationLocated,
    facts: {
      ...HEALTHY,
      cypressConfiguration: decided(UNREADABLE, VALIDATION_SKIPPED),
    },
    // Not "missing": the file is there, so telling the reader to create one would be actively misleading.
    status: CheckStatus.Failed,
    code: HealthCode.CypressConfigurationUnreadable,
  },
  "cypress.configuration-located.empty": {
    check: CheckId.CypressConfigurationLocated,
    facts: {
      ...HEALTHY,
      cypressConfiguration: decided(EMPTY, VALIDATION_SKIPPED),
    },
    status: CheckStatus.Failed,
    code: HealthCode.CypressConfigurationEmpty,
  },
  "cypress.configuration-located.legacy-format": {
    check: CheckId.CypressConfigurationLocated,
    facts: {
      ...HEALTHY,
      cypressConfiguration: decided(LEGACY, VALIDATION_SKIPPED),
    },
    // Detected, readable and valid for its era. Failing it would fail a project that runs today.
    status: CheckStatus.Warned,
    code: HealthCode.CypressConfigurationLegacyFormat,
  },
  "cypress.configuration-located.not-inspected": {
    check: CheckId.CypressConfigurationLocated,
    facts: {
      ...HEALTHY,
      cypressConfiguration: decided(NOT_INSPECTED, VALIDATION_SKIPPED),
    },
    // A question we could not answer: never a pass, because silence must not read as consent.
    status: CheckStatus.Warned,
    code: HealthCode.CypressConfigurationNotInspected,
  },
  "cypress.configuration-located.not-applicable": {
    check: CheckId.CypressConfigurationLocated,
    facts: {
      ...HEALTHY,
      cypressConfiguration: decided(NOT_APPLICABLE, VALIDATION_SKIPPED),
    },
    // Normally unreachable — the precondition skips a non-Cypress project first — and asserted anyway, because a runner
    // that could not skip must still get a pass rather than a finding about a file nobody expected.
    status: CheckStatus.Passed,
  },

  // cypress configuration — validity
  //
  // Two codes and eleven cases: one per terminal outcome, plus one per gap cause. The gaps are the interesting half —
  // "not validated" is a legitimate result and would otherwise be the branch nobody proves.
  "cypress.configuration-validatable.validated-json": {
    check: CheckId.CypressConfigurationValidatable,
    facts: {
      ...HEALTHY,
      cypressConfiguration: decided(LOCATED, VALIDATED_JSON),
    },
    // A parser is definitive about syntax, so this is a pass with the strongest available authority behind it.
    status: CheckStatus.Passed,
  },
  "cypress.configuration-validatable.validated-loader": {
    check: CheckId.CypressConfigurationValidatable,
    facts: {
      ...HEALTHY,
      cypressConfiguration: decided(LOCATED, VALIDATED_LOADER),
    },
    status: CheckStatus.Passed,
  },
  "cypress.configuration-validatable.invalid-syntax": {
    check: CheckId.CypressConfigurationValidatable,
    facts: {
      ...HEALTHY,
      cypressConfiguration: decided(LOCATED, INVALID_SYNTAX),
    },
    status: CheckStatus.Failed,
    code: HealthCode.CypressConfigurationInvalid,
  },
  "cypress.configuration-validatable.invalid-shape": {
    check: CheckId.CypressConfigurationValidatable,
    facts: {
      ...HEALTHY,
      cypressConfiguration: decided(LOCATED, INVALID_SHAPE),
    },
    // A shape problem is not a syntax problem: the file parses and is still unusable, and the remedy is different.
    status: CheckStatus.Failed,
    code: HealthCode.CypressConfigurationInvalid,
  },
  "cypress.configuration-validatable.invalid-load": {
    check: CheckId.CypressConfigurationValidatable,
    facts: {
      ...HEALTHY,
      cypressConfiguration: decided(LOCATED, INVALID_LOAD),
    },
    // The only case where the authority is the project's own loader rather than a parser.
    status: CheckStatus.Failed,
    code: HealthCode.CypressConfigurationInvalid,
  },
  "cypress.configuration-validatable.not-validated-deep-disabled": {
    check: CheckId.CypressConfigurationValidatable,
    facts: {
      ...HEALTHY,
      cypressConfiguration: decided(LOCATED, gap("deep-validation-disabled")),
    },
    // A warning rather than a pass, even though deep validation being off is the default: a green check would claim a
    // verification that never ran.
    status: CheckStatus.Warned,
    code: HealthCode.CypressConfigurationUnverified,
  },
  "cypress.configuration-validatable.not-validated-deep-unavailable": {
    check: CheckId.CypressConfigurationValidatable,
    facts: {
      ...HEALTHY,
      cypressConfiguration: decided(
        LOCATED,
        gap("deep-validation-unavailable"),
      ),
    },
    status: CheckStatus.Warned,
    code: HealthCode.CypressConfigurationUnverified,
  },
  "cypress.configuration-validatable.not-validated-probe-timeout": {
    check: CheckId.CypressConfigurationValidatable,
    facts: {
      ...HEALTHY,
      cypressConfiguration: decided(LOCATED, gap("probe-timeout")),
    },
    // An exhausted budget proves nothing about the file. Reporting it as invalid would blame the user for our own bound.
    status: CheckStatus.Warned,
    code: HealthCode.CypressConfigurationUnverified,
  },
  "cypress.configuration-validatable.not-validated-undecodable": {
    check: CheckId.CypressConfigurationValidatable,
    facts: {
      ...HEALTHY,
      cypressConfiguration: decided(LOCATED, gap("undecodable-text")),
    },
    status: CheckStatus.Warned,
    code: HealthCode.CypressConfigurationUnverified,
  },
  "cypress.configuration-validatable.not-validated-size-budget": {
    check: CheckId.CypressConfigurationValidatable,
    facts: {
      ...HEALTHY,
      cypressConfiguration: decided(LOCATED, gap("size-budget-exceeded")),
    },
    // Nothing was read at all, so no tier spoke — which is why this gap carries `none` rather than `T0-text`.
    status: CheckStatus.Warned,
    code: HealthCode.CypressConfigurationUnverified,
  },
  "cypress.configuration-validatable.not-validated-text-sanity": {
    check: CheckId.CypressConfigurationValidatable,
    facts: {
      ...HEALTHY,
      cypressConfiguration: decided(
        LOCATED,
        gap("text-sanity-not-established"),
      ),
    },
    status: CheckStatus.Warned,
    code: HealthCode.CypressConfigurationUnverified,
  },

  // cypress layout
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
