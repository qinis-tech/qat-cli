/**
 * Evidence models for the Cypress health checks.
 *
 * A diagnostic finding is not just a status — it is a claim someone will act on, and the evidence is what makes the claim
 * checkable. That makes evidence a **published contract**: it is rendered into the terminal, serialised into
 * `--format json`, persisted into the diagnostic session and read back by the history and explanation tooling. Once
 * something is in evidence, removing or renaming it is a breaking change.
 *
 * This file is therefore the single place where Cypress evidence is defined and built, for three reasons that are all
 * about not owning the same bug three times:
 *
 *  1. **One allowlist, not three.** Each rule previously assembled its own evidence object. Three allowlists drift: one
 *     rule publishes a field the others do not, a contract test asserts two of the three shapes, and the odd one out is
 *     discovered by a user reading JSON.
 *  2. **One sanitiser.** Evidence content includes text produced by a *project-controlled binary* (`cypress verify`
 *     output). That is untrusted input. It must be stripped of terminal control sequences before it reaches a TTY, or a
 *     compromised install can repaint the doctor's output and hide the real finding. One implementation, applied to every
 *     field, is the only version of that control that holds.
 *  3. **One shape definition.** The interfaces below double as the schema for the JSON export and for the documentation
 *     table, so a contract test can assert that what is published is exactly what is documented.
 *
 * Publication rules, enforced here rather than remembered in review:
 *
 *  • **No absolute paths.** Paths reaching evidence are display strings already abbreviated to `~` by the binary module. A
 *    diagnostic needs to say *where* it looked; it never needs to publish a home directory into a shared CI log.
 *  • **No environment values, no tokens, no file contents.** Nothing from `.npmrc`, nothing from the process environment,
 *    nothing read out of a project file.
 *  • **No `undefined`.** Absent observations are `null`. `undefined` disappears during JSON serialisation and would erase
 *    the difference between "we looked and found nothing" and "we never looked".
 *  • **Bounded text.** Free-form text is stripped, collapsed and capped. Evidence is a summary, not a log transcript.
 */

import type { CypressConditionResult } from "../../project/cypress-health/index.js";

/* -------------------------------------------------------------------------- */
/* Limits and sanitisation                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Cap on any free-form text placed in evidence.
 *
 * Long enough for the actionable tail of Cypress output, short enough that evidence stays a summary. Truncation keeps the
 * *end* of the string because that is where command output puts the reason.
 */
const MAX_EVIDENCE_TEXT = 300;

/*
 * `no-control-regex` is disabled for the two patterns below, deliberately and within this block only.
 *
 * Block form rather than `eslint-disable-next-line`: the ANSI pattern does not fit on the assignment line, so the formatter
 * puts it on the next one — and `-next-line` then applies to the assignment and misses the pattern entirely. That is not a
 * theoretical trap; it is what happened, reported as one unused directive and one violation on the same expression.
 *
 * The rule itself is right in general and wrong here. Matching terminal control characters is the entire purpose of these
 * expressions: the text they sanitise comes from a binary a project controls, and a pattern that avoided control
 * characters could not remove them.
 */
/* eslint-disable no-control-regex -- matching control characters is the purpose of these two patterns */
const ANSI_ESCAPE =
  /\u001B(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\)|[@-Z\\-_])/g;

/** Remaining C0/C1 control characters, which have no place in a diagnostic message. */
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/g;
/* eslint-enable no-control-regex */

/**
 * Normalises untrusted text for publication.
 *
 * Strips terminal control sequences, collapses all whitespace, trims, and caps length. Returns `null` for "nothing usable
 * left", so an empty probe output cannot be published as `""` and mistaken for a meaningful value.
 *
 * Exported so the behaviour is testable directly rather than only through a rule.
 */
export function sanitiseEvidenceText(
  value: string | null | undefined,
): string | null {
  if (value === null || value === undefined) return null;

  const stripped = value
    .replace(ANSI_ESCAPE, " ")
    .replace(CONTROL_CHARACTERS, " ");
  const collapsed = stripped.replace(/\s+/g, " ").trim();

  if (collapsed === "") return null;

  return collapsed.length > MAX_EVIDENCE_TEXT
    ? `…${collapsed.slice(-MAX_EVIDENCE_TEXT)}`
    : collapsed;
}

/**
 * Reads a text field out of a condition result and sanitises it.
 *
 * The health module's evidence is a loose record by contract, so this is where the narrowing happens — once, for every
 * Cypress check. Returning `null` rather than `undefined` keeps a published finding honest through JSON round-trips.
 */
export function readEvidenceText(
  result: CypressConditionResult,
  key: string,
): string | null {
  const value = result.evidence[key];

  return typeof value === "string" ? sanitiseEvidenceText(value) : null;
}

/* -------------------------------------------------------------------------- */
/* Serialised form                                                            */
/* -------------------------------------------------------------------------- */

/** A value that is safe and meaningful once serialised. */
export type CypressEvidenceValue =
  string | number | boolean | null | readonly string[];

/**
 * The shape a finding's evidence slot accepts.
 *
 * The three interfaces below are the *documented* shape of what each check publishes; this is the loose record the
 * reporting contract takes. The bridge between them is a spread at the call site —
 * `evidence: { ...buildCypressHealthEvidence(result) }` — which yields an anonymous object type with an implicit index
 * signature. That is deliberate: the alternative would be to give each interface an index signature, which would let any
 * misspelt key type-check and quietly publish a field nobody reads.
 */
export type CypressEvidenceRecord = Readonly<
  Record<string, CypressEvidenceValue>
>;

/* -------------------------------------------------------------------------- */
/* Published shapes, per check                                                */
/* -------------------------------------------------------------------------- */

/**
 * DEP-003 — declaration and installation.
 *
 * `declared` is derived from `declaredIn` rather than stored twice, so a malformed observation cannot produce the
 * contradiction "declared: true, declaredIn: null".
 */
export interface CypressDependencyEvidence {
  readonly declared: boolean;
  readonly declaredIn: string | null;
  readonly declaredSpecifier: string | null;
  readonly installedVersion: string | null;
  readonly supportedRange: string | null;
}

/**
 * DEP-004 — version identification and compatibility.
 *
 * `supportedOrigin` carries the provenance of the range ("adapters/cypress#compatibility") because a finding that says "this
 * version is unsupported" must be able to say on what authority, or a reader has no way to judge the claim.
 *
 * `evaluatorReason` is the version engine's own reason, retained for debugging: it distinguishes "version unparsable" from
 * "range unparsable", which are different fixes and would otherwise both surface as "unknown".
 *
 * `blockedBy` and `blockedByReason` describe a prerequisite rather than this check, so a skipped finding explains itself
 * from the JSON alone without the reader correlating findings by hand.
 */
export interface CypressCompatibilityEvidence {
  readonly detected: string | null;
  readonly supported: string | null;
  readonly supportedOrigin: string | null;
  readonly evaluatorReason: string | null;
  readonly blockedBy: string | null;
  readonly blockedByReason: string | null;
}

/**
 * DEP-008 — binary availability.
 *
 * `verifiedBy` is the calibration of the verdict: `static-cache-inspection` means "a file with execute bits",
 * `cypress-verify` means "Cypress started it". Publishing it stops a `stat` from being read as proof of execution.
 *
 * `probeDetail` is the only field carrying project-controlled text, which is exactly why it goes through
 * `sanitiseEvidenceText`.
 */
export interface CypressBinaryAvailabilityEvidence {
  readonly detected: string | null;
  readonly cacheRoot: string | null;
  readonly expectedPath: string | null;
  readonly verifiedBy: string | null;
  readonly probeDetail: string | null;
  readonly blockedBy: string | null;
  readonly blockedByReason: string | null;
}

/** Whatever the check being built publishes. Used so the dispatcher has one honest return type. */
export type CypressEvidence =
  | CypressDependencyEvidence
  | CypressCompatibilityEvidence
  | CypressBinaryAvailabilityEvidence;

/* -------------------------------------------------------------------------- */
/* Context supplied by the calling rule                                       */
/* -------------------------------------------------------------------------- */

/**
 * Facts a rule owns that the assessment does not.
 *
 * Evidence combines two sources: what was *observed* (on the condition result) and what the *policy* says (injected at
 * composition). Both go through the same allowlist so a policy-derived field can never bypass publication rules.
 */
export interface CypressEvidenceContext {
  /** Supported range, for checks whose finding quotes the policy. */
  readonly supportedRange?: string | null;
}

/* -------------------------------------------------------------------------- */
/* Builders                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * DEP-003 evidence.
 *
 * Note what is absent: the resolved package directory. It is an absolute path and belongs in verbose logs, not in a
 * persisted finding.
 */
export function buildCypressDependencyEvidence(
  result: CypressConditionResult,
  context: CypressEvidenceContext = {},
): CypressDependencyEvidence {
  const declaredIn = readEvidenceText(result, "declaredIn");

  return Object.freeze({
    declared: declaredIn !== null,
    declaredIn,
    declaredSpecifier: readEvidenceText(result, "declaredSpecifier"),
    installedVersion: readEvidenceText(result, "installedVersion"),
    supportedRange: sanitiseEvidenceText(context.supportedRange ?? null),
  });
}

/** DEP-004 evidence. See the interface above for what each field is for. */
export function buildCypressCompatibilityEvidence(
  result: CypressConditionResult,
): CypressCompatibilityEvidence {
  return Object.freeze({
    detected: readEvidenceText(result, "detected"),
    supported: readEvidenceText(result, "supported"),
    supportedOrigin: readEvidenceText(result, "supportedOrigin"),
    evaluatorReason: readEvidenceText(result, "evaluatorReason"),
    blockedBy: result.prerequisite?.checkId ?? null,
    blockedByReason: result.prerequisite?.reason ?? null,
  });
}

/**
 * DEP-008 evidence.
 *
 * `cacheRoot` and `expectedPath` are already `~`-abbreviated upstream; the sanitiser is applied anyway so every published
 * field passes the same gate, including the one field that carries untrusted output.
 */
export function buildCypressBinaryEvidence(
  result: CypressConditionResult,
): CypressBinaryAvailabilityEvidence {
  return Object.freeze({
    detected: readEvidenceText(result, "detected"),
    cacheRoot: readEvidenceText(result, "cacheRoot"),
    expectedPath: readEvidenceText(result, "expectedPath"),
    verifiedBy: readEvidenceText(result, "verifiedBy"),
    probeDetail: readEvidenceText(result, "probeDetail"),
    blockedBy: result.prerequisite?.checkId ?? null,
    blockedByReason: result.prerequisite?.reason ?? null,
  });
}

/**
 * Dispatches to the builder for the result's own check.
 *
 * The three rules call this one function, so "which evidence does a DEP-008 finding publish" has exactly one answer. The
 * return type is the union of the three shapes rather than a loose record: the caller knows which check it is building, and
 * a precise type keeps the field names checked at the call site instead of silently accepting any key.
 *
 * An unrecognised ID throws rather than returning an empty object: a finding whose evidence silently carries nothing is
 * indistinguishable from a finding that had nothing to report, and the check engine isolates a throwing check rather than
 * letting it corrupt the run. The branch is unreachable while `CypressConditionResult['checkId']` has three members, which
 * is precisely why it stays: it is the seed of an error the day a fourth check is added and this switch is not updated.
 */
export function buildCypressHealthEvidence(
  result: CypressConditionResult,
  context: CypressEvidenceContext = {},
): CypressEvidence {
  switch (result.checkId) {
    case "DEP-003":
      return buildCypressDependencyEvidence(result, context);

    case "DEP-004":
      return buildCypressCompatibilityEvidence(result);

    case "DEP-008":
      return buildCypressBinaryEvidence(result);

    default:
      throw new Error(
        `No Cypress evidence model for check ${String(result.checkId)}`,
      );
  }
}

/* -------------------------------------------------------------------------- */
/* Published key sets — the anti-drift device                                 */
/* -------------------------------------------------------------------------- */

/**
 * The exact keys each check publishes.
 *
 * Exported so a contract test can assert that a real finding's `Object.keys(evidence)` equals this list. Without it, a field
 * can be added to a builder and never documented — or worse, a field can be removed while the documentation still promises
 * it. Evidence is a published contract; changes to it should be deliberate and visible in review.
 */
export const CYPRESS_EVIDENCE_KEYS = {
  "DEP-003": [
    "declared",
    "declaredIn",
    "declaredSpecifier",
    "installedVersion",
    "supportedRange",
  ],
  "DEP-004": [
    "detected",
    "supported",
    "supportedOrigin",
    "evaluatorReason",
    "blockedBy",
    "blockedByReason",
  ],
  "DEP-008": [
    "detected",
    "cacheRoot",
    "expectedPath",
    "verifiedBy",
    "probeDetail",
    "blockedBy",
    "blockedByReason",
  ],
} as const satisfies Record<string, readonly string[]>;
