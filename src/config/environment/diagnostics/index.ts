/**
 * Public surface of the environment diagnostics sub-module.
 *
 * This barrel exists to make the module boundary explicit and to give callers a
 * single import path, so that the internal split (classification policy vs
 * output safety) stays free to change without touching every call site.
 *
 * The pipeline it exposes is deliberately three steps, not one:
 *
 *   inspectEnvironment()      → facts      (profiles, variables, paths)
 *   classifyEnvironment()     → verdicts   (status, severity, reason)
 *   buildEnvironmentEvidence() → evidence  (safe to print or persist)
 *
 * Kept separate because each has a different reason to change and a different
 * kind of test: the classifier is pure policy, the evidence builder is a
 * security boundary. Folding them into one convenient call would make the
 * security boundary invisible, and invisible boundaries get bypassed.
 *
 * What is intentionally absent from this surface:
 *  • no I/O, no filesystem, no process access — everything arrives via ports;
 *  • no dependency on the diagnostics package — these are environment-shaped
 *    results, adapted by the rule layer;
 *  • no internal helpers — the private functions behind classification stay
 *    private, so tests exercise behaviour rather than implementation.
 */

// ─── Facts → verdicts ────────────────────────────────────────────────────────

export {
  classifyEnvironment,
  type ClassifyEnvironmentOptions,
  type EnvironmentDiagnostic,
  type EnvironmentDiagnosticId,
  type EnvironmentDiagnosticSeverity,
  type EnvironmentDiagnosticStatus,
  type EnvironmentDetail,
} from "./classify.js";

// ─── Verdicts → evidence ─────────────────────────────────────────────────────

export {
  buildEnvironmentEvidence,
  type EnvironmentEvidenceInput,
} from "./evidence.js";

// ─── Output gate ─────────────────────────────────────────────────────────────

/**
 * The sanitisers are exported because the rule layer renders human output too,
 * and human output is the easiest place to forget the gate. Exporting them means
 * there is one implementation of "safe to print" rather than a copy per renderer.
 *
 * `EVIDENCE_LIMITS` and `OUTSIDE_PROJECT` travel with them so a renderer cannot
 * invent a different bound or placeholder than the persisted evidence uses.
 */
export {
  capList,
  EVIDENCE_LIMITS,
  OUTSIDE_PROJECT,
  sanitiseDetail,
  sanitiseName,
  sanitiseToken,
  toProjectRelative,
} from "./evidence.js";
