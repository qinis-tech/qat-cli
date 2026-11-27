/**
 * CFG-004 — could a supported mechanism establish that the Cypress configuration is
 * valid, and if so, what did it say?
 *
 * Three things are deliberately not done here:
 *
 *   • **No loading.** `ConfigValidation` is a decision, and decisions are made in the
 *     gatherer — the only layer allowed to touch a filesystem or spawn a process.
 *     `evaluate` is synchronous by type, which is the guarantee, not an
 *     inconvenience: a check that could await would eventually reach for a disk.
 *
 *   • **No skip logic of its own.** This check declares the location check as its
 *     `precondition`, so a failed or skipped prerequisite makes this one skipped
 *     *before* it runs. What that does **not** cover is a location verdict that
 *     *passed* while nothing was validated — a project that is located and simply not
 *     applicable — and that arrives here as `CYPRESS_CONFIG_SKIPPED` rather than as a
 *     skip of this check.
 *
 *   • **No prose.** The sentence comes from `guidance.ts`, keyed by the code. Both
 *     entries read the verdict they are told about — the invalid one names the
 *     mechanism, the kind and the line; the unverified one branches on the gap
 *     cause. None of that belongs here.
 *
 * ## Why two codes and not six
 *
 * A mechanism spoke and said no, or no mechanism was entitled to speak. That is the
 * distinction the whole configuration pair rests on, so it survives as two codes.
 * The six ways the second can happen share one, because they share one remedy — get
 * a mechanism, then ask again — and because a code per cause would put QAT's own
 * default behaviour ("deep validation is off") in the same list as the project's
 * defects.
 *
 * With no evidence bag on `CheckFinding`, the cause still reaches a reader: the
 * guidance entry branches on it and the explanation says which one it was. What the
 * finding refuses to carry is the loader's raw message, because a loader's message
 * can embed a code frame and a code frame is file content.
 *
 * The severity is Error, and it is safe to declare that flatly precisely because
 * `fail` is only reachable when a mechanism actually established invalidity. An
 * unproven claim of invalidity would be a false finding; this check would rather
 * warn that it could not tell than block on something it never observed.
 */

import {
  CheckCategory,
  CheckId,
  HealthCode,
  type CheckFinding,
} from "../../../core/application/checks.js";
import { DiagnosticSeverity } from "../../../core/application/diagnostics.js";
import { FactGroup, PASS, present } from "../contracts.js";
import type { CheckDefinition, CheckVerdict } from "../contracts.js";
import { healthFinding } from "../guidance.js";

/**
 * A scenario identifier, prefixed by the check's own identifier.
 *
 * Built from the constant rather than typed as a literal: the register asserts every
 * scenario name starts with its check's identifier, and two literal strings that must
 * agree is exactly the duplication a table exists to prevent.
 */
const scenario = (name: string): string =>
  `${CheckId.CypressConfigurationValidatable}.${name}`;

export const cypressConfigValidityCheck: CheckDefinition = {
  id: CheckId.CypressConfigurationValidatable,
  category: CheckCategory.CypressConfiguration,
  title: "Cypress configuration validatable",

  purpose:
    "A configuration that parses but cannot be loaded fails at run time with a message far from its cause.",

  procedure:
    "Reports which mechanism validated the configuration, or why none was entitled to an opinion.",

  // The same group the location check reads, taken from the same capture. Two
  // verdicts about one file, so the two checks cannot describe two different
  // instants of the filesystem.
  requires: [FactGroup.CypressConfiguration],

  // Not an ordering dependency: a *failed or skipped* location check makes this one
  // skipped, which is precisely "no configuration was located, so there is nothing
  // to validate" without a second finding saying it. A location check that passes —
  // including when the project is not applicable — does not skip this one, and the
  // `CYPRESS_CONFIG_SKIPPED` case below is what handles the verdict it then
  // receives.
  precondition: CheckId.CypressConfigurationLocated,

  severity: DiagnosticSeverity.Error,

  // One scenario per reachable outcome, including every gap cause. The gap causes
  // are the interesting half — "not validated" is a legitimate result and would
  // otherwise be the branch nobody proves.
  scenarios: [
    scenario("validated-json"),
    scenario("validated-loader"),
    scenario("invalid-syntax"),
    scenario("invalid-shape"),
    scenario("invalid-load"),
    scenario("not-validated-deep-disabled"),
    scenario("not-validated-deep-unavailable"),
    scenario("not-validated-probe-timeout"),
    scenario("not-validated-undecodable"),
    scenario("not-validated-size-budget"),
    scenario("not-validated-text-sanity"),
  ],

  evaluate: (facts): CheckVerdict => {
    // Guaranteed present by `requires`; the throw is for the case where this check
    // and its declaration disagree, which is a defect here rather than a project
    // condition and must be loud rather than reported as a finding.
    const { validation } = present(facts.cypressConfiguration);

    switch (validation.reason) {
      // A mechanism spoke and was satisfied. The only path to a pass, and the
      // authority — JSON parser or the project's own loader — is named in the
      // sentence the finding carries.
      case "CYPRESS_CONFIG_VALIDATED":
        return PASS;

      // Reached only when a supported mechanism established invalidity: a parser for
      // syntax or shape, the loader for a load failure. That is the entire
      // justification for this check's Error severity.
      case "CYPRESS_CONFIG_INVALID": {
        const finding: CheckFinding = healthFinding(
          HealthCode.CypressConfigurationInvalid,
          facts,
        );

        return { verdict: "fail", finding };
      }

      // Not an error, and not silence. "Could not establish" is a warn by this
      // layer's own rule: silence must not read as consent, and a question we failed
      // to answer must not block work we can still perform. Which of the six causes
      // it was is decided in the guidance entry, from this same verdict.
      case "CYPRESS_CONFIG_NOT_VALIDATED": {
        const finding: CheckFinding = healthFinding(
          HealthCode.CypressConfigurationUnverified,
          facts,
        );

        return { verdict: "warn", finding };
      }

      // Nothing was validated, and there is nothing wrong with that.
      //
      // This case is reachable, which is what the first version of this switch got
      // wrong. The precondition only skips this check when the location check did
      // not *pass*; a project that is located and simply not applicable passes
      // location and arrives here holding a skipped validation verdict. So does one
      // whose configuration nothing was entitled to inspect, which warns at the
      // location check and has nothing to validate here.
      //
      // Reporting nothing is correct in both: the sentence explaining why there is
      // nothing to validate belongs to the finding that decision already produced,
      // and repeating it here would report one condition as two. Throwing would be
      // worse — it would turn a legitimate state of a non-Cypress project into a
      // crash in the command a user runs because something is already wrong.
      case "CYPRESS_CONFIG_SKIPPED":
        return PASS;
    }
  },
};
