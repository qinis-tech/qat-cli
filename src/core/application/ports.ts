/**
 * Ports: what the application needs from the outside world, expressed as types.
 *
 * Declared by the layer that consumes them, implemented by the layer that can supply
 * them. The direction is the point — the application never names an implementation, so
 * any implementation can be replaced, including by a fake in a test.
 *
 * Every member here is an interface. The application layer contains no logic in this
 * file, and no implementation may appear in it, or the dependency rule that justifies
 * the whole arrangement collapses.
 *
 * Error contract, uniform across every port: a port **rejects** with an `ApplicationError`
 * when a condition prevents it from doing its job, and **resolves** otherwise. Returning
 * `undefined` means "not found", which is not an error. Nothing here throws a bare
 * `string` or a framework-specific error object.
 *
 * Path convention: a **live request** carries absolute paths, resolved once at the
 * composition boundary. **Stored and returned data** carries paths relative to a declared
 * root, so records stay portable. The asymmetry is deliberate — absolute paths are
 * convenient in flight and corrosive at rest.
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
  Framework,
  IsoTimestamp,
  ProjectInfo,
} from "../domain/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// Discovery and configuration
// ─────────────────────────────────────────────────────────────────────────────

export interface ProjectDiscovery {
  /**
   * Establishes what the project is, once.
   *
   * @param root Absolute path to the directory to inspect.
   * @throws {ApplicationError} when the directory is not a project QAT can run — no
   *   framework detected, or a framework present but unusable. A project with no
   *   configuration file is not an error: defaults exist for that case.
   */
  discover(root: string): Promise<ProjectInfo>;
}

export interface ConfigurationLoader {
  /**
   * Reads, validates and defaults the configuration.
   *
   * Returns a result rather than rejecting, because an invalid configuration is
   * expected input, not an exceptional condition. A caller reporting the problem needs
   * every issue at once, not the first one to fail.
   */
  load(input: ConfigurationInput): Promise<ConfigurationResult>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Execution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Boundary around one testing framework.
 *
 * Everything framework-specific lives behind this interface: process invocation, output
 * parsing, version quirks, option translation. Adding a second framework means adding an
 * implementation, not editing this file or anything that consumes it.
 */
export interface FrameworkAdapter {
  /** Which framework this adapter drives. Used to select it from discovery. */
  readonly framework: Framework;

  /**
   * Whether the framework can actually run here.
   *
   * Separate from discovery so that "the project declares Cypress" and "Cypress is
   * installed and executable" stay distinguishable. The first is a property of the
   * project; the second is a property of the machine, and it is the one that changes
   * between a developer laptop and CI.
   */
  available(project: ProjectInfo): Promise<boolean>;

  /**
   * Runs the request and returns a normalised result.
   *
   * Resolves for **both** outcomes: a run in which tests failed is a successful
   * execution, and is reported through `ExecutionResult.status` and `totals`. This is
   * the distinction the whole error model rests on — a failing assertion must never
   * arrive here as a rejection.
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
 * The application's public surface, and the reason `src/cli` needs no knowledge of
 * adapters, repositories or reports. Its input is what a command parsed; its output is
 * the record that everything downstream consumes.
 */
export interface ExecutionService {
  /**
   * Resolves a request against the project, drives the adapter, records the result and
   * returns it.
   *
   * @throws {ApplicationError} for any expected failure: discovery, configuration,
   *   framework unavailability, storage.
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
 * No `evidenceId` and no `createdAt`: both are assigned at recording time, so a caller
 * cannot invent them and end up with two references that disagree.
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
 * Kept separate from `ExecutionRepository` so a run can be recorded without collecting
 * evidence, and evidence can be collected without persisting a result.
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

/** A row in an execution list. Deliberately smaller than a full result. */
export interface ExecutionSummary {
  readonly executionId: ExecutionId;
  readonly startedAt: IsoTimestamp;
  readonly status: ExecutionResult["status"];
  readonly environment: EnvironmentId;
  readonly total: number;
  readonly failed: number;
}

/**
 * Query for a history listing.
 *
 * An object rather than positional arguments so filters can be added without changing
 * every call site, which is the cheapest kind of extensibility available.
 */
export interface ExecutionQuery {
  readonly limit: number;
  readonly environment?: EnvironmentId;
}

/**
 * Persistence of completed results.
 *
 * The interface names no storage technology, and must not. An implementation may be
 * SQLite, JSON files or an in-memory map, and no caller may be able to tell — that is
 * what makes the repository replaceable and testable without a database.
 */
export interface ExecutionRepository {
  /** @throws {ApplicationError} when the result could not be persisted. */
  save(result: ExecutionResult): Promise<void>;
  findById(executionId: ExecutionId): Promise<ExecutionResult | undefined>;
  findLatest(): Promise<ExecutionResult | undefined>;
  list(query: ExecutionQuery): Promise<readonly ExecutionSummary[]>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reporting
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Output formats.
 *
 * Lives here rather than in the domain because a format is how a result is *presented*,
 * not what a result *is*. Adding a format is an application concern and must not force a
 * domain change.
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
   * Absolute because this is a live request, resolved once by the caller from the
   * project root and the configured output directory. Stored artefacts are relative;
   * in-flight requests are absolute.
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
 * One generator per format, selected by `format`. A single generator switching on the
 * format would accumulate every format's concerns in one file and make adding a format a
 * change to code that already works.
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
 * Context attached to a log entry. Values are `unknown` because the logger decides how
 * to serialise and redact, and a port that pre-shapes them would move that decision into
 * every caller.
 */
export type LogContext = Readonly<Record<string, unknown>>;

/**
 * Structured logging.
 *
 * Six levels rather than four. `trace` exists for diagnosing the logger itself and should
 * almost never be used in application code; `fatal` exists because a process about to exit
 * has no second chance to report why.
 *
 * A port rather than an import, because the application layer is forbidden from importing
 * `core/logging` — that is an implementation.
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
 * Not ceremony. Without it, every test of anything timestamped asserts "roughly now" and
 * every duration is approximate. With it, a test supplies a fixed clock and asserts an
 * exact value — the difference between a test that proves something and one that proves
 * the code did not crash.
 */
export interface Clock {
  now(): Date;
}

/**
 * Identifier generation.
 *
 * Same reasoning as `Clock`, plus one more: a deterministic generator makes result files
 * diffable between runs, which is what makes a golden-file test possible at all.
 */
export interface IdGenerator {
  next(): string;
}
