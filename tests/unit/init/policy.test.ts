/**
 * Which project conditions stop initialisation.
 *
 * The policy is one allow-list and one filter, so the tests are mostly about the two directions it can fail in:
 *
 * - **Too permissive** — a condition that means "this is not a Cypress project" is allowed through, and `qat init`
 *   writes a configuration into a directory nothing will ever read it from.
 * - **Too strict** — an installation condition blocks, and the tool refuses exactly where it is most useful: a fresh
 *   clone, before `npm ci`.
 *
 * The list is deliberately pinned in a test rather than left to be read from the source. It is four entries of policy,
 * and policy that changes without a failing test is policy nobody reviewed.
 */
import { describe, expect, it } from "vitest";

import {
  DiagnosticCode,
  DiagnosticSeverity,
  type ProjectDiagnosis,
} from "~/core/application/diagnostics.js";
import {
  OperationReadiness,
  QatOperation,
  ValidationCode,
  type AnyDiagnosticFinding,
  type OperationGate,
  type ProjectAssessment,
} from "~/core/application/validation.js";
import { INSTALLATION_ONLY, unusableProjectFindings } from "~/init/policy.js";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/** A finding as a gate carries it: either vocabulary. */
function finding(
  code: AnyDiagnosticFinding["code"],
  overrides: Partial<AnyDiagnosticFinding> = {},
): AnyDiagnosticFinding {
  return {
    code,
    severity: DiagnosticSeverity.Error,
    explanation: "Cypress is declared in devDependencies but is not installed.",
    ...overrides,
  };
}

function diagnosis(): ProjectDiagnosis {
  return {
    identity: {
      root: "/project",
      name: "demo",
      packageMetadata: "present",
      declaredWorkspaces: [],
    },
    framework: {
      declaration: { section: "devDependencies", range: "^13.15.0" },
      installation: {
        framework: "cypress",
        version: "13.15.0",
        source: "project",
      },
      configuration: "cypress.config.ts",
      configurationsFound: ["cypress.config.ts"],
      unsupportedConfigurations: [],
      binaryAvailable: undefined,
    },
    detection: "detected",
    compatibility: "consistent",
    findings: [],
  };
}

/**
 * An assessment with the findings placed where the caller says.
 *
 * Both gates are always built, because the policy's choice of gate is half of what it decides: a fixture with one gate
 * could not tell a policy that read the wrong one from a policy that read the right one.
 */
function assessment(
  options: {
    readonly blocking?: readonly AnyDiagnosticFinding[];
    readonly warnings?: readonly AnyDiagnosticFinding[];
    readonly inspectBlocking?: readonly AnyDiagnosticFinding[];
  } = {},
): ProjectAssessment {
  const blocking = options.blocking ?? [];
  const warnings = options.warnings ?? [];

  const gate = (
    operation: QatOperation,
    gateBlocking: readonly AnyDiagnosticFinding[],
    gateWarnings: readonly AnyDiagnosticFinding[],
  ): OperationGate => ({
    operation,
    readiness:
      gateBlocking.length > 0
        ? OperationReadiness.Blocked
        : gateWarnings.length > 0
          ? OperationReadiness.ReadyWithWarnings
          : OperationReadiness.Ready,
    blocking: gateBlocking,
    warnings: gateWarnings,
  });

  return {
    diagnosis: diagnosis(),
    findings: [],
    requirements: [],
    gates: {
      [QatOperation.Inspect]: gate(
        QatOperation.Inspect,
        options.inspectBlocking ?? [],
        [],
      ),
      [QatOperation.Execute]: gate(QatOperation.Execute, blocking, warnings),
    },
  };
}

/**
 * A code this build has never heard of.
 *
 * Cast rather than fabricated in the type system, because the point is a finding whose code is outside both unions — the
 * shape a new code takes the day it is added upstream and not yet here.
 */
const UNKNOWN_CODE = "QAT-Z999" as unknown as AnyDiagnosticFinding["code"];

/* -------------------------------------------------------------------------- */
/* The allow-list                                                             */
/* -------------------------------------------------------------------------- */

describe("the installation-only allow-list", () => {
  it("names exactly the four conditions that are about the machine", () => {
    // Pinned deliberately. An entry added here silently makes initialisation more permissive, which is the failure
    // direction that produces a configuration file nobody can use.
    expect([...INSTALLATION_ONLY].sort()).toStrictEqual(
      [
        DiagnosticCode.DependencyNotInstalled,
        DiagnosticCode.ManifestMissing,
        DiagnosticCode.ManifestIncomplete,
        DiagnosticCode.DependencyUndeclared,
      ].sort(),
    );
  });

  it("does not excuse any condition about the project itself", () => {
    const aboutTheProject = [
      DiagnosticCode.FrameworkNotDetected,
      DiagnosticCode.ConfigurationMissing,
      DiagnosticCode.ConfigurationAmbiguous,
      DiagnosticCode.ConfigurationUnsupported,
      DiagnosticCode.VersionIncompatible,
      DiagnosticCode.ManifestUnreadable,
      ValidationCode.ConfigurationMisplaced,
    ];

    const excused = aboutTheProject.filter((code) =>
      INSTALLATION_ONLY.has(code),
    );

    // `ManifestUnreadable` is the interesting one: it is about a file on the machine and still blocks, because a
    // manifest that cannot be read means detection cannot be trusted, and configuring such a project hides the real
    // problem behind a second file.
    expect(excused).toStrictEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* What blocks                                                                */
/* -------------------------------------------------------------------------- */

describe("the conditions that stop initialisation", () => {
  it("returns nothing for a project with no blocking findings", () => {
    expect(unusableProjectFindings(assessment())).toStrictEqual([]);
  });

  it.each([
    ["no framework detected", DiagnosticCode.FrameworkNotDetected],
    ["no Cypress configuration", DiagnosticCode.ConfigurationMissing],
    ["two Cypress configurations", DiagnosticCode.ConfigurationAmbiguous],
    [
      "an unreadable configuration format",
      DiagnosticCode.ConfigurationUnsupported,
    ],
    ["an incompatible Cypress version", DiagnosticCode.VersionIncompatible],
    ["an unreadable manifest", DiagnosticCode.ManifestUnreadable],
    [
      "a misplaced Cypress configuration",
      ValidationCode.ConfigurationMisplaced,
    ],
  ])("blocks on %s", (_case, code) => {
    // Seven cases spanning both vocabularies: the policy reads a gate, and a gate carries findings from detection and
    // from validation. A policy that knew only one of the two would look correct for half a project's conditions.
    expect(
      unusableProjectFindings(assessment({ blocking: [finding(code)] })),
    ).toHaveLength(1);
  });

  it("blocks on a code it has never seen", () => {
    // Default-deny. The cost of wrongly refusing is a message a reader can act on; the cost of wrongly accepting is a
    // configuration in a project that cannot use it.
    expect(
      unusableProjectFindings(
        assessment({ blocking: [finding(UNKNOWN_CODE)] }),
      ),
    ).toHaveLength(1);
  });

  it("ignores warnings, however many there are", () => {
    const warnings = [
      finding(DiagnosticCode.ManifestMissing, {
        severity: DiagnosticSeverity.Warning,
      }),
      finding(DiagnosticCode.DependencyUndeclared, {
        severity: DiagnosticSeverity.Warning,
      }),
    ];

    // A project with advice and nothing wrong is a project QAT can configure. Blocking here would make `qat init` fail
    // on a directory that is entirely healthy.
    expect(unusableProjectFindings(assessment({ warnings }))).toStrictEqual([]);
  });

  it("reads the execute gate, not the inspect gate", () => {
    // The two gates answer different questions, and the fixture can put findings only one of them. A policy that read
    // the inspect gate would accept every directory, because that gate is never blocked.
    expect(
      unusableProjectFindings(
        assessment({
          inspectBlocking: [finding(DiagnosticCode.FrameworkNotDetected)],
        }),
      ),
    ).toStrictEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* What is excused                                                            */
/* -------------------------------------------------------------------------- */

describe("the conditions that do not stop initialisation", () => {
  it.each([
    [
      "a dependency that is declared but not installed",
      DiagnosticCode.DependencyNotInstalled,
    ],
    ["a project with no manifest", DiagnosticCode.ManifestMissing],
    ["a manifest with no name", DiagnosticCode.ManifestIncomplete],
    [
      "a dependency installed but undeclared",
      DiagnosticCode.DependencyUndeclared,
    ],
  ])("allows %s", (_case, code) => {
    // The journey this protects: clone, `qat init`, `npm ci`, `qat run`. An initialisation that demanded the install
    // first would be unusable in the moment it is most wanted.
    expect(
      unusableProjectFindings(assessment({ blocking: [finding(code)] })),
    ).toStrictEqual([]);
  });

  it("excuses by code, not by severity", () => {
    // Realistically these arrive as warnings, so this pins the mechanism: the filter reads the code. Were it to read
    // severity instead, a finding promoted upstream to `error` would start blocking initialisation with nothing in this
    // module having changed.
    const promoted = finding(DiagnosticCode.DependencyNotInstalled, {
      severity: DiagnosticSeverity.Error,
    });

    expect(
      unusableProjectFindings(assessment({ blocking: [promoted] })),
    ).toStrictEqual([]);
  });

  it("allows a project whose only blocking finding is excused", () => {
    const mixed = [
      finding(DiagnosticCode.ManifestMissing, {
        severity: DiagnosticSeverity.Warning,
      }),
    ];

    expect(
      unusableProjectFindings(assessment({ blocking: mixed })),
    ).toStrictEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* What comes back                                                            */
/* -------------------------------------------------------------------------- */

describe("the findings that are returned", () => {
  it("keeps the gate's order", () => {
    const blocking = [
      finding(DiagnosticCode.ConfigurationMissing),
      finding(ValidationCode.ConfigurationMisplaced),
      finding(DiagnosticCode.VersionIncompatible),
    ];

    // Order matters because these are rendered: the block a reader sees first should be the condition the gate listed
    // first, not whichever one a filter happened to visit.
    expect(
      unusableProjectFindings(assessment({ blocking })).map((f) => f.code),
    ).toStrictEqual([
      DiagnosticCode.ConfigurationMissing,
      ValidationCode.ConfigurationMisplaced,
      DiagnosticCode.VersionIncompatible,
    ]);
  });

  it("drops the excused findings and leaves the rest in place", () => {
    const blocking = [
      finding(DiagnosticCode.DependencyNotInstalled),
      finding(DiagnosticCode.ConfigurationMissing),
      finding(DiagnosticCode.ManifestMissing, {
        severity: DiagnosticSeverity.Warning,
      }),
      finding(DiagnosticCode.ManifestUnreadable),
    ];

    expect(
      unusableProjectFindings(assessment({ blocking })).map((f) => f.code),
    ).toStrictEqual([
      DiagnosticCode.ConfigurationMissing,
      DiagnosticCode.ManifestUnreadable,
    ]);
  });

  it("carries the sentence, the file and the remedy", () => {
    const blocking = [
      finding(ValidationCode.ConfigurationMisplaced, {
        explanation:
          "A configuration was found where Cypress does not load it.",
        path: "cypress/cypress.config.ts",
        remediation: "Move it to the project root as cypress.config.ts.",
      }),
    ];

    expect(unusableProjectFindings(assessment({ blocking }))).toStrictEqual([
      {
        code: ValidationCode.ConfigurationMisplaced,
        severity: DiagnosticSeverity.Error,
        explanation:
          "A configuration was found where Cypress does not load it.",
        path: "cypress/cypress.config.ts",
        remediation: "Move it to the project root as cypress.config.ts.",
      },
    ]);
  });

  it("omits a file and a remedy rather than carrying them as undefined", () => {
    const [mapped] = unusableProjectFindings(
      assessment({ blocking: [finding(DiagnosticCode.FrameworkNotDetected)] }),
    );

    // With strict optional properties, `path: undefined` and an absent `path` are different values — and a renderer
    // that checks `=== undefined` would work with both, while a renderer walking keys would print a blank `at:` line.
    expect(mapped).toBeDefined();
    expect(mapped !== undefined && "path" in mapped).toBe(false);
    expect(mapped !== undefined && "remediation" in mapped).toBe(false);
  });

  it("always says something", () => {
    const mapped = unusableProjectFindings(
      assessment({
        blocking: [
          finding(DiagnosticCode.ConfigurationMissing),
          finding(ValidationCode.ConfigurationMisplaced),
        ],
      }),
    );

    // A finding with no sentence would render as a bare code, which tells a reader the tool refused and nothing about
    // why. This is cheap to assert and impossible to notice by reading the filter.
    for (const one of mapped) {
      expect(one.code.length).toBeGreaterThan(0);
      expect(one.explanation.trim().length).toBeGreaterThan(0);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Non-functional                                                             */
/* -------------------------------------------------------------------------- */

describe("non-functional behaviour", () => {
  it("does not modify the assessment it was given", () => {
    const value = assessment({
      blocking: [
        finding(DiagnosticCode.DependencyNotInstalled),
        finding(DiagnosticCode.FrameworkNotDetected),
      ],
    });
    const before = structuredClone(value);

    unusableProjectFindings(value);

    // A filter that spliced in place would corrupt the value the command is about to render — the findings printed and
    // the findings that blocked would then be different lists.
    expect(value).toStrictEqual(before);
  });

  it("returns the same answer twice", () => {
    const value = assessment({
      blocking: [finding(DiagnosticCode.ConfigurationMissing)],
    });

    expect(unusableProjectFindings(value)).toStrictEqual(
      unusableProjectFindings(value),
    );
  });

  it("is synchronous", () => {
    // No I/O, no clock: it reads one value and builds another.
    expect(unusableProjectFindings(assessment())).not.toBeInstanceOf(Promise);
  });
});
