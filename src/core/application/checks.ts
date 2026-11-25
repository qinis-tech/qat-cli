/**
 * Health checks: the questions `qat doctor` answers about a project before anything runs.
 *
 * ## A check is a question, not an action
 *
 * Every check in this catalogue is a pure function of evidence somebody else gathered — a runtime version, an
 * assessment, a configuration load result, a writability fact. Nothing here reads a file, spawns a process or talks to
 * a stream.
 *
 * That is not tidiness. It is what makes the catalogue's own requirement — a documented purpose, four separate outcome
 * conditions and a remedy for each check — verifiable rather than asserted. A rule that touches a disk can only be
 * checked by constructing a disk; a rule that takes a value can be checked by constructing a value, which means the
 * *whole* table can be exercised, including the branches nobody bothered to build a directory for.
 *
 * ## Two vocabularies for outcome, deliberately
 *
 * `CheckSeverity` is declared per check and never changes: it says what an unfavourable answer *means*.
 * `CheckStatus` is what actually happened on this run. They are separate because the same severity produces different
 * statuses depending on which condition fired, and because a check that could set its own severity at the point of
 * failure would let one condition refuse a run today and advise it tomorrow.
 *
 * `Failed` is reserved for checks whose severity is `error`. That is an invariant rather than a convention: the
 * catalogue test holds every entry to it, so an advisory check that reports a failure is a build failure rather than a
 * report that quietly refuses a run.
 *
 * ## Four code vocabularies, one finding shape
 *
 * `QAT-D` is what detection found wrong with a project, `QAT-V` whether that stops an operation, `QAT-C` what is wrong
 * with a configuration document, and `QAT-H` what is wrong with this machine or this run. A reader can tell which layer
 * raised a finding from the code alone, and `DiagnosticFinding` is generic over the set so nothing has to branch on it.
 *
 * A check that restates another layer's conclusion carries that layer's code **unchanged**. One condition, one code,
 * one sentence — the rule the rest of the diagnostics chain already follows.
 *
 * ## What this file is not
 *
 * It is not the catalogue. It is the vocabulary the catalogue is written in: the identifiers, the statuses, the shape
 * of an outcome, and the three predicates a caller needs. The table itself lives in `src/diagnostics/checks/`, and the
 * prose behind each `QAT-H` code lives beside it. A command will receive a `DoctorReport` through a port, which is why
 * the report's shape belongs here and its production does not.
 */
import type { ConfigurationDiagnosticCode } from "./configuration.js";
import {
  DiagnosticSeverity,
  type DiagnosticCode,
  type DiagnosticFinding,
} from "./diagnostics.js";
import type { ValidationCode } from "./validation.js";

/**
 * The eight groups every check belongs to.
 *
 * Closed, and taken from the approved categories rather than invented: a check belongs to exactly one, and a new
 * category is a decision about how the report is grouped rather than a label a check may choose for itself.
 */
export const CheckCategory = {
  /**
   * The Node.js runtime QAT is running on, and what a framework requires of that runtime.
   *
   * One group rather than two because a reader looking at a report cares about one thing — whether this machine can run
   * the work — and splitting "the runtime" from "the runtime something else needs" would ask them to compare two
   * sections to answer it.
   */
  Runtime: "runtime",
  /** Whether a package manager can be named, so remedies can name one. */
  PackageManager: "package-manager",
  /** Whether the directory is a test project at all, and whether its manifest can be read. */
  ProjectStructure: "project-structure",
  /** Whether the framework is installed, and at a version this tool will drive. */
  CypressInstallation: "cypress-installation",
  /** Whether there is exactly one readable configuration and a spec location QAT can drive. */
  CypressConfiguration: "cypress-configuration",
  /** Whether the QAT configuration file itself can be read. */
  QatConfiguration: "qat-configuration",
  /** Whether the environment a command selected exists. */
  EnvironmentProfiles: "environment-profiles",
  /** Whether reports and evidence can be written where the configuration says they go. */
  OutputPermissions: "output-permissions",
} as const;

export type CheckCategory = (typeof CheckCategory)[keyof typeof CheckCategory];

/**
 * The thirteen health checks.
 *
 * An identifier is a dotted slug rather than a code, because it names a *question* and is quoted in documentation and
 * in the identifier of the scenario that verifies it. The diagnostic *code* is attached to the finding a check
 * produces, and is usually another layer's.
 *
 * The first segment names the **subject**, which is not always the category: `cypress` spans both the configuration and
 * the installation categories, because that is how a reader looking for Cypress problems thinks about them. The
 * category is what the report groups by, and the register asserts every category has at least one check.
 *
 * Permanent, for the same reason codes are: a withdrawn check leaves its identifier unused rather than reusing it, so
 * an identifier quoted in a bug report keeps the meaning it had when it was quoted.
 */
export const CheckId = {
  /**
   * Is the running Node.js version inside the range QAT declares?
   *
   * "Version", not "major": the declared requirement is a range, and a check that reduced it to a major number would
   * accept every patch above a floor and every pre-release of the next line that happened to share the digit.
   */
  NodeVersion: "runtime.node-version",
  /** Can a package manager be named for this project? */
  PackageManager: "environment.package-manager",
  /** Is this directory recognisable as a test project at all? */
  ProjectRecognised: "project.recognised",
  /** Can the project's own metadata be read, and does it name itself? */
  PackageMetadata: "project.package-metadata",
  /** Is there exactly one Cypress configuration, in a format QAT can read? */
  CypressConfigurationLocated: "cypress.configuration-located",
  /** Is there a spec location QAT can drive? */
  CypressLayoutDriveable: "cypress.layout-driveable",
  /** Is the framework installed here or above? */
  CypressInstalled: "cypress.installed",
  /** Is the installed major inside the range QAT will drive? */
  CypressVersionSupported: "cypress.version-supported",
  /**
   * Does the running Node.js version satisfy what the project's framework requires of it?
   *
   * A second runtime question with a different owner: `runtime.node-version` asks what *QAT* needs, this asks what the
   * project's framework needs. The subject segment keeps the framework's questions together; the category keeps the
   * answer in the Runtime group of the report, where a reader is already looking.
   */
  CypressRuntimeSupported: "cypress.runtime-supported",
  /** Can the QAT configuration file be read? */
  QatConfigurationLoadable: "qat.configuration-loadable",
  /** Does the environment a command selected exist in the configuration? */
  EnvironmentResolvable: "qat.environment-resolvable",
  /** Can reports be written where the configuration says they go? */
  ReportsWritable: "output.reports-writable",
  /** Can evidence be written where the configuration says they go? */
  EvidenceWritable: "output.evidence-writable",
} as const;

export type CheckId = (typeof CheckId)[keyof typeof CheckId];

/**
 * How serious an unfavourable answer is. Declared once per check, never at the point of failure.
 *
 * The same two levels a finding has, and deliberately the same definition rather than a second copy. "How bad is this"
 * is one question whether it is being asked about a check or about a finding it produced, and two identical enumerations
 * would drift the day a third level arrived in one of them.
 *
 * The distinction that survives is between a *severity* and a *status*: this says what a failure means, and
 * `CheckStatus` says what happened.
 */
export const CheckSeverity = DiagnosticSeverity;

export type CheckSeverity = DiagnosticSeverity;

/** What happened when a check ran. Four values, because four conditions are documented for every check. */
export const CheckStatus = {
  /** The condition the check documents was met. */
  Passed: "passed",
  /** The check's milder condition was met. Never blocks. */
  Warned: "warned",
  /** The check's blocking condition was met. Only ever produced by an `error` severity check. */
  Failed: "failed",
  /** The check was not run, and says why. Never blocks. */
  Skipped: "skipped",
} as const;

export type CheckStatus = (typeof CheckStatus)[keyof typeof CheckStatus];

/**
 * Why a check did not run.
 *
 * Two reasons, and the difference is the difference between a user's problem and ours. A failed **precondition** is a
 * fact about the project: the question is unanswerable until something else is fixed, and the report names what. A
 * missing **input** is a fact about the caller: nobody gathered the evidence, which is a defect in the assembly rather
 * than in the project — the same distinction an absent configuration file makes between "nothing is configured" and "I
 * could not look".
 */
export const CheckSkipReason = {
  PreconditionFailed: "precondition-failed",
  InputUnavailable: "input-unavailable",
} as const;

export type CheckSkipReason =
  (typeof CheckSkipReason)[keyof typeof CheckSkipReason];

/**
 * Conditions the doctor is the first layer to notice.
 *
 * A fourth prefix, because the three existing ones answer questions about a *project* and these answer questions about
 * the *run*: whether the runtime is new enough, whether a package manager exists, whether output can be written, whether
 * the configuration file is a document at all. Nothing else in the tool asks those, so nothing else owns the codes.
 *
 * `QAT-H003` covers both output directories. One condition, one code: which directory is in the finding's `path`, which
 * is the same arrangement validation uses for two shapes of a misplaced configuration.
 *
 * The runtime is three codes rather than one, and the split is the split between *observed* and *unobtainable*: a
 * mismatch QAT could measure blocks, an answer QAT could not get warns, and a requirement owned by the project's
 * framework is reported on its own so the remedy names the right owner. One code could say "unsupported" for all
 * three; it could not tell a reader which of three different things to do.
 *
 * New codes are appended, never inserted, so a number quoted in a report keeps its meaning.
 */
export const HealthCode = {
  /** The running Node.js version was read and lies outside the range QAT declares. */
  RuntimeUnsupported: "QAT-H001",
  /** Neither a manifest declaration nor a lockfile names a package manager. */
  PackageManagerUnknown: "QAT-H002",
  /** A configured output directory cannot be written. */
  OutputUnwritable: "QAT-H003",
  /** The configuration file exists and contains nothing but whitespace. */
  ConfigurationEmpty: "QAT-H004",
  /** The configuration file is not valid JSON. */
  ConfigurationNotJson: "QAT-H005",
  /** The configuration file is larger than QAT will read. */
  ConfigurationTooLarge: "QAT-H006",
  /** The environment a command selected is not declared in the configuration. */
  EnvironmentUndeclared: "QAT-H007",
  /**
   * The running Node.js version could not be compared with the declared range.
   *
   * Covers the three ways that happens — the host reported no version, reported something that is not a version, or the
   * declared requirement itself could not be read. One code because the reader's next step is the same for all three,
   * and because a code per cause would put QAT's own installation defects in the same list as the project's.
   *
   * Warning, never a pass: an unverified runtime is not a compatible one, and silence would read as consent.
   */
  RuntimeUnknown: "QAT-H008",
  /**
   * The project's framework release declares a Node.js range the running version does not satisfy.
   *
   * Separate from `QAT-H001` because the owner is different and so is the remedy: one is fixed by moving QAT, the other
   * by moving the project's framework — or the runtime the project builds against.
   */
  FrameworkRuntimeUnsupported: "QAT-H009",
} as const;

export type HealthCode = (typeof HealthCode)[keyof typeof HealthCode];

/** Any code a check's finding may carry, from whichever layer owns the condition. */
export type DoctorDiagnosticCode =
  DiagnosticCode | ValidationCode | ConfigurationDiagnosticCode | HealthCode;

/**
 * A finding a check reported.
 *
 * The same shape as every other finding in the project, parameterised over the wider code set — which is what the
 * parameter was added for. Text is carried rather than looked up, so a stored report still reads correctly after the
 * catalogue's wording has changed, and a renderer needs no access to a catalogue to print it.
 */
export type CheckFinding = DiagnosticFinding<DoctorDiagnosticCode>;

/** A check that ran and was satisfied. */
export interface CheckPassed {
  readonly check: CheckId;
  readonly category: CheckCategory;
  /** The check's declared severity, whether or not it mattered this time. */
  readonly severity: CheckSeverity;
  readonly status: typeof CheckStatus.Passed;
}

/**
 * A check that ran and was not satisfied.
 *
 * `Warned` and `Failed` share a shape because they differ only in what the severity means: a warning is a finding the
 * reader should see before a run, and a failure is one that stops it. Splitting them would duplicate every field to
 * express one bit.
 */
export interface CheckConcluded {
  readonly check: CheckId;
  readonly category: CheckCategory;
  readonly severity: CheckSeverity;
  readonly status: typeof CheckStatus.Warned | typeof CheckStatus.Failed;
  readonly finding: CheckFinding;
}

/**
 * A check that did not run.
 *
 * Carries an explanation because "skipped" on its own is the least useful word in a report. The sentence names the
 * check that stopped it, which is the only actionable thing about a skipped check — and it says "not run" rather than
 * "could not be verified", because those read as two different levels of doubt.
 */
export interface CheckSkipped {
  readonly check: CheckId;
  readonly category: CheckCategory;
  readonly severity: CheckSeverity;
  readonly status: typeof CheckStatus.Skipped;
  readonly reason: CheckSkipReason;
  readonly explanation: string;
}

export type CheckOutcome = CheckPassed | CheckConcluded | CheckSkipped;

/**
 * Everything a doctor run concluded.
 *
 * Ordered by the catalogue's declaration order, which is the order a reader fixes things in — so a report rendered top
 * to bottom is already a plan, with causes before consequences.
 *
 * The diagnosis is deliberately absent. This value is the verdict about the run; a later decision is where the project
 * description sits relative to it, and embedding it here would make every consumer of a report carry a tree of findings
 * it may not print.
 */
export interface DoctorReport {
  readonly outcomes: readonly CheckOutcome[];
}

/** One check's outcome, or `undefined` when the run never covered it. */
export function outcomeOf(
  report: DoctorReport,
  check: CheckId,
): CheckOutcome | undefined {
  return report.outcomes.find((outcome) => outcome.check === check);
}

/**
 * Whether anything the doctor found stops a run.
 *
 * A `skipped` outcome never blocks, and that is not an oversight. A check is skipped *because* another check did not
 * pass, and that failure is already in the list — counting the consequence as well would report one condition as
 * several, which is the collapse the whole diagnostics chain exists to prevent.
 */
export function isBlocked(report: DoctorReport): boolean {
  return report.outcomes.some(
    (outcome) => outcome.status === CheckStatus.Failed,
  );
}

/**
 * The checks that failed, in declaration order.
 *
 * Named for what they are rather than for what they cause: `blockedChecks` would read as "checks that were blocked",
 * which is what `skipped` means, and a caller would reach for it expecting the other list.
 */
export function failedChecks(report: DoctorReport): readonly CheckConcluded[] {
  return report.outcomes.filter(
    (outcome): outcome is CheckConcluded =>
      outcome.status === CheckStatus.Failed,
  );
}
