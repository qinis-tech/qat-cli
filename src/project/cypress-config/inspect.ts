/**
 * The CFG-003 location verdict: detection evidence plus our own file facts.
 *
 * This is a projection, not a discovery pass. `cypress-detection` has already
 * decided *what exists* — which configuration file, in what layout, whether the
 * directory is a Cypress project at all — and reports a verdict plus evidence.
 * This function decides the follow-up question: *is what exists usable?*
 *
 * Keeping that boundary means one probe of the tree per run. A second opinion
 * about the same directory is not free: it can disagree with the first, costs a
 * full traversal, and gives the user two reports to reconcile.
 *
 * Pure: no filesystem, no clock, no globals. The same detection plus the same
 * facts always produce the same verdict, which is what makes every mandatory
 * scenario a plain function call over fixtures.
 */

import path from "node:path";

import type { CypressDetection } from "../cypress-detection/contracts.js";

import type {
  ConfigDiscovery,
  ConfigFileFacts,
  CypressConfigFormat,
} from "./contracts.js";

/**
 * Freezes and narrows in one step.
 *
 * Typing the parameter as the union gives object literals full contextual
 * typing and excess-property checking against every member, so a field that a
 * reason does not carry is a compile error rather than something a reader has to
 * notice. Freezing keeps the immutability claim honest without `Object.freeze`
 * calls scattered through the branches.
 */
const verdict = (value: ConfigDiscovery): ConfigDiscovery =>
  Object.freeze(value);

/** Sorted, frozen copy — evidence order must never depend on directory order. */
const sorted = (files: readonly string[]): readonly string[] =>
  Object.freeze([...files].sort());

/**
 * Cypress configuration has been a module since v10; `.json` is the pre-v10
 * carrier. This predicate is the only place that opinion lives, so changing the
 * policy is one edit rather than a hunt through evidence and messages.
 */
function isLegacyConfiguration(file: string): boolean {
  return path.extname(file).toLowerCase() === ".json";
}

/**
 * Format decides how far validation is allowed to go: `json` can be parsed
 * definitively, `executable` can only be loaded by the project's own Cypress.
 */
function formatOf(file: string): CypressConfigFormat {
  return isLegacyConfiguration(file) ? "json" : "executable";
}

/**
 * Decides the configuration situation for one project.
 *
 * The order below mirrors the order a user must fix things, and each branch stops
 * at exactly one reason so the reporter writes exactly one message:
 *
 *   is anything configured → is there more than one → is the name one Cypress
 *   reads → is it where Cypress looks → is the path free → can we open it →
 *   does it contain anything → is it the modern format.
 */
export function inspectConfiguration(input: {
  readonly detection: CypressDetection;
  /**
   * Facts about the reported file, when something inspected it.
   *
   * Declared `| undefined` rather than only optional, because the explicit `undefined` is part of the contract: a gatherer
   * that decided nothing needed inspecting passes the value it has, and "nobody looked" is a real answer this function
   * reports as `NOT_INSPECTED`. Optional-only would force every caller into a spread or a ternary to say the same thing.
   */
  readonly facts?: ConfigFileFacts | undefined;
}): ConfigDiscovery {
  const { detection, facts } = input;
  const { layout } = detection;

  switch (detection.verdict) {
    // `absent` and `incomplete` both mean "no configuration file", but the
    // evidence around them usually explains why — and the explanation is the
    // whole value of the message.
    case "absent":
    case "incomplete": {
      // A directory sitting on a configuration filename is invisible to a file
      // probe, so the engine correctly reported no configuration. This is the
      // one fact that turns a baffling "no configuration found" into "delete
      // that directory".
      if (layout.occupiedConfigurationPaths.length > 0) {
        return verdict({
          reason: "CYPRESS_CONFIG_PATH_OCCUPIED",
          outcome: "fail",
          paths: sorted(layout.occupiedConfigurationPaths),
        });
      }

      // Configured, just not where Cypress looks. Distinct from "nothing is
      // configured": the fix is to move a file, not to write one.
      if (layout.misplacedConfigurations.length > 0) {
        return verdict({
          reason: "CYPRESS_CONFIG_MISPLACED",
          outcome: "warning",
          files: sorted(layout.misplacedConfigurations),
        });
      }

      return verdict({
        reason: "CYPRESS_CONFIG_MISSING",
        outcome: "fail",
        // Mirrors the engine's own split, because the two need different
        // messages: "nothing here is Cypress" is a setup problem, while
        // "Cypress is here but unconfigured" is a half-finished migration.
        context:
          detection.verdict === "incomplete"
            ? "cypress-evidenced"
            : "no-cypress-evidence",
      });
    }

    // Two configuration files is not a preference to resolve, it is a fight to
    // report: Cypress refuses to start rather than pick one, so choosing a
    // "winner" here would bless a file Cypress is about to reject.
    case "ambiguous":
      return verdict({
        reason: "CYPRESS_CONFIG_AMBIGUOUS",
        outcome: "fail",
        files: sorted(detection.configurations),
      });

    case "unsupported":
      return verdict({
        reason: "CYPRESS_CONFIG_UNSUPPORTED_NAME",
        outcome: "fail",
        // Both sets: a project mid-migration has a usable-looking file and an
        // ignored one, and naming only the ignored half sends the user to the
        // wrong file.
        files: sorted([
          ...detection.configurations,
          ...detection.unsupportedConfigurations,
        ]),
      });

    case "detected":
      // Narrowed to `DetectedProject` past this point: `configuration` exists.
      break;
  }

  const file = detection.configuration;

  // Detection said the file is there; without facts we have observed nothing
  // about it, so we say so rather than assuming it is usable.
  if (facts === undefined) {
    return verdict({
      reason: "CYPRESS_CONFIG_NOT_INSPECTED",
      outcome: "indeterminate",
      file,
    });
  }

  return refineFromFacts(detection.root, file, facts);
}

/**
 * An advisory for a stale configuration that exists somewhere Cypress ignores.
 *
 * Produced separately and only alongside a `detected` verdict, because the
 * failure paths above already explain themselves — double-reporting the same
 * file would make one problem look like two. The engine's own wording applies:
 * worth mentioning, not worth failing.
 */
export function inspectMisplacedConfiguration(
  detection: CypressDetection,
): ConfigDiscovery | undefined {
  if (
    detection.verdict !== "detected" ||
    detection.layout.misplacedConfigurations.length === 0
  ) {
    return undefined;
  }

  return verdict({
    reason: "CYPRESS_CONFIG_MISPLACED",
    outcome: "warning",
    files: sorted(detection.layout.misplacedConfigurations),
  });
}

/**
 * Applies our own observations to a configuration detection accepted.
 *
 * Readability is judged before emptiness, and emptiness before format: a file we
 * could not open tells us nothing about its contents, and a file with no
 * contents tells us nothing about its format. Each answer is only as strong as
 * the evidence in front of it.
 */
function refineFromFacts(
  projectRoot: string,
  file: string,
  facts: ConfigFileFacts,
): ConfigDiscovery {
  switch (facts.state) {
    case "outside-project":
      // The boundary is the project root and nothing else. Reading a file that
      // escapes it would let a repository point QAT at something the developer
      // never meant to expose to a diagnostic.
      return verdict({
        reason: "CYPRESS_CONFIG_OUTSIDE_PROJECT",
        outcome: "fail",
        file,
        resolvedPath: facts.absolutePath,
        projectRoot,
      });

    // A directory, or a link that leads nowhere: in both cases the actionable
    // fact is that this is not a file Cypress can read.
    case "directory":
    case "dangling-symlink":
      return verdict({
        reason: "CYPRESS_CONFIG_NOT_A_FILE",
        outcome: "fail",
        file,
      });

    case "unreadable":
      return verdict({
        reason: "CYPRESS_CONFIG_UNREADABLE",
        outcome: "fail",
        file,
        // The snapshot collapses EACCES/EPERM/EIO/ELOOP into one state, so
        // provenance is reported as the overwhelmingly common case. Carrying the
        // errno on `ConfigFileFacts` would make this exact — worth doing only if
        // the distinction ever changes the remedy, which today it does not.
        cause: "permissions",
      });

    case "file":
      break;
  }

  // Present but provably useless: Cypress cannot load a configuration with no
  // exports. Calling this "valid but empty" would send the user hunting for a
  // syntax error that does not exist.
  if ((facts.sizeBytes ?? 0) === 0) {
    return verdict({ reason: "CYPRESS_CONFIG_EMPTY", outcome: "fail", file });
  }

  // Detected, readable and valid for its era — deprecated, not broken. A
  // Warning is precisely the severity that says "true, and worth acting on
  // before your next upgrade".
  if (isLegacyConfiguration(file)) {
    return verdict({
      reason: "CYPRESS_CONFIG_LEGACY_FORMAT",
      outcome: "warning",
      file,
      sizeBytes: facts.sizeBytes ?? 0,
    });
  }

  return verdict({
    reason: "CYPRESS_CONFIG_FOUND",
    outcome: "pass",
    file,
    format: formatOf(file),
    sizeBytes: facts.sizeBytes ?? 0,
  });
}
