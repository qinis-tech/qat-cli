/**
 * CFG-003 — can the Cypress configuration be located, and is what was found usable?
 *
 * This file is a translation, and nothing else. Everything that required an opinion
 * has already happened by the time it runs:
 *
 *   • `cypress-detection` decided *what exists* — one probe of the tree, its own
 *     verdict, its own evidence;
 *   • the gatherer ran `inspectConfiguration` over that evidence plus the file's
 *     real state, and stored the one reason it produced.
 *
 * A check is data: `evaluate(facts)` has no constructor, no ports, no second
 * channel, and is synchronous by type. That is not a limitation to work around —
 * it is what guarantees every check is testable with literals and cannot acquire a
 * private opinion about what "installed" or "present" means.
 *
 * So this check answers one question in one place: given a decided location, which
 * code, which verdict, which status?
 *
 * ## Where the detail lives now
 *
 * `CheckFinding` has no evidence bag — it is a code, a severity, an explanation, a
 * remediation and a path. So the classification an evidence bag would have carried
 * is carried by the **code**: eleven reporting reasons map to ten distinct `QAT-H`
 * members (two of them share one, because they share a remedy), and a reader — or a
 * filter, or a stored report — can tell "two configuration files" from "not allowed
 * to read it" without parsing prose.
 *
 * That is why the reasons did not collapse into one "Cypress configuration
 * problem": with no structured detail on the finding, the code *is* the detail.
 *
 * Severity is Error, because without a configuration Cypress will not start at
 * all — every later configuration check and `qat run` itself depend on this one.
 * Three reasons still conclude as warnings rather than failures (a legacy format, a
 * stale copy in the wrong place, a file nothing inspected); one declared severity,
 * a status decided by the condition, which is exactly why the two vocabularies are
 * separate.
 */

import {
  CheckCategory,
  CheckId,
  HealthCode,
  type CheckFinding,
} from "../../../core/application/checks.js";
import { DiagnosticSeverity } from "../../../core/application/diagnostics.js";
import type { ConfigDiscovery } from "../../../project/cypress-config/index.js";
import { FactGroup, PASS, present } from "../contracts.js";
import type { CheckDefinition, CheckVerdict } from "../contracts.js";
import { healthFinding } from "../guidance.js";

/**
 * A scenario identifier, prefixed by the check's own identifier.
 *
 * Built from the constant rather than typed as a literal: the register asserts every
 * scenario name starts with its check's identifier followed by a dot, and two literal
 * strings that must agree is exactly the duplication a table exists to prevent. If
 * the identifier ever moved, these move with it.
 *
 * The separator is a dot and that is not cosmetic: `run.test.ts` keys its fixtures
 * by these exact strings, so a different separator makes the rule and its
 * verification disagree while both read correctly in isolation.
 */
const scenario = (name: string): string =>
  `${CheckId.CypressConfigurationLocated}.${name}`;

/**
 * The reason → code map, exhaustive over the reasons that report something.
 *
 * `FOUND` and `NOT_APPLICABLE` are excluded *by type* rather than by a runtime
 * guard: they produce no finding, so an entry for either would be prose nothing
 * could render — and the exclusion is what lets the lookup below be total instead
 * of returning `undefined` for a case the check already handled.
 *
 * A new reason in the contract is a compile error here; a new code in the guidance
 * table is a compile error there. Neither can ship without a sentence the other
 * needs.
 */
const CODE_BY_REASON: Readonly<
  Record<
    Exclude<
      ConfigDiscovery["reason"],
      "CYPRESS_CONFIG_FOUND" | "CYPRESS_CONFIG_NOT_APPLICABLE"
    >,
    HealthCode
  >
> = {
  CYPRESS_CONFIG_MISSING: HealthCode.CypressConfigurationMissing,
  CYPRESS_CONFIG_AMBIGUOUS: HealthCode.CypressConfigurationAmbiguous,
  CYPRESS_CONFIG_UNSUPPORTED_NAME:
    HealthCode.CypressConfigurationUnsupportedFormat,
  CYPRESS_CONFIG_MISPLACED: HealthCode.CypressConfigurationMisplaced,
  // Both reasons end in the same instruction — put a regular file at that path — so
  // they share a code. The guidance entry distinguishes them from the verdict it was
  // given, not by re-inspecting the directory.
  CYPRESS_CONFIG_PATH_OCCUPIED: HealthCode.CypressConfigurationPathNotAFile,
  CYPRESS_CONFIG_NOT_A_FILE: HealthCode.CypressConfigurationPathNotAFile,
  CYPRESS_CONFIG_OUTSIDE_PROJECT: HealthCode.CypressConfigurationOutsideProject,
  CYPRESS_CONFIG_UNREADABLE: HealthCode.CypressConfigurationUnreadable,
  CYPRESS_CONFIG_EMPTY: HealthCode.CypressConfigurationEmpty,
  CYPRESS_CONFIG_LEGACY_FORMAT: HealthCode.CypressConfigurationLegacyFormat,
  CYPRESS_CONFIG_NOT_INSPECTED: HealthCode.CypressConfigurationNotInspected,
};

export const cypressConfigDiscoveryCheck: CheckDefinition = {
  id: CheckId.CypressConfigurationLocated,
  category: CheckCategory.CypressConfiguration,
  title: "Cypress configuration discoverable",

  purpose:
    "A Cypress project cannot start without exactly one configuration file Cypress will read.",

  procedure:
    "Reports the single reason recorded when the project was inspected for a Cypress configuration.",

  // The decided location verdict, gathered once. The check cannot read the file
  // itself — `evaluate` is synchronous by type — and must not: a second read of the
  // same file is a second answer that can disagree with the first.
  requires: [FactGroup.CypressConfiguration],

  // A project that is not recognisable has no configuration to discuss, and
  // reporting one condition as two problems is what the precondition mechanism
  // exists to prevent. This belongs here for the same reason `project.package-metadata`
  // and `cypress.layout-driveable` declare it: nothing about the configuration means
  // anything until the directory is established as a project.
  precondition: CheckId.ProjectRecognised,

  severity: DiagnosticSeverity.Error,

  // One scenario per reason the contract can carry, including the two that produce
  // no finding. A reason with no scenario is a claim nobody verifies.
  scenarios: [
    scenario("found"),
    scenario("missing"),
    scenario("ambiguous"),
    scenario("unsupported-name"),
    scenario("misplaced"),
    scenario("path-occupied"),
    scenario("not-a-file"),
    scenario("outside-project"),
    scenario("unreadable"),
    scenario("empty"),
    scenario("legacy-format"),
    scenario("not-inspected"),
    // Normally unreachable: the precondition above means a non-Cypress project never
    // reaches this check, and the runner reports the skip itself. The scenario stays
    // because the branch below still handles the case where it does — a runner that
    // cannot skip must still get a pass rather than a finding about a file that was
    // never expected.
    scenario("not-applicable"),
  ],

  evaluate: (facts): CheckVerdict => {
    // Guaranteed present by `requires`; the throw is for the case where this check
    // and its declaration disagree, which is a defect here rather than a project
    // condition and must be loud rather than reported as a finding.
    const { location } = present(facts.cypressConfiguration);

    // Not applicable is not a finding: a repository that never claimed to be a
    // Cypress project has no configuration to be missing, and warning about it would
    // train users to ignore this check. Found is a pass by definition.
    if (
      location.reason === "CYPRESS_CONFIG_FOUND" ||
      location.reason === "CYPRESS_CONFIG_NOT_APPLICABLE"
    ) {
      return PASS;
    }

    // Prose and path both come from the guidance table, keyed by the code. The whole
    // of `facts` is handed over because an entry reads the verdict it was told
    // about — no entry opens a directory to decide what to say.
    const finding: CheckFinding = healthFinding(
      CODE_BY_REASON[location.reason],
      facts,
    );

    // `fail` blocks when the check's severity says so; `warn` reports without
    // stopping. "Could not establish" is a warn by the layer's own rule — silence
    // must not read as consent, and a question we failed to answer must not block
    // work we can still perform.
    return location.outcome === "fail"
      ? { verdict: "fail", finding }
      : { verdict: "warn", finding };
  },
};
