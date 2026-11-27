/**
 * The remediation catalogue.
 *
 * One entry per diagnostic code, and the entry is where the prose lives. A condition's explanation, its remedy and its
 * severity are written once, next to the code that identifies it, rather than at each of the places that might report it.
 *
 * The table is a `Record` over the code union, so a code without an entry does not compile. That is the guarantee behind
 * "every diagnostic code has an understandable explanation" — it is not a promise anybody has to remember.
 *
 * ## "Configuration" in this file always means the framework's
 *
 * Every entry below is about finding and trusting a *Cypress* configuration file. That was unambiguous while the tool had
 * no configuration of its own; it is not any more. A project now normally contains `qat.config.json`, which is required,
 * versioned and validated separately — and a reader told that "no configuration file was found" while looking at their own
 * perfectly good one will create a second file and be no closer to a working project.
 *
 * So the prose below names the file it means. This is not pedantry about wording: a remedy that sends a reader to
 * `qat.config.json` is a remedy that fails, and the failure looks like the tool not recognising a file it just read.
 *
 * ## Severity here answers for the project, not for an operation
 *
 * An entry's severity says how serious the condition is, not whether it stops anything. Whether it stops something depends
 * on what the caller was about to do: a project with no configuration is blocked for a run and perfectly reportable by an
 * inspection, and one severity field cannot say both. The per-operation verdict belongs to the validation layer's gate,
 * which reads these severities rather than re-deciding them.
 *
 * ## Why the placement facts earn a clause and not a code
 *
 * The detection engine reports where a configuration *is* as well as whether one was found: a configuration filed inside
 * `cypress/`, and a directory sitting on a configuration path. Both are real, both are diagnosable, and both currently
 * arrive here as "no configuration found".
 *
 * They do not get their own codes, for the reason this catalogue exists: a code names a *condition*, and the condition is
 * the same one — Cypress cannot load a configuration from this directory. What the placement facts change is the
 * explanation and the remedy, which is the difference between "create a file" (wrong, and actively harmful when a
 * directory is in the way) and "move the file you already have".
 *
 * The doctor layer does carry finer-grained codes for these, because it reads file bytes and can tell "unreadable" from
 * "misplaced" from "a directory on the path". This layer answers what detection found about the tree; it stops where the
 * tree stops.
 *
 * ## Why this catalogue holds no runtime entry
 *
 * The Node.js runtime conditions are `QAT-H` codes owned by `src/diagnostics/checks`. They are properties of the machine a
 * command happens to be running on, not of the project being inspected, and nothing here could describe them without
 * borrowing the wrong vocabulary: every entry below is a statement about a tree of files, and "your Node is too old" is not
 * one.
 *
 * The near-miss case is a *project-declared* runtime bound — the range a project's framework release says it needs. That
 * genuinely is a property of the project, and it still does not belong here: it is compared against the running
 * interpreter, so its finding is a runtime finding, and it must name the framework's requirement separately from QAT's. It
 * is reported under `HealthCode.FrameworkRuntimeUnsupported`, from the same pair of checks that report the blocking one.
 *
 * ## Why this catalogue holds no package-manager entry either
 *
 * The same argument, and it is worth writing out because the split here is finer. Package-manager *identity* really is a
 * property of the tree: which lockfile exists and what `packageManager` says are facts about files, and facts about files
 * are what this catalogue is made of.
 *
 * But the question a reader actually asks — "is my package-manager environment healthy?" — cannot be answered from the
 * tree. It needs the installed tool's version, and whether the binary exists at all, which are properties of the machine.
 * One question with two sources belongs where both sources are available, so it lives in `src/diagnostics/checks`, which is
 * also where its prose lives (`HealthCode.PackageManager*`).
 *
 * Putting identity here and health there was the alternative, and it is worse in a specific way: the same condition would
 * acquire two owners, and the day the two disagreed about what "the package manager" is, neither would be obviously wrong.
 *
 * ## Why this file keeps a Cypress major while a sibling file deleted a Node major
 *
 * `MINIMUM_CYPRESS_MAJOR` is a fact about a file format. Cypress 10 introduced `cypress.config.*`, so an installation older
 * than that cannot read the file whose presence is what identified the project. It is not a support policy, it is not
 * restated from any manifest, and it changes only if Cypress changes its format again.
 *
 * The Node floor that used to live in the checks layer's guidance was the opposite kind of number: a support policy, derived
 * from the package manifest, and therefore available as evidence. It was deleted, and the check now compares against
 * whatever the manifest declares.
 *
 * Both constants were integers and only one of them was a duplicate. That is why the rule is not "delete every version
 * constant" — it is "state no policy twice", and a format fact is not a policy.
 */

import {
  DiagnosticCode,
  DiagnosticSeverity,
} from "../../core/application/diagnostics.js";
import type { FrameworkDeclaration } from "../../core/domain/index.js";

/**
 * The first Cypress major that can read a `cypress.config.*` file.
 *
 * A fact about the configuration format rather than a support policy. Cypress 10 replaced `cypress.json` with a module, so
 * an installation older than that cannot read the file whose presence caused this project to be identified at all.
 *
 * The number this tool will *drive* is a separate decision and lives in the validation layer's version policy. The two
 * coincide today and are deliberately not the same constant: one is a fact about a file, the other a choice about support,
 * and a single value serving both would make the next change to either look like a change to the other.
 *
 * This is also why it survived the removal of the Node floor that used to sit in the checks layer. That number was a support
 * policy restated from `engines.node`; this one is not restated from anything, because nothing declares it.
 */
export const MINIMUM_CYPRESS_MAJOR = 10;

/**
 * Everything a catalogue entry may need in order to describe itself.
 *
 * Deliberately holds nothing about package managers, package-manager versions or installed tooling. Those entries do not
 * exist in this catalogue (see the note above), and adding a field for them would be the first step towards creating them —
 * a field nothing here reads is an invitation for the next person to use it.
 */
export interface DiagnosticFacts {
  readonly root: string;
  /** Declared workspace patterns. Used only to improve one remedy, never to find anything. */
  readonly workspaces: readonly string[];
  readonly declaration?: FrameworkDeclaration;
  readonly installationVersion?: string;
  readonly configurations: readonly string[];
  readonly unsupportedConfigurations: readonly string[];
  /**
   * Configuration files that exist where Cypress never reads one — inside `cypress/`.
   *
   * An empty array is a real answer ("there is none") rather than an omission, which is why this is required: a message
   * that said "create a configuration file" to a reader who already has one, one directory away, is the failure mode this
   * field prevents.
   */
  readonly misplacedConfigurations: readonly string[];
  /**
   * Paths carrying a configuration filename that are directories rather than files.
   *
   * Separate from "missing" because the remedy is the opposite of creating a file: the path is occupied, so a create
   * attempt fails, and a reader told to create one concludes the tool is broken.
   */
  readonly occupiedConfigurationPaths: readonly string[];
  readonly hasCypressDirectory: boolean;
}

/**
 * What an entry produces.
 *
 * `remediation` is required rather than optional: every condition in this table has a next step, and the finding this text
 * becomes requires a string. Making it optional would only create the opportunity to publish a finding with nothing to do
 * about it.
 *
 * `path` stays optional because it is genuinely not always known — several entries are about the directory as a whole
 * rather than one file.
 */
export interface DiagnosticText {
  readonly explanation: string;
  readonly remediation: string;
  readonly path?: string;
}

interface Guidance {
  readonly severity: DiagnosticSeverity;
  readonly describe: (facts: DiagnosticFacts) => DiagnosticText;
}

/**
 * A bounded, readable list.
 *
 * A manifest can declare forty workspace patterns, and a sentence that quotes all of them is a sentence nobody finishes. The
 * first few are enough to recognise the situation; the ellipsis says there is more.
 */
function listOf(values: readonly string[]): string {
  const shown = values.slice(0, 4);
  return shown.join(", ") + (values.length > shown.length ? ", …" : "");
}

/**
 * What to suggest when there is no *usable* configuration.
 *
 * Ordered by specificity, because the general advice is wrong more often than it is right:
 *
 * 1. A directory on the path — creating a file cannot succeed, so say what is actually in the way.
 * 2. A configuration one directory away — the file exists, so sending the reader to write another one creates a second
 *    project instead of finding the first.
 * 3. A declared workspace — the reader is almost certainly one level too high, which is why the patterns are named rather
 *    than expanded.
 * 4. Nothing known — the honest general instruction, with both common extensions, because naming only `.ts` sends a
 *    JavaScript project looking for a toolchain it does not need.
 *
 * The file is named in every branch because the alternative reading is now live: "create a configuration file" in a
 * project that already has `qat.config.json` sounds like advice to create a second one of those, which would satisfy the
 * instruction and change nothing about the condition being reported.
 */
function configurationRemedy(facts: DiagnosticFacts): string {
  if (facts.occupiedConfigurationPaths.length > 0) {
    return `Rename or remove the directory at ${listOf(facts.occupiedConfigurationPaths)}, then create cypress.config.ts (or cypress.config.js).`;
  }

  if (facts.misplacedConfigurations.length > 0) {
    return `Move ${listOf(facts.misplacedConfigurations)} to the project root and rename it to cypress.config.ts.`;
  }

  if (facts.workspaces.length === 0) {
    return "Create cypress.config.ts (or cypress.config.js) for Cypress, or run this in the right directory.";
  }

  return `This looks like a workspace root (${listOf(facts.workspaces)}). Run the command from the package directory.`;
}

export const GUIDANCE: Readonly<Record<DiagnosticCode, Guidance>> = {
  [DiagnosticCode.FrameworkNotDetected]: {
    severity: DiagnosticSeverity.Error,
    describe: (facts) => ({
      explanation: `No Cypress configuration was found in ${facts.root}.`,
      remediation: configurationRemedy(facts),
    }),
  },

  [DiagnosticCode.ConfigurationMissing]: {
    severity: DiagnosticSeverity.Error,

    describe: (facts) => {
      // Most specific first. The two placement branches exist because a file probe answers "is there a regular file with
      // this name", so a directory on the path and a configuration inside `cypress/` both arrive here as "missing" — and
      // both make the generic remedy actively wrong.
      if (facts.occupiedConfigurationPaths.length > 0) {
        return {
          explanation: `A directory occupies ${listOf(facts.occupiedConfigurationPaths)} in ${facts.root}, so no Cypress configuration file can be found there.`,
          remediation: configurationRemedy(facts),
        };
      }

      if (facts.misplacedConfigurations.length > 0) {
        return {
          explanation: `A Cypress configuration exists in ${facts.root}, but not where Cypress looks: ${listOf(facts.misplacedConfigurations)}.`,
          remediation: configurationRemedy(facts),
        };
      }

      // Then the four causes that have four different next steps: one file to create, the same file plus an install, a
      // configuration that was deleted, or a directory that never had one. The last branch exists so the message never
      // claims a `cypress` directory was found when the facts do not say so.
      if (facts.installationVersion !== undefined) {
        return {
          explanation: `Cypress ${facts.installationVersion} is installed in ${facts.root}, but no Cypress configuration file was found.`,
          remediation: configurationRemedy(facts),
        };
      }

      if (facts.declaration !== undefined) {
        return {
          explanation: `Cypress is declared in ${facts.declaration.section}, but there is no Cypress configuration file in ${facts.root}.`,
          remediation: configurationRemedy(facts),
        };
      }

      if (facts.hasCypressDirectory) {
        return {
          explanation: `A cypress directory was found in ${facts.root}, but no Cypress configuration file.`,
          remediation: configurationRemedy(facts),
        };
      }

      return {
        explanation: `No Cypress configuration file was found in ${facts.root}.`,
        remediation: configurationRemedy(facts),
      };
    },
  },

  [DiagnosticCode.ConfigurationAmbiguous]: {
    severity: DiagnosticSeverity.Error,
    describe: (facts) => ({
      explanation: `More than one Cypress configuration was found in ${facts.root}.`,
      remediation:
        "Keep one Cypress configuration file and delete the others; qat.config.json is a separate file and is not the ambiguity.",
    }),
  },

  [DiagnosticCode.ConfigurationUnsupported]: {
    severity: DiagnosticSeverity.Error,

    describe: (facts) => {
      // A list that is empty cannot be joined into a sentence. The condition implies a non-empty list, but a message
      // reading "uses , which this build cannot use" is worse than a general one, and the general one is still true.
      //
      // "Use", not "read": a legacy `cypress.json` is perfectly readable JSON. What it cannot be is *used* as a
      // configuration by this build, and saying "read" sends a reader to check file permissions on a file that is fine.
      const explanation =
        facts.unsupportedConfigurations.length === 0
          ? `${facts.root} uses a Cypress configuration format this build cannot use.`
          : `${facts.root} uses ${listOf(facts.unsupportedConfigurations)}, which this build cannot use as a Cypress configuration.`;

      return {
        explanation,
        remediation:
          "Upgrade to cypress.config.ts, which Cypress 10 and later use.",
        // The first one, because a project with two unusable configurations has bigger problems than this message.
        ...(facts.unsupportedConfigurations[0] === undefined
          ? {}
          : { path: facts.unsupportedConfigurations[0] }),
      };
    },
  },

  /**
   * Declared, configured, and not installed.
   *
   * The remedy says *what* to do and deliberately not *how*, because "how" depends on which tool installs in this project
   * and this catalogue has just argued that it cannot know that. The command that respects the committed lockfile is
   * produced by the package-manager check's own guidance, keyed on the manager it identified — one owner per question: this
   * file says "install the dependency", that one says "with this command".
   *
   * Naming a command here would be the duplicate: two files, two invocations, and the day one of them learned about frozen
   * lockfiles the other would still be advising the rewrite this tool exists to detect.
   */
  [DiagnosticCode.DependencyNotInstalled]: {
    severity: DiagnosticSeverity.Error,
    describe: (facts) => ({
      explanation:
        facts.declaration === undefined
          ? `No Cypress dependency is declared in ${facts.root}, and Cypress is not installed.`
          : `Cypress is declared in ${facts.declaration.section} but is not installed.`,
      remediation: "Install it with the package manager this project uses.",
      path: "node_modules/cypress",
    }),
  },

  [DiagnosticCode.VersionIncompatible]: {
    severity: DiagnosticSeverity.Error,
    describe: (facts) => ({
      explanation: `Cypress ${facts.installationVersion ?? "unknown"} is installed, but ${facts.configurations[0] ?? "the configuration"} uses the format introduced in Cypress ${String(MINIMUM_CYPRESS_MAJOR)}.`,
      remediation: `Upgrade Cypress to ${String(MINIMUM_CYPRESS_MAJOR)} or later, or restore a cypress.json configuration.`,
      ...(facts.configurations[0] === undefined
        ? {}
        : { path: facts.configurations[0] }),
    }),
  },

  [DiagnosticCode.ManifestUnreadable]: {
    severity: DiagnosticSeverity.Error,
    describe: () => ({
      explanation: "A package manifest could not be read as JSON.",
      remediation:
        "Correct the syntax of the file, or restore it from version control.",
      path: "package.json",
    }),
  },

  [DiagnosticCode.ManifestMissing]: {
    severity: DiagnosticSeverity.Warning,
    describe: (facts) => ({
      explanation: `No package.json was found in ${facts.root}; the directory name is used as the project name.`,
      remediation:
        "Add one if this project should be installable or shareable.",
    }),
  },

  [DiagnosticCode.ManifestIncomplete]: {
    severity: DiagnosticSeverity.Warning,
    describe: () => ({
      explanation: "package.json declares no name, no version, or neither.",
      remediation:
        "Declare both, so the project can be identified and published.",
      path: "package.json",
    }),
  },

  [DiagnosticCode.DependencyUndeclared]: {
    severity: DiagnosticSeverity.Warning,
    describe: (facts) => ({
      explanation: `Cypress ${facts.installationVersion ?? "unknown"} is installed in this project, but package.json does not declare it.`,
      remediation:
        "Declare it in devDependencies, or confirm it is installed deliberately.",
      path: "package.json",
    }),
  },
};
