/**
 * The catalogue.
 *
 * Sixteen checks, keyed by identifier so a missing entry does not compile, in the order a reader fixes things in. Every
 * field the task asks for is a field on an entry, which is what makes "every check has a documented purpose" something a
 * test can hold rather than something a reviewer has to remember.
 *
 * ## Two kinds of check, and the difference is visible in the body
 *
 * Five **forward** a conclusion a lower layer already drew: they find the finding the assessment carries and carry it
 * onward unchanged. Eleven **judge** something nothing else looks at — the runtime QAT requires, the runtime a framework
 * requires, the package manager, the Cypress configuration's location and its validity, QAT's own configuration's
 * readability and its validity, the selected environment profile and the variables that profile references, and the two
 * output directories — and author a `QAT-H` finding of their own.
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
 * ## Why the configuration pairs are judged rather than forwarded
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
 * ## Why nine checks are not defined in this file
 *
 * Because their comparisons have real branches, and a branch that lives inside a map literal is a branch nobody tests in
 * isolation. The runtime pair has a floor, a ceiling, gap alternatives, pre-release admission and three unreadable states;
 * the package-manager check has seven conditions that each send a reader somewhere different; the Cypress configuration
 * pair has ten location reasons and six validation gaps; QAT's own configuration pair has six inspection states and eleven
 * codes between them; the environment pair has a selection with three possible origins, a profile that can fail in five
 * ways and references that can fail in four more. All nine live in `./rules/*.js` and are registered here, so this file
 * keeps its single job: decide *which* questions exist, in *what* order, under *which* identifier.
 *
 * File names in `./rules/` are not uniform, and the difference is deliberate rather than drift: the two Cypress rules are
 * named `-discovery` and `-validity` because that pair was named together, while QAT's second rule is `-schema` because
 * what it validates is a schema. A rule's file name is a note to the next reader, not an address the compiler checks —
 * what the compiler checks is that this import names a real module and a real export, which is exactly how the mismatch
 * this file briefly had was caught.
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
 * ## Why each configuration pair is two checks and not one
 *
 * Unlike the package manager, these are not rungs of one ladder: they are two questions with a precondition between them.
 * A file can be located and provably unvalidatable; a file can be located and answer nothing at all, because nothing was
 * entitled to speak. One identifier would carry two remedies and would hide which of the two answered.
 *
 * QAT's own configuration has exactly the same shape, which is why it gained the same pair: a file that cannot be read has
 * nothing to validate, and a file that can be read may still be rejected field by field.
 *
 * ## Why the environment is two checks and not one
 *
 * The same shape, and the same argument. "Is the selected profile usable?" and "are the variables that profile references
 * present?" are different questions with different owners: the first is fixed by editing the configuration a reader
 * committed, the second by exporting a value on the machine that is running. A single identifier would have to carry both
 * remedies and would report a missing variable as a consequence of a profile the reader had already been told to fix.
 *
 * The precondition is what makes the pair honest. An unusable profile has no references worth judging — they belong to a
 * profile that failed the schema, so their presence is not a fact about the project — and the runner says exactly that by
 * skipping the second check with a named cause. The alternative, judging references out of a profile we could not parse,
 * would produce findings about a document we never read.
 *
 * ## Absence is a pass, and whose decision that is
 *
 * "No configuration file" is a supported state: the documented defaults apply. The doctor says so by passing, exactly as
 * it did when the load outcome was the only thing it could see. Whether a *particular command* can proceed without a
 * configuration is that command's guard, not a health question — the report describes the project, and the preflight
 * refuses on behalf of the operation.
 *
 * "No environment selected" is the same kind of state for the same reason: most projects have no environment-specific
 * settings at all, and the documented behaviour for a run with no selection is to use the defaults. A doctor that failed
 * — or even warned — on the commonest configuration in the ecosystem would be teaching its readers to skim. Whether the
 * *invoking command* needs an environment is again decided by that command, which knows what it is about to do; the
 * environment rule receives that decision as evidence (`requiredForOperation`) rather than inferring it, so the report
 * never guesses on a command's behalf.
 *
 * That is why there is no informational severity anywhere in this file. The vocabulary here is pass, warn, fail and skip;
 * "we looked and it is fine" is a pass, and inventing a fourth severity to say it more quietly would give the report two
 * ways to express one outcome.
 */

import {
  CheckCategory,
  CheckId,
  CheckSeverity,
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
import { unwritableFinding } from "./guidance.js";
import { cypressConfigDiscoveryCheck } from "./rules/cypress-config-discovery.js";
import { cypressConfigValidityCheck } from "./rules/cypress-config-validity.js";
import { environmentProfileCheck } from "./rules/environment-profile.js";
import { environmentVariablesCheck } from "./rules/environment-variables.js";
import {
  frameworkRuntimeCheck,
  nodeRuntimeCheck,
} from "./rules/node-runtime.js";
import { packageManagerCheck } from "./rules/package-manager.js";
import { qatConfigDiscoveryCheck } from "./rules/qat-config-discovery.js";
// Named for what it validates rather than for the pair, and that is the only
// asymmetry in this block. The export name is what matters: the compiler has no
// opinion about file names, which is why the import path had to be corrected by
// hand when the two disagreed.
import { qatConfigSchemaCheck } from "./rules/qat-config-schema.js";

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

  /**
   * Registered from the rule module because the question is no longer one question.
   *
   * It used to read the load outcome directly: loaded, not found, empty, malformed, too large, schema-invalid. Two of
   * those belong to the second half of the pair, and one of them — schema-invalid — is the whole of it. Reading a load
   * result here would also mean this check and `qat.configuration-valid` each composing their own picture of one file,
   * which is how two rows of one report end up disagreeing about the same bytes.
   *
   * The rule module consumes the composed inspection instead: one capture, six states, and both checks project from it.
   *
   * Absence is a pass, as it always was. The documented defaults are a supported state, and deciding whether a *command*
   * may proceed without a configuration belongs to that command's preflight rather than to a health question.
   */
  [CheckId.QatConfigurationLoadable]: withoutId(qatConfigDiscoveryCheck),

  /**
   * The second half of the pair, immediately after the first so declaration order satisfies its precondition.
   *
   * The precondition does real work here rather than being decorative: a file that could not be read has nothing to
   * validate, so the runner skips this check with a named cause instead of this one inventing a schema verdict about
   * bytes nobody parsed. That is the whole reason it is a separate identifier rather than three more codes on the check
   * above.
   *
   * Its definition lives in `./rules/qat-config-schema.js` — the file name says what the rule validates, which is the one
   * thing a reader needs to know when deciding whether to open it.
   */
  [CheckId.QatConfigurationValid]: withoutId(qatConfigSchemaCheck),

  /**
   * Registered from the rule module because the question outgrew "is the name in the list".
   *
   * That comparison was the whole of this check when a selection could only be a string compared against an array. The
   * conditions its owner actually hits include an empty selection that must not fall through to a default, a
   * `defaultEnvironment` naming a profile nobody declared, a profile the schema rejected, and paths that escape the
   * project — each with its own remedy, and each decided once in the environment classifier rather than re-derived here.
   *
   * The rule consumes the decided inspection: one resolution of one configuration, and both halves of the pair project
   * from it. Nothing in this file compares a name against a list, because a second comparison is a second answer.
   *
   * The precondition on the configuration check is not decorative either: a file that could not be read declares no
   * profiles, so there is nothing to resolve against and the runner says so by skipping rather than by reporting an
   * empty set as a missing environment.
   */
  [CheckId.EnvironmentResolvable]: withoutId(environmentProfileCheck),

  /**
   * The second half of the pair, immediately after the first so declaration order satisfies its precondition.
   *
   * A separate identifier because it carries a separate remedy: the profile check sends the reader to a file they
   * committed, and this one sends them to a shell, a CI secret store or a `.env` they have not exported. One identifier
   * would have to name both and would report a missing variable as a consequence of a profile the reader had already been
   * told to fix.
   *
   * The precondition is the whole reason the pair is honest. References inside a profile that failed the schema belong to
   * a document that could not be parsed, so their presence is not a fact about the project — the runner skips this check
   * with a named cause instead of judging variables out of a profile nobody read.
   *
   * Severity is `Error` and the *rule* decides when that severity applies: a variable the profile marks required blocks,
   * while one whose requirement the profile never states is reported as a warning. That looks like the conditional
   * severity this file argues against, and is not: the check's declared severity governs only the failure it is entitled
   * to report, and the advisory case is a different verdict it returns rather than a second weight on the same one.
   */
  [CheckId.EnvironmentVariablesPresent]: withoutId(environmentVariablesCheck),

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
