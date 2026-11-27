/**
 * Evidence shaping for configuration findings.
 *
 * This module decides what is allowed to leave the process. Everything else in
 * the configuration diagnostics deals with structure; this file deals with
 * bytes. Keeping it isolated and small means the question "can a secret leak
 * through a configuration finding?" has exactly one place to look — and one
 * place to test exhaustively.
 *
 * The contract this module enforces
 * ────────────────────────────────
 *  • Paths are project-relative and use forward slashes, so an absolute home
 *    directory or a Windows-only separator never reaches a shared CI log.
 *  • Configuration *values* never appear. Where a value must be conveyed, it is
 *    reduced to a type summary ("string", "object(3 keys)", "array(2)").
 *  • Every string that does survive is truncated and passed through the
 *    product's redactor, even the ones we believe are safe. Belt and braces:
 *    "probably not a secret" is not a security property.
 *  • The set of detail keys is a closed union, so no future caller can smuggle
 *    a field onto the evidence object without changing this file deliberately.
 *  • The result is frozen; consumers may render, serialise or persist it, but
 *    never mutate it.
 *
 * ## Why the redactor is a port declared here rather than an imported class
 *
 * This module needs exactly one capability from the logging layer: turn a string
 * into a string that is safe to print. Importing the logging module to obtain it
 * would make evidence shaping depend on a module about destinations, levels and
 * transports — a dependency this file would then have to keep in step with, for
 * one method.
 *
 * Declaring the shape here is the narrower contract: any redactor the product
 * grows satisfies it structurally, the wiring site stays free to substitute one,
 * and a test can pass a three-line fake instead of constructing the real thing.
 * A port belongs at the boundary that needs it, which is this one.
 */
import type { ConfigIssue } from "../inspect.js";

import type {
  ConfigDiagnosticIssue,
  ConfigEvidence,
  ConfigEvidenceValue,
  QatConfigCheckId,
} from "./contracts.js";

/* ------------------------------------------------------------------------- *
 * Ports
 * ------------------------------------------------------------------------- */

/**
 * The one capability evidence shaping needs from the redaction service.
 *
 * Structural rather than nominal on purpose: the product's redactor is expected
 * to satisfy this without knowing this file exists, and a test double needs to
 * satisfy nothing else.
 */
export interface SecretRedactorPort {
  /** Returns a printable form of a value. Must never return the input unchanged for a known secret. */
  readonly redact: (value: string) => string;
}

/* ------------------------------------------------------------------------- *
 * Limits
 * ------------------------------------------------------------------------- */

/**
 * Longest string retained in evidence.
 *
 * Field paths and repository paths can be arbitrarily long. Truncation keeps one
 * pathological path from dominating a terminal report or a log line, and keeps
 * the JSON payload bounded for consumers that persist findings.
 */
export const MAX_EVIDENCE_STRING = 200;

/** Placeholder for anything outside the project root. */
const OUTSIDE_PROJECT = "<outside-project>";

/**
 * The complete set of keys a finding may add to its evidence.
 *
 * Closed on purpose: adding a detail is a deliberate edit here, reviewed once,
 * rather than a scatter of ad-hoc keys across rule implementations.
 */
export type SafeDetailKey =
  | "state"
  | "code"
  | "line"
  | "column"
  | "declared"
  | "supported"
  | "issueCount";

/* ------------------------------------------------------------------------- *
 * Inputs
 * ------------------------------------------------------------------------- */

export interface ConfigEvidenceInput {
  /** Absolute project root, used only to make paths relative. Never emitted. */
  readonly projectRoot: string;
  /** Absolute or relative path of the file inspected; "." when nothing was found. */
  readonly path: string;
  /** Declared schema version, only when it was a usable number. */
  readonly schemaVersion: number | null;
  /** Declared framework identifier, only when it is a supported value. */
  readonly framework: string | null;
  /** Field-level issues; carried through the same safe-issue projection. */
  readonly issues?: readonly ConfigIssue[];
  /** Check that had to pass before this finding could be produced. */
  readonly prerequisite: QatConfigCheckId | null;
  /** Additional non-secret facts, restricted to the allowlist above. */
  readonly details?: Readonly<
    Partial<Record<SafeDetailKey, ConfigEvidenceValue>>
  >;
  /** The product's redaction service. Injected so there is exactly one. */
  readonly redactor: SecretRedactorPort;
}

/* ------------------------------------------------------------------------- *
 * Assembly
 * ------------------------------------------------------------------------- */

/**
 * Builds the evidence object for a configuration finding.
 *
 * Order of operations is deliberate: truncate first, then redact. Redacting a
 * value and then truncating it can split a redaction marker and reveal a
 * fragment; truncating first means the redactor always sees the final text.
 */
export function buildConfigEvidence(
  input: ConfigEvidenceInput,
): ConfigEvidence {
  return Object.freeze({
    path: safePath(input),
    schemaVersion: input.schemaVersion,
    framework: safeIdentifier(input.framework, input.redactor),
    issues: Object.freeze((input.issues ?? []).map(toSafeIssue)),
    prerequisite: input.prerequisite,
    details: Object.freeze(safeDetails(input)),
  });
}

/**
 * Converts one schema issue into the shape allowed in evidence.
 *
 * The wording is ours, derived from the issue *code*, not from the schema
 * library's message. Two reasons: it stays stable when a dependency rewords its
 * output, and it cannot accidentally reproduce a rejected value.
 */
export function toSafeIssue(issue: ConfigIssue): ConfigDiagnosticIssue {
  return Object.freeze({
    path: issuePath(issue),
    code: issue.code,
    expected: expectedFor(issue.code),
    received: receivedSummary(issue.code),
  });
}

/* ------------------------------------------------------------------------- *
 * Paths
 * ------------------------------------------------------------------------- */

/**
 * Makes a path safe to print.
 *
 * Normalises separators to forward slashes (portable logs), strips the project
 * root, and refuses to emit an absolute path when the target lies outside the
 * project — a case that only arises for a symlink escaping the root, and which
 * must not become a way to publish someone's home directory.
 *
 * Uses string operations rather than `node:path` so the function stays pure and
 * identical across platforms: the doctor runs in containers and on Windows
 * agents, and a relative path must read the same in both.
 */
export function toProjectRelative(projectRoot: string, target: string): string {
  const root = normalise(projectRoot).replace(/\/+$/, "");
  const candidate = normalise(target);

  if (candidate === root || candidate === "") return ".";

  const withBoundary = `${root}/`;

  if (!candidate.startsWith(withBoundary)) {
    // Outside the project: keep only the basename. Enough to identify the file,
    // not enough to disclose the surrounding filesystem layout.
    return truncate(`${OUTSIDE_PROJECT}/${basename(candidate)}`);
  }

  return truncate(candidate.slice(withBoundary.length));
}

function safePath(input: ConfigEvidenceInput): string {
  // Already-relative input (".", "qat.config.json") passes through unchanged;
  // absolute input is made relative. Both then take the same safety treatment.
  const relative = isAbsolute(input.path)
    ? toProjectRelative(input.projectRoot, input.path)
    : normalise(input.path);

  return truncate(relative);
}

function normalise(value: string): string {
  return value.replace(/\\/g, "/");
}

function isAbsolute(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:\//.test(normalise(value));
}

function basename(value: string): string {
  const index = value.lastIndexOf("/");
  return index === -1 ? value : value.slice(index + 1);
}

/* ------------------------------------------------------------------------- *
 * Values
 * ------------------------------------------------------------------------- */

/** Truncate, redact, truncate again — the order every surviving string takes. */
function squash(value: string, redactor: SecretRedactorPort): string {
  return truncate(redactor.redact(truncate(value)));
}

/**
 * Redacts an enumerable identifier (currently only the framework name).
 *
 * A framework name is not a secret, but it is user-authored and it flows into
 * output, so it takes the same treatment as everything else. If the redactor
 * masks it, the identifier becomes a placeholder — which is the correct
 * outcome, not a bug: a value that looks like a credential must not be printed
 * even when we believe we know what it is.
 */
function safeIdentifier(
  value: string | null,
  redactor: SecretRedactorPort,
): string | null {
  return value === null ? null : squash(value, redactor);
}

/**
 * Copies the allowlisted details, shrinking each to its safe form.
 *
 * Branches are ordered so each one narrows by itself: a string, then an array,
 * then whatever is left — which is already the non-string, non-array part of
 * `ConfigEvidenceValue`. That ordering is why this function needs no type
 * assertions; the compiler can see what the remainder is.
 *
 * Arrays are mapped element-wise so a list of supported versions cannot smuggle
 * a long string in, and every element passes the same truncation and redaction.
 */
function safeDetails(
  input: ConfigEvidenceInput,
): Record<string, ConfigEvidenceValue> {
  const details = input.details;
  if (details === undefined) return {};

  const safe: Record<string, ConfigEvidenceValue> = {};

  for (const [key, value] of Object.entries(details)) {
    if (value === undefined) continue;

    if (typeof value === "string") {
      safe[key] = squash(value, input.redactor);
      continue;
    }

    if (Array.isArray(value)) {
      safe[key] = Object.freeze(
        value.map((item: unknown) => squash(String(item), input.redactor)),
      );
      continue;
    }

    // `number | boolean | null` — already safe by type, and carrying no text.
    safe[key] = value;
  }

  return safe;
}

/**
 * Reduces an unknown value to a type summary.
 *
 * This is the escape hatch for "we would like to say something about what we
 * found without saying what it was". It is exported so future evidence needs
 * reach for this instead of stringifying a value.
 */
export function summariseValue(value: unknown): ConfigEvidenceValue {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === "object")
    return `object(${Object.keys(value).length} keys)`;
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return typeof value;
}

/* ------------------------------------------------------------------------- *
 * Issue wording
 * ------------------------------------------------------------------------- */

function issuePath(issue: ConfigIssue): string {
  return issue.path.length === 0 ? "<root>" : truncate(issue.path.join("."));
}

/** Stable, content-free expectations keyed by issue code. */
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

/**
 * Type-level summary of what was found.
 *
 * Deliberately independent of the actual value: this string is designed to be
 * safe for a public issue tracker.
 */
function receivedSummary(code: string): string | null {
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

/* ------------------------------------------------------------------------- *
 * Helpers
 * ------------------------------------------------------------------------- */

/** Bounds a string for evidence, marking that it was shortened. */
export function truncate(
  value: string,
  max: number = MAX_EVIDENCE_STRING,
): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
