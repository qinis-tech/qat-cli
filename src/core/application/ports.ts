/**
 * Ports: what the application needs from the outside world, expressed as types.
 *
 * Declared by the layer that consumes them, implemented by the layer that can supply them. The direction is the
 * point — the application never names an implementation, so any implementation can be replaced, including by a fake in
 * a test.
 *
 * Every member here is an interface. The application layer contains no logic in this file, and no implementation may
 * appear in it, or the dependency rule that justifies the whole arrangement collapses.
 *
 * Error contract, uniform across every port: a port **rejects** with an `ApplicationError` when a condition prevents
 * it from doing its job, and **resolves** otherwise. Returning `undefined` means "not found", which is not an error.
 * Nothing here throws a bare `string` or a framework-specific error object.
 *
 * Path convention: a **live request** carries absolute paths, resolved once at the composition boundary. **Stored and
 * returned data** carries paths relative to a declared root, so records stay portable. The asymmetry is deliberate —
 * absolute paths are convenient in flight and corrosive at rest.
 *
 * ## Sibling modules
 *
 * A contract group large enough to have its own vocabulary lives in its own file in this directory and is imported
 * from here, rather than being inlined. `./diagnostics.js` is the first: a diagnosis has statuses, codes and findings,
 * and pasting those into this file would double it. Nothing else moves until it has the same reason.
 */
import type {
  ConfigurationInput,
  ConfigurationResult,
  EnvironmentId,
  EvidenceReference,
  EvidenceType,
  ExecutionId,
  ExecutionRequest,
  ExecutionResult,
  ExecutionStatus,
  ExecutionTotals,
  Framework,
  IsoTimestamp,
  ProjectInfo,
} from "../domain/index.js";

import type { ProjectDiagnosis } from "./diagnostics.js";

// ─────────────────────────────────────────────────────────────────────────────
// Discovery and configuration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Where a project directory was taken from.
 *
 * Recorded because three inputs can produce the same failure and they have three different fixes: "not a directory"
 * without saying which one sends the reader looking in the wrong place.
 */
export const WorkingDirectorySource = {
  /** Named as a positional argument to the command. */
  Argument: "argument",
  /** Named by the global working-directory option. */
  Option: "option",
  /** Neither: the directory the process was started in. */
  Process: "process",
} as const;

export type WorkingDirectorySource =
  (typeof WorkingDirectorySource)[keyof typeof WorkingDirectorySource];

/** The two ways a command can be told which directory to work on. */
export interface WorkingDirectoryCandidates {
  readonly argument?: string | undefined;
  readonly option?: string | undefined;
}

export interface ResolvedWorkingDirectory {
  /** Absolute and normalised. Resolved once, passed to discovery, never re-derived downstream. */
  readonly directory: string;
  readonly source: WorkingDirectorySource;
}

export interface ProjectDiscovery {
  /**
   * Decides which directory a command should look at, before any discovery happens.
   *
   * On this port rather than in the CLI because it answers a question about a project — which one are we on — rather
   * than about argument parsing. A command supplies the two values it knows about and receives one answer, so no
   * command re-implements the precedence.
   *
   * Checks existence and refuses anything that is not a directory, so an invalid input never reaches `discover`.
   *
   * @throws {ApplicationError} when the chosen directory does not exist or is not a directory.
   */
  resolveWorkingDirectory(
    candidates: WorkingDirectoryCandidates,
  ): Promise<ResolvedWorkingDirectory>;

  /**
   * Reports what was found about the directory, including what is wrong with it, without throwing.
   *
   * The two members below answer different questions. `diagnose` produces a report — including a report that says
   * there is nothing here — and never raises for an unfavourable answer. `discover` produces a project QAT can use, or
   * raises the error that stopped it.
   *
   * A command that wants to tell a user what it sees needs this one, and cannot get it from `discover` without
   * catching an exception purely to obtain information.
   *
   * @param root Absolute path to the directory to inspect.
   * @throws {ApplicationError} only when something outside the project could not be read: a permission failure, an I/O
   *   error. A missing configuration, an ambiguous one, an unusable format and an unreadable manifest all come back as
   *   findings.
   */
  diagnose(root: string): Promise<ProjectDiagnosis>;

  /**
   * Establishes what the project is, once.
   *
   * @param root Absolute path to the directory to inspect.
   * @throws {ApplicationError} when the directory is not a project QAT can run: no project markers, no supported
   *   configuration, more than one configuration, a configuration in an unusable format, or no installed framework.
   *   Use `diagnose` to obtain the same findings without an exception.
   */
  discover(root: string): Promise<ProjectInfo>;
}

export interface ConfigurationLoader {
  /**
   * Reads, validates and defaults the configuration.
   *
   * Returns a result rather than rejecting, because an invalid configuration is expected input, not an exceptional
   * condition. A caller reporting the problem needs every issue at once, not the first one to fail.
   */
  load(input: ConfigurationInput): Promise<ConfigurationResult>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Execution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Boundary around one testing framework.
 *
 * Everything framework-specific lives behind this interface: process invocation, output parsing, version quirks,
 * option translation. Adding a second framework means adding an implementation, not editing this file or anything that
 * consumes it.
 */
export interface FrameworkAdapter {
  /** Which framework this adapter drives. Used to select it from discovery. */
  readonly framework: Framework;

  /**
   * Whether the framework can actually run here.
   *
   * Separate from discovery so that "the project declares Cypress" and "Cypress is installed and executable" stay
   * distinguishable. The first is a property of the project; the second is a property of the machine, and it is the one
   * that changes between a developer laptop and CI.
   */
  available(project: ProjectInfo): Promise<boolean>;

  /**
   * Runs the request and returns a normalised result.
   *
   * Resolves for **both** outcomes: a run in which tests failed is a successful execution, and is reported through
   * `ExecutionResult.status` and `totals`. This is the distinction the whole error model rests on — a failing assertion
   * must never arrive here as a rejection.
   *
   * @throws {ApplicationError} only when the framework could not run at all.
   */
  execute(
    request: ExecutionRequest,
    project: ProjectInfo,
  ): Promise<ExecutionResult>;
}

/**
 * What the CLI is allowed to call.
 *
 * The application's public surface, and the reason `src/cli` needs no knowledge of adapters, repositories or reports.
 * Its input is what a command parsed; its output is the record that everything downstream consumes.
 */
export interface ExecutionService {
  /**
   * Resolves a request against the project, drives the adapter, records the result and returns it.
   *
   * @throws {ApplicationError} for any expected failure: discovery, configuration, framework unavailability, storage.
   */
  run(
    request: ExecutionRequest,
    project: ProjectInfo,
  ): Promise<ExecutionResult>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Evidence
// ─────────────────────────────────────────────────────────────────────────────

/**
 * An artefact the collector found on disk, before it was recorded.
 *
 * No `evidenceId` and no `createdAt`: both are assigned at recording time, so a caller cannot invent them and end up
 * with two references that disagree.
 */
export interface EvidenceCandidate {
  readonly type: EvidenceType;
  /** Path relative to the evidence directory. The collector knows the root; callers do not. */
  readonly relativePath: string;
  readonly mediaType?: string;
  readonly sizeBytes?: number;
}

/**
 * Recording artefacts for a run.
 *
 * Kept separate from `ExecutionRepository` so a run can be recorded without collecting evidence, and evidence can be
 * collected without persisting a result.
 */
export interface EvidenceStore {
  record(
    executionId: ExecutionId,
    candidates: readonly EvidenceCandidate[],
  ): Promise<readonly EvidenceReference[]>;
  list(executionId: ExecutionId): Promise<readonly EvidenceReference[]>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Storage
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Status of a *stored* execution.
 *
 * The domain's `ExecutionStatus` describes how a run ended, so it has no member for a run that has not. Storage needs
 * one: a row is created when a run starts and updated when it finishes, which is what makes "a run that began and whose
 * process died" discoverable afterwards. Adding `running` to the domain union would put a state into the result schema
 * that a result can never legitimately have.
 */
export type ExecutionRecordStatus = ExecutionStatus | "running";

/**
 * The metadata QAT retains about one execution.
 *
 * Metadata only. Test-level results live in the result document on disk and are never duplicated here: duplicating them
 * would create two copies of the same fact that can disagree, and the database exists to answer "which runs happened"
 * rather than "what did each test do".
 */
export interface ExecutionRecord {
  readonly executionId: ExecutionId;
  /** Absolute, and the key history is grouped by. */
  readonly projectRoot: string;
  readonly environment: EnvironmentId;
  readonly framework: string;
  readonly frameworkVersion: string;
  readonly status: ExecutionRecordStatus;
  readonly startedAt: IsoTimestamp;
  readonly completedAt?: IsoTimestamp;
  readonly durationMs?: number;
  readonly totals?: ExecutionTotals;
  /** Path to the result document, relative to the project root. Absent when none was written. */
  readonly resultPath?: string;
  /** How many artefacts were recorded. Not their paths: those live in the result document. */
  readonly evidenceCount: number;
}

/**
 * The only mutation permitted after creation.
 *
 * A stored execution is append-then-complete. Nothing else about it changes, which removes a whole category of
 * question — "which version of this record is the real one" — before it can be asked.
 */
export interface ExecutionCompletion {
  readonly status: ExecutionStatus;
  readonly completedAt: IsoTimestamp;
  readonly durationMs: number;
  readonly totals: ExecutionTotals;
  readonly resultPath?: string;
  readonly evidenceCount?: number;
}

/**
 * Query for a history listing.
 *
 * An object rather than positional arguments so filters can be added without changing every call site, which is the
 * cheapest kind of extensibility available.
 */
export interface ExecutionQuery {
  readonly limit: number;
  /** Restrict to one project. Omitted means every project in this database. */
  readonly projectRoot?: string;
  readonly environment?: EnvironmentId;
}

/** A row in an execution list. Deliberately smaller than a full record. */
export interface ExecutionSummary {
  readonly executionId: ExecutionId;
  readonly startedAt: IsoTimestamp;
  readonly status: ExecutionRecordStatus;
  readonly environment: EnvironmentId;
  readonly total: number;
  readonly failed: number;
}

/**
 * Persistence of execution metadata.
 *
 * The interface names no storage technology and must not. An implementation may be SQLite, an in-memory map or a JSON
 * file, and no caller may be able to tell — which is what keeps the application unaware that a database exists and lets
 * every test run without one.
 *
 * Every method is atomic: either the whole effect is applied or none of it is. A caller never sees a half-written
 * record.
 *
 * `findById` returns `undefined` for an unknown identifier. A missing record is an ordinary answer to an ordinary
 * question, not a failure. `complete` on an unknown identifier **is** a failure, because it means the store lost
 * something a caller had just written.
 */
export interface ExecutionRepository {
  /** @throws {ApplicationError} when a record with this identifier already exists. */
  create(record: ExecutionRecord): Promise<void>;

  /**
   * Records how a run ended.
   *
   * @throws {ApplicationError} when the record does not exist, or has already been completed — both indicate a second
   *   writer or a retry defect, and silently overwriting would hide it.
   */
  complete(
    executionId: ExecutionId,
    completion: ExecutionCompletion,
  ): Promise<void>;

  findById(executionId: ExecutionId): Promise<ExecutionRecord | undefined>;

  /** Newest first, ordered by `startedAt` then `executionId` so the order is total. */
  list(query: ExecutionQuery): Promise<readonly ExecutionSummary[]>;

  /**
   * Releases whatever the implementation holds.
   *
   * Part of the contract rather than an implementation detail, because a database connection is a resource and a caller
   * that never closes one leaks it. Called once by whoever constructed the implementation — the composition root, and
   * nobody else.
   *
   * Must be safe to call more than once: shutdown is reached from a signal handler and from a normal exit, and neither
   * can be relied on to be the only path.
   */
  close(): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reporting
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Output formats.
 *
 * Lives here rather than in the domain because a format is how a result is *presented*, not what a result *is*. Adding
 * a format is an application concern and must not force a domain change.
 */
export const ReportFormat = {
  Html: "html",
  Json: "json",
  JUnit: "junit",
} as const;

export type ReportFormat = (typeof ReportFormat)[keyof typeof ReportFormat];

export interface ReportRequest {
  /** A completed result. Reporting never reaches back into execution to fill a gap. */
  readonly execution: ExecutionResult;
  readonly format: ReportFormat;
  /**
   * Absolute output directory.
   *
   * Absolute because this is a live request, resolved once by the caller from the project root and the configured
   * output directory. Stored artefacts are relative; in-flight requests are absolute.
   */
  readonly outputDirectory: string;
}

export interface ReportArtifact {
  readonly format: ReportFormat;
  /** Path relative to `ReportRequest.outputDirectory`, so the artefact stays portable. */
  readonly relativePath: string;
  readonly sizeBytes: number;
}

/**
 * Generation of one report format.
 *
 * One generator per format, selected by `format`. A single generator switching on the format would accumulate every
 * format's concerns in one file and make adding a format a change to code that already works.
 */
export interface ReportGenerator {
  readonly format: ReportFormat;
  /** @throws {ApplicationError} when the report could not be written. */
  generate(request: ReportRequest): Promise<ReportArtifact>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cross-cutting capabilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Context attached to a log entry. Values are `unknown` because the logger decides how to serialise and redact, and a
 * port that pre-shapes them would move that decision into every caller.
 */
export type LogContext = Readonly<Record<string, unknown>>;

/**
 * Structured logging.
 *
 * Six levels rather than four. `trace` exists for diagnosing the logger itself and should almost never be used in
 * application code; `fatal` exists because a process about to exit has no second chance to report why.
 *
 * A port rather than an import, because the application layer is forbidden from importing `core/logging` — that is an
 * implementation.
 */
export interface Logger {
  trace(message: string, context?: LogContext): void;
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  fatal(message: string, context?: LogContext): void;
}

/**
 * Current time.
 *
 * Not ceremony. Without it, every test of anything timestamped asserts "roughly now" and every duration is approximate.
 * With it, a test supplies a fixed clock and asserts an exact value — the difference between a test that proves
 * something and one that proves the code did not crash.
 */
export interface Clock {
  now(): Date;
}

/**
 * Identifier generation.
 *
 * Same reasoning as `Clock`, plus one more: a deterministic generator makes result files diffable between runs, which is
 * what makes a golden-file test possible at all.
 */
export interface IdGenerator {
  next(): string;
}

// ─────────────────────────────────────────────────────────────────────────────
// The assembled application
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What a command handler receives.
 *
 * A contract, not the assembled object. It lives here rather than beside the composition root so the CLI can depend on
 * what it is given without depending on what assembles it — which is the whole reason the assembly was separated from
 * the entry point.
 *
 * `logger` is the port, not the concrete logger service: a handler reports, it does not derive correlated children.
 * Anything that needs a run-scoped logger receives one as a parameter later.
 */
export interface Application {
  readonly logger: Logger;
  readonly repository: ExecutionRepository;
  readonly discovery: ProjectDiscovery;

  /** Releases everything the application holds. Safe to call more than once. */
  dispose(): Promise<void>;
}
