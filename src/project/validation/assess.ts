/**
 * The validation service.
 *
 * One call to the detection engine — or none at all, when the caller already has a result — then one pass over
 * the requirement table and one lookup per code in the catalogue.
 *
 * ## No I/O
 *
 * `assessDetection` touches no filesystem. Every fact it uses is already on the detection result, which is
 * what makes the whole rule set testable from a value and what keeps validation from becoming a second place
 * that guesses about a project's shape.
 *
 * ## Two gates, one set of findings
 *
 * The findings do not depend on the operation; only the verdict does. Building the gates is therefore the last
 * step and the only step that knows about operations at all — one place to read when the question is "what
 * stops what".
 */
import {
  DiagnosticSeverity,
  type ProjectDiagnosis,
} from "../../core/application/diagnostics.js";
import {
  OperationReadiness,
  QatOperation,
  RequirementOutcome,
  type AnyDiagnosticFinding,
  type OperationGate,
  type ProjectAssessment,
  type ValidationCode,
  type ValidationFinding,
  type ValidationRequirementResult,
} from "../../core/application/validation.js";
import { DEFAULT_MAX_PARENT_DEPTH } from "../contracts.js";
import { detectCypress } from "../cypress-detection/index.js";
import type { CypressDetection } from "../cypress-detection/index.js";
import {
  diagnosisFrom,
  unreadableProjectDiagnosis,
} from "../diagnostics/index.js";

import { VALIDATION_GUIDANCE, type ValidationFacts } from "./catalogue.js";
import type {
  RequirementVerdict,
  ValidationInput,
  ValidationRequirement,
} from "./contracts.js";
import { classifyLayout } from "./layout-policy.js";
import { REQUIREMENTS } from "./rules.js";

export interface AssessmentOptions {
  /** How far to climb for a hoisted install. Carried through to the engine unchanged. */
  readonly maxDepth?: number;
}

/**
 * Assesses a detection result.
 *
 * Pure and synchronous. Given the same result it returns the same assessment, which is what lets a rule be
 * tested by constructing evidence rather than by constructing a directory.
 */
export function assessDetection(
  detection: CypressDetection,
): ProjectAssessment {
  const diagnosis = diagnosisFrom(detection);

  const input: ValidationInput = {
    detection,
    diagnosis,
    layout: classifyLayout(detection.layout, diagnosis.framework.configuration),
  };

  const facts = factsOf(input);

  const evaluations = REQUIREMENTS.map((requirement) =>
    evaluate(requirement, requirement.evaluate(input), facts),
  );

  // Two lists with two purposes. `raised` is what this layer is the first to notice, and it is what a report
  // presents as validation's own contribution. `all` is everything that applies, and it is what the gates
  // judge — including detection's findings, which arrive through the forwarding requirement and are therefore
  // present here only because a requirement put them there.
  const raised = evaluations.flatMap((evaluation) => evaluation.raised);
  const all = sortBySeverity(
    evaluations.flatMap((evaluation) => evaluation.all),
  );

  return {
    diagnosis,
    findings: raised,
    requirements: evaluations.map((evaluation) => evaluation.result),
    gates: buildGates(all),
  };
}

/**
 * Assesses a project on disk.
 *
 * Never throws for an unfavourable answer. The one condition detection refuses to classify — a manifest that
 * does not parse — becomes an assessment that blocks execution, so a command asking "may I run" receives an
 * answer naming the file rather than an exception it has to translate.
 */
export async function assessProject(
  root: string,
  options: AssessmentOptions = {},
): Promise<ProjectAssessment> {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_PARENT_DEPTH;

  try {
    return assessDetection(await detectCypress(root, { maxDepth }));
  } catch (error) {
    // Nothing was gather-able, so no requirement can be evaluated. The diagnosis is the whole answer, and its
    // findings are the only ones there are.
    return assessmentWithoutEvidence(unreadableProjectDiagnosis(root, error));
  }
}

interface Evaluation {
  readonly result: ValidationRequirementResult;
  /** Conditions this layer noticed. */
  readonly raised: readonly ValidationFinding[];
  /** Everything the requirement contributed, raised and forwarded together. */
  readonly all: readonly AnyDiagnosticFinding[];
}

function evaluate(
  requirement: ValidationRequirement,
  verdict: RequirementVerdict,
  facts: ValidationFacts,
): Evaluation {
  const raised = (verdict.codes ?? []).map((code) => render(code, facts));
  const all: readonly AnyDiagnosticFinding[] = [
    ...(verdict.findings ?? []),
    ...raised,
  ];

  return {
    result: {
      requirement: requirement.id,
      summary: requirement.summary,
      outcome: outcomeOf(all),
      codes: all.map((finding) => finding.code),
    },
    raised,
    all,
  };
}

/**
 * A conclusion from the findings, not from the verdict.
 *
 * Derived rather than declared so a requirement cannot call itself satisfied while returning an error, which
 * is the kind of contradiction a table of hand-written outcomes invites.
 */
function outcomeOf(
  findings: readonly AnyDiagnosticFinding[],
): RequirementOutcome {
  if (
    findings.some((finding) => finding.severity === DiagnosticSeverity.Error)
  ) {
    return RequirementOutcome.Violated;
  }

  return findings.length > 0
    ? RequirementOutcome.Warning
    : RequirementOutcome.Satisfied;
}

/** Renders one code through the catalogue. The only place prose meets a code in this layer. */
function render(
  code: ValidationCode,
  facts: ValidationFacts,
): ValidationFinding {
  const guidance = VALIDATION_GUIDANCE[code];
  const text = guidance.describe(facts);

  return {
    code,
    severity: guidance.severity,
    explanation: text.explanation,
    ...(text.remediation === undefined
      ? {}
      : { remediation: text.remediation }),
    ...(text.path === undefined ? {} : { path: text.path }),
  };
}

/** The fact set the catalogue entries describe themselves from. Computed once per assessment. */
function factsOf({ diagnosis, detection }: ValidationInput): ValidationFacts {
  const { framework, identity } = diagnosis;
  const { layout } = detection;

  return {
    root: identity.root,
    declaredWorkspaces: identity.declaredWorkspaces,
    ...(framework.installation === undefined
      ? {}
      : { installedVersion: framework.installation.version }),
    ...(framework.configuration === undefined
      ? {}
      : { configuration: framework.configuration }),
    misplacedConfigurations: layout.misplacedConfigurations,
    occupiedConfigurationPaths: layout.occupiedConfigurationPaths,
    specDirectories: layout.specDirectories,
    ...(layout.componentDirectory === undefined
      ? {}
      : { componentDirectory: layout.componentDirectory }),
    unsupportedConfigurations: framework.unsupportedConfigurations,
  };
}

/**
 * One gate per operation.
 *
 * The only function that knows what an operation means. `inspect` reports, so it is never blocked;
 * `execute` acts, so any error stops it. A caller reading a gate never needs to know which of those rules
 * produced the answer.
 */
function buildGates(
  findings: readonly AnyDiagnosticFinding[],
): Readonly<Record<QatOperation, OperationGate>> {
  const blocking = findings.filter(
    (finding) => finding.severity === DiagnosticSeverity.Error,
  );
  const warnings = findings.filter(
    (finding) => finding.severity === DiagnosticSeverity.Warning,
  );

  function readiness(operation: QatOperation): OperationReadiness {
    if (operation === QatOperation.Inspect) {
      // Never blocked: surfacing the blockers is the operation. The findings are still listed, because an
      // inspection that hid them would have nothing to report.
      return findings.length === 0
        ? OperationReadiness.Ready
        : OperationReadiness.ReadyWithWarnings;
    }

    if (blocking.length > 0) return OperationReadiness.Blocked;

    return warnings.length > 0
      ? OperationReadiness.ReadyWithWarnings
      : OperationReadiness.Ready;
  }

  function gate(operation: QatOperation): OperationGate {
    return { operation, readiness: readiness(operation), blocking, warnings };
  }

  return {
    [QatOperation.Inspect]: gate(QatOperation.Inspect),
    [QatOperation.Execute]: gate(QatOperation.Execute),
  };
}

/**
 * Errors first, warnings next, observations last, otherwise untouched.
 *
 * `Array.prototype.sort` is stable, so within a severity the requirement order survives — which is what makes
 * the first blocking finding the most fundamental problem rather than an arbitrary one.
 *
 * The third entry is not decoration. A two-entry table compares an informational finding against `undefined`, and
 * `NaN` in a comparator is unspecified behaviour — in practice it moves the element to the front, which is the one
 * position a reader looks for something that stops a run. `Record<DiagnosticSeverity, number>` is what makes the
 * omission a compile error instead of a sort that is quietly wrong.
 */
const SEVERITY_RANK: Readonly<Record<DiagnosticSeverity, number>> = {
  [DiagnosticSeverity.Error]: 0,
  [DiagnosticSeverity.Warning]: 1,
  [DiagnosticSeverity.Information]: 2,
};

function sortBySeverity(
  findings: readonly AnyDiagnosticFinding[],
): readonly AnyDiagnosticFinding[] {
  return [...findings].sort(
    (left, right) =>
      SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity],
  );
}

/**
 * The assessment for a project whose description could not be read.
 *
 * No requirements are listed, because none ran: there was no evidence to judge. The diagnosis's findings are
 * the whole answer, and they gate execution exactly as they would have if the forwarding requirement had run.
 */
function assessmentWithoutEvidence(
  diagnosis: ProjectDiagnosis,
): ProjectAssessment {
  return {
    diagnosis,
    findings: [],
    requirements: [],
    gates: buildGates(sortBySeverity(diagnosis.findings)),
  };
}
