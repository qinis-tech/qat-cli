/**
 * Environment classification — inspection facts in, diagnostics out.
 *
 * This is the only place where environment *judgement* happens. `inspect.ts`
 * establishes facts (which profile, which variables, which paths); this file
 * decides what those facts mean, how severe they are, and which of the two
 * environment checks owns each one:
 *
 *   ENV-002  the profile itself — selection, existence, schema validity, paths
 *   ENV-001  the variables that profile references — presence and policy
 *
 * Three decisions are encoded here and nowhere else:
 *
 *  1. "Not selected" is not "invalid". Different status, different severity,
 *     different remediation. Collapsing them is why people are told to fix a
 *     profile they never chose.
 *  2. Severity follows the *declaration*, not QAT's opinion. A missing variable
 *     is blocking only when the profile marked it required; when the
 *     requirement cannot be established it is a Warning, which is exactly the
 *     latitude the diagnostic catalogue allows.
 *  3. A dependent check is SKIPPED with its prerequisite named, never failed.
 *     Reporting "variables missing" for a profile that does not exist is a
 *     fabricated finding.
 *
 * Note the dependency direction: this module knows nothing about the diagnostics
 * package. It emits environment-shaped diagnostics, and the rule layer adapts
 * them to the shared result type. That keeps configuration logic reusable by
 * `qat run`'s preflight, which needs the same verdicts without a doctor.
 */

import type {
  EnvironmentInspection,
  EnvironmentName,
  EnvironmentReason,
  SelectionOrigin,
  VariableRequirement,
  VariableStatus,
} from "../contracts.js";

// ─── Output contract ─────────────────────────────────────────────────────────

/** The two checks this module can speak for. */
export type EnvironmentDiagnosticId = "ENV-001" | "ENV-002";

export type EnvironmentDiagnosticStatus =
  "pass" | "fail" | "indeterminate" | "skipped";

export type EnvironmentDiagnosticSeverity = "error" | "warning" | "information";

/**
 * Evidence payload: names, counts, paths and enum-ish strings only.
 *
 * There is no slot here capable of holding a variable's value, which is what
 * makes "the doctor must not expose resolved secrets" structural rather than
 * aspirational. If a future field needs a value, the field is wrong — the value
 * belongs to the runner.
 */
export type EnvironmentDetail = Readonly<
  Record<string, string | number | readonly string[] | null>
>;

export interface EnvironmentDiagnostic {
  readonly id: EnvironmentDiagnosticId;
  readonly status: EnvironmentDiagnosticStatus;
  readonly severity: EnvironmentDiagnosticSeverity;
  /** What to report, and the key into the remediation catalogue. `null` = nothing to fix. */
  readonly reason: EnvironmentReason | null;
  readonly profile: EnvironmentName | null;
  readonly origin: SelectionOrigin;
  readonly detail: EnvironmentDetail;
}

export interface ClassifyEnvironmentOptions {
  /**
   * Whether the operation being guarded actually needs an environment.
   *
   * Passed in rather than looked up: necessity belongs to the caller's context,
   * not to the configuration file. `qat doctor` can run with no environment
   * selected; `qat run --env staging` cannot.
   */
  readonly required: boolean;
}

// ─── Entry point ─────────────────────────────────────────────────────────────

/**
 * Projects an inspection into diagnostics.
 *
 * Always returns ENV-002 first, then ENV-001, so output ordering is stable and
 * matches the order in which problems must be fixed. A check that could not run
 * appears as `skipped` rather than being omitted — silence would look like
 * success in a summary line.
 */
export function classifyEnvironment(
  inspection: EnvironmentInspection,
  options: ClassifyEnvironmentOptions,
): readonly EnvironmentDiagnostic[] {
  switch (inspection.state) {
    case "not-selected":
      return notSelected(options);

    case "selection-invalid":
      return [
        finding(
          "ENV-002",
          "fail",
          "error",
          "ENV_SELECTION_INVALID",
          null,
          inspection.origin,
          {
            supplied: inspection.raw,
            origin: inspection.origin,
          },
        ),
        skipped("ENV-001", "ENV-002", null, inspection.origin),
      ];

    case "profile-not-found":
      return profileNotFound(inspection);

    case "profile-invalid":
      return profileInvalid(inspection);

    case "profile-valid":
      return profileValid(inspection);

    default:
      // Unreachable for a well-typed union; present so a widened inspection
      // fails to compile here rather than silently reporting nothing.
      return assertNever(inspection);
  }
}

// ─── States ──────────────────────────────────────────────────────────────────

/**
 * Nothing was supplied anywhere — no `--env`, no `QAT_ENV`, no default.
 *
 * Not a defect: many projects have no environment-specific settings at all. It
 * is also not a pass, because nothing was verified — `indeterminate` says
 * precisely that. When the calling operation needs an environment, the same
 * fact becomes blocking, which is the one place this function changes its mind.
 */
function notSelected(
  options: ClassifyEnvironmentOptions,
): readonly EnvironmentDiagnostic[] {
  return [
    finding(
      "ENV-002",
      options.required ? "fail" : "indeterminate",
      options.required ? "error" : "information",
      "ENV_NO_SELECTION",
      null,
      "none",
      {
        required: options.required ? "yes" : "no",
        searched: ["--env", "QAT_ENV", "defaultEnvironment"],
      },
    ),
    skipped("ENV-001", "ENV-002", null, "none"),
  ];
}

/**
 * A name was requested and no such profile exists.
 *
 * The reason depends on *how* it was requested, and that is what makes the
 * selection origin worth recording:
 *  • requested explicitly, or via `QAT_ENV` → the user asked for something that
 *    is not there (`ENV_PROFILE_NOT_FOUND`);
 *  • taken from `defaultEnvironment` → the configuration points at a profile
 *    that does not exist (`ENV_REFERENCE_DANGLING`), a different bug with a
 *    different owner.
 */
function profileNotFound(
  inspection: Extract<EnvironmentInspection, { state: "profile-not-found" }>,
): readonly EnvironmentDiagnostic[] {
  const dangling = inspection.origin === "configuration-default";

  return [
    finding(
      "ENV-002",
      "fail",
      "error",
      dangling ? "ENV_REFERENCE_DANGLING" : "ENV_PROFILE_NOT_FOUND",
      inspection.name,
      inspection.origin,
      {
        requested: inspection.name,
        available: inspection.available,
        origin: inspection.origin,
      },
    ),
    skipped("ENV-001", "ENV-002", inspection.name, inspection.origin),
  ];
}

/**
 * The profile exists and fails the schema.
 *
 * Field paths travel; rejected values do not. A single missing-field issue and a
 * profile full of problems are both `ENV_PROFILE_INVALID` — the remediation is
 * field-specific because the issue list is, not because the reason differs.
 */
function profileInvalid(
  inspection: Extract<EnvironmentInspection, { state: "profile-invalid" }>,
): readonly EnvironmentDiagnostic[] {
  return [
    finding(
      "ENV-002",
      "fail",
      "error",
      "ENV_PROFILE_INVALID",
      inspection.name,
      inspection.origin,
      {
        profile: inspection.name,
        fields: inspection.issues.map((issue) => issue.path ?? "<profile>"),
        codes: inspection.issues.map((issue) => issue.code),
        issueCount: inspection.issues.length,
      },
    ),
    skipped("ENV-001", "ENV-002", inspection.name, inspection.origin),
  ];
}

/**
 * The profile is usable — so the remaining two questions can finally be asked.
 *
 * ENV-002 still owns path resolution, because a path is part of the profile's
 * declaration. Whether a directory *exists* or is *writable* is a filesystem
 * concern with its own checks; conflating them would give two different answers
 * for one problem.
 */
function profileValid(
  inspection: Extract<EnvironmentInspection, { state: "profile-valid" }>,
): readonly EnvironmentDiagnostic[] {
  return [pathDiagnostic(inspection), variableDiagnostic(inspection)];
}

function pathDiagnostic(
  inspection: Extract<EnvironmentInspection, { state: "profile-valid" }>,
): EnvironmentDiagnostic {
  const unresolved = inspection.paths.filter(
    (path) => path.reason !== "ENV_PATH_RESOLVED",
  );

  if (unresolved.length === 0) {
    return finding(
      "ENV-002",
      "pass",
      "information",
      null,
      inspection.name,
      inspection.origin,
      {
        profile: inspection.name,
        pathsChecked: inspection.paths.length,
      },
    );
  }

  return finding(
    "ENV-002",
    "fail",
    "error",
    "ENV_PATH_INVALID",
    inspection.name,
    inspection.origin,
    {
      profile: inspection.name,
      fields: unresolved.map((path) => path.field),
      kinds: unresolved.map((path) => path.reason),
    },
  );
}

// ─── Variables ───────────────────────────────────────────────────────────────

/** One thing worth reporting about the profile's variables. `null` = nothing. */
interface VariableConcern {
  readonly status: Exclude<EnvironmentDiagnosticStatus, "skipped" | "pass">;
  readonly severity: EnvironmentDiagnosticSeverity;
  readonly reason: EnvironmentReason;
}

/**
 * Locale-independent ordering.
 *
 * `localeCompare` would make evidence order depend on the host, and this module's whole contract is that
 * the same inspection produces the same report on every machine.
 */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * ENV-001 — presence and policy for every declared reference.
 *
 * The references are sorted **here**, not merely trusted to arrive sorted. Two things depend on the order:
 * the `missing` / `blank` / `rejected` lists in the detail, which are persisted evidence, and the tie-break
 * below, where equal concerns keep the incumbent. `inspectEnvironment` already sorts before calling this,
 * and that sort is not a substitute — a second caller with its own inspection (a preflight, a future
 * gatherer) would otherwise produce a report that differs from the doctor's for identical inputs.
 */
function variableDiagnostic(
  inspection: Extract<EnvironmentInspection, { state: "profile-valid" }>,
): EnvironmentDiagnostic {
  const variables = [...inspection.variables].sort((a, b) =>
    compare(a.name, b.name),
  );

  const concerns = variables
    .map(concernFor)
    .filter(
      (
        concern,
      ): concern is { concern: VariableConcern; variable: VariableStatus } =>
        concern !== null,
    );

  const detail = summarise(variables);

  if (concerns.length === 0) {
    return finding(
      "ENV-001",
      "pass",
      "information",
      null,
      inspection.name,
      inspection.origin,
      detail,
    );
  }

  const worst = concerns.reduce((a, b) =>
    isWorse(b.concern, a.concern) ? b : a,
  );

  return finding(
    "ENV-001",
    worst.concern.status,
    worst.concern.severity,
    worst.concern.reason,
    inspection.name,
    inspection.origin,
    { ...detail, reported: worst.variable.name },
  );
}

/**
 * Maps one variable status to a concern, or `null` when it needs no reporting.
 *
 * Exhaustive by construction. Policy failures (unapproved source, unusable name)
 * are always Errors: they are defects in the configuration, not conditions of the
 * machine. An unverifiable variable is `indeterminate` with a Warning — we looked
 * and could not see, and that is never rendered as "present".
 */
function concernFor(
  variable: VariableStatus,
): { concern: VariableConcern; variable: VariableStatus } | null {
  switch (variable.reason) {
    case "ENV_VARIABLE_PRESENT":
      return null;

    case "ENV_VARIABLE_MISSING":
    case "ENV_VARIABLE_BLANK": {
      const severity = severityForAbsence(variable.requirement);
      return severity === null
        ? null
        : {
            variable,
            concern: { status: "fail", severity, reason: variable.reason },
          };
    }

    case "ENV_REFERENCE_SOURCE_NOT_APPROVED":
    case "ENV_REFERENCE_NAME_INVALID":
      return {
        variable,
        concern: { status: "fail", severity: "error", reason: variable.reason },
      };

    case "ENV_VARIABLE_UNVERIFIABLE":
      return {
        variable,
        concern: {
          status: "indeterminate",
          severity: "warning",
          reason: variable.reason,
        },
      };

    default:
      return assertNever(variable);
  }
}

/**
 * Severity of an absent (or blank) variable, derived from its declaration.
 *
 * This function is the whole conditional-severity rule from the catalogue:
 *   required     → Error  — the profile stated the need; not meeting it is a defect
 *   unspecified  → Warning — QAT cannot establish the requirement, so it does not block
 *   optional     → nothing — an absent optional value is the documented default
 */
function severityForAbsence(
  requirement: VariableRequirement,
): EnvironmentDiagnosticSeverity | null {
  switch (requirement) {
    case "required":
      return "error";
    case "unspecified":
      return "warning";
    case "optional":
      return null;
  }
}

/**
 * Builds the always-present half of the ENV-001 evidence: how many references
 * were examined and which names fall into each category. Names only, ever.
 */
function summarise(variables: readonly VariableStatus[]): EnvironmentDetail {
  const names = (reason: VariableStatus["reason"]): readonly string[] =>
    variables
      .filter((variable) => variable.reason === reason)
      .map((variable) => variable.name);

  return {
    checked: variables.length,
    missing: names("ENV_VARIABLE_MISSING"),
    blank: names("ENV_VARIABLE_BLANK"),
    rejected: [
      ...names("ENV_REFERENCE_SOURCE_NOT_APPROVED"),
      ...names("ENV_REFERENCE_NAME_INVALID"),
    ],
    unverifiable: names("ENV_VARIABLE_UNVERIFIABLE"),
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Precedence between two concerns: blocking beats unknown, unknown beats
 * warning-only. Ties keep the first entry, and the incoming list is already
 * sorted by name, so the winner is deterministic.
 */
const STATUS_RANK: Readonly<Record<VariableConcern["status"], number>> = {
  fail: 2,
  indeterminate: 1,
};

const SEVERITY_RANK: Readonly<Record<EnvironmentDiagnosticSeverity, number>> = {
  error: 3,
  warning: 2,
  information: 1,
};

function isWorse(
  candidate: VariableConcern,
  current: VariableConcern,
): boolean {
  const byStatus = STATUS_RANK[candidate.status] - STATUS_RANK[current.status];
  return byStatus !== 0
    ? byStatus > 0
    : SEVERITY_RANK[candidate.severity] > SEVERITY_RANK[current.severity];
}

function finding(
  id: EnvironmentDiagnosticId,
  status: EnvironmentDiagnosticStatus,
  severity: EnvironmentDiagnosticSeverity,
  reason: EnvironmentReason | null,
  profile: EnvironmentName | null,
  origin: SelectionOrigin,
  detail: EnvironmentDetail,
): EnvironmentDiagnostic {
  return Object.freeze({
    id,
    status,
    severity,
    reason,
    profile,
    origin,
    detail: Object.freeze(detail),
  });
}

/**
 * A check that could not run, with the reason it could not run.
 *
 * Always `information`: a skipped check is a statement about ordering, not about
 * the project, and it must never influence the exit status.
 */
function skipped(
  id: EnvironmentDiagnosticId,
  prerequisite: EnvironmentDiagnosticId,
  profile: EnvironmentName | null,
  origin: SelectionOrigin,
): EnvironmentDiagnostic {
  return finding(id, "skipped", "information", null, profile, origin, {
    prerequisite,
  });
}

/** Compile-time exhaustiveness guard: a widened union becomes a type error here. */
function assertNever(value: never): never {
  throw new Error(`Unhandled environment state: ${JSON.stringify(value)}`);
}
