/**
 * Guidance for the validation codes.
 *
 * The same arrangement as the detection catalogue, for the same reason: one entry per code, the table is a
 * `Record` over the code union, and a code without an entry does not compile. Severity, explanation and remedy
 * are written once, beside the code that identifies the condition.
 *
 * This table's severity column **is** the blocking-and-non-blocking classification the tool promises. There is
 * no second list of fatal codes, because a second list is the one that goes out of step.
 */
import { DiagnosticSeverity } from "../../core/application/diagnostics.js";
import { ValidationCode } from "../../core/application/validation.js";

import { CYPRESS_VERSION_POLICY } from "./policy.js";

/** Everything a validation entry may need in order to describe itself. */
export interface ValidationFacts {
  readonly root: string;
  readonly declaredWorkspaces: readonly string[];
  readonly installedVersion?: string;
  readonly configuration?: string;
  readonly misplacedConfigurations: readonly string[];
  readonly occupiedConfigurationPaths: readonly string[];
  readonly specDirectories: readonly string[];
  readonly componentDirectory?: string;
  readonly unsupportedConfigurations: readonly string[];
}

/**
 * What an entry produces.
 *
 * Every field but `explanation` is optional, and **optional means absent** rather than present-and-undefined: the
 * finding built from this carries the same shape, and a `null` in a serialised document cannot be told apart from
 * a fact nobody established. Producers therefore spread conditionally rather than assigning `undefined`, which is
 * also what a `noUncheckedIndexedAccess` read forces — the first element of a non-empty array is typed
 * `string | undefined`, and only the condition proves otherwise.
 */
interface ValidationText {
  readonly explanation: string;
  readonly remediation?: string;
  readonly path?: string;
}

interface Guidance {
  readonly severity: DiagnosticSeverity;
  readonly describe: (facts: ValidationFacts) => ValidationText;
}

/** Comma-separated, so three paths read as one sentence rather than as three fragments. */
function listOf(values: readonly string[]): string {
  return values.join(", ");
}

export const VALIDATION_GUIDANCE: Readonly<Record<ValidationCode, Guidance>> = {
  [ValidationCode.ConfigurationMisplaced]: {
    severity: DiagnosticSeverity.Error,
    describe: (facts) => {
      // Two shapes behind one code, described separately because the fixes differ: move a file, or remove a
      // directory occupying a filename Cypress expects to be a file.
      if (facts.misplacedConfigurations.length > 0) {
        const [first] = facts.misplacedConfigurations;

        return {
          explanation: `A Cypress configuration was found at ${listOf(facts.misplacedConfigurations)}, where Cypress does not load it.`,
          remediation: `Move it to the project root as ${facts.misplacedConfigurations
            .map((file) => file.replace(/^cypress\//, ""))
            .join(" or ")}.`,
          // Spread rather than assigned. The length check above proves an element exists; the type system cannot
          // see that, and under `exactOptionalPropertyTypes` an explicit `undefined` is not the same as absence.
          ...(first === undefined ? {} : { path: first }),
        };
      }

      const [occupied] = facts.occupiedConfigurationPaths;

      return {
        explanation: `A directory occupies ${listOf(facts.occupiedConfigurationPaths)}, so no configuration file can exist under that name.`,
        remediation:
          "Remove or rename the directory, then create the configuration file it is hiding.",
        ...(occupied === undefined ? {} : { path: occupied }),
      };
    },
  },

  [ValidationCode.LayoutUnsupported]: {
    severity: DiagnosticSeverity.Error,
    describe: (facts) => {
      if (facts.componentDirectory !== undefined) {
        return {
          explanation: `The only recognised test location is ${facts.componentDirectory}, and QAT has no component-testing execution path.`,
          remediation:
            "Add end-to-end specs under cypress/e2e, or run component tests with Cypress directly.",
          path: facts.componentDirectory,
        };
      }

      return {
        explanation: `No spec location is recognisable in ${facts.root}. A custom specPattern would have to be evaluated to find one, which QAT does not do.`,
        remediation:
          "Move the specs under cypress/e2e, or record the pattern in the repository documentation.",
      };
    },
  },

  [ValidationCode.RootAmbiguous]: {
    severity: DiagnosticSeverity.Warning,
    describe: (facts) => ({
      explanation: `${facts.root} declares workspaces (${listOf(facts.declaredWorkspaces)}) and has its own Cypress configuration, so it is both a package and a workspace container.`,
      remediation:
        "Confirm the root is the intended target, or run the command from the package directory.",
    }),
  },

  [ValidationCode.BinaryUnavailable]: {
    severity: DiagnosticSeverity.Error,
    describe: (facts) => ({
      explanation:
        facts.installedVersion === undefined
          ? `The Cypress executable could not be invoked in ${facts.root}.`
          : `Cypress ${facts.installedVersion} is installed in ${facts.root}, but its executable could not be invoked.`,
      remediation:
        "Reinstall Cypress so its binary is downloaded again, then retry.",
    }),
  },

  [ValidationCode.VersionBelowSupported]: {
    severity: DiagnosticSeverity.Error,
    describe: (facts) => ({
      explanation: `Cypress ${facts.installedVersion ?? "unknown"} is installed, and QAT supports ${String(CYPRESS_VERSION_POLICY.minimumSupportedMajor)} and later.`,
      remediation: `Upgrade Cypress to ${String(CYPRESS_VERSION_POLICY.minimumSupportedMajor)} or later.`,
    }),
  },

  [ValidationCode.VersionAboveKnownGood]: {
    severity: DiagnosticSeverity.Warning,
    describe: (facts) => ({
      explanation: `Cypress ${facts.installedVersion ?? "unknown"} is newer than ${String(CYPRESS_VERSION_POLICY.knownGoodMaximumMajor)}, the newest major QAT has been written against.`,
      remediation:
        "Proceed, and report anything that behaves unexpectedly against this version.",
    }),
  },
};
