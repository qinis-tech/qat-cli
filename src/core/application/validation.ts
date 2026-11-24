/**
 * Validation: whether a recognised project may be used for a particular operation.
 *
 * ## Where this sits
 *
 * Detection answers *what is here*. Diagnostics answer *what is wrong with it*. Validation answers the only
 * question a command needs before it acts: **does what is wrong stop this operation**.
 *
 * The three are separate because one answer cannot serve three audiences. A report wants everything, including
 * the things that are fine. A run wants to know only whether it may start. Collapsing them produces the failure
 * this whole chain of modules exists to avoid: refusing to report on a project *because* it is broken, which
 * is exactly when a report is most wanted.
 *
 * ## One set of findings, a different verdict per operation
 *
 * The findings are identical whichever operation asks. What differs is the verdict:
 *
 * | Operation | Role      | Blocked when                                  |
 * | --------- | --------- | --------------------------------------------- |
 * | `inspect` | Reporting | Never — surfacing the blockers *is* the job    |
 * | `execute` | Gating    | Any finding whose severity is `error`          |
 *
 * That asymmetry is the point. A directory with no configuration is blocked for execution and perfectly
 * inspectable. A single status field would have to choose, and either choice is wrong half the time.
 *
 * ## Why there is no "valid" flag
 *
 * A boolean, or a three-state enumeration, would have to answer *is anything wrong* — which is not the
 * question. A project with Cypress declared and not installed is not wrong: it is a fresh clone. A project
 * whose installed Cypress predates its configuration format is wrong in a way no install command fixes. Both
 * are "not runnable right now" and they need different sentences, so the assessment carries findings plus a
 * gate per operation, rather than a flag that discards the distinction.
 */
import type { ResolvedProjectConfiguration } from "./configuration.js";
import type {
  DiagnosticCode,
  DiagnosticFinding,
  ProjectDiagnosis,
} from "./diagnostics.js";

/**
 * The operations a command can perform on a project.
 *
 * A closed set. Adding a member forces a decision in the gate builder about how it is gated, which is the
 * point: a new operation that inherited someone else's gate by default would be a permission nobody granted.
 */
export const QatOperation = {
  /**
   * Reading the project and reporting what was found.
   *
   * Never blocked. This is the operation whose purpose is to surface the conditions that block the other one,
   * so refusing to perform it because those conditions exist would be self-defeating.
   */
  Inspect: "inspect",
  /** Driving the framework. Blocked by any error finding. */
  Execute: "execute",
} as const;

export type QatOperation = (typeof QatOperation)[keyof typeof QatOperation];

/**
 * How ready a project is for one operation.
 *
 * Three values, and the middle one is not a rounding of the other two: `ready-with-warnings` means proceed
 * *and read the findings*, which is different advice from both `ready` and `blocked`.
 */
export const OperationReadiness = {
  Ready: "ready",
  ReadyWithWarnings: "ready-with-warnings",
  Blocked: "blocked",
} as const;

export type OperationReadiness =
  (typeof OperationReadiness)[keyof typeof OperationReadiness];

/**
 * Conditions validation adds on top of detection.
 *
 * A separate prefix from the detection codes, because the two vocabularies answer different questions and a
 * reader should be able to tell which layer raised a finding from the code alone. Codes are permanent: a
 * withdrawn condition leaves its code unused rather than reusing it, so a code quoted in a bug report keeps
 * the meaning it had when it was quoted.
 *
 * Severity lives on the catalogue entry, not here — the same reason exit codes derive from one table rather
 * than being chosen wherever a failure is raised.
 */
export const ValidationCode = {
  /** A Cypress configuration exists, but not where Cypress loads it from. */
  ConfigurationMisplaced: "QAT-V001",
  /** A configuration is present, but the layout it describes cannot be driven. */
  LayoutUnsupported: "QAT-V002",
  /** The root is a workspace container as well as a project, so the intended target is ambiguous. */
  RootAmbiguous: "QAT-V003",
  /** Something verified the executable and it could not be invoked. */
  BinaryUnavailable: "QAT-V004",
  /** The installed major is older than QAT supports. */
  VersionBelowSupported: "QAT-V005",
  /** The installed major is newer than QAT has been written against. */
  VersionAboveKnownGood: "QAT-V006",
} as const;

export type ValidationCode =
  (typeof ValidationCode)[keyof typeof ValidationCode];

/** Any code a finding may carry, from either vocabulary. */
export type AnyDiagnosticCode = DiagnosticCode | ValidationCode;

/** A finding from either layer — what a gate's lists hold. */
export type AnyDiagnosticFinding = DiagnosticFinding<AnyDiagnosticCode>;

/** A finding this layer raised. Detection's own findings are carried unchanged, never re-worded. */
export type ValidationFinding = DiagnosticFinding<ValidationCode>;

/**
 * The requirements validation checks.
 *
 * Named rather than anonymous so a report can say what was checked *and passed*, not only what failed. That
 * is also what makes "every approved rule has a test" verifiable: the set is enumerable.
 */
export const ValidationRequirementId = {
  ProjectRecognised: "project-recognised",
  ConfigurationLocated: "configuration-located",
  LayoutSupported: "layout-supported",
  VersionSupported: "version-supported",
  BinaryAvailable: "binary-available",
  RootUnambiguous: "root-unambiguous",
} as const;

export type ValidationRequirementId =
  (typeof ValidationRequirementId)[keyof typeof ValidationRequirementId];

/** What one requirement concluded. */
export const RequirementOutcome = {
  Satisfied: "satisfied",
  /** Satisfied, with something worth saying about it. */
  Warning: "warning",
  Violated: "violated",
} as const;

export type RequirementOutcome =
  (typeof RequirementOutcome)[keyof typeof RequirementOutcome];

/**
 * One requirement's conclusion, kept even when it passed.
 *
 * A list of failures alone cannot distinguish "everything was checked" from "nothing was checked", and an
 * empty list looks exactly like the second.
 */
export interface ValidationRequirementResult {
  readonly requirement: ValidationRequirementId;
  /** What the requirement asserts, in one line, so a report can print the ones that passed. */
  readonly summary: string;
  readonly outcome: RequirementOutcome;
  /** Codes this requirement contributed, from either vocabulary. Empty when satisfied. */
  readonly codes: readonly AnyDiagnosticCode[];
}

/**
 * The verdict for one operation.
 *
 * `blocking` and `warnings` are sorted by severity, so a caller that prints only the first entry of
 * `blocking` prints the most fundamental problem rather than whichever check happened to run first.
 *
 * The two lists are identical across operations; only `readiness` differs. That is worth knowing before
 * reading a gate — `readiness` is the field carrying the per-operation judgement.
 */
export interface OperationGate {
  readonly operation: QatOperation;
  readonly readiness: OperationReadiness;
  /** Findings whose severity is error. Reported by an inspection; fatal to an execution. */
  readonly blocking: readonly AnyDiagnosticFinding[];
  /** Findings whose severity is warning. */
  readonly warnings: readonly AnyDiagnosticFinding[];
}

/**
 * Everything validation concluded about one project.
 *
 * The diagnosis is embedded rather than summarised, so the two layers cannot disagree: there is no second copy
 * of "was it detected" to drift from the first.
 */
export interface ProjectAssessment {
  /** What detection found, unchanged by this layer. */
  readonly diagnosis: ProjectDiagnosis;
  /** What validation added. Never repeats a condition the diagnosis already reported. */
  readonly findings: readonly ValidationFinding[];
  /**
   * Every requirement that was evaluated.
   *
   * Empty when nothing could be evaluated — an unreadable manifest stops before there is evidence to judge.
   * An empty list says that plainly, which a fixed-length list of "passed" entries would not.
   */
  readonly requirements: readonly ValidationRequirementResult[];
  /** One gate per operation, keyed, so a caller cannot ask about an operation that was never gated. */
  readonly gates: Readonly<Record<QatOperation, OperationGate>>;

  /**
   * Where this project's run would write, and against which environment.
   *
   * Optional because an assessment can be produced for a project whose configuration could not be read — which is a
   * perfectly good assessment, and exactly the case in which there is no location to report.
   */
  readonly configuration?: ResolvedProjectConfiguration;
}

/** Whether an execution may start. The question every mutating command asks first. */
export function isExecutable(assessment: ProjectAssessment): boolean {
  return (
    assessment.gates[QatOperation.Execute].readiness !==
    OperationReadiness.Blocked
  );
}

/** How ready the project is for one operation. Total over the operation set by construction. */
export function readinessFor(
  assessment: ProjectAssessment,
  operation: QatOperation,
): OperationReadiness {
  return assessment.gates[operation].readiness;
}
