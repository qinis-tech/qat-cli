/**
 * Evidence model for runtime (engine) diagnostics.
 *
 * This module owns the *reporting* shape of the Node.js compatibility check: the
 * compact, JSON-serialisable record that appears next to a finding in human
 * output, in `--format json`, and in a persisted diagnostic session.
 *
 * Why it is separate from the rule:
 *
 *   • The shape is a CONTRACT. Users pipe `qat doctor --format json` into their
 *     own tooling, so field names are as public as a function signature. Keeping
 *     them in one small file makes an accidental rename a visible diff instead of
 *     a change buried in rule logic.
 *   • The projection has exactly one implementation. If the rule hand-rolled the
 *     evidence object, a second rule that later reports on the same runtime would
 *     produce a slightly different shape — and every consumer would need to know
 *     both.
 *   • Redaction is reviewable in isolation. Everything a persisted diagnostic can
 *     expose is visible in one type, so "can this leak a credential?" is answered
 *     by reading a dozen lines rather than auditing a rule.
 *
 * Invariants this file guarantees, all of them deliberate:
 *
 *   • JSON-SAFE        — absent values are `null`, never `undefined`. JSON drops
 *                        undefined keys, which would make a field vanish rather
 *                        than appear as "not available", and a consumer parsing
 *                        the output could not tell the difference.
 *   • REDACTION-SAFE   — every field is a version string, a policy string or a
 *                        provenance pointer. No paths, no environment values, no
 *                        interpreter metadata. A new field must be reviewed
 *                        against that rule before it is added here.
 *   • ADDITIVE         — fields may be added; renaming or removing one is a
 *                        breaking change to a published output and needs a
 *                        documented decision, not a quick edit.
 *   • STABLE KEYS      — the key set is exported so a test can assert it, which
 *                        is what stops a field silently appearing or vanishing
 *                        between releases.
 */

import type {
  CompatibilityReason,
  CompatibilityVerdict,
  RuntimeRequirementSource,
} from "../../core/compatibility/index.js";
import { formatNodeVersion } from "../../core/compatibility/index.js";

/**
 * Evidence for a runtime compatibility finding.
 *
 * The pairing of `detected` and `expected` is the point of the whole check: it
 * lets a user see immediately what they have, what is required, and where that
 * requirement came from — without reading a paragraph of prose first.
 */
export interface NodeRuntimeEvidence {
  /**
   * The version exactly as the interpreter reported it (`v18.19.0`), or `null`
   * when no version was reported at all.
   *
   * Raw on purpose: it is what the user will see in their own terminal and can
   * search for, and rewriting it would make the evidence disagree with the shell
   * that produced it.
   */
  readonly detected: string | null;

  /**
   * Canonical `MAJOR.MINOR.PATCH[-prerelease]` form, or `null`.
   *
   * Present because comparison happens on normalised values, and a user deciding
   * between "18.19.0" and ">=20.11.0 <21" should not have to strip a `v` prefix
   * or ignore build metadata themselves.
   */
  readonly detectedNormalised: string | null;

  /** The supported range exactly as its owner declared it. Never normalised. */
  readonly expected: string;

  /** Which authority declared `expected`, so attribution is never ambiguous. */
  readonly requirementSource: RuntimeRequirementSource;

  /**
   * Where that declaration lives, in a form the user can open — e.g.
   * `package.json#engines.node`. This is the answer to "says who?", and it is
   * what turns a disagreement with QAT into a two-minute check instead of a
   * support ticket.
   */
  readonly requirementOrigin: string;

  /**
   * Machine-readable reason, for grouping, for `qat explain`, and for tests that
   * assert the *kind* of failure rather than its wording.
   */
  readonly reason: CompatibilityReason;
}

/**
 * The complete key set of the evidence object.
 *
 * Exported so a test can assert that what the rule actually emits matches this
 * list — in both directions. Without it, adding a field to the interface and
 * forgetting to populate it (or populating a field that no longer exists) would
 * only surface as a missing value in someone's downstream report.
 *
 * `satisfies` proves every listed name is a real key; the test proves the list is
 * complete, which the type system cannot do for an array.
 */
export const NODE_RUNTIME_EVIDENCE_FIELDS = [
  "detected",
  "detectedNormalised",
  "expected",
  "requirementSource",
  "requirementOrigin",
  "reason",
] as const satisfies readonly (keyof NodeRuntimeEvidence)[];

/**
 * Projects a compatibility verdict onto its evidence record.
 *
 * This is the only place the projection exists. It performs no evaluation — the
 * verdict is already decided — and it makes no judgement about severity or
 * wording; it only selects and normalises what the user needs to see.
 *
 * Absent values become `null` rather than staying `undefined` so the record
 * survives a JSON round trip with its shape intact: a consumer must be able to
 * distinguish "no version was reported" from "this field was never serialised".
 *
 * Both halves of the projection read from `verdict` and nothing else, which is
 * what keeps this function honest: there is no second source it could disagree
 * with, and no argument a caller could supply that the verdict had not already
 * decided.
 */
export function toNodeRuntimeEvidence(
  verdict: CompatibilityVerdict,
): NodeRuntimeEvidence {
  const { requirement, detected } = verdict;

  return {
    // Raw as reported: `v18.19.0` stays `v18.19.0`, because that is the string the
    // user's own terminal shows and the one they will search for.
    detected: detected?.raw ?? null,

    // Normalised for comparison. Derived rather than stored: a stored copy could
    // drift from `detected`, and one value with two spellings is a bug waiting to
    // be reported as an inconsistency.
    detectedNormalised:
      detected === undefined ? null : formatNodeVersion(detected),

    // Passed through verbatim. A normalised range here would be a second opinion
    // about what the declared requirement is.
    expected: requirement.range,

    requirementSource: requirement.source,
    requirementOrigin: requirement.origin,
    reason: verdict.reason,
  };
}
