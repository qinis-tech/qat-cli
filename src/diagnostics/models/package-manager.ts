/**
 * Persisted evidence model for the package-manager health check.
 *
 * Diagnostic findings outlive the run that produced them: they are written to the
 * local execution database, exported as JSON, pasted into issue reports and
 * diffed between runs. That makes this file a *storage contract*, not a
 * formatting helper — which drives three decisions.
 *
 * 1. Versioned. `schemaVersion` travels with every record so a consumer written
 *    against v1 can detect a future shape instead of misreading it.
 *
 * 2. Redacted by construction. No absolute paths, no environment contents, no
 *    `.npmrc` values. A home-directory path leaks a username into every shared
 *    report, so the persisted shape keeps the *command name* and whether it
 *    resolved — enough to diagnose, nothing that identifies a person or machine.
 *    Absolute paths stay in console output, which is ephemeral by default.
 *
 * 3. Bounded. Strings are truncated and lists are capped, so one pathological
 *    project cannot produce a megabyte of evidence that bloats the database,
 *    breaks a log pipeline or makes a report unreadable.
 *
 * ## Derived, not restated
 *
 * Everything below that already has a definition elsewhere is *derived* from it —
 * `Detection['status']`, `HealthIssue['detail']`, the probe's own failure
 * reasons. A storage contract that copies a vocabulary is a storage contract that
 * goes stale the first time the vocabulary grows, and the failure is silent: the
 * record still validates, it simply has fewer states than the writer can produce.
 *
 * Only types are imported from the package-manager module; this file performs no
 * I/O and reads no clock, so it can be unit-tested as a pure transformation.
 */

import type {
  Detection,
  ExecutableAvailability,
  HealthIssue,
  HealthIssueCode,
  HealthOutcome,
  PackageManagerAssessment,
  PackageManagerName,
  VersionEvidence,
} from "../../project/package-manager/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// Versioning and limits
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Current evidence schema version.
 *
 * Bump only for a breaking change. Adding an optional field is compatible and
 * must not move this number — otherwise every stored record looks obsolete for
 * no reason and consumers start needing migration code they never needed.
 */
export const PACKAGE_MANAGER_EVIDENCE_SCHEMA_VERSION = 1;

/** Longest string kept in evidence; the tail is replaced with an ellipsis. */
export const MAX_EVIDENCE_STRING_LENGTH = 200;

/** Most entries kept in any evidence list. */
export const MAX_EVIDENCE_LIST_LENGTH = 20;

// ─────────────────────────────────────────────────────────────────────────────
// Shapes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How identity was established, as a small closed vocabulary.
 *
 * Derived from `Detection` rather than spelled out, so adding a fifth detection
 * outcome is a compile error here instead of a stored record that silently
 * cannot represent it.
 */
export type DetectionSummary = Detection["status"];

/**
 * Why a version is absent, in the probe's own terms.
 *
 * Derived from `VersionEvidence` for the same reason: if the probe learns a new
 * failure mode, this union grows with it and the writer below stops compiling
 * until it says how to store the new case. `not-probed` is added because it is
 * the one absence the probe reports as a successful answer rather than a failure.
 */
export type VersionUnavailableReason =
  Extract<VersionEvidence, { status: "unreadable" }>["reason"] | "not-probed";

/**
 * The executable as it may safely be stored.
 *
 * `command` is the name we looked for (`pnpm`), not the absolute path we found.
 * `resolved` distinguishes "not installed" from "installed but silent", which are
 * different fixes. `version` is the parsed version string, or null when none was
 * obtained.
 */
export interface PackageManagerExecutableEvidence {
  readonly command: string;
  readonly resolved: boolean;
  readonly version: string | null;
  /** Why no version is present, when it is not. */
  readonly versionUnavailableReason: VersionUnavailableReason | null;
}

/**
 * One named issue, flattened for storage.
 *
 * The detail record is already flat and redaction-safe upstream; it is copied
 * rather than referenced so the stored record never aliases a live object that a
 * later code path could mutate.
 */
export interface PackageManagerIssueEvidence {
  readonly code: HealthIssueCode;
  readonly outcome: HealthOutcome;
  readonly manager: PackageManagerName | null;
  readonly detail: HealthIssue["detail"];
}

/** The complete, persisted evidence record for the package-manager check. */
export interface PackageManagerEvidence {
  readonly schemaVersion: typeof PACKAGE_MANAGER_EVIDENCE_SCHEMA_VERSION;
  readonly detection: DetectionSummary;
  /** Manager identified, or null when none could be. */
  readonly manager: PackageManagerName | null;
  /** Whether the project declared its manager itself, versus us inferring it. */
  readonly declared: boolean;
  /** Lockfile basenames only — never full paths. */
  readonly lockfiles: readonly string[];
  readonly executable: PackageManagerExecutableEvidence | null;
  readonly outcome: HealthOutcome;
  readonly issues: readonly PackageManagerIssueEvidence[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Ordering
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fixed display order for issue codes, following the order a reader would work
 * through them: decide the tool, install the tool, then install dependencies.
 *
 * Sorting here (rather than trusting insertion order) keeps two runs over the
 * same project byte-identical, which is what makes evidence diffable in review.
 */
const ISSUE_ORDER: readonly HealthIssueCode[] = Object.freeze([
  "PM_LOCKFILES_CONFLICT",
  "PM_DECLARATION_MISMATCH",
  "PM_DECLARATION_UNPARSABLE",
  "PM_UNSUPPORTED",
  "PM_UNDECLARED",
  "PM_EXECUTABLE_MISSING",
  "PM_EXECUTABLE_VERSION_MISMATCH",
  "PM_VERSION_UNVERIFIED",
  "PM_FOREIGN_NODE_MODULES",
  "PM_DEPENDENCIES_NOT_INSTALLED",
]);

function rankOf(code: HealthIssueCode): number {
  const index = ISSUE_ORDER.indexOf(code);
  // Unknown codes sort last rather than wildly: a future code must not reorder
  // existing evidence.
  return index === -1 ? ISSUE_ORDER.length : index;
}

// ─────────────────────────────────────────────────────────────────────────────
// Builders
// ─────────────────────────────────────────────────────────────────────────────

/** Truncates to the evidence budget, marking the cut so nobody trusts a partial value. */
function bound(value: string): string {
  return value.length <= MAX_EVIDENCE_STRING_LENGTH
    ? value
    : `${value.slice(0, MAX_EVIDENCE_STRING_LENGTH - 1)}…`;
}

/** Caps a list and truncates each entry, preserving order. */
function boundList(values: readonly string[]): readonly string[] {
  return values.slice(0, MAX_EVIDENCE_LIST_LENGTH).map(bound);
}

/**
 * Narrows a detail value to a string list.
 *
 * A type guard rather than a cast at the call site. `Array.isArray` does not
 * narrow a `readonly string[]` in a union, so the cast was the tempting repair —
 * and it would have gone on asserting "this is a list of strings" for any array a
 * future detail field happened to hold, including one of numbers.
 */
function isStringList(
  value: HealthIssue["detail"][string],
): value is readonly string[] {
  return Array.isArray(value);
}

/**
 * Normalises one issue into its stored form.
 *
 * Strings are bounded; array values inside `detail` are bounded too, because a
 * detail field is the most likely place for an unbounded list (lockfiles,
 * candidate executables) to appear.
 */
export function toIssueEvidence(
  entry: HealthIssue,
): PackageManagerIssueEvidence {
  const detail: Record<string, HealthIssue["detail"][string]> = {};

  for (const [key, value] of Object.entries(entry.detail)) {
    detail[key] =
      typeof value === "string"
        ? bound(value)
        : isStringList(value)
          ? boundList(value)
          : value;
  }

  return Object.freeze({
    code: entry.code,
    outcome: entry.outcome,
    manager: entry.manager ?? null,
    detail: Object.freeze(detail),
  });
}

/**
 * Projects an availability result onto the storable shape.
 *
 * The resolved absolute path is intentionally dropped: it is console-only
 * information. What remains answers the two questions a reader actually has —
 * was the command found, and did it report a version.
 */
export function toExecutableEvidence(
  availability: ExecutableAvailability,
  command: string,
): PackageManagerExecutableEvidence {
  if (availability.status === "missing") {
    return Object.freeze({
      command: bound(command),
      resolved: false,
      version: null,
      versionUnavailableReason: null,
    });
  }

  const { version } = availability;

  return Object.freeze({
    command: bound(command),
    resolved: true,
    version: version.status === "read" ? bound(version.value) : null,
    versionUnavailableReason:
      version.status === "read"
        ? null
        : version.status === "unreadable"
          ? version.reason
          : "not-probed",
  });
}

/** Reads the lockfile names a detection decided on. Total over the union. */
function lockfilesOf(detection: Detection): readonly string[] {
  switch (detection.status) {
    case "conflicting":
    case "undeclared":
      return detection.lockfiles;
    case "detected":
    case "unsupported":
      // The `detected`/`unsupported` variants carry a single lockfile, and an
      // empty string when the manager was declared without one. `''` is not a
      // filename, so it must not reach evidence as one.
      return detection.lockfile === "" ? [] : [detection.lockfile];
  }
}

/**
 * Builds the persisted evidence record.
 *
 * The diagnostic rule delegates here so the stored shape has exactly one
 * definition. Splitting it out means the shape can be asserted — ordering,
 * bounds, absence of paths — without constructing a whole check.
 */
export function toPackageManagerEvidence(input: {
  readonly detection: Detection;
  readonly assessment: PackageManagerAssessment;
  readonly executableCommand: string;
  readonly executable: ExecutableAvailability;
}): PackageManagerEvidence {
  const { detection, assessment } = input;

  const issues = [...assessment.issues]
    .sort((a, b) => rankOf(a.code) - rankOf(b.code))
    .map(toIssueEvidence);

  return Object.freeze({
    schemaVersion: PACKAGE_MANAGER_EVIDENCE_SCHEMA_VERSION,
    detection: detection.status,
    manager: assessment.manager ?? null,
    declared: detection.status === "detected" && detection.declared,
    lockfiles: Object.freeze(boundList(lockfilesOf(detection))),
    executable:
      detection.status === "detected"
        ? toExecutableEvidence(input.executable, input.executableCommand)
        : null,
    outcome: assessment.outcome,
    issues: Object.freeze(issues),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Guards
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Structural check for consumers that read evidence back from storage.
 *
 * Intentionally shallow: it verifies the version tag and the fields a reader will
 * dereference. A deep validator would duplicate the writer's guarantees and drift
 * from them, which is worse than a narrow guard that is obviously correct.
 */
export function isPackageManagerEvidence(
  value: unknown,
): value is PackageManagerEvidence {
  if (typeof value !== "object" || value === null) return false;

  const candidate = value as Partial<PackageManagerEvidence>;

  return (
    candidate.schemaVersion === PACKAGE_MANAGER_EVIDENCE_SCHEMA_VERSION &&
    typeof candidate.detection === "string" &&
    typeof candidate.outcome === "string" &&
    Array.isArray(candidate.issues)
  );
}

/**
 * True when a record contains an absolute path in any string field.
 *
 * Used by the redaction test to assert the promise above rather than describe it:
 * the model must never leak a home directory or a drive root into persisted
 * evidence, no matter which fields a future change adds.
 *
 * Deliberately walks *any* object rather than known keys — the promise is about
 * the record as a whole, and a test that only checked today's fields would pass
 * on the day a nested field started carrying a path.
 */
export function containsAbsolutePath(value: unknown): boolean {
  if (typeof value === "string") {
    return /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(value);
  }
  if (Array.isArray(value)) {
    return value.some(containsAbsolutePath);
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value).some(containsAbsolutePath);
  }
  return false;
}
