/**
 * Reporting model for QAT configuration health.
 *
 * Why this exists
 * ───────────────
 * The checks produce individual findings; the terminal renderer, the JSON
 * formatter, the persisted diagnostic session and any future report all need the
 * same *shape* of answer to one question: "how healthy is this project's QAT
 * configuration, and what is blocking it?"
 *
 * Without a model, each consumer re-derives that answer — and re-implementing
 * "is this blocked?" three times means three slightly different definitions,
 * which is how a JSON report and a terminal line end up disagreeing about the
 * same run.
 *
 * What this file is not
 * ─────────────────────
 * It holds no validation logic, no file access and no prose. It aggregates
 * findings that have already been classified and already been redacted, and it
 * stores nothing that could carry a configuration value: every field below is an
 * identifier, a count, a severity, or a project-relative path.
 *
 * The model is immutable and deterministic — the same findings always produce an
 * equal model — so it can be snapshotted in tests and diffed between runs.
 *
 * A note on `DiagnosticSeverity`
 * ──────────────────────────────
 * This file imports it from `config/diagnostics`, where it has three members
 * (`information`, `warning`, `error`), not from `core/application/diagnostics`,
 * where it has two. The two are deliberately different vocabularies for different
 * questions — a *finding's* loudness versus a *check's* blocking weight — and the
 * import site is the only thing that says which one is meant. A reader who
 * "tidies" this import will lose the `information` rank and silently change every
 * `overall` computation.
 */

import type {
  ConfigDiagnostic,
  ConfigDiagnosticIssue,
  DiagnosticSeverity,
  DiagnosticStatus,
  QatConfigCheckId,
  QatConfigReason,
} from "../../config/diagnostics/index.js";

/* ------------------------------------------------------------------------- *
 * Vocabulary
 * ------------------------------------------------------------------------- */

/**
 * The single answer a consumer needs.
 *
 * Ordered from best to worst; the builder picks the worst that applies, so a
 * single blocking check cannot be masked by an informational one.
 */
export type ConfigurationOverall =
  /** Every configuration check reached a verdict and nothing failed. */
  | "healthy"
  /** Only warnings — worth reading, nothing is blocked. */
  | "degraded"
  /** At least one Error finding. The next command will fail without a fix. */
  | "blocked"
  /** Nothing could be evaluated: no verdict exists either way. */
  | "unknown";

/** What was found at the configuration location, independent of validity. */
export type ConfigurationFileState =
  "present" | "absent" | "unreadable" | "malformed" | "unknown";

/* ------------------------------------------------------------------------- *
 * Model
 * ------------------------------------------------------------------------- */

/** One check, flattened for rendering. */
export interface ConfigurationCheckSummary {
  readonly id: QatConfigCheckId;
  readonly title: string;
  readonly status: DiagnosticStatus;
  readonly severity: DiagnosticSeverity;
  readonly reason: QatConfigReason;
  /** True when this finding, on its own, prevents the next command from running. */
  readonly blocking: boolean;
}

/** Location facts. Paths are project-relative and already safe to print. */
export interface ConfigurationFileFacts {
  readonly state: ConfigurationFileState;
  /** Relative path of the file inspected, or "." when nothing was found. */
  readonly path: string;
}

/** Schema facts, surfaced so a report can state what was accepted. */
export interface ConfigurationSchemaFacts {
  /** Declared schema version, when it was a usable number. */
  readonly version: number | null;
  /** Framework identifier, when it is one of the supported values. */
  readonly framework: string | null;
  /** Field-level issues, already reduced to safe paths and type summaries. */
  readonly issues: readonly ConfigDiagnosticIssue[];
}

/** The aggregate answer produced once per doctor run. */
export interface QatConfigurationHealth {
  readonly overall: ConfigurationOverall;
  /** Checks in canonical order, so two renderers list them identically. */
  readonly checks: readonly ConfigurationCheckSummary[];
  /** Identifiers of the findings that block. Empty when nothing is blocking. */
  readonly blocking: readonly QatConfigCheckId[];
  /** Identifiers of checks that reached no verdict. Never counted as healthy. */
  readonly unverified: readonly QatConfigCheckId[];
  readonly file: ConfigurationFileFacts;
  readonly schema: ConfigurationSchemaFacts;
  /** ISO 8601 UTC timestamp of the earliest finding in this set. */
  readonly evaluatedAt: string;
}

/* ------------------------------------------------------------------------- *
 * Constants
 * ------------------------------------------------------------------------- */

/**
 * Canonical display order.
 *
 * Discovery before validity, because that is the order a person fixes them: you
 * cannot correct a field in a file you cannot open. Any check not listed here is
 * appended after these in identifier order, so adding a third check needs no
 * change to this file's ordering logic.
 */
export const CONFIG_CHECK_ORDER: readonly QatConfigCheckId[] = [
  "CFG-001",
  "CFG-002",
];

/** Severity ranking used for the worst-of computation. */
const SEVERITY_RANK: Readonly<Record<DiagnosticSeverity, number>> = {
  information: 0,
  warning: 1,
  error: 2,
};

/* ------------------------------------------------------------------------- *
 * Builder
 * ------------------------------------------------------------------------- */

/**
 * Aggregates configuration findings into the reporting model.
 *
 * Assumes findings have already been classified and their evidence shaped. The
 * builder is total: it accepts an empty array (a run where the configuration
 * category was filtered out) and returns an `unknown` model rather than throwing,
 * because a report that cannot render an empty category is not a report.
 *
 * @throws if two findings share an identifier — that is a programming error in
 * the check registration, and silently keeping one of them would hide a check
 * that never ran.
 */
export function buildQatConfigurationHealth(
  findings: readonly ConfigDiagnostic[],
): QatConfigurationHealth {
  const ordered = orderChecks(findings);
  assertDistinctIds(ordered);

  const checks: readonly ConfigurationCheckSummary[] = Object.freeze(
    ordered.map((finding) => toCheckSummary(finding)),
  );

  return Object.freeze({
    overall: overallOf(checks),
    checks,
    blocking: Object.freeze(
      checks.filter((check) => check.blocking).map((check) => check.id),
    ),
    unverified: Object.freeze(
      checks
        .filter(
          (check) =>
            check.status === "skipped" || check.status === "indeterminate",
        )
        .map((check) => check.id),
    ),
    file: fileFactsOf(ordered),
    schema: schemaFactsOf(ordered),
    evaluatedAt: earliestTimestamp(ordered),
  });
}

/* ------------------------------------------------------------------------- *
 * Derivations
 * ------------------------------------------------------------------------- */

/**
 * A finding blocks only when it both failed and carries Error severity.
 *
 * Both conditions matter: an Error-severity finding whose status is `skipped` is
 * an unevaluated check, and an unevaluated check must not stop a command that
 * has nothing wrong with it.
 */
function toCheckSummary(finding: ConfigDiagnostic): ConfigurationCheckSummary {
  return Object.freeze({
    id: finding.id,
    title: finding.title,
    status: finding.status,
    severity: finding.severity,
    reason: finding.reason,
    blocking: finding.status === "fail" && finding.severity === "error",
  });
}

/**
 * Worst-of, computed from the summaries rather than from the raw findings so
 * that there is exactly one definition of "blocking" in the product.
 */
function overallOf(
  checks: readonly ConfigurationCheckSummary[],
): ConfigurationOverall {
  if (checks.length === 0) return "unknown";
  if (checks.some((check) => check.blocking)) return "blocked";
  if (
    checks.every(
      (check) => check.status === "skipped" || check.status === "indeterminate",
    )
  ) {
    return "unknown";
  }

  // The accumulator is `highest`, not `worst`. It used to be `worst`, which
  // shadowed the `const worst` below and made `no-shadow` fail: one name for the
  // running maximum and for the final value reads fine in prose and is a lint
  // error in TypeScript, because the outer binding is in scope for the callback.
  const worst = checks.reduce(
    (highest, check) => Math.max(highest, SEVERITY_RANK[check.severity]),
    0,
  );

  return worst >= SEVERITY_RANK.warning ? "degraded" : "healthy";
}

/**
 * Derives the file-state fact from the reason, which is where the observation
 * actually lives. Mapping it once here keeps renderers from re-decoding reason
 * codes into presentation states.
 */
function fileFactsOf(
  findings: readonly ConfigDiagnostic[],
): ConfigurationFileFacts {
  const primary =
    findings.find((finding) => finding.id === "CFG-001") ?? findings[0];

  if (primary === undefined) {
    return Object.freeze({ state: "unknown" as const, path: "." });
  }

  return Object.freeze({
    state: fileStateFor(primary.reason),
    path: primary.evidence.path,
  });
}

function fileStateFor(reason: QatConfigReason): ConfigurationFileState {
  switch (reason) {
    case "QAT_CONFIG_MISSING":
    case "QAT_CONFIG_MISSING_REQUIRED":
      return "absent";
    case "QAT_CONFIG_UNREADABLE":
      return "unreadable";
    case "QAT_CONFIG_MALFORMED":
      return "malformed";
    default:
      return "present";
  }
}

/**
 * Collects schema facts from whichever finding carried them.
 *
 * The version and framework live on the evidence of the schema check when it
 * could evaluate, and are null otherwise. Taking the first non-null across the
 * set keeps this resilient to a future split into more than two checks.
 */
function schemaFactsOf(
  findings: readonly ConfigDiagnostic[],
): ConfigurationSchemaFacts {
  const version =
    findings.find((finding) => finding.evidence.schemaVersion !== null)
      ?.evidence.schemaVersion ?? null;
  const framework =
    findings.find((finding) => finding.evidence.framework !== null)?.evidence
      .framework ?? null;
  const issues = findings.flatMap((finding) => finding.evidence.issues);

  return Object.freeze({
    version,
    framework,
    issues: Object.freeze(issues),
  });
}

/**
 * Timestamps can differ by a millisecond between checks; the report states the
 * earliest so that "when did this run look at my configuration?" has one answer.
 */
function earliestTimestamp(findings: readonly ConfigDiagnostic[]): string {
  const timestamps = findings.map((finding) => finding.executedAt).sort();
  return timestamps[0] ?? "";
}

/* ------------------------------------------------------------------------- *
 * Ordering and guards
 * ------------------------------------------------------------------------- */

function orderChecks(
  findings: readonly ConfigDiagnostic[],
): readonly ConfigDiagnostic[] {
  const rank = (id: QatConfigCheckId): number => {
    const index = CONFIG_CHECK_ORDER.indexOf(id);
    return index === -1 ? CONFIG_CHECK_ORDER.length : index;
  };

  return [...findings].sort(
    (a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id),
  );
}

/**
 * Refuses a set with two findings for one check.
 *
 * A duplicate means the registration produced the same identifier twice, and
 * keeping the first would silently hide a check — the report would show one row
 * where two questions were asked. Throwing here is the only option that cannot
 * be mistaken for a verdict about the project.
 */
function assertDistinctIds(findings: readonly ConfigDiagnostic[]): void {
  const seen = new Set<string>();

  for (const finding of findings) {
    if (seen.has(finding.id)) {
      throw new Error(`Duplicate configuration finding for ${finding.id}.`);
    }
    seen.add(finding.id);
  }
}
