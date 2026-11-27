/**
 * CFG-001 — "QAT configuration exists and is readable".
 *
 * Scope
 * ─────
 * One question: can QAT's own configuration document be obtained at all?
 *
 * Six states, and this check has an opinion on two of them. Anything that means
 * "bytes arrived and became a document" is a pass here — including a document
 * that then failed schema validation or declared a version we do not support,
 * because *interpreting* a document is CFG-002's question and answering it twice
 * would put one condition on two rows of the report.
 *
 * Why there is no dependency injection
 * ────────────────────────────────────
 * A check in this catalogue is data with one input: `evaluate(facts)`. No
 * constructor, no port bag, no clock. That is what makes the whole table
 * exercisable from object literals, and what stops one entry behaving differently
 * depending on who assembled it.
 *
 * The configuration verdict therefore arrives as evidence — `facts.configuration`
 * — rather than through an accessor. Composition memoises it per project root, so
 * CFG-001 and CFG-002 read *one* value produced by *one* read. Sharing a value is
 * the stronger guarantee than sharing a getter: there is nothing left to call
 * twice.
 *
 * Why this file does not use `classifyConfiguration`
 * ─────────────────────────────────────────────────
 * That helper renders findings, and rendering needs a guidance port and a
 * redactor. This layer renders prose through `guidance.ts`, keyed by `HealthCode`,
 * so pulling it in would create a second text pipeline and a dependency a pure
 * check cannot supply.
 *
 * Remove rendering and what remains is a state-to-code map of a few lines — and
 * that belongs where the state is read.
 */
import {
  CheckCategory,
  CheckId,
  CheckSeverity,
  HealthCode,
} from "../../../core/application/checks.js";
import {
  FactGroup,
  PASS,
  present,
  type CheckDefinition,
  type CheckFacts,
  type CheckVerdict,
} from "../contracts.js";
import { healthFinding } from "../guidance.js";

/**
 * The discovery half of QAT's configuration pair.
 *
 * Severity is `error` even though absence is a normal state, and the two are not
 * in tension: this check's *unfavourable* answer — a file that exists and cannot
 * be read — blocks. Absence is not an unfavourable answer here; whether a
 * particular command may proceed without a configuration is that command's
 * preflight, which knows what the user asked for and this check does not.
 */
export const qatConfigDiscoveryCheck: CheckDefinition = {
  id: CheckId.QatConfigurationLoadable,
  category: CheckCategory.QatConfiguration,
  title: "QAT configuration readable",
  purpose:
    "A configuration file that cannot be read is not a reason to run with defaults, and a reader needs to know which kind of unreadable it is before touching a setting.",
  procedure:
    "Reads the composed configuration verdict and distinguishes absent from unreadable, malformed and oversized.",
  requires: [FactGroup.Configuration],
  severity: CheckSeverity.Error,
  scenarios: [
    "qat.configuration-loadable.absent",
    "qat.configuration-loadable.loaded",
    "qat.configuration-loadable.unreadable",
    "qat.configuration-loadable.not-json",
    "qat.configuration-loadable.too-large",
    // The boundary this check exists to respect: a document we can read but
    // cannot interpret is still readable, and CFG-002 is where that is said.
    "qat.configuration-loadable.schema-invalid-is-still-readable",
    "qat.configuration-loadable.version-unsupported-is-still-readable",
  ],

  evaluate: (facts) => {
    const inspection = present(facts.configuration);

    switch (inspection.state) {
      /**
       * The document arrived. Everything else about it belongs to the validity
       * check, which owns the version gate and the field report.
       */
      case "valid":
      case "schema-invalid":
      case "version-unsupported":
        return PASS;

      /**
       * Absent is a supported state: the documented defaults apply.
       *
       * A pass, not an informational finding. The verdict vocabulary is pass,
       * warn, fail and skip; "we looked and it is fine" is the first of those,
       * and inventing a quieter channel for it would give the report two ways to
       * express one outcome.
       */
      case "missing":
        return PASS;

      /**
       * Present and unobtainable. Two codes, not one: "too large" is a file the
       * reader can shrink, while a permission or a directory sitting on the path
       * is fixed outside the file. The inspection already decided which; this
       * layer only chooses the sentence.
       */
      case "inaccessible":
        return fail(
          inspection.code === "TOO_LARGE"
            ? HealthCode.ConfigurationTooLarge
            : HealthCode.ConfigurationUnreadable,
          facts,
        );

      /**
       * Present, readable and not a document.
       *
       * `ConfigurationEmpty` is deliberately not selected. An empty file reaches
       * this state today — the loader's `Empty` outcome becomes a malformed
       * failure in translation — and this check cannot tell the two apart without
       * guessing from an absent line number. When the inspection grows a distinct
       * empty state, that branch is one line and the code's prose already exists.
       */
      case "malformed":
        return fail(HealthCode.ConfigurationNotJson, facts);
    }
  },
};

/**
 * Renders one failure verdict.
 *
 * Extracted so the failing branches cannot drift in how they build a verdict.
 * Severity is not a parameter: it comes from the guidance table, keyed by the
 * code, so it cannot be passed wrongly.
 */
function fail(code: HealthCode, facts: CheckFacts): CheckVerdict {
  return { verdict: "fail", finding: healthFinding(code, facts) };
}
