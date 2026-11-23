import { describe, expect, it } from "vitest";

import { exitCodeFor, reportLines } from "~/cli/output/diagnostics.js";
import {
  DiagnosticCode,
  DiagnosticSeverity,
  type DiagnosticFinding,
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
import { ExitCode } from "~/core/errors/index.js";

/**
 * The report shape, from values.
 *
 * No CLI and no temporary directory: the presenter is a function over an assessment, so every line it can produce is
 * reachable from a literal. The command's orchestration is covered end to end in `tests/e2e/doctor.test.ts`; this file
 * is where the format lives, and where a change to it is cheapest to make and to review.
 *
 * The expected lines are written out with their spacing rather than computed from the same expression the
 * implementation uses. A `padEnd(10)` on both sides of an assertion proves only that the two agree, which they will
 * even when the column is wrong.
 *
 * ## Two finding shapes, because there are two vocabularies
 *
 * `DiagnosticFinding` carries the codes **detection** can report, and it is what a diagnosis holds.
 * `AnyDiagnosticFinding` widens that to include validation's codes, and it is what a gate holds. A diagnosis cannot
 * contain a `QAT-V` code — validation is what adds those — so the fixtures below keep the two apart rather than
 * widening everything to the union and losing the distinction the contract is making.
 */

/** A finding as a gate carries it: either vocabulary. */
function finding(
  overrides: Partial<AnyDiagnosticFinding> = {},
): AnyDiagnosticFinding {
  return {
    code: DiagnosticCode.DependencyNotInstalled,
    severity: DiagnosticSeverity.Error,
    explanation: "Cypress is declared in devDependencies but is not installed.",
    ...overrides,
  };
}

/** A finding as a diagnosis carries it: detection codes only. */
function detectionFinding(
  overrides: Partial<DiagnosticFinding> = {},
): DiagnosticFinding {
  return {
    code: DiagnosticCode.DependencyNotInstalled,
    severity: DiagnosticSeverity.Error,
    explanation: "Cypress is declared in devDependencies but is not installed.",
    ...overrides,
  };
}

function diagnosis(
  overrides: Partial<ProjectDiagnosis> = {},
): ProjectDiagnosis {
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
    ...overrides,
  };
}

/**
 * An assessment whose gates agree with its findings, per operation.
 *
 * The readiness derivation is duplicated from the service, and the duplication is the point: the two operations do not
 * share a verdict, so a fixture that gave both gates the same one would let a presenter read the wrong gate and still
 * pass. Inspection is never blocked; execution is blocked by any error. That is the whole design, and a fixture that
 * flattened it would test the presenter against a world the service never produces.
 *
 * The cost is one place that can drift from `buildGates`. The assertion at the end of the exit-status block is what
 * catches it, and it is why that case exists rather than being folded into the one above it.
 */
function assessment(
  options: {
    readonly blocking?: readonly AnyDiagnosticFinding[];
    readonly warnings?: readonly AnyDiagnosticFinding[];
    readonly diagnosis?: ProjectDiagnosis;
  } = {},
): ProjectAssessment {
  const blocking = options.blocking ?? [];
  const warnings = options.warnings ?? [];

  const readinessFor = (operation: QatOperation): OperationReadiness => {
    if (operation === QatOperation.Inspect) {
      return blocking.length > 0 || warnings.length > 0
        ? OperationReadiness.ReadyWithWarnings
        : OperationReadiness.Ready;
    }

    if (blocking.length > 0) return OperationReadiness.Blocked;

    return warnings.length > 0
      ? OperationReadiness.ReadyWithWarnings
      : OperationReadiness.Ready;
  };

  const gate = (operation: QatOperation): OperationGate => ({
    operation,
    readiness: readinessFor(operation),
    blocking,
    warnings,
  });

  return {
    diagnosis: options.diagnosis ?? diagnosis(),
    findings: [],
    requirements: [],
    gates: {
      [QatOperation.Inspect]: gate(QatOperation.Inspect),
      [QatOperation.Execute]: gate(QatOperation.Execute),
    },
  };
}

describe("the summary", () => {
  it("states identity, framework, statuses and the verdict, in that order", () => {
    // Nine labels, each padded to ten columns and followed by one space. Written out rather than computed, so a change
    // to the column width or to a label's length shows up here as a diff rather than as two expressions that agree.
    expect(reportLines(assessment())).toStrictEqual([
      "project    demo",
      "root       /project",
      "package    present",
      "framework  cypress 13.15.0 (project install)",
      "declared   devDependencies (^13.15.0)",
      "config     cypress.config.ts",
      "detection  detected",
      "compatibility consistent",
      "result     ready",
    ]);
  });

  it("aligns short labels in one column and lets a long one take a single space", () => {
    const lines = reportLines(assessment());

    // Eleven is the column: ten for the label plus one separating space. `compatibility` is three characters wider
    // than the column, so its value starts four columns later — the documented behaviour of a computed pad, and the
    // reason adding a longer label cannot misalign the twelve beside it.
    expect(lines[0]?.indexOf("demo")).toBe(11);
    expect(lines[5]?.indexOf("cypress.config.ts")).toBe(11);
    expect(lines[7]?.indexOf("consistent")).toBe(14);
  });

  it("says what is absent rather than printing nothing", () => {
    const value = assessment({
      diagnosis: diagnosis({
        framework: {
          configurationsFound: [],
          unsupportedConfigurations: [],
          binaryAvailable: undefined,
        },
      }),
    });

    const lines = reportLines(value);

    // A line that disappears makes "no installation" indistinguishable from "not reported", which is the failure the
    // diagnosis itself was shaped to avoid.
    expect(lines).toContain("framework  cypress (not installed)");
    expect(lines).toContain("declared   nowhere in this package");
    expect(lines).toContain("config     (none)");
  });

  it("reports the readiness the gate carries, not a readiness it computes", () => {
    const lines = reportLines(
      assessment({
        warnings: [finding({ severity: DiagnosticSeverity.Warning })],
      }),
    );

    // The distinction matters: the presenter must not decide anything, so it prints what the gate concluded. A
    // presenter that recomputed this would agree today and diverge the moment a rule changed.
    expect(lines).toContain("result     ready-with-warnings");
  });

  it("prints the metadata status rather than a version", () => {
    const lines = reportLines(
      assessment({
        diagnosis: diagnosis({
          identity: { ...diagnosis().identity, packageMetadata: "incomplete" },
        }),
      }),
    );

    expect(lines).toContain("package    incomplete");
    expect(lines).not.toContain("demo@1.0.0");
  });
});

describe("the findings", () => {
  const misplaced = finding({
    code: ValidationCode.ConfigurationMisplaced,
    explanation:
      "A Cypress configuration was found at cypress/cypress.config.ts, where Cypress does not load it.",
    path: "cypress/cypress.config.ts",
    remediation: "Move it to the project root as cypress.config.ts.",
  });

  it("prints one block per condition, with its file and its fix", () => {
    const lines = reportLines(assessment({ blocking: [misplaced] }));

    // The block starts after the nine summary lines and one separator, so index 10. Asserted positionally, because a
    // report whose findings appear above the verdict is a different report.
    expect(lines.slice(10)).toStrictEqual([
      "QAT-V001 error",
      "  A Cypress configuration was found at cypress/cypress.config.ts, where Cypress does not load it.",
      "  at:  cypress/cypress.config.ts",
      "  fix: Move it to the project root as cypress.config.ts.",
    ]);
    expect(lines[9]).toBe("");
  });

  it("omits the file and the fix when there are none", () => {
    const lines = reportLines(assessment({ blocking: [finding()] }));

    // Two lines, not four with empty values. A consumer parsing this should be able to tell "no file" from "a file with
    // an unhelpful name".
    expect(lines.slice(-2)).toStrictEqual([
      "QAT-D005 error",
      "  Cypress is declared in devDependencies but is not installed.",
    ]);
  });

  it("prints the code and the severity on one line, code first", () => {
    const [first] = reportLines(assessment({ blocking: [misplaced] })).slice(
      10,
    );

    // The code is what a reader quotes and what a script greps for; the severity is what tells them whether to keep
    // reading. Splitting them across two lines makes one of the two easy to miss.
    expect(first).toBe("QAT-V001 error");
  });

  it("prints blocking conditions before warnings", () => {
    const lines = reportLines(
      assessment({
        blocking: [finding()],
        warnings: [
          finding({
            code: DiagnosticCode.ManifestMissing,
            severity: DiagnosticSeverity.Warning,
          }),
        ],
      }),
    );

    expect(lines.indexOf("QAT-D005 error")).toBeLessThan(
      lines.indexOf("QAT-D010 warning"),
    );
  });

  it("separates the summary from the findings, and each severity group from the next", () => {
    const lines = reportLines(
      assessment({
        blocking: [finding()],
        warnings: [
          finding({
            code: DiagnosticCode.ManifestMissing,
            severity: DiagnosticSeverity.Warning,
          }),
        ],
      }),
    );

    expect(lines.filter((line) => line === "")).toHaveLength(2);
  });

  it("adds no blank line when there is nothing to report", () => {
    // A trailing blank line in a clean report is the kind of thing that ends up in a golden file and then in a diff
    // nobody understands.
    expect(
      reportLines(assessment()).filter((line) => line === ""),
    ).toStrictEqual([]);
    expect(reportLines(assessment()).at(-1)).toBe("result     ready");
  });

  it("reads the gate rather than the diagnosis for what to report", () => {
    const value = assessment();

    // A diagnosis carrying a finding its gate does not list means the two were built inconsistently — the forwarding
    // requirement is what normally puts them in both places. The presenter reads the gate regardless, because the gate
    // is the operation-specific answer: a presenter that walked the diagnosis instead would report a condition the
    // verdict had already accounted for, or miss one it had.
    const withDiagnosisFindings: ProjectAssessment = {
      ...value,
      diagnosis: { ...value.diagnosis, findings: [detectionFinding()] },
    };

    expect(reportLines(withDiagnosisFindings)).toStrictEqual(
      reportLines(value),
    );
  });
});

describe("the exit status", () => {
  it("is success for a ready project", () => {
    expect(exitCodeFor(assessment())).toBe(ExitCode.Success);
  });

  it("is success for a project with warnings only", () => {
    // The decision that keeps the command usable in a pipeline. A tool that fails on advice is a tool people pass
    // `|| true` to, and then it fails on blockers too.
    expect(
      exitCodeFor(
        assessment({
          warnings: [finding({ severity: DiagnosticSeverity.Warning })],
        }),
      ),
    ).toBe(ExitCode.Success);
  });

  it("is invalid input for a blocked project", () => {
    // The project is the problem rather than the machine, so it fails the way every other bad input fails. A script
    // that already branches on `2` keeps working.
    expect(exitCodeFor(assessment({ blocking: [finding()] }))).toBe(
      ExitCode.InvalidInput,
    );
  });

  it("is decided by the execution gate and not by the inspection gate", () => {
    const value = assessment({ blocking: [finding()] });

    // The gates differ only in readiness, and only in one direction. Asserting both sides is what makes the status
    // meaningful: if a presenter or this fixture ever gave the two the same verdict, `exitCodeFor` could read either
    // and pass — and every broken project would be reported as runnable, or none would be reportable at all.
    expect(value.gates[QatOperation.Inspect].readiness).toBe(
      OperationReadiness.ReadyWithWarnings,
    );
    expect(value.gates[QatOperation.Execute].readiness).toBe(
      OperationReadiness.Blocked,
    );
    expect(exitCodeFor(value)).toBe(ExitCode.InvalidInput);
  });
});

describe("non-functional behaviour", () => {
  it("prints no template hole", () => {
    const lines = reportLines(
      assessment({
        blocking: [finding()],
        warnings: [finding({ severity: DiagnosticSeverity.Warning })],
      }),
    );

    for (const line of lines) expect(line).not.toContain("undefined");
  });

  it("prints ASCII only", () => {
    const lines = reportLines(
      assessment({
        blocking: [
          finding({ remediation: "Install it.", path: "node_modules/cypress" }),
        ],
      }),
    );

    // A console on a legacy code page turns an em dash into mojibake, and the reader cannot tell whether the tool broke
    // or their terminal did.
    for (const line of lines) expect(line).toMatch(/^[\x20-\x7E]*$/);
  });

  it("is deterministic", () => {
    const value = assessment({ blocking: [finding()] });

    expect(reportLines(value)).toStrictEqual(reportLines(value));
    expect(exitCodeFor(value)).toBe(exitCodeFor(value));
  });

  it("does not modify the assessment it was given", () => {
    const value = assessment({ blocking: [finding()] });
    const before = structuredClone(value);

    reportLines(value);
    exitCodeFor(value);

    // A presenter that sorted or spliced a gate's arrays would corrupt the value a later consumer reads — the command
    // prints and then reads the same assessment to decide its status, so the damage would change the exit code.
    expect(value).toStrictEqual(before);
  });
});
