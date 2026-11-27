/**
 * Classification of a configuration inspection into diagnostic findings.
 *
 * This is the join between "what the configuration pipeline observed" and
 * "what the doctor reports". It is deliberately pure: it receives an immutable
 * inspection result and pure guidance, and returns immutable findings. No
 * filesystem, no clock, no I/O — which is why every state and every reason can
 * be exercised from a plain object literal in a unit test.
 *
 * Two ideas carry the whole file
 * ──────────────────────────────
 *  1. The *state* decides the finding; the *reason* decides the sentence.
 *     A state is what we observed; a reason is what a person can act on. One
 *     state can yield different reasons (a schema failure caused by the
 *     `framework` field is a different problem from one caused by a reports
 *     path), and that difference is the difference between a useful message
 *     and a shrug.
 *
 *  2. A check whose prerequisite failed is SKIPPED, never failed.
 *     Reporting "schema invalid" because the file could not be read is a
 *     fabricated finding. The skipped diagnostic names the blocker so the user
 *     fixes one thing rather than guessing at five.
 *
 * A finding exists only where there is something to say
 * ─────────────────────────────────────────────────────
 * This function does not return one finding per check. It returns the findings
 * the observation *earns*:
 *
 *   missing / inaccessible / malformed   CFG-001 reports, CFG-002 is skipped
 *   version-unsupported                  CFG-002 reports, CFG-001 is silent
 *   schema-invalid                       CFG-002 reports, CFG-001 is silent
 *   valid                                neither reports
 *
 * Silence is how a pass is expressed in this vocabulary. A configuration that
 * was read successfully has nothing to tell the reader, and manufacturing a
 * "readable" row so that both checks always appear would put a line in every
 * report that says nothing and costs a reader attention on every run.
 */

import type { ConfigInspection, ConfigIssue } from "../inspect.js";

import type {
  ConfigDiagnostic,
  ConfigDiagnosticIssue,
  ConfigEvidence,
  ConfigEvidenceValue,
  DiagnosticStatus,
  QatConfigCheckId,
  QatConfigReason,
  QatConfigState,
} from "./contracts.js";
import { CHECK_TITLE, DEFAULT_SEVERITY } from "./contracts.js";

/**
 * Guidance is injected, not embedded.
 *
 * All user-facing prose lives in one catalogue, so wording can be reviewed,
 * translated or shortened without touching classification logic — and so this
 * file stays a deterministic function of its inputs.
 */
export interface ConfigGuidancePort {
  /** Explanation of an observed state. Receives only safe, non-secret context. */
  readonly explain: (input: GuidanceInput) => string;
  /** Actionable next step, or null when there is nothing to fix. */
  readonly remediate: (input: GuidanceInput) => string | null;
}

/** Safe context handed to guidance. Contains no configuration values. */
export interface GuidanceInput {
  readonly reason: QatConfigReason;
  /** Project-relative path of the file inspected, or "." when absent. */
  readonly path: string;
  /** Field paths implicated by the finding; empty for non-field reasons. */
  readonly fields: readonly string[];
  /** Supported schema versions, for the version-related reasons. */
  readonly supportedVersions: readonly number[];
  /** True when the invoking operation cannot proceed without configuration. */
  readonly required: boolean;
}

export interface ClassifyOptions {
  /**
   * Whether the invoking operation requires configuration.
   *
   * This is a property of the operation, not of the file: `qat doctor` runs
   * happily with no configuration at all, `qat run` does not. Passing it in
   * keeps this function pure and makes the conditional severity visible at the
   * call site instead of hidden behind a lookup.
   */
  readonly required: boolean;
  readonly guidance: ConfigGuidancePort;
  /** Injected for deterministic timestamps in tests. */
  readonly now?: () => string;
}

/**
 * Configuration roots whose values are filesystem locations.
 *
 * A schema failure underneath one of these is almost always a path-shape
 * problem (absolute, escaping the project, Windows-only separators), which has
 * a specific fix. Extending this list is the only change needed when the schema
 * grows another path-bearing section.
 *
 * This list lives here and nowhere else. It is consulted by
 * `primaryReasonForIssues` below, which is exported precisely so that a check
 * needing "which field is the headline?" gets this answer rather than inventing
 * a second one that drifts the first time the schema grows a section.
 */
const PATH_BEARING_ROOTS: readonly string[] = [
  "reports",
  "evidence",
  "artifacts",
  "output",
];

/**
 * Projects one inspection into the findings it earns.
 *
 * Called once per read, so both configuration checks describe the same instant
 * of the same file. See the note at the top of this file for which checks report
 * in which state — a pass is silence, not a row.
 */
export function classifyConfiguration(
  inspection: ConfigInspection,
  options: ClassifyOptions,
): readonly ConfigDiagnostic[] {
  const timestamp = (options.now ?? defaultNow)();

  switch (inspection.state) {
    /* ── Nothing to read: CFG-002 cannot be evaluated ────────────────────── */
    case "missing": {
      // Optional capability → a positive observation with Information severity.
      // Required → a blocking Error. Same observation, different consequence,
      // so they are distinct reasons rather than one reason with a flag.
      const reason: QatConfigReason = options.required
        ? "QAT_CONFIG_MISSING_REQUIRED"
        : "QAT_CONFIG_MISSING";

      const discovery = finding(inspection.state, reason, {
        path: inspection.searchedAt,
        fields: [],
        inspection,
        options,
        timestamp,
      });

      return [
        discovery,
        skipped(
          "CFG-002",
          inspection.state,
          reason,
          inspection.searchedAt,
          timestamp,
        ),
      ];
    }

    case "inaccessible":
      return [
        finding(inspection.state, "QAT_CONFIG_UNREADABLE", {
          path: inspection.path,
          fields: [],
          inspection,
          options,
          timestamp,
        }),
        skipped(
          "CFG-002",
          inspection.state,
          "QAT_CONFIG_UNREADABLE",
          inspection.path,
          timestamp,
        ),
      ];

    case "malformed":
      return [
        finding(inspection.state, "QAT_CONFIG_MALFORMED", {
          path: inspection.path,
          fields: [],
          inspection,
          options,
          timestamp,
        }),
        skipped(
          "CFG-002",
          inspection.state,
          "QAT_CONFIG_MALFORMED",
          inspection.path,
          timestamp,
        ),
      ];

    /* ── Readable but not interpretable: one blocked finding, no field dump ─ */
    case "version-unsupported":
      // CFG-001 stays silent: the bytes arrived, which is all it asked. A wall of
      // field complaints would also be wrong here — there is nothing meaningful
      // to say about fields in a document whose version we cannot interpret.
      return [
        finding(inspection.state, "QAT_CONFIG_VERSION_UNSUPPORTED", {
          path: inspection.path,
          fields: [],
          inspection,
          options,
          timestamp,
        }),
      ];

    /* ── Readable and interpretable: field-level findings ────────────────── */
    case "schema-invalid": {
      const fields = inspection.issues.map(issuePath);

      // Again one finding: the document was obtained, so CFG-001 has nothing to
      // report, and the specific field is CFG-002's to name.
      return [
        finding(inspection.state, primaryReasonForIssues(inspection.issues), {
          path: inspection.path,
          fields,
          inspection,
          options,
          timestamp,
        }),
      ];
    }

    case "valid":
      // Both checks pass and neither speaks. See the note at the top of the file.
      return [
        finding(inspection.state, "QAT_CONFIG_VALID", {
          path: inspection.path,
          fields: [],
          inspection,
          options,
          timestamp,
        }),
      ];
  }
}

/* ------------------------------------------------------------------------- *
 * Reason selection
 * ------------------------------------------------------------------------- */

/**
 * Chooses the *primary* reason for a schema failure.
 *
 * Ordered by what a user needs to fix first:
 *   1. an unusable `schemaVersion` — nothing else about the file can be trusted;
 *   2. an unusable `framework` — the wrong tool entirely;
 *   3. a path-shaped field under a path-bearing root — a specific, common fix;
 *   4. everything else — the generic field report.
 *
 * All issues are still carried in evidence regardless of the primary reason, so
 * nothing observed is hidden from the reader.
 *
 * Exported because the validity check needs exactly this decision and must not
 * make its own. It owns the path-bearing-section list; a check re-deriving the
 * ordering would be a second answer to "which field matters most", and the two
 * would diverge the first time the schema grew a section — with the divergence
 * appearing as two reports naming different fields for one file.
 *
 * Total by construction: every path through this function returns a reason, and
 * the general case is a real answer rather than a fallback.
 */
export function primaryReasonForIssues(
  issues: readonly ConfigIssue[],
): QatConfigReason {
  const paths = issues.map(issuePath);

  if (paths.some((path) => path === "schemaVersion"))
    return "QAT_CONFIG_VERSION_INVALID";
  if (paths.some((path) => path === "framework"))
    return "QAT_CONFIG_FRAMEWORK_UNSUPPORTED";
  if (paths.some(isPathBearingField)) return "QAT_CONFIG_OUTPUT_PATH_INVALID";

  return "QAT_CONFIG_SCHEMA_INVALID";
}

function isPathBearingField(path: string): boolean {
  // Indexed access is `string | undefined` under noUncheckedIndexedAccess;
  // a path with no root cannot be path-bearing, so the empty default is safe.
  const root = path.split(".")[0] ?? "";
  return PATH_BEARING_ROOTS.includes(root);
}

/* ------------------------------------------------------------------------- *
 * Finding construction
 * ------------------------------------------------------------------------- */

interface FindingContext {
  readonly path: string;
  readonly fields: readonly string[];
  readonly inspection: ConfigInspection;
  readonly options: ClassifyOptions;
  readonly timestamp: string;
}

/**
 * Builds one finding from a state, a reason and safe context.
 *
 * Status and severity are derived, never passed in: they follow from the reason
 * through the shared tables in `contracts.ts`, so a rule cannot accidentally
 * report a blocking configuration problem as information.
 */
function finding(
  state: QatConfigState,
  reason: QatConfigReason,
  context: FindingContext,
): ConfigDiagnostic {
  const id: QatConfigCheckId = ownerOf(reason);

  const guidanceInput: GuidanceInput = {
    reason,
    path: context.path,
    fields: context.fields,
    supportedVersions: supportedVersionsOf(context.inspection),
    required: context.options.required,
  };

  return Object.freeze({
    id,
    title: CHECK_TITLE[id],
    category: "configuration" as const,
    status: statusFor(reason),
    severity: DEFAULT_SEVERITY[reason],
    reason,
    explanation: context.options.guidance.explain(guidanceInput),
    remediation: context.options.guidance.remediate(guidanceInput),
    evidence: evidenceFor(state, reason, context),
    executedAt: context.timestamp,
  });
}

/**
 * Builds the `skipped` companion for a check whose prerequisite failed.
 *
 * The reason is echoed from the blocker rather than invented: it is the fact
 * that prevented evaluation. `evidence.prerequisite` is what tells a reader —
 * and any future automated triage — which single finding to act on first.
 */
function skipped(
  id: QatConfigCheckId,
  state: QatConfigState,
  reason: QatConfigReason,
  path: string,
  timestamp: string,
): ConfigDiagnostic {
  return Object.freeze({
    id,
    title: CHECK_TITLE[id],
    category: "configuration" as const,
    status: "skipped" as const,
    // Never blocks: an unevaluated check carries no verdict to act on.
    severity: "information" as const,
    reason,
    explanation: `Not evaluated: the configuration is ${state}, so there is nothing to validate.`,
    remediation: null,
    evidence: Object.freeze({
      path,
      schemaVersion: null,
      framework: null,
      issues: Object.freeze([]),
      prerequisite: "CFG-001" as const,
      details: Object.freeze({ state }),
    }),
    executedAt: timestamp,
  });
}

/* ------------------------------------------------------------------------- *
 * Derivations
 * ------------------------------------------------------------------------- */

/** Status follows the reason; there is no path where a caller overrides it. */
function statusFor(reason: QatConfigReason): DiagnosticStatus {
  switch (reason) {
    // Absent configuration with documented defaults is a positive observation,
    // not a pass we merely tolerate: nothing is wrong.
    case "QAT_CONFIG_MISSING":
    case "QAT_CONFIG_VALID":
      return "pass";
    default:
      return "fail";
  }
}

/** Which check owns a reason. Kept local so `contracts.ts` stays dependency-free. */
function ownerOf(reason: QatConfigReason): QatConfigCheckId {
  switch (reason) {
    case "QAT_CONFIG_MISSING":
    case "QAT_CONFIG_MISSING_REQUIRED":
    case "QAT_CONFIG_UNREADABLE":
    case "QAT_CONFIG_MALFORMED":
      return "CFG-001";
    default:
      return "CFG-002";
  }
}

function supportedVersionsOf(inspection: ConfigInspection): readonly number[] {
  return inspection.state === "version-unsupported" ? inspection.supported : [];
}

/**
 * Assembles evidence: paths, counts, enumerations and type summaries only.
 *
 * Every value here is either a path we have already made project-relative or a
 * scalar from a closed set. Configuration values never reach this function.
 *
 * `details` is keyed dynamically, so its members are read and written with
 * bracket syntax — required by `noPropertyAccessFromIndexSignature`, and a
 * useful reminder at the call site that these keys are not a fixed contract.
 */
function evidenceFor(
  state: QatConfigState,
  reason: QatConfigReason,
  context: FindingContext,
): ConfigEvidence {
  const details: Record<string, ConfigEvidenceValue> = { state };

  switch (context.inspection.state) {
    case "inaccessible":
      details["code"] = context.inspection.code;
      break;

    case "malformed":
      // Position only — the parser's message could quote the file.
      if (context.inspection.line !== undefined)
        details["line"] = context.inspection.line;
      if (context.inspection.column !== undefined)
        details["column"] = context.inspection.column;
      break;

    case "version-unsupported":
      details["declared"] =
        typeof context.inspection.declared === "number"
          ? context.inspection.declared
          : null;
      details["supported"] = context.inspection.supported.map(String);
      break;

    case "schema-invalid":
      details["issueCount"] = context.inspection.issues.length;
      break;

    case "valid":
      details["framework"] = safeFramework(context.inspection.config);
      break;

    case "missing":
      break;
  }

  return Object.freeze({
    path: context.path,
    schemaVersion: schemaVersionOf(context.inspection),
    framework: frameworkOf(context.inspection),
    issues: Object.freeze(
      context.inspection.state === "schema-invalid"
        ? context.inspection.issues.map(toDiagnosticIssue)
        : [],
    ),
    prerequisite: prerequisiteFor(reason),
    details: Object.freeze(details),
  });
}

/**
 * Reduces a schema issue to what is safe to print.
 *
 * The received value is summarised as a *type*, never echoed: a configuration
 * issue can sit on a secret-adjacent field, and a diagnostic that quotes it is
 * a leak waiting for a shared CI log.
 */
function toDiagnosticIssue(issue: ConfigIssue): ConfigDiagnosticIssue {
  return Object.freeze({
    path: issuePath(issue),
    code: issue.code,
    expected: expectedFor(issue.code),
    received: receivedSummary(issue.code),
  });
}

/** Stable wording per issue code, so dependency phrasing cannot drift into output. */
function expectedFor(code: string): string {
  switch (code) {
    case "invalid_type":
      return "a value of the declared type";
    case "unrecognized_keys":
      return "no unknown properties";
    case "invalid_enum_value":
      return "one of the supported values";
    case "too_small":
      return "a value within the permitted range";
    case "custom":
      return "a value satisfying the documented constraint";
    default:
      return "a value that satisfies the configuration schema";
  }
}

function receivedSummary(code: string): string | null {
  // Type-level only. Deliberately independent of the actual value.
  switch (code) {
    case "invalid_type":
      return "a value of a different type";
    case "unrecognized_keys":
      return "an object carrying unknown properties";
    case "invalid_enum_value":
      return "an unsupported value";
    default:
      return null;
  }
}

function issuePath(issue: ConfigIssue): string {
  return issue.path.length === 0 ? "<root>" : issue.path.join(".");
}

function prerequisiteFor(reason: QatConfigReason): QatConfigCheckId | null {
  switch (reason) {
    case "QAT_CONFIG_MISSING":
    case "QAT_CONFIG_MISSING_REQUIRED":
    case "QAT_CONFIG_UNREADABLE":
    case "QAT_CONFIG_MALFORMED":
      return null;
    default:
      return "CFG-001";
  }
}

/** Version is a number only when it was usable; otherwise it is unknown. */
function schemaVersionOf(inspection: ConfigInspection): number | null {
  switch (inspection.state) {
    case "valid":
    case "schema-invalid":
      return inspection.version >= 0 ? inspection.version : null;
    default:
      return null;
  }
}

/** Framework is echoed only when it is a plain identifier, never an object. */
function frameworkOf(inspection: ConfigInspection): string | null {
  return inspection.state === "valid" ? safeFramework(inspection.config) : null;
}

function safeFramework(config: unknown): string | null {
  if (typeof config !== "object" || config === null) return null;
  // Bracket access is mandatory here under noPropertyAccessFromIndexSignature.
  const framework = (config as Record<string, unknown>)["framework"];
  return typeof framework === "string" ? framework : null;
}

function defaultNow(): string {
  return new Date().toISOString();
}
