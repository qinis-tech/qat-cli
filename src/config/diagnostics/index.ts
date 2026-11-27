/**
 * Public surface of the configuration diagnostics module.
 *
 * What this module is
 * ───────────────────
 * A projection layer. It turns the result of the configuration pipeline (see
 * `src/config/inspect.ts`) into the findings the doctor renders, and decides
 * which bytes of that result may be printed. It owns no validation logic of its
 * own: if a schema rule changes, behaviour here changes for free.
 *
 * Why the exports are curated rather than `export *`
 * ────────────────────────────────────────────────
 * A barrel with a wildcard makes every helper part of the contract the moment
 * it is written, and invites callers to reach for internals that were never
 * meant to be stable. Everything below is deliberate: the entry points, the
 * read-only policy tables, the evidence builders, and the types those three
 * require. Anything absent is internal and free to change.
 *
 * Consumers
 * ─────────
 *  • `src/diagnostics/checks/rules/qat-config-*.ts` — the discovery check uses
 *    `classifyConfiguration`; the validity check uses `primaryReasonForIssues`
 *    to learn *which* field the schema objected to, and phrases it itself.
 *  • The guidance catalogue — uses the reason type and policy tables so its
 *    coverage is exhaustive by construction.
 *  • Tests — use the same surface the rules do, never private helpers.
 */

/* ------------------------------------------------------------------------- *
 * Decision
 * ------------------------------------------------------------------------- */

/**
 * `classifyConfiguration` renders both findings at once; `primaryReasonForIssues`
 * answers the narrower question the validity check needs.
 *
 * They are exported together because they answer the same question at two levels
 * of detail, and splitting them across modules would invite a caller to
 * reimplement the coarser one. The path-bearing-section list that `primaryReason`
 * consults lives in `classify.ts` and nowhere else: a check that decided "which
 * field matters most" itself would be a second answer, and the two would diverge
 * the first time the schema grew a section.
 */
export { classifyConfiguration, primaryReasonForIssues } from "./classify.js";
export type {
  ClassifyOptions,
  ConfigGuidancePort,
  GuidanceInput,
} from "./classify.js";

/* ------------------------------------------------------------------------- *
 * Contracts
 *
 * Types describe the vocabulary; the value exports are frozen lookup tables.
 * Both are needed downstream: the rules read the types, while the catalogue and
 * the tests read the tables to stay in step with them.
 * ------------------------------------------------------------------------- */

export type {
  ConfigDiagnostic,
  ConfigDiagnosticIssue,
  ConfigEvidence,
  ConfigEvidenceValue,
  DiagnosticSeverity,
  DiagnosticStatus,
  QatConfigCheckId,
  QatConfigReason,
  QatConfigState,
} from "./contracts.js";

export {
  CHECK_TITLE,
  DEFAULT_SEVERITY,
  REASON_OWNER,
  REASON_PREREQUISITE,
} from "./contracts.js";

/* ------------------------------------------------------------------------- *
 * Evidence
 *
 * Exported because evidence assembly is a shared responsibility: a future
 * configuration check must reuse these builders rather than invent its own
 * path handling or its own idea of what a safe string looks like.
 * ------------------------------------------------------------------------- */

export {
  buildConfigEvidence,
  MAX_EVIDENCE_STRING,
  summariseValue,
  toProjectRelative,
  toSafeIssue,
  truncate,
} from "./evidence.js";
export type { ConfigEvidenceInput, SafeDetailKey } from "./evidence.js";
