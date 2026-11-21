/**
 * Execution contracts.
 *
 * The vocabulary every layer shares. Nothing here knows about Cypress, so a second
 * framework can produce the same shapes without the reporting layer noticing.
 *
 * Types and constants only: no behaviour, and no imports beyond the domain itself.
 */
import type { EvidenceReference } from "./evidence.js";
import type { EnvironmentId, ExecutionId, IsoTimestamp } from "./primitives.js";

// Identifier and timestamp aliases live in ./primitives.js, so that no domain module
// has to import another merely to name a value. Their documentation is there, and they
// are NOT re-exported from this file: `index.ts` exports ./primitives.js directly, and a
// second home for the same name is an ambiguity error at the barrel.

/**
 * How a run ended.
 *
 * `Errored` is deliberately distinct from `Failed`, and the distinction is load bearing:
 * a failed run means the tests executed and some disagreed with reality, while an errored
 * run means they never executed at all. They map to different exit codes, and conflating
 * them produces a signal nobody can trust.
 */
export const ExecutionStatus = {
  Succeeded: "succeeded",
  Failed: "failed",
  Errored: "errored",
  Cancelled: "cancelled",
} as const;

export type ExecutionStatus =
  (typeof ExecutionStatus)[keyof typeof ExecutionStatus];

/** How a single test ended. */
export const TestStatus = {
  Passed: "passed",
  Failed: "failed",
  Pending: "pending",
  Skipped: "skipped",
} as const;

export type TestStatus = (typeof TestStatus)[keyof typeof TestStatus];

/**
 * Headless or interactive.
 *
 * A closed set rather than a boolean: interactive mode is a development affordance that
 * must never be reachable from CI, and naming the states makes that explicit at every
 * call site rather than implicit in a `false`.
 */
export const ExecutionMode = {
  Headless: "headless",
  Interactive: "interactive",
} as const;

export type ExecutionMode = (typeof ExecutionMode)[keyof typeof ExecutionMode];

/**
 * What to run.
 *
 * A discriminated union rather than `{ suite?: string; spec?: string }`, so an exhaustive
 * `switch` catches a new selection kind at compile time instead of silently matching no
 * branch and running nothing.
 */
export type SpecSelection =
  | { readonly kind: "all" }
  | { readonly kind: "suite"; readonly suite: string }
  | { readonly kind: "spec"; readonly specPattern: string };

/** Knobs that affect how a run executes, independent of what it executes. */
export interface ExecutionOptions {
  /** Wall-clock limit for the whole run, including adapter startup. */
  readonly timeoutMs: number;
  /** Retries per test before a failure is final. */
  readonly retries: number;
  /**
   * Capture screenshots and video.
   *
   * Off by default: artefacts are large, and on a failing run they may capture production
   * data. Opting in should be a visible decision rather than an inherited default.
   */
  readonly collectEvidence: boolean;
}

/**
 * A request to execute tests.
 *
 * `executionId` is supplied by the caller rather than generated here, so the value that
 * appears in logs, result files and artefact paths is decided in exactly one place and
 * can be correlated before the run starts.
 */
export interface ExecutionRequest {
  readonly executionId: ExecutionId;
  readonly environment: EnvironmentId;
  readonly specSelection: SpecSelection;
  readonly mode: ExecutionMode;
  readonly options: ExecutionOptions;
  /** Browser name where the framework supports choosing one. Omitted means the framework default. */
  readonly browser?: string;
  /** Cooperative cancellation. Optional, so a caller without one needs no ceremony. */
  readonly signal?: AbortSignal;
}

export interface TestFailure {
  readonly message: string;
  /**
   * First line of the framework stack only, where one exists.
   *
   * Deliberately not the full trace. Traces are large, they are already captured in
   * evidence, and embedding them makes every result file expensive to store and to read
   * for the one field anybody actually needs.
   */
  readonly detail?: string;
}

export interface TestResult {
  /** Path relative to the project root, so a result stays portable across machines. */
  readonly specPath: string;
  readonly title: string;
  /** Full title including describe blocks, used to disambiguate identical test names. */
  readonly fullTitle: string;
  readonly status: TestStatus;
  readonly durationMs: number;
  /** Attempts made, including the successful one. `1` means it passed first time. */
  readonly attempts: number;
  readonly failure?: TestFailure;
}

/**
 * Counts derived from `ExecutionResult.tests`.
 *
 * Invariant: `total === passed + failed + pending + skipped`. Stored rather than computed
 * on access because every consumer needs it, and recomputing invites each one to get it
 * slightly wrong in a different way.
 */
export interface ExecutionTotals {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly pending: number;
  readonly skipped: number;
}

/**
 * Why a run errored before producing test results.
 *
 * `code` is a plain string, not an application error code, so the domain depends on
 * nothing. Mapping an error onto this shape happens where the error is raised, not where
 * the result is defined.
 */
export interface ExecutionErrorInfo {
  readonly code: string;
  readonly message: string;
}

/**
 * Version of the result shape.
 *
 * Persisted results outlive the code that wrote them, so a reader must be able to
 * recognise a shape it does not understand. Bump this whenever a field changes meaning,
 * and read it before trusting anything else in the record.
 */
export const EXECUTION_RESULT_SCHEMA_VERSION = 1;

/**
 * The record of one completed execution.
 *
 * This is the boundary between execution and everything downstream: reporting,
 * persistence and diagnostics consume this and nothing else. A consumer that needs to
 * import the execution layer to understand a result has found a gap in this type, not a
 * reason to add the import.
 */
export interface ExecutionResult {
  readonly schemaVersion: typeof EXECUTION_RESULT_SCHEMA_VERSION;
  readonly executionId: ExecutionId;
  readonly status: ExecutionStatus;
  readonly startedAt: IsoTimestamp;
  readonly completedAt: IsoTimestamp;
  readonly durationMs: number;
  readonly environment: EnvironmentId;
  /** Absolute, resolved once at discovery so nothing downstream re-derives it. */
  readonly projectRoot: string;
  /**
   * Framework identifier, kept as a plain string rather than the `Framework` union.
   *
   * A stored result may be read by a future version whose union has gained or lost a
   * member. A closed union here would make an old record unreadable — or worse, make a
   * reader reject a record that is perfectly valid. Primitives in persisted data,
   * unions in live code.
   */
  readonly framework: string;
  readonly frameworkVersion: string;
  readonly tests: readonly TestResult[];
  readonly totals: ExecutionTotals;
  readonly evidence: readonly EvidenceReference[];
  /** Present only when the run errored before producing test results. */
  readonly error?: ExecutionErrorInfo;
}
