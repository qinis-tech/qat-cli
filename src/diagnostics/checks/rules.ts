/**
 * The catalogue.
 *
 * Fourteen checks, keyed by identifier so a missing entry does not compile, in the order a reader fixes things in. Every
 * field the task asks for is a field on an entry, which is what makes "every check has a documented purpose" something a
 * test can hold rather than something a reviewer has to remember.
 *
 * ## Two kinds of check, and the difference is visible in the body
 *
 * Five **forward** a conclusion a lower layer already drew: they find the finding the assessment carries and carry it
 * onward unchanged. Nine **judge** something nothing else looks at — the runtime QAT requires, the runtime a framework
 * requires, the package manager, the Cypress configuration's location and its validity, the QAT configuration file, the
 * selected environment, the two output directories — and author a `QAT-H` finding of their own.
 *
 * The forwarding checks are deliberately thin. Their value is not the logic; it is that the question a *user* asks is
 * answered where they look for it, with the severity and the remedy the layer that noticed the condition chose.
 *
 * ## Why a check never re-derives a policy
 *
 * `cypress.version-supported` does not compare a version with a floor. It reads the finding the version policy produced.
 * A second arithmetic in a second place is the arithmetic that disagrees, and the doctor is the worst possible home for a
 * support decision — it would become the definition the moment somebody read it there.
 *
 * `runtime.node-version` *does* compare, and it is not an exception: it compares by delegating to the one compatibility
 * engine, using the range the package manifest declares, both supplied as evidence. The distinction is between *using* an
 * authority and *being* one. That check contributes no floor, no operator and no tolerance of its own — delete it and the
 * policy is unchanged; delete the engine and nothing compiles.
 *
 * `environment.package-manager` is the third of those, and it compares a version for the same reason and by the same
 * engine: the installed tool's version against whatever the project declared, quoted back with its provenance. What it
 * contributes is the *ladder* — which of several conditions to report first — and nothing about what "supported" means.
 *
 * ## Why the configuration pair is judged rather than forwarded
 *
 * `cypress.configuration-located` used to forward the three detection codes — missing, ambiguous, unusable format — and
 * could report nothing else, because those are the only configuration conditions the detection engine looks for. It
 * probes *names* at the project root and deliberately never reads a file.
 *
 * The rest are file-level facts it cannot see: a directory sitting on the configuration path, a file the user may not
 * read, an empty file, a symlink that escapes the project, a legacy format, a stale copy in the wrong place. Reporting
 * those needs bytes, and bytes are exactly what the detection layer refuses to touch — so a doctor forwarding only the
 * detection codes would call a project configured while its configuration was unreadable, which is the one condition its
 * owner most needs to hear about.
 *
 * Both halves of the pair therefore consume one decided verdict, taken from one capture of one file. Neither re-reads the
 * tree, and the detection codes those three conditions produced remain in the diagnosis for every other consumer.
 *
 * ## Why five checks are not defined in this file
 *
 * Because their comparisons have real branches, and a branch that lives inside a map literal is a branch nobody tests in
 * isolation. The runtime pair has a floor, a ceiling, gap alternatives, pre-release admission and three unreadable states;
 * the package-manager check has seven conditions that each send a reader somewhere different; the configuration pair has
 * ten location reasons and six validation gaps. All five live in `./rules/*.js` and are registered here, so this file
 * keeps its single job: decide *which* questions exist, in *what* order, under *which* identifier.
 *
 * ## Why the package manager is one check and not seven
 *
 * Its conditions are a ladder, and the rungs are mutually exclusive in practice: nothing identifies the tool, so there is
 * no version to compare; the binary is absent, so there is no version to read; the tree is foreign, so "not installed" is
 * not the story. Reporting every rung at once would present consequences of one cause as separate problems — the same
 * reasoning that makes a failed precondition skip a check rather than fail it.
 *
 * The ladder's order is the order a reader fixes things in, so it is also the order the report tells the story in.
 *
 * ## Why the configuration pair is two checks and not one
 *
 * Unlike the package manager, these are not rungs of one ladder: they are two questions with a precondition between them.
 * A file can be located and provably unvalidatable; a file can be located and answer nothing at all, because nothing was
 * entitled to speak. One identifier would carry two remedies and would hide which of the two answered.
 */

import { ConfigurationLoad } from "../../config/loader/index.js";
import {
  CheckCategory,
  CheckId,
  CheckSeverity,
  HealthCode,
  type DoctorDiagnosticCode,
} from "../../core/application/checks.js";
import {
  DetectionStatus,
  DiagnosticCode,
  DiagnosticSeverity,
  PackageMetadataStatus,
} from "../../core/application/diagnostics.js";
import {
  QatOperation,
  ValidationCode,
  type AnyDiagnosticFinding,
} from "../../core/application/validation.js";

import {
  FactGroup,
  PASS,
  present,
  type CheckDefinition,
  type CheckFacts,
  type CheckVerdict,
} from "./contracts.js";
import { healthFinding, unwritableFinding } from "./guidance.js";
import { cypressConfigDiscoveryCheck } from "./rules/cypress-config-discovery.js";
import { cypressConfigValidityCheck } from "./rules/cypress-config-validity.js";
import {
  frameworkRuntimeCheck,
  nodeRuntimeCheck,
} from "./rules/node-runtime.js";
import { packageManagerCheck } from "./rules/package-manager.js";

/**
 * The codes that mean "this directory cannot be recognised as a project QAT could drive".
 *
 * Typed against the union rather than spelled, so a mistyped code is a compile error rather than a filter that quietly
 * matches nothing — which would turn `project.recognised` into a check that always passes.
 *
 * Two conditions, not "any blocking finding": a missing dependency also blocks and is a different question with a
 * different answer. Recognition is about the project's shape; everything else has a check of its own.
 */
const RECOGNITION_CODES: readonly DoctorDiagnosticCode[] = [
  DiagnosticCode.FrameworkNotDetected,
  DiagnosticCode.ManifestUnreadable,
];

/** The code for "there is a configuration, and no spec location this tool can drive". */
const LAYOUT_CODES: readonly DoctorDiagnosticCode[] = [
  ValidationCode.LayoutUnsupported,
];

/** The code for "configured, not installed". */
const INSTALLATION_CODES: readonly DoctorDiagnosticCode[] = [
  DiagnosticCode.DependencyNotInstalled,
];

/**
 * Every code the version policy can produce, from either layer.
 *
 * Two of them are advisory: a major above the known-good range warns and proceeds, which is why this set is read for its
 * *findings* rather than its codes — the severity travels with the finding instead of being re-decided here.
 */
const VERSION_CODES: readonly DoctorDiagnosticCode[] = [
  DiagnosticCode.VersionIncompatible,
  ValidationCode.VersionBelowSupported,
  ValidationCode.VersionAboveKnownGood,
];

/** The manifest warnings. Advisory by nature: a project with no manifest is legal. */
const MANIFEST_CODES: readonly DoctorDiagnosticCode[] = [
  DiagnosticCode.ManifestMissing,
  DiagnosticCode.ManifestIncomplete,
];

/**
 * A verdict from a finding another layer rendered.
 *
 * The severity-to-status mapping, once. An `error` finding is a failure and a `warning` finding is a warning, and every
 * forwarding check goes through this function so the mapping cannot vary between them.
 *
 * No cast: `DiagnosticFinding` is generic over its code set with a readonly `code`, so a finding from a narrower vocabulary
 * is assignable to this layer's wider one. That is what the parameter was added for.
 */
function verdictFrom(finding: AnyDiagnosticFinding): CheckVerdict {
  return {
    verdict: finding.severity === DiagnosticSeverity.Error ? "fail" : "warn",
    finding,
  };
}

/**
 * The first blocking or advisory finding whose code is in a set, or `undefined` when there is none.
 *
 * The caller treats `undefined` as a pass. A check reports what the diagnosis carries and never invents a finding to fill
 * a silence: a sentence about a condition nothing observed is worse than saying nothing, and it would be
 * indistinguishable from a real answer.
 */
function firstOf(
  facts: CheckFacts,
  codes: readonly DoctorDiagnosticCode[],
): AnyDiagnosticFinding | undefined {
  const assessment = present(facts.assessment);

  // Both lists, not only `blocking`. A check that forwards a conclusion has to see the advisory ones too — a missing
  // manifest and a Cypress major above the known-good range are findings, and a search of the blocking list alone would
  // report both conditions as absent. `blocking` first, so an error still wins over a warning for one code.
  const { blocking, warnings } = assessment.gates[QatOperation.Execute];

  return [...blocking, ...warnings].find((finding) =>
    codes.includes(finding.code),
  );
}

/**
 * Separates a definition from its identifier.
 *
 * The map below is keyed by identifier and therefore holds entries without one: the key *is* the identity, and a
 * definition carrying its own copy would allow the two to disagree with nothing to catch it. Destructuring names the
 * discarded field explicitly, so the discard is visible rather than implied by an omission — and the lint config sets
 * `ignoreRestSiblings` precisely so this idiom is not reported as an unused variable. The leading underscore is the
 * house convention for a binding that exists only to be dropped.
 */
function withoutId({
  id: _discardedId,
  ...definition
}: CheckDefinition): Omit<CheckDefinition, "id"> {
  return definition;
}

const BY_ID: Readonly<Record<CheckId, Omit<CheckDefinition, "id">>> = {
  /**
   * Registered from the rule module rather than defined here. Its comparison is the compatibility engine's, and its
   * supported range is whatever the manifest declares — neither of which this file should be able to restate.
   */
  [CheckId.NodeVersion]: withoutId(nodeRuntimeCheck),

  /**
   * Immediately after the blocking runtime question, and advisory. A reader meets the requirement they must satisfy
   * before the one their project's framework adds — and if the first fails, the second is still worth reading, which is
   * why it carries no precondition on its sibling.
   */
  [CheckId.CypressRuntimeSupported]: withoutId(frameworkRuntimeCheck),

  /**
   * Third, and advisory like the rest of the tooling questions.
   *
   * Placed after both runtime checks and before anything about the project's shape, because every remedy below this point
   * names a package manager: "install the dependencies" is advice a reader has to translate when nothing says which tool
   * installs them. Answering it first is what makes the later messages actionable.
   *
   * Carries no precondition on the runtime checks: a project can be un-runnable on this Node *and* still have a perfectly
   * reportable package-manager problem, and the reader may well be able to fix the second on a machine that has no
   * supported interpreter.
   */
  [CheckId.PackageManager]: withoutId(packageManagerCheck),

  [CheckId.ProjectRecognised]: {
    category: CheckCategory.ProjectStructure,
    title: "Project recognised",
    purpose:
      "Nothing else in this report means anything if the directory is not a project, and a reader needs to be told that before being told about its configuration.",
    procedure:
      "Reads the detection status and carries forward the finding that made the project unrecognisable.",
    requires: [FactGroup.Assessment],
    severity: CheckSeverity.Error,
    scenarios: [
      "project.recognised.detected",
      "project.recognised.nothing-identifying-cypress",
      "project.recognised.manifest-unreadable",
    ],
    evaluate: (facts) => {
      const { diagnosis } = present(facts.assessment);

      if (diagnosis.detection === DetectionStatus.Detected) return PASS;

      const finding = firstOf(facts, RECOGNITION_CODES);

      return finding === undefined ? PASS : verdictFrom(finding);
    },
  },

  [CheckId.PackageMetadata]: {
    category: CheckCategory.ProjectStructure,
    title: "Package metadata",
    purpose:
      "A missing or partial manifest is legal and worth knowing: it decides whether the project name is declared or assumed.",
    procedure: "Reads the metadata status and carries forward its warning.",
    requires: [FactGroup.Assessment],
    precondition: CheckId.ProjectRecognised,
    severity: CheckSeverity.Warning,
    scenarios: [
      "project.package-metadata.present",
      "project.package-metadata.missing",
      "project.package-metadata.incomplete",
    ],
    evaluate: (facts) => {
      const { diagnosis } = present(facts.assessment);

      if (diagnosis.identity.packageMetadata === PackageMetadataStatus.Present)
        return PASS;

      const finding = firstOf(facts, MANIFEST_CODES);

      return finding === undefined ? PASS : verdictFrom(finding);
    },
  },

  /**
   * Registered from the rule module because the question outgrew forwarding.
   *
   * It used to carry the three detection codes onward and nothing else, which was correct while the only conditions
   * anyone looked for were ones a name probe can find. The conditions its owner actually hits include a directory on the
   * path, a file they may not read, an empty file and a symlink out of the project — all of which need bytes, and bytes are
   * what the detection layer refuses to read. Ten reasons with ten remedies is a branch, so it lives in
   * `./rules/cypress-config-discovery.js` and is registered here.
   *
   * The precondition stays: a project that is not recognisable has no configuration to discuss, and saying so twice would
   * report one condition as two problems.
   */
  [CheckId.CypressConfigurationLocated]: withoutId(cypressConfigDiscoveryCheck),

  /**
   * The second half of the pair, immediately after the first so declaration order satisfies its precondition.
   *
   * A separate question, not a rung of the same ladder: a located file can be provably invalid, and it can also answer
   * nothing at all because no mechanism was entitled to speak. Registered from its rule module because the verdict has
   * four outcomes, one of them a correct refusal to have an opinion, and because the guidance for its six gaps branches on
   * the cause.
   */
  [CheckId.CypressConfigurationValidatable]: withoutId(
    cypressConfigValidityCheck,
  ),

  [CheckId.CypressLayoutDriveable]: {
    category: CheckCategory.CypressConfiguration,
    title: "Spec location driveable",
    purpose:
      "A project can be configured correctly and still have no specs QAT can run, and a reader needs to know which of the two unsupported shapes they have.",
    procedure:
      "Carries forward the layout finding, which distinguishes an unknown layout from component tests.",
    requires: [FactGroup.Assessment],
    precondition: CheckId.CypressConfigurationLocated,
    severity: CheckSeverity.Error,
    scenarios: [
      "cypress.layout-driveable.supported",
      "cypress.layout-driveable.no-recognisable-location",
      "cypress.layout-driveable.component-only",
    ],
    evaluate: (facts) => {
      const finding = firstOf(facts, LAYOUT_CODES);

      return finding === undefined ? PASS : verdictFrom(finding);
    },
  },

  [CheckId.CypressInstalled]: {
    category: CheckCategory.CypressInstallation,
    title: "Cypress installed",
    purpose:
      "The most common state of a fresh clone is a correct project with nothing installed, and it deserves its own sentence rather than a general failure.",
    procedure:
      "Carries forward the finding for a framework that is configured but not installed.",
    requires: [FactGroup.Assessment],
    precondition: CheckId.CypressConfigurationLocated,
    severity: CheckSeverity.Error,
    scenarios: [
      "cypress.installed.installed",
      "cypress.installed.declared-not-installed",
      "cypress.installed.not-declared-not-installed",
    ],
    evaluate: (facts) => {
      const finding = firstOf(facts, INSTALLATION_CODES);

      return finding === undefined ? PASS : verdictFrom(finding);
    },
  },

  [CheckId.CypressVersionSupported]: {
    category: CheckCategory.CypressInstallation,
    title: "Cypress version supported",
    purpose:
      "An installed major outside the range QAT drives fails somewhere unhelpful later, and the doctor is the cheapest place to say so.",
    procedure:
      "Carries forward the version finding the policy already produced, keeping its severity: below the floor fails, above the known-good major warns.",
    requires: [FactGroup.Assessment],
    precondition: CheckId.CypressInstalled,
    severity: CheckSeverity.Error,
    scenarios: [
      "cypress.version-supported.in-range",
      "cypress.version-supported.below-floor",
      "cypress.version-supported.above-known-good",
    ],
    evaluate: (facts) => {
      const finding = firstOf(facts, VERSION_CODES);

      return finding === undefined ? PASS : verdictFrom(finding);
    },
  },

  [CheckId.QatConfigurationLoadable]: {
    category: CheckCategory.QatConfiguration,
    title: "QAT configuration readable",
    purpose:
      "A broken configuration file is not a reason to run with defaults, and a reader needs to know which kind of broken it is before touching a setting.",
    procedure:
      "Reads the load outcome and distinguishes absent, empty, malformed, oversized and schema-invalid.",
    requires: [FactGroup.Configuration],
    severity: CheckSeverity.Error,
    scenarios: [
      "qat.configuration-loadable.absent",
      "qat.configuration-loadable.loaded",
      "qat.configuration-loadable.empty",
      "qat.configuration-loadable.not-json",
      "qat.configuration-loadable.too-large",
      "qat.configuration-loadable.schema-invalid",
    ],
    evaluate: (facts) => {
      const result = present(facts.configuration);

      switch (result.kind) {
        case ConfigurationLoad.Loaded:
        case ConfigurationLoad.NotFound:
          // Absence is legal: the defaults apply and nothing is wrong. Reported together with `loaded` because the
          // reader's next step is the same either way, and it involves doing nothing.
          return PASS;

        case ConfigurationLoad.Empty:
          return {
            verdict: "fail",
            finding: healthFinding(HealthCode.ConfigurationEmpty, facts),
          };

        case ConfigurationLoad.Malformed:
          return {
            verdict: "fail",
            finding: healthFinding(HealthCode.ConfigurationNotJson, facts),
          };

        case ConfigurationLoad.TooLarge:
          return {
            verdict: "fail",
            finding: healthFinding(HealthCode.ConfigurationTooLarge, facts),
          };

        case ConfigurationLoad.Invalid: {
          const [first] = result.diagnostics;

          // The schema always reports at least one issue, so the fallback is unreachable — and the check reports nothing
          // rather than inventing a sentence for a state that cannot occur.
          return first === undefined
            ? PASS
            : {
                verdict: "fail",
                finding: {
                  code: first.code,
                  // Every schema issue is an error; the code set has no advisory member, and this layer does not
                  // second-guess the catalogue that chose it.
                  severity: DiagnosticSeverity.Error,
                  explanation: first.message,
                  ...(first.remediation === undefined
                    ? {}
                    : { remediation: first.remediation }),
                  // An empty path means the issue is about the document rather than a field.
                  ...(first.path === "" ? {} : { path: first.path }),
                },
              };
        }
      }
    },
  },

  [CheckId.EnvironmentResolvable]: {
    category: CheckCategory.EnvironmentProfiles,
    title: "Selected environment declared",
    purpose:
      "A run told to use an environment that does not exist fails at a point where nothing explains it; the doctor can explain it now.",
    procedure:
      "Compares the selected profile with the profiles the configuration declares. Nothing selected is a pass.",
    // Only the environment facts. The precondition already guarantees a readable configuration, so requiring it again would
    // declare a dependency this check does not read — and a check that lists a group it never touches makes the declaration
    // untrustworthy for the ones that do.
    requires: [FactGroup.Environment],
    precondition: CheckId.QatConfigurationLoadable,
    severity: CheckSeverity.Error,
    scenarios: [
      "qat.environment-resolvable.none-selected",
      "qat.environment-resolvable.declared",
      "qat.environment-resolvable.undeclared",
    ],
    evaluate: (facts) => {
      const { selected, declared } = present(facts.environment);

      if (selected === undefined) return PASS;

      return declared.includes(selected)
        ? PASS
        : {
            verdict: "fail",
            finding: healthFinding(HealthCode.EnvironmentUndeclared, facts),
          };
    },
  },

  [CheckId.ReportsWritable]: {
    category: CheckCategory.OutputPermissions,
    title: "Reports directory writable",
    purpose:
      "A run that cannot write its report has produced nothing a pipeline can use, and finding out at the end costs the whole run.",
    procedure:
      "Reports whether the resolved reports directory accepts a write.",
    requires: [FactGroup.Output],
    precondition: CheckId.QatConfigurationLoadable,
    severity: CheckSeverity.Error,
    scenarios: [
      "output.reports-writable.writable",
      "output.reports-writable.unwritable",
    ],
    evaluate: (facts) => {
      const { reports } = present(facts.output);

      // `unwritableFinding` rather than `healthFinding`: one code covers both directories, so the check supplies the path it
      // probed instead of letting the message guess between two targets.
      return reports.writable
        ? PASS
        : { verdict: "fail", finding: unwritableFinding(reports) };
    },
  },

  [CheckId.EvidenceWritable]: {
    category: CheckCategory.OutputPermissions,
    title: "Evidence directory writable",
    purpose:
      "Evidence is the part of a run a report links to, and it is written to a different path from the report — so it can fail while the report succeeds.",
    procedure:
      "Reports whether the resolved evidence directory accepts a write.",
    requires: [FactGroup.Output],
    precondition: CheckId.QatConfigurationLoadable,
    severity: CheckSeverity.Error,
    scenarios: [
      "output.evidence-writable.writable",
      "output.evidence-writable.unwritable",
      "output.evidence-writable.reports-usable-evidence-not",
    ],
    evaluate: (facts) => {
      const { evidence } = present(facts.output);

      return evidence.writable
        ? PASS
        : { verdict: "fail", finding: unwritableFinding(evidence) };
    },
  },
};

/**
 * Every check, in the order a reader fixes things in.
 *
 * Declaration order is load-bearing twice: it is the report's order, and it guarantees that a precondition appears before
 * its dependant — which is what lets the runner resolve skips in a single pass rather than iterating to a fixed point. The
 * catalogue test asserts it rather than trusting it.
 *
 * The `Record` annotation above is what makes the cast below safe: every key is a member of the union by construction, and
 * a missing member does not compile. Without it, a check could be deleted and the only symptom would be a question that
 * silently stopped being asked.
 *
 * The cast is unavoidable because `Object.entries` widens keys to `string`; it is also the only one in this file, and it
 * is annotated so a reader can see exactly what is being asserted — a tuple of the record's own key type and value type,
 * nothing wider.
 */
export const CHECKS: readonly CheckDefinition[] = (
  Object.entries(BY_ID) as readonly (readonly [
    CheckId,
    Omit<CheckDefinition, "id">,
  ])[]
).map(([id, definition]) => ({ id, ...definition }));
