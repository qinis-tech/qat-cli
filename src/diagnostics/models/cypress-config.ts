/**
 * The evidence models for CFG-003 and CFG-004.
 *
 * A rule decides a verdict; a model describes what was observed. Splitting them
 * is what lets the same observation feed three consumers — the human report, the
 * `--format json` output and the persisted diagnostic session — without each one
 * inventing its own shape, and without three chances to leak something into one
 * of them.
 *
 * Two constraints shape everything below:
 *
 *   • **JSON-safe scalars only.** No nested objects, no class instances, no
 *     functions. Evidence is serialised, schema-checked and read by tools that
 *     were not written here, so the type is the contract, not a convention.
 *
 *   • **Structure, never contents.** A Cypress configuration routinely holds
 *     credentials under `env`. Names, sizes, formats, causes and line numbers are
 *     observations; file text is not, and there is no field here that could carry
 *     it. The one place a parser or loader message appears is the finding's
 *     `message`, where it is capped and ANSI-stripped upstream — deliberately not
 *     duplicated into evidence, because evidence outlives the terminal it was
 *     printed in.
 */

import type {
  ConfigDiscovery,
  ConfigValidation,
} from "../../project/cypress-config/index.js";

/**
 * The complete vocabulary of an evidence bag.
 *
 * `null` is a value, not an absence: a report that distinguishes "no line number"
 * from "the property was never written" is a report a schema can validate. Absent
 * keys would make every consumer handle two spellings of nothing.
 */
export type EvidenceValue =
  string | number | boolean | readonly string[] | null;

/** A frozen evidence bag. Flat by construction, so it serialises predictably. */
export type CypressConfigEvidence = Readonly<Record<string, EvidenceValue>>;

/**
 * Cap on any single string in evidence.
 *
 * A filesystem permits file names far longer than a terminal or a report column
 * can show, and a pathological name would push the useful part of a finding out
 * of view. This is a presentation concern, not a validation one: the verdict has
 * already been decided by the time evidence is built.
 */
export const MAX_EVIDENCE_STRING_CHARS = 200;

function clip(value: string): string {
  return value.length <= MAX_EVIDENCE_STRING_CHARS
    ? value
    : `${value.slice(0, MAX_EVIDENCE_STRING_CHARS - 1)}…`;
}

const clipAll = (values: readonly string[]): readonly string[] =>
  values.map(clip);

/** Guards the one thing a switch cannot: a union member added later. */
function unhandled(value: never): never {
  throw new Error(
    `Unhandled verdict in the Cypress configuration evidence model: ${JSON.stringify(value)}`,
  );
}

/**
 * Evidence for CFG-003, built from the decided location verdict.
 *
 * The `check` key is carried so a JSON consumer can group findings by check
 * without correlating against a sibling field, and the `reason` key is carried
 * verbatim so a reader can map a report line straight back to a catalogue entry.
 * Everything else is the minimum that makes that reason actionable.
 *
 * Exhaustive by construction: a new reason in the contract is a compile error
 * here, which is how a new condition gets an evidence shape before a report can
 * render it as `undefined`.
 */
export function discoveryEvidence(
  location: ConfigDiscovery,
): CypressConfigEvidence {
  switch (location.reason) {
    case "CYPRESS_CONFIG_FOUND":
      return Object.freeze({
        check: "CFG-003",
        reason: location.reason,
        file: clip(location.file),
        format: location.format,
        sizeBytes: location.sizeBytes,
      });

    // Reported as `json` rather than as a separate format value: the format is a
    // property of the file Cypress reads, and legacy *is* the JSON carrier. The
    // reason already says it is deprecated.
    case "CYPRESS_CONFIG_LEGACY_FORMAT":
      return Object.freeze({
        check: "CFG-003",
        reason: location.reason,
        file: clip(location.file),
        format: "json",
        sizeBytes: location.sizeBytes,
      });

    // The two states both mean "no configuration file", and the context is what
    // separates a setup problem from a half-finished migration — the sentence a
    // report prints depends on it, so it belongs in the data, not in the prose.
    case "CYPRESS_CONFIG_MISSING":
      return Object.freeze({
        check: "CFG-003",
        reason: location.reason,
        context: location.context,
      });

    case "CYPRESS_CONFIG_AMBIGUOUS":
    case "CYPRESS_CONFIG_UNSUPPORTED_NAME":
    case "CYPRESS_CONFIG_MISPLACED":
      return Object.freeze({
        check: "CFG-003",
        reason: location.reason,
        files: clipAll(location.files),
      });

    case "CYPRESS_CONFIG_PATH_OCCUPIED":
      return Object.freeze({
        check: "CFG-003",
        reason: location.reason,
        paths: clipAll(location.paths),
      });

    // The only absolute path that ever reaches evidence, and only because it is
    // the fact a reader needs: where the link escapes to. Everywhere else paths
    // are project-relative, so a report never carries a user's home directory.
    case "CYPRESS_CONFIG_OUTSIDE_PROJECT":
      return Object.freeze({
        check: "CFG-003",
        reason: location.reason,
        file: clip(location.file),
        resolvedPath: clip(location.resolvedPath),
      });

    case "CYPRESS_CONFIG_UNREADABLE":
      return Object.freeze({
        check: "CFG-003",
        reason: location.reason,
        file: clip(location.file),
        cause: location.cause,
      });

    case "CYPRESS_CONFIG_NOT_A_FILE":
    case "CYPRESS_CONFIG_EMPTY":
    case "CYPRESS_CONFIG_NOT_INSPECTED":
      return Object.freeze({
        check: "CFG-003",
        reason: location.reason,
        file: clip(location.file),
      });

    case "CYPRESS_CONFIG_NOT_APPLICABLE":
      return Object.freeze({ check: "CFG-003", reason: location.reason });

    default:
      return unhandled(location);
  }
}

/**
 * Evidence for CFG-004, built from the decided validation verdict.
 *
 * The `tier` is the most important field here: it answers "who said so?". A JSON
 * parser and the project's own loader are not equally strong witnesses, and a
 * reader comparing two reports needs to see which one spoke.
 *
 * The failure *kind* and *line* are recorded; the failure *message* is not. The
 * message quotes the user's own configuration, which is the right thing to show
 * them in the terminal and the wrong thing to persist in a session that may be
 * attached to a bug report.
 */
export function validationEvidence(
  validation: ConfigValidation,
): CypressConfigEvidence {
  switch (validation.reason) {
    case "CYPRESS_CONFIG_VALIDATED":
      return Object.freeze({
        check: "CFG-004",
        reason: validation.reason,
        file: clip(validation.file),
        tier: validation.tier,
        // Present only for the loader tier, where the cost is worth recording.
        durationMs: validation.durationMs ?? null,
      });

    case "CYPRESS_CONFIG_INVALID":
      return Object.freeze({
        check: "CFG-004",
        reason: validation.reason,
        file: clip(validation.file),
        tier: validation.tier,
        failureKind: validation.failure.kind,
        line: validation.failure.line ?? null,
        durationMs: validation.durationMs ?? null,
        // True means the loader's output was capped before sanitising, so a
        // reader knows the message was truncated rather than complete.
        truncated: validation.truncated ?? false,
      });

    case "CYPRESS_CONFIG_NOT_VALIDATED":
      return Object.freeze({
        check: "CFG-004",
        reason: validation.reason,
        file: clip(validation.file),
        tier: validation.tier,
        cause: validation.cause,
      });

    // Reachable only when the runner did not honour CFG-003 as this check's
    // precondition. The evidence still describes it accurately rather than
    // pretending the verdict was something else.
    case "CYPRESS_CONFIG_SKIPPED":
      return Object.freeze({
        check: "CFG-004",
        reason: validation.reason,
        prerequisite: validation.prerequisite,
      });

    default:
      return unhandled(validation);
  }
}
