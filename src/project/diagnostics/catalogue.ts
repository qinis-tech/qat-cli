/**
 * The remediation catalogue.
 *
 * One entry per diagnostic code, and the entry is where the prose lives. A condition's explanation, its remedy and
 * its severity are written once, next to the code that identifies it, rather than at each of the places that might
 * report it.
 *
 * The table is a `Record` over the code union, so a code without an entry does not compile. That is the guarantee
 * behind "every diagnostic code has an understandable explanation" — it is not a promise anybody has to remember.
 *
 * ## Severity here answers for the project, not for an operation
 *
 * An entry's severity says how serious the condition is, not whether it stops anything. Whether it stops something
 * depends on what the caller was about to do: a project with no configuration is blocked for a run and perfectly
 * reportable by an inspection, and one severity field cannot say both. The per-operation verdict belongs to the
 * validation layer's gate, which reads these severities rather than re-deciding them.
 */
import {
  DiagnosticCode,
  DiagnosticSeverity,
} from "../../core/application/diagnostics.js";
import type { FrameworkDeclaration } from "../../core/domain/index.js";

/**
 * The first Cypress major that can read a `cypress.config.*` file.
 *
 * A fact about the configuration format rather than a support policy. Cypress 10 replaced `cypress.json` with a
 * module, so an installation older than that cannot read the file whose presence caused this project to be
 * identified at all.
 *
 * The number this tool will *drive* is a separate decision and lives in the validation layer's version policy. The
 * two coincide today and are deliberately not the same constant: one is a fact about a file, the other a choice
 * about support, and a single value serving both would make the next change to either look like a change to the
 * other.
 */
export const MINIMUM_CYPRESS_MAJOR = 10;

/** Everything a catalogue entry may need in order to describe itself. */
export interface DiagnosticFacts {
  readonly root: string;
  /** Declared workspace patterns. Used only to improve one remedy, never to find anything. */
  readonly workspaces: readonly string[];
  readonly declaration?: FrameworkDeclaration;
  readonly installationVersion?: string;
  readonly configurations: readonly string[];
  readonly unsupportedConfigurations: readonly string[];
  readonly hasCypressDirectory: boolean;
}

/** What an entry produces. */
export interface DiagnosticText {
  readonly explanation: string;
  readonly remediation?: string;
  readonly path?: string;
}

interface Guidance {
  readonly severity: DiagnosticSeverity;
  readonly describe: (facts: DiagnosticFacts) => DiagnosticText;
}

/**
 * What to suggest when there is no usable configuration.
 *
 * A declared workspace changes the advice entirely: the reader is almost certainly one directory too high, and
 * telling them to create a configuration file would create a second project instead of finding the first. The
 * patterns are named and never expanded.
 */
function configurationRemedy(facts: DiagnosticFacts): string {
  if (facts.workspaces.length === 0) {
    return "Create cypress.config.ts, or run this in the right directory.";
  }

  return `This looks like a workspace root (${facts.workspaces.join(", ")}). Run the command from the package directory.`;
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
      // Three causes, three explanations, because they have three different next steps: one file to create, the
      // same file plus an install, or a configuration that was deleted.
      if (facts.installationVersion !== undefined) {
        return {
          explanation: `Cypress ${facts.installationVersion} is installed in ${facts.root}, but no configuration file was found.`,
          remediation: configurationRemedy(facts),
        };
      }

      if (facts.declaration !== undefined) {
        return {
          explanation: `Cypress is declared in ${facts.declaration.section}, but no configuration file was found in ${facts.root}.`,
          remediation: configurationRemedy(facts),
        };
      }

      return {
        explanation: `A cypress directory was found in ${facts.root}, but no configuration file.`,
        remediation: configurationRemedy(facts),
      };
    },
  },

  [DiagnosticCode.ConfigurationAmbiguous]: {
    severity: DiagnosticSeverity.Error,
    describe: (facts) => ({
      explanation: `More than one Cypress configuration was found in ${facts.root}.`,
      remediation: "Keep one configuration file and delete the others.",
    }),
  },

  [DiagnosticCode.ConfigurationUnsupported]: {
    severity: DiagnosticSeverity.Error,
    describe: (facts) => ({
      explanation: `${facts.root} uses ${facts.unsupportedConfigurations.join(", ")}, which QAT cannot read.`,
      remediation:
        "Upgrade to cypress.config.ts, which Cypress 10 and later use.",
      // The first one, because a project with two unusable configurations has bigger problems than this message.
      ...(facts.unsupportedConfigurations[0] === undefined
        ? {}
        : { path: facts.unsupportedConfigurations[0] }),
    }),
  },

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
