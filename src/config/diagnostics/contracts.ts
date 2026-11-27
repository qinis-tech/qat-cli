/**
 * Configuration diagnostic contracts.
 *
 * The shared vocabulary for the two QAT configuration checks. Everything the
 * rules, the evidence builder and the tests need to agree on lives here, so
 * that a reason code cannot mean one thing in `classify.ts` and something else
 * in `guidance.ts`.
 *
 * Rules for this file
 * ───────────────────
 *  • Types and frozen constant tables only — no logic, no I/O, no imports that
 *    pull in behaviour.
 *  • Read-only throughout, so a diagnostic can be handed to a renderer, a JSON
 *    serialiser or a persisted session without anyone mutating it.
 *  • Every reason code names exactly one owner check, so two rules can never
 *    both claim to have found the same problem.
 *  • No field here is allowed to carry a configuration *value*. Evidence holds
 *    paths, counts, enumerations and type summaries — some configuration values
 *    are secrets.
 */

/* ------------------------------------------------------------------------- *
 * Diagnostic vocabulary
 *
 * These mirror the shared diagnostic result contract. If the shared contract
 * exports equivalent names, re-export those instead of these aliases; a
 * type-level assignability test guards the two from drifting apart.
 * ------------------------------------------------------------------------- */

/** Stable identifiers of the configuration checks. */
export type QatConfigCheckId = "CFG-001" | "CFG-002";

/**
 * Outcome of a check evaluation.
 *
 * `skipped` is distinct from `pass` and `fail` on purpose: it records that a
 * prerequisite was not established, and therefore that no verdict was reached.
 */
export type DiagnosticStatus = "pass" | "fail" | "indeterminate" | "skipped";

/**
 * Urgency of a finding, independent of its status.
 *
 * `indeterminate` findings are always at most `warning`: an unanswered question
 * must not block a command that might otherwise work.
 */
export type DiagnosticSeverity = "error" | "warning" | "information";

/** The six configuration states a finding can describe. */
export type QatConfigState =
  | "missing"
  | "inaccessible"
  | "malformed"
  | "version-unsupported"
  | "schema-invalid"
  | "valid";

/* ------------------------------------------------------------------------- *
 * Reasons
 * ------------------------------------------------------------------------- */

/**
 * Why a configuration finding was produced.
 *
 * One code per *actionable* situation, not one per code path: two situations
 * that need the same fix share a code, and two that need different fixes never
 * do. That is what makes remediation possible without guessing.
 */
export type QatConfigReason =
  /** No configuration file at the project root. Optional capability: defaults apply. */
  | "QAT_CONFIG_MISSING"
  /** No configuration file, and the invoking operation cannot proceed without one. */
  | "QAT_CONFIG_MISSING_REQUIRED"
  /** A file is present but could not be read: permissions, a directory, a symlink loop, too large. */
  | "QAT_CONFIG_UNREADABLE"
  /** A file is present and readable, but is not valid JSON. */
  | "QAT_CONFIG_MALFORMED"
  /** The declared schema version is outside the supported set. */
  | "QAT_CONFIG_VERSION_UNSUPPORTED"
  /** The declared schema version is absent or not a number. */
  | "QAT_CONFIG_VERSION_INVALID"
  /** The schema rejected one or more fields. */
  | "QAT_CONFIG_SCHEMA_INVALID"
  /** A declared output path is absolute, escapes the project, or is otherwise not portable. */
  | "QAT_CONFIG_OUTPUT_PATH_INVALID"
  /** The declared framework identifier is not one QAT can run. */
  | "QAT_CONFIG_FRAMEWORK_UNSUPPORTED"
  /** Parsed, version-checked, schema-valid and resolved. */
  | "QAT_CONFIG_VALID";

/* ------------------------------------------------------------------------- *
 * Findings
 * ------------------------------------------------------------------------- */

/**
 * One validation problem, reduced to what is safe to print.
 *
 * `path` is the address a user can act on; `received` is a *type summary* such
 * as "string" or "array(2)", never the value itself.
 */
export interface ConfigDiagnosticIssue {
  /** Dotted field path from the configuration root, e.g. "reports.directory". */
  readonly path: string;
  /** Stable code from the schema layer, e.g. "invalid_type". */
  readonly code: string;
  /** What the schema expected, in our words, so wording changes cannot drift. */
  readonly expected: string;
  /** Type-level summary of what was found; null when nothing safe can be said. */
  readonly received: string | null;
}

/** A primitive that is safe to place in evidence after redaction. */
export type ConfigEvidenceValue =
  string | number | boolean | null | readonly string[];

/**
 * Evidence attached to a configuration finding.
 *
 * Contract: sufficient to understand and act on the finding, insufficient to
 * reconstruct the configuration. Paths are project-relative so an absolute home
 * directory never reaches a CI log; values are summarised, never echoed.
 */
export interface ConfigEvidence {
  /** Project-relative path of the file inspected, or "." when nothing was found. */
  readonly path: string;
  /** Declared schema version, when it was a usable number. */
  readonly schemaVersion: number | null;
  /** Declared framework identifier, when it is one of the supported values. */
  readonly framework: string | null;
  /** Field-level issues; empty for every reason except schema-invalid. */
  readonly issues: readonly ConfigDiagnosticIssue[];
  /** Check that must pass before this finding could be produced. */
  readonly prerequisite: QatConfigCheckId | null;
  /** Additional redacted, non-secret facts, keyed by a stable name. */
  readonly details: Readonly<Record<string, ConfigEvidenceValue>>;
}

/**
 * A single configuration finding.
 *
 * Shape mirrors the shared diagnostic result so the collector, the terminal
 * renderer and the JSON formatter all consume one structure.
 */
export interface ConfigDiagnostic {
  readonly id: QatConfigCheckId;
  readonly title: string;
  readonly category: "configuration";
  readonly status: DiagnosticStatus;
  readonly severity: DiagnosticSeverity;
  readonly reason: QatConfigReason;
  /** Human-readable explanation of the observed state, with no values echoed. */
  readonly explanation: string;
  /** Next step in concrete terms; null when there is nothing to fix. */
  readonly remediation: string | null;
  readonly evidence: ConfigEvidence;
  /** ISO 8601 UTC timestamp of the evaluation. */
  readonly executedAt: string;
}

/* ------------------------------------------------------------------------- *
 * Ownership and severity policy
 *
 * Declared as data so the rules, the catalogue and the tests read the same
 * table. If a reason needs a different owner or a different default severity,
 * there is exactly one line to change.
 * ------------------------------------------------------------------------- */

/** Which check reports each reason. One owner, always. */
export const REASON_OWNER = {
  QAT_CONFIG_MISSING: "CFG-001",
  QAT_CONFIG_MISSING_REQUIRED: "CFG-001",
  QAT_CONFIG_UNREADABLE: "CFG-001",
  QAT_CONFIG_MALFORMED: "CFG-001",
  QAT_CONFIG_VERSION_UNSUPPORTED: "CFG-002",
  QAT_CONFIG_VERSION_INVALID: "CFG-002",
  QAT_CONFIG_SCHEMA_INVALID: "CFG-002",
  QAT_CONFIG_OUTPUT_PATH_INVALID: "CFG-002",
  QAT_CONFIG_FRAMEWORK_UNSUPPORTED: "CFG-002",
  QAT_CONFIG_VALID: "CFG-002",
} as const satisfies Record<QatConfigReason, QatConfigCheckId>;

/**
 * Default severity per reason.
 *
 * `QAT_CONFIG_MISSING` is the only conditional entry: absent configuration is
 * an Information observation when the operation can proceed on documented
 * defaults, and an Error when it cannot. The caller decides which, and sets the
 * severity accordingly; this table records the default so the two call sites
 * cannot disagree about which is the "normal" case.
 */
export const DEFAULT_SEVERITY = {
  QAT_CONFIG_MISSING: "information",
  QAT_CONFIG_MISSING_REQUIRED: "error",
  QAT_CONFIG_UNREADABLE: "error",
  QAT_CONFIG_MALFORMED: "error",
  QAT_CONFIG_VERSION_UNSUPPORTED: "error",
  QAT_CONFIG_VERSION_INVALID: "error",
  QAT_CONFIG_SCHEMA_INVALID: "error",
  QAT_CONFIG_OUTPUT_PATH_INVALID: "error",
  QAT_CONFIG_FRAMEWORK_UNSUPPORTED: "error",
  QAT_CONFIG_VALID: "information",
} as const satisfies Record<QatConfigReason, DiagnosticSeverity>;

/**
 * Prerequisite each reason depends on.
 *
 * Anything schema-related requires a parseable, readable file first. Encoding
 * that here keeps the skip logic declarative instead of scattered through the
 * rules.
 */
export const REASON_PREREQUISITE = {
  QAT_CONFIG_MISSING: null,
  QAT_CONFIG_MISSING_REQUIRED: null,
  QAT_CONFIG_UNREADABLE: null,
  QAT_CONFIG_MALFORMED: null,
  QAT_CONFIG_VERSION_UNSUPPORTED: "CFG-001",
  QAT_CONFIG_VERSION_INVALID: "CFG-001",
  QAT_CONFIG_SCHEMA_INVALID: "CFG-001",
  QAT_CONFIG_OUTPUT_PATH_INVALID: "CFG-001",
  QAT_CONFIG_FRAMEWORK_UNSUPPORTED: "CFG-001",
  QAT_CONFIG_VALID: "CFG-001",
} as const satisfies Record<QatConfigReason, QatConfigCheckId | null>;

/** Human titles, used by both rules and the catalogue so they cannot diverge. */
export const CHECK_TITLE = {
  "CFG-001": "QAT configuration exists and is readable",
  "CFG-002": "QAT configuration schema valid",
} as const satisfies Record<QatConfigCheckId, string>;
