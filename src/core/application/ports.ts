/**
 * Ports: what the application needs from the outside world, expressed as types.
 *
 * Declared by the layer that consumes them, implemented by the layer that can supply them. The direction is the
 * point — the application never names an implementation, so any implementation can be replaced, including by a fake
 * in a test.
 *
 * Every member here is an interface. The application layer contains no logic in this file, and no implementation may
 * appear in it, or the dependency rule that justifies the whole arrangement collapses.
 *
 * Error contract, uniform across every port: a port **rejects** with an `ApplicationError` when a condition prevents
 * it from doing its job, and **resolves** otherwise. Returning `undefined` means "not found", which is not an error.
 * Nothing here throws a bare `string` or a framework-specific error object.
 *
 * The rule for *asynchrony* is that it follows from I/O, not from habit. A member is synchronous only when it
 * performs no I/O — in which case a promise would announce work that never happens, and every caller would begin
 * handling a failure that cannot occur. Two members qualify, and both say so in their own documentation:
 * `ConfigurationResolver.resolve`, which is a pure function of a validated document and an absolute root, and
 * `RuntimeProbe.readNodeVersion`, which reads a value already in memory. Asynchrony is never dropped for convenience,
 * and it is never added to make an interface look uniform.
 *
 * Path convention: a **live request** carries absolute paths, resolved once at the composition boundary. **Stored and
 * returned data** carries paths relative to a declared root, so records stay portable. The asymmetry is deliberate —
 * absolute paths are convenient in flight and corrosive at rest. A *resolved configuration* is the one value that is
 * absolute on both sides of that line, because its whole purpose is to be a live request's output location.
 *
 * ## Sibling modules
 *
 * A contract group large enough to have its own vocabulary lives in its own file in this directory and is imported
 * from here, rather than being inlined. Four do:
 *
 * - `./diagnostics.js` — a diagnosis has statuses, a code set and a finding shape.
 * - `./validation.js` — an assessment adds operations, readiness and a second code vocabulary.
 * - `./configuration.js` — a resolved configuration has paths, findings and two outcomes.
 * - `./initialisation.js` — creating a configuration has four outcomes, three of which are refusals.
 *
 * Inlining any of them would put four vocabularies in one namespace, and a reader checking "what can a finding say"
 * would find it a hundred lines below the interface that mentions it. The rule as this file grows is that a group
 * moves out when its *vocabulary* is independent, not when the file gets long.
 *
 * The machine-level ports below stay here for the opposite reason: each is one interface with no vocabulary of its
 * own — they borrow nothing, not even a domain type; `string`, `boolean` and an optional are all they need — so a
 * sibling file for them would be ceremony around four lines.
 */

// The widened name, because there is now only one. What this shape describes has grown — the runtime QAT requires, the
// bound a project's framework declares, and the version a project pins for its package manager — and the runtime-era
// alias in `core/compatibility` exists solely so that call sites in flight keep compiling. Importing it here would put a
// deprecated name on the application's own surface, which is the one place it can least afford to be ambiguous.
import type { VersionRequirement } from "../compatibility/index.js";
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

import type { ConfigurationResolver } from "./configuration.js";
import type { ProjectDiagnosis } from "./diagnostics.js";
import type { InitialisationService } from "./initialisation.js";
import type { ProjectAssessment } from "./validation.js";

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

/**
 * The project a command is working on, reached four ways.
 *
 * The members form a ladder of commitment, and reading them in this order is the intended use:
 *
 * | Member | Question | On a bad project |
 * | --- | --- | --- |
 * | `resolveWorkingDirectory` | Which directory? | Rejects — the input was wrong |
 * | `diagnose` | What is there, and what is wrong with it? | Never rejects; the problems are findings |
 * | `assess` | May I act on it, and for which operations? | Never rejects; the verdict is on the value |
 * | `discover` | Give me the project, or stop. | Rejects |
 *
 * The middle two exist because the outer two were not enough. A report cannot be built from a function that
 * throws on the condition it exists to describe, which is exactly when a report is most wanted; and a
 * per-operation verdict cannot be read from a function that answers for the project as a whole, because
 * inspection and execution have different answers.
 *
 * A command picks the lowest rung that answers its question. Anything that mutates the project should be
 * reached through `assess` and its gate rather than through `discover`, so the refusal names every condition
 * that applies rather than whichever check ran first.
 */
export interface ProjectDiscovery {
  /**
   * Decides which directory a command should look at, before any discovery happens.
   *
   * On this port rather than in the CLI because it answers a question about a project — which one are we on — rather
   * than about argument parsing. A command supplies the two values it knows about and receives one answer, so no
   * command re-implements the precedence.
   *
   * Checks existence and refuses anything that is not a directory, so an invalid input never reaches `diagnose`,
   * `assess` or `discover`.
   *
   * @throws {ApplicationError} when the chosen directory does not exist or is not a directory.
   */
  resolveWorkingDirectory(
    candidates: WorkingDirectoryCandidates,
  ): Promise<ResolvedWorkingDirectory>;

  /**
   * Reports what was found about the directory, including what is wrong with it, without throwing.
   *
   * Never raises for an unfavourable project. A missing configuration, an ambiguous one, an unusable format and
   * an unreadable manifest all come back as findings, because the caller asking this question is usually about
   * to display them.
   *
   * @param root Absolute path to the directory to inspect.
   * @throws {ApplicationError} only when something outside the project could not be read: a permission failure,
   *   an I/O error.
   */
  diagnose(root: string): Promise<ProjectDiagnosis>;

  /**
   * Decides whether the directory may be used for each operation.
   *
   * The same tree, the same evidence, a different question from `diagnose`: not *what did you find* but *may I
   * act*. Both arrive on one value, because the assessment embeds the diagnosis rather than summarising it — so
   * the two views cannot disagree about what was found.
   *
   * The verdict is read from the value, never from an exception. `isExecutable` and `readinessFor` are pure
   * functions over this result, and the per-operation detail — which findings block, which merely warn — is on
   * the gate. Deciding to refuse is the caller's job, which is what keeps a gating policy and a gating message
   * in different places.
   *
   * @param root Absolute path to the directory to inspect.
   * @throws {ApplicationError} only when something outside the project could not be read.
   */
  assess(root: string): Promise<ProjectAssessment>;

  /**
   * Establishes what the project is, once.
   *
   * The committed form: a project description, or the error that stopped it. Use `diagnose` to obtain the same
   * findings without an exception, and `assess` to obtain a per-operation verdict.
   *
   * @param root Absolute path to the directory to inspect.
   * @throws {ApplicationError} when the directory is not a project QAT can run: no project markers, no supported
   *   configuration, more than one configuration, a configuration in an unusable format, or no installed
   *   framework.
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
 * option translation. Adding a second framework means adding an implementation, not editing this file or anything
 * that consumes it.
 */
export interface FrameworkAdapter {
  /** Which framework this adapter drives. Used to select it from discovery. */
  readonly framework: Framework;

  /**
   * Whether the framework can actually run here.
   *
   * Separate from discovery so that "the project declares Cypress" and "Cypress is installed and executable" stay
   * distinguishable. The first is a property of the project; the second is a property of the machine, and it is the
   * one that changes between a developer laptop and CI.
   *
   * A positive answer here is evidence that can be written back onto an assessment's `binaryAvailable`; the
   * validation layer reads an explicit `false` and never an absent answer, so a caller that has not asked this
   * question cannot accidentally block a run by omission.
   */
  available(project: ProjectInfo): Promise<boolean>;

  /**
   * Runs the request and returns a normalised result.
   *
   * Resolves for **both** outcomes: a run in which tests failed is a successful execution, and is reported through
   * `ExecutionResult.status` and `totals`. This is the distinction the whole error model rests on — a failing
   * assertion must never arrive here as a rejection.
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
 * The application's public surface, and the reason `src/cli` needs no knowledge of adapters, repositories or
 * reports. Its input is what a command parsed; its output is the record that everything downstream consumes.
 */
export interface ExecutionService {
  /**
   * Resolves a request against the project, drives the adapter, records the result and returns it.
   *
   * @throws {ApplicationError} for any expected failure: discovery, configuration, framework unavailability,
   *   storage.
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
 * one: a row is created when a run starts and updated when it finishes, which is what makes "a run that began and
 * whose process died" discoverable afterwards. Adding `running` to the domain union would put a state into the result
 * schema that a result can never legitimately have.
 */
export type ExecutionRecordStatus = ExecutionStatus | "running";

/**
 * The metadata QAT retains about one execution.
 *
 * Metadata only. Test-level results live in the result document on disk and are never duplicated here: duplicating
 * them would create two copies of the same fact that can disagree, and the database exists to answer "which runs
 * happened" rather than "what did each test do".
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
 * file, and no caller may be able to tell — which is what keeps the application unaware that a database exists and
 * lets every test run without one.
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
   * @throws {ApplicationError} when the record does not exist, or has already been completed — both indicate a
   *   second writer or a retry defect, and silently overwriting would hide it.
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
   * Part of the contract rather than an implementation detail, because a database connection is a resource and a
   * caller that never closes one leaks it. Called once by whoever constructed the implementation — the composition
   * root, and nobody else.
   *
   * Must be safe to call more than once: shutdown is reached from a signal handler and from a normal exit, and
   * neither can be relied on to be the only path.
   */
  close(): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reporting
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Output formats.
 *
 * Lives here rather than in the domain because a format is how a result is *presented*, not what a result *is*.
 * Adding a format is an application concern and must not force a domain change.
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
// Runtime environment
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reading the identity of the runtime that is executing QAT.
 *
 * One question, one answer: which version is running us. Deliberately narrow — a probe that also reported platform,
 * architecture and executable path would force every implementation and every fake to supply four facts in order to
 * answer one, and would blur the only fact a compatibility decision depends on. If a second question is ever needed,
 * it belongs on a second port, not on a wider version of this one.
 *
 * The port exists at all because the application layer must not reach for `process`. Detection belongs to the machine
 * (`core/environment`), comparison belongs to `core/compatibility`, and the diagnostic that consumes the answer must
 * be constructible without either — which is what makes the whole supported/unsupported boundary matrix testable with
 * literals instead of real interpreters.
 *
 * ## Synchronous, on purpose
 *
 * The answer is already in memory: the running interpreter's version is a property read, with no file to open and no
 * process to wait for. A promise here would announce I/O that does not happen, and every caller would begin handling
 * a failure that cannot occur — the same argument that makes `ConfigurationResolver.resolve` synchronous. An
 * implementation that genuinely needed I/O would need a different port; "make it async in case" is how an interface
 * loses the ability to say what it does.
 *
 * ## Answer contract
 *
 * - **Returns** the version exactly as the host reports it (e.g. `20.11.1`), unparsed and unnormalised. Parsing and
 *   ordering are one decision made in one place; a probe that normalised would be a second opinion about what a
 *   version looks like, and the two would eventually disagree.
 * - **Returns `undefined`** when the host reports no version at all. That is "not found", not a failure. The caller
 *   turns it into an indeterminate compatibility result, which is reported — and never counted as a pass.
 * - **Throws** `ApplicationError` only when the probe cannot answer at all. A port that threw for an absent version
 *   would make an ordinary environmental condition look like a defect, and the diagnostic that exists to explain the
 *   environment would be the thing that crashes.
 *
 * `undefined` rather than an empty string because absence and malformation are different findings with different
 * messages: "no version was reported" describes the environment, while "reported something unreadable" describes a
 * value worth quoting back to the user.
 */
export interface RuntimeProbe {
  readNodeVersion(): string | undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Machine tooling
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Outcome of running one command.
 *
 * Why an outcome value and not "resolve or throw": a non-zero exit status is the *most common* result of running a
 * tool and is information about the environment, not a defect in QAT. Modelling it as an exception would force every
 * caller into a `try` that immediately swallows it, and the distinction between "exited with a status" and "could not
 * start at all" would be lost in the process.
 *
 * The shape mirrors what the process layer already produces, so binding one to the other is a structural match rather
 * than an adapter with a mapping table. The package-manager module declares a structurally identical `CommandOutcome`
 * for its own probe; that duplicate should be deleted in favour of this one, since this is the layer that owns the
 * machine-level vocabulary.
 */
export type CommandOutcome =
  | {
      readonly status: "exited";
      readonly exitCode: number;
      /** Captured output, already truncated by the runner to the requested budget. */
      readonly stdout: string;
    }
  | { readonly status: "timed-out"; readonly stdout: string }
  | { readonly status: "failed"; readonly reason: string };

/**
 * Runs an external command, shell-free and bounded.
 *
 * Two constraints are part of the contract rather than an implementation detail, because violating either turns a
 * read-only diagnostic into an execution surface:
 *
 * - **No shell.** Arguments are passed as an array, so a path containing `;` or `&` cannot become a command.
 * - **Bounded.** A timeout and an output cap are required, not optional. An unresponsive binary must not be able to
 *   make a health check appear frozen.
 *
 * Asynchronous because it is I/O in the strongest sense: it waits for another process.
 */
export interface CommandRunner {
  run(
    command: string,
    args: readonly string[],
    options: { readonly timeoutMs: number; readonly maxOutputBytes: number },
  ): Promise<CommandOutcome>;
}

/**
 * Finding an executable on the user's PATH.
 *
 * One question — "is this command available, and where" — and no vocabulary beyond `string`. Kept this narrow so the
 * project layer can compose it into a package-manager-shaped port while this file stays free of any project
 * vocabulary; the same reasoning that keeps `RuntimeProbe` down to a single member.
 *
 * ## Resolution rules the contract requires
 *
 * - **PATH only.** An implementation must never search a project-local binary directory such as
 *   `node_modules/.bin`: it is writable by any dependency install, so resolving a tool from there would run
 *   project-controlled code merely to learn its name.
 * - **Empty and relative PATH segments are refused.** An empty segment means "the current directory", the classic
 *   way an unrelated file gets executed because someone happened to be standing in the wrong folder.
 *
 * Returns `undefined` when the command is not found, which is an ordinary answer. It throws only when PATH itself
 * could not be inspected — a condition the caller cannot fix and should not report as "not installed".
 *
 * Asynchronous because it stats the filesystem.
 */
export interface ExecutableLocator {
  locateExecutable(command: string): Promise<string | undefined>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cross-cutting capabilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Context attached to a log entry. Values are `unknown` because the logger decides how to serialise and redact, and a
 * port that pre-shaped them would move that decision into every caller.
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
 * Not ceremony. Without it, every test of anything timestamped asserts "roughly now" and every duration is
 * approximate. With it, a test supplies a fixed clock and asserts an exact value — the difference between a test that
 * proves something and one that proves the code did not crash.
 */
export interface Clock {
  now(): Date;
}

/**
 * Identifier generation.
 *
 * Same reasoning as `Clock`, plus one more: a deterministic generator makes result files diffable between runs, which
 * is what makes a golden-file test possible at all.
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
 * A contract, not the assembled object. It lives here rather than beside the composition root so the CLI can depend
 * on what it is given without depending on what assembles it — which is the whole reason the assembly was separated
 * from the entry point.
 *
 * `logger` is the port, not the concrete logger service: a handler reports, it does not derive correlated children.
 * Anything that needs a run-scoped logger receives one as a parameter later.
 *
 * Three of these members are *evidence*, not services: `runtime`, `nodeRequirement` and `executables`. They are
 * exposed because the health checks consume gathered facts rather than dependencies, and the gatherer is a
 * command-level workflow — so the halves of each compatibility question have to be reachable from outside without any
 * command resolving them for itself. None is a second source: all come from the assembly, once.
 */
export interface Application {
  readonly logger: Logger;
  readonly repository: ExecutionRepository;
  readonly discovery: ProjectDiscovery;

  /**
   * Reads the running interpreter.
   *
   * Here rather than inside the discovery port because it answers a question about the *machine*, not about the
   * project: `discover`, `diagnose` and `assess` all describe a directory, and a runtime version describes the process
   * asking about it. Folding it in would make "what is this project" and "what am I running on" arrive as one answer
   * that a caller has to take apart.
   *
   * Returning the port rather than a version string is the same choice made elsewhere in this file: the gatherer
   * pairs this with `nodeRequirement`, and a bare string would lose the `undefined` case that means "no version was
   * reported".
   */
  readonly runtime: RuntimeProbe;

  /**
   * The Node.js range this build declares, read once from its own manifest.
   *
   * A value, not a resolver: a second read would be a second answer, and a report that quoted one range while
   * comparing against another would be wrong in the one place it must not be.
   *
   * `range` is carried **verbatim**, including when it is empty. An installation that declares nothing must be
   * reported as declaring nothing; correcting it here — with a default, or by omitting the member — would replace a
   * visible warning with a silent assumption.
   *
   * Deliberately not the type a check consumes. The range reaches a check through the runtime facts the gatherer
   * builds, so no checks-layer type appears in this file: a port may say what a caller can ask for, never how a
   * particular consumer shapes the answer.
   *
   * The type is `VersionRequirement`, which is wider than this member's name suggests and deliberately so: one shape
   * serves the runtime QAT requires, a framework's advisory bound and a package-manager pin, so the seam that carries a
   * declared range needs no second vocabulary when the third is added. The member keeps its own name because the
   * assembly reads exactly one such value today; a second would be a second member, not a wider type.
   */
  readonly nodeRequirement: VersionRequirement;

  /**
   * Resolves a tool's location on PATH, for the checks that must reason about installed tooling.
   *
   * A machine fact, like `runtime` — not a project fact, so it does not belong on `discovery`. Exposed rather than
   * consumed internally because the package-manager check is a command-level workflow: it decides *which* command to
   * look for from project evidence, then asks this port. Keeping the decision outside and the resolution here is what
   * lets the project layer own its vocabulary (`PackageManagerName`, lockfiles, markers) while this file stays free of
   * it, and what makes the whole detection matrix testable with a fake locator instead of a real PATH.
   *
   * Deliberately the primitive port and not a package-manager-shaped one: a wider interface here would drag project
   * vocabulary into `core` and invert the dependency direction the rest of this file exists to protect.
   */
  readonly executables: ExecutableLocator;

  /**
   * The configuration a project supplied, defaulted and anchored.
   *
   * Beside `discovery` rather than inside it, because the two answer different questions and fail in different ways.
   * Discovery reports what a project *is* and never rejects for an unfavourable project; resolution reports where that
   * project's output goes and returns findings, rather than throwing, for a path it refused.
   *
   * Deliberately not folded into `ConfigurationLoader`: that port answers "may I trust this file", and this one
   * answers "where does this file point". Merging them would force a caller that only wants to read a configuration
   * to acquire an opinion about the project root as well.
   *
   * One of the two synchronous members in this file, for the reason given on the interface itself: resolution is a
   * pure function of a validated document and an absolute root, so a promise would advertise I/O that does not
   * happen.
   */
  readonly configuration: ConfigurationResolver;

  /**
   * Creates a project's configuration.
   *
   * One operation, because there is one thing a caller can want. The nine steps a workflow needs — resolve, detect,
   * judge, check, generate, validate, write — are the implementation's business, and publishing them would let a
   * command run four of the nine and report a result that never happened.
   *
   * The only member of this interface that writes inside the project. It is create-only by contract: a refusal to
   * touch an existing file is not a policy a caller can opt out of, because the alternative is a command that can
   * destroy settings nobody asked it to change.
   *
   * Three outcomes are refusals and one is a creation, so the answer is a value rather than an exception — the same
   * rule as `diagnose`. The exception is a machine that could not answer: a permission failure, a full disk, a
   * filesystem that cannot create a file atomically.
   *
   * @throws {ApplicationError} only when the filesystem could not answer or refused to create the file.
   */
  readonly initialisation: InitialisationService;

  /** Releases everything the application holds. Safe to call more than once. */
  dispose(): Promise<void>;
}
