/**
 * Environment evidence — the last gate before anything is printed or persisted.
 *
 * Two jobs, and only two:
 *
 *  1. Assemble the evidence object for a finding from facts that already exist
 *     (the inspection) and verdicts that already exist (the diagnostics). It
 *     recomputes nothing, so it can never disagree with what was reported.
 *  2. Guarantee that whatever leaves this module is safe to write into a
 *     terminal, a JSON document, a CI log or a persisted diagnostic session:
 *     no control characters, no ANSI escapes, no absolute paths, bounded size.
 *
 * Why a gate at all, given the contracts are already value-free:
 *
 *  Secret safety here is *structural* — `VariableStatus` has no field that could
 *  hold a value, so this module has nothing secret to redact. We deliberately do
 *  not call the logging redaction service: importing it would create a false
 *  impression that a value could reach here. What *can* reach here is
 *  attacker-influenced text: profile names and variable names come from a
 *  configuration file and are printed verbatim. A name containing a newline or
 *  an ANSI escape would forge a diagnostic line or garble a CI log. That is a
 *  real, mundane risk, and it is what this file exists to close.
 *
 * Ordering rule: sanitise, then cap. The truncation marker is emitted by us, not
 * by the user, so it must never be run through the token sanitiser.
 */

import { isAbsolute, relative, sep } from "node:path";

import type {
  EnvironmentEvidence,
  EnvironmentInspection,
  EnvironmentName,
  SelectionOrigin,
} from "../contracts.js";

import type { EnvironmentDetail, EnvironmentDiagnostic } from "./classify.js";

// ─── Limits ──────────────────────────────────────────────────────────────────

/**
 * Bounds on everything that leaves this module.
 *
 * A pathological configuration must not be able to produce a megabyte of
 * evidence, and a machine-generated profile name must not be able to push a
 * unrelated finding off the user's screen. The numbers are small enough to be
 * harmless and large enough that a real project never hits them.
 */
export const EVIDENCE_LIMITS = Object.freeze({
  /** Longest single printable token (path, field path, enum-ish value). */
  tokenLength: 256,
  /** Longest profile or variable name. */
  nameLength: 64,
  /** Longest list of names or paths carried in one finding. */
  listLength: 50,
});

/** Placeholder used instead of any path that escapes the project root. */
export const OUTSIDE_PROJECT = "<outside-project>";

// ─── Assembly ────────────────────────────────────────────────────────────────

export interface EnvironmentEvidenceInput {
  readonly inspection: EnvironmentInspection;
  /**
   * The classified diagnostics for this inspection.
   *
   * Passed in rather than recomputed: `issueCount` must describe what was
   * actually reported. Re-deriving it here would duplicate the severity policy
   * and eventually disagree with the finding beside it.
   */
  readonly diagnostics: readonly EnvironmentDiagnostic[];
  readonly projectRoot: string;
  /** Configured location of the QAT configuration file, or `null` when absent. */
  readonly configPath: string | null;
}

/**
 * Builds the evidence object attached to an environment finding.
 *
 * Everything is derived from the inspection and the diagnostics — there is no
 * second interpretation of the same facts, which is why this cannot drift from
 * the message it accompanies.
 */
export function buildEnvironmentEvidence(
  input: EnvironmentEvidenceInput,
): EnvironmentEvidence {
  const { inspection } = input;

  return Object.freeze({
    profile: profileOf(inspection),
    selectionOrigin: originOf(inspection),
    // Relativised: a shared CI log must never reveal a contributor's home
    // directory layout, and an absolute path is rarely useful anyway.
    configPath:
      input.configPath === null
        ? null
        : toProjectRelative(input.projectRoot, input.configPath),
    // Names only, and only the names that were actually examined — this is the
    // "what did you check?" half of the evidence.
    variables: capList(variableNamesOf(inspection).map(sanitiseName)),
    paths: capList(pathFieldsOf(inspection).map(sanitiseToken)),
    issueCount: countIssues(input.diagnostics),
  });
}

/** The profile a finding is about, or `null` when nothing was selected. */
function profileOf(inspection: EnvironmentInspection): EnvironmentName | null {
  switch (inspection.state) {
    case "not-selected":
      return null;
    case "selection-invalid":
      return inspection.raw === "" ? null : sanitiseName(inspection.raw);
    case "profile-not-found":
    case "profile-invalid":
    case "profile-valid":
      return sanitiseName(inspection.name);
    default:
      return assertNever(inspection);
  }
}

/** How the profile came to be chosen — the "why should I trust this?" half. */
function originOf(inspection: EnvironmentInspection): SelectionOrigin {
  return inspection.state === "not-selected" ? "none" : inspection.origin;
}

function variableNamesOf(inspection: EnvironmentInspection): readonly string[] {
  return inspection.state === "profile-valid"
    ? inspection.variables.map((variable) => variable.name)
    : [];
}

function pathFieldsOf(inspection: EnvironmentInspection): readonly string[] {
  return inspection.state === "profile-valid"
    ? inspection.paths.map((path) => path.field)
    : [];
}

/**
 * Counts what was actually reported as a problem.
 *
 * Skips and passes are excluded: an `issueCount` that included them would make a
 * clean result look like six issues and train people to ignore the number.
 */
function countIssues(diagnostics: readonly EnvironmentDiagnostic[]): number {
  return diagnostics.filter(
    (diagnostic) =>
      diagnostic.status === "fail" || diagnostic.status === "indeterminate",
  ).length;
}

// ─── Detail sanitisation ─────────────────────────────────────────────────────

/**
 * Normalises a diagnostic's detail map for output.
 *
 * One uniform rule for every string, rather than a per-key table: a table is a
 * maintenance cliff where a newly added key silently skips sanitisation. Since
 * no legitimate detail value needs a character outside the allowlist, uniformity
 * is both safer and simpler.
 */
export function sanitiseDetail(detail: EnvironmentDetail): EnvironmentDetail {
  const safe: Record<string, string | number | readonly string[] | null> = {};

  for (const [key, value] of Object.entries(detail)) {
    const safeKey = sanitiseToken(key);

    if (typeof value === "number") {
      safe[safeKey] = value;
    } else if (typeof value === "string") {
      safe[safeKey] = sanitiseToken(value);
    } else if (Array.isArray(value)) {
      safe[safeKey] = capList(value.map(sanitiseToken));
    } else {
      // `null` and anything unexpected collapse to `null` rather than being
      // stringified: `String(undefined)` would invent a value out of a bug.
      safe[safeKey] = null;
    }
  }

  return Object.freeze(safe);
}

/**
 * Makes a single value safe to print.
 *
 * Disallowed characters become `?` rather than being deleted, so the shape and
 * length of the original stay visible — a user reading `?????` learns something
 * useful, whereas a silently shortened token looks like a different name.
 */
export function sanitiseToken(value: string): string {
  return value
    .replace(DISALLOWED_TOKEN_CHARS, "?")
    .slice(0, EVIDENCE_LIMITS.tokenLength);
}

/** Profile and variable names: the same rule, with a tighter bound. */
export function sanitiseName(value: string): string {
  return sanitiseToken(value).slice(0, EVIDENCE_LIMITS.nameLength);
}

/**
 * Allowlist for printable tokens.
 *
 * Covers identifiers, dotted field paths, POSIX and Windows path fragments, our
 * own `<...>` placeholders and the punctuation that legitimately appears in a
 * version or range. Notably excluded: whitespace, control characters, the ESC
 * introducer, quotes, backticks and semicolons — the raw material of log
 * injection and terminal escape sequences.
 */
const DISALLOWED_TOKEN_CHARS = /[^A-Za-z0-9._:/\\<>+@=-]/g;

// ─── Paths ───────────────────────────────────────────────────────────────────

/**
 * Renders a path relative to the project root, or a placeholder if it escapes.
 *
 * Deliberately conservative in three ways:
 *  • an absolute path outside the root becomes `OUTSIDE_PROJECT` — the fact that
 *    it escaped is the finding, and the user's directory layout is not;
 *  • Windows-style input is handled on every platform, because configuration
 *    files travel between machines far more often than people expect;
 *  • nothing throws. Evidence assembly runs after a verdict has already been
 *    reached; a malformed path must not be able to destroy the report that
 *    explains it.
 */
export function toProjectRelative(
  projectRoot: string,
  candidate: string,
): string {
  const unified = candidate.replace(/\\/g, "/");

  // A drive-letter or UNC path can never be inside a POSIX project root, and on
  // Windows `path.relative` would silently "succeed" across drives only because
  // it returns an absolute path — which we reject below anyway.
  if (isForeignAbsolute(unified)) {
    return isInside(projectRoot, candidate)
      ? relativise(projectRoot, candidate)
      : OUTSIDE_PROJECT;
  }

  const resolved = isAbsolute(candidate)
    ? relative(projectRoot, candidate)
    : candidate;
  const normalised = resolved.split(sep).join("/").replace(/^\.\//, "");

  if (normalised === "") return ".";
  if (normalised === ".." || normalised.startsWith("../"))
    return OUTSIDE_PROJECT;

  return sanitiseToken(normalised);
}

function relativise(projectRoot: string, candidate: string): string {
  return sanitiseToken(relative(projectRoot, candidate).split(sep).join("/"));
}

function isInside(projectRoot: string, candidate: string): boolean {
  const resolved = relative(projectRoot, candidate);
  return resolved !== "" && !resolved.startsWith("..") && !isAbsolute(resolved);
}

/** `C:/…` or `//server/share` — absolute somewhere else, even on this platform. */
function isForeignAbsolute(value: string): boolean {
  return /^[A-Za-z]:\//.test(value) || value.startsWith("//");
}

// ─── Lists ───────────────────────────────────────────────────────────────────

/**
 * Bounds a list and says so.
 *
 * Silent truncation is the worst option: the report would look complete while
 * quietly hiding the entry the user needed. The marker keeps the list honest and
 * is emitted by us — which is why capping happens *after* sanitisation.
 */
export function capList(
  items: readonly string[],
  limit: number = EVIDENCE_LIMITS.listLength,
): readonly string[] {
  if (items.length <= limit) return Object.freeze([...items]);

  const omitted = items.length - limit;
  return Object.freeze([...items.slice(0, limit), `+${omitted} more`]);
}

/** Compile-time exhaustiveness guard: a widened union becomes a type error here. */
function assertNever(value: never): never {
  throw new Error(`Unhandled environment state: ${JSON.stringify(value)}`);
}
