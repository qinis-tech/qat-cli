/**
 * The prose behind the codes this layer owns.
 *
 * One entry per `QAT-H` code, and the table is a `Record` over the union — a code without an entry does not compile.
 * That is the same guarantee the diagnostic and configuration catalogues make, applied to the fourth vocabulary.
 *
 * ## Only `QAT-H` codes are here
 *
 * A check that forwards another layer's finding carries that layer's rendered text. Re-wording it here would put one
 * condition's prose in two catalogues, and the two would drift the first time either was edited.
 *
 * ## Every sentence is authored from the rule, never from the file
 *
 * The rule the configuration layer states — a diagnostic names a path and a rule and never quotes a configured value —
 * applies here with one consequence worth spelling out: a line of a configuration file is *file content*, so a
 * malformed file is described by line and column rather than by an excerpt. The excerpt is available on the loader's
 * outcome and it stays there, for a human reading a terminal; it does not travel into a finding that may be logged,
 * pasted into an issue, or rendered by something that has not read the disclosure rule.
 */
import {
  HealthCode,
  type CheckFinding,
} from "../../core/application/checks.js";
import { DiagnosticSeverity } from "../../core/application/diagnostics.js";

import type { CheckFacts, OutputTarget } from "./contracts.js";

/**
 * The lowest Node major QAT supports.
 *
 * The `engines.node` floor, restated rather than read: a module of pure functions cannot open `package.json`, and a
 * check that did would no longer be testable from a value. A test asserts this number equals the manifest's, so the
 * restatement cannot drift from the declaration it restates.
 */
export const MINIMUM_NODE_MAJOR = 24;

interface HealthText {
  readonly explanation: string;
  readonly remediation?: string;
  readonly path?: string;
}

interface Guidance {
  readonly severity: DiagnosticSeverity;
  readonly describe: (facts: CheckFacts) => HealthText;
}

/** The file an entry is about, or a phrase standing in for it when the facts carried no name. */
function fileOf(facts: CheckFacts): string {
  return facts.configuration?.path ?? "The configuration file";
}

/** A profile name, as the configuration schema defines one. Used only to decide whether a name is safe to quote. */
const PROFILE_NAME = /^[a-z][a-z0-9-]*$/;

export const HEALTH_GUIDANCE: Readonly<Record<HealthCode, Guidance>> = {
  [HealthCode.RuntimeUnsupported]: {
    severity: DiagnosticSeverity.Error,
    describe: (facts) =>
      facts.runtime === undefined
        ? {
            explanation:
              "The running Node version was not available, so it could not be checked.",
            remediation: `Run the command on Node ${String(MINIMUM_NODE_MAJOR)} or later.`,
          }
        : {
            // The version is printed as the process reports it — `v20.20.2`, leading `v` and all — because that is the
            // string the reader will compare against `node --version`, and trimming it here would make the message and
            // their terminal disagree about the same runtime.
            explanation: `Node ${facts.runtime.nodeVersion} is running, and QAT requires Node ${String(MINIMUM_NODE_MAJOR)} or later.`,
            remediation: `Install Node ${String(MINIMUM_NODE_MAJOR)} or later, then run the command again.`,
          },
  },

  [HealthCode.PackageManagerUnknown]: {
    severity: DiagnosticSeverity.Warning,
    describe: () => ({
      explanation:
        "No package manager could be identified: neither package.json nor a lockfile names one.",
      remediation:
        "Declare one in the packageManager field, or commit the lockfile your project installs with.",
    }),
  },

  [HealthCode.OutputUnwritable]: {
    severity: DiagnosticSeverity.Error,
    describe: () => ({
      // Deliberately does not name a directory. One code covers both output paths, and the check that raised it knows
      // which one it was about — so the path is supplied by the caller rather than guessed here from a facts object
      // that holds both. A message that said "the reports directory" while the evidence directory was the problem
      // would be worse than saying nothing.
      explanation: "The configured output directory cannot be written to.",
      remediation:
        "Choose a writable output directory, or correct the permissions on it.",
    }),
  },

  [HealthCode.ConfigurationEmpty]: {
    severity: DiagnosticSeverity.Error,
    describe: (facts) => ({
      explanation: `${fileOf(facts)} is empty.`,
      remediation:
        "Write a configuration, or delete the file to run with the defaults.",
      ...(facts.configuration === undefined
        ? {}
        : { path: facts.configuration.path }),
    }),
  },

  [HealthCode.ConfigurationNotJson]: {
    severity: DiagnosticSeverity.Error,
    describe: (facts) => {
      // Line and column only. The excerpt would be a line of the file, and a line of a configuration file can hold an
      // environment value — which is exactly what a diagnostic must not carry.
      const location =
        facts.configuration?.kind === "malformed"
          ? facts.configuration.location
          : undefined;

      if (location === undefined) {
        return {
          explanation: `${fileOf(facts)} is not valid JSON.`,
          remediation:
            "Correct the syntax of the file, or restore it from version control.",
          ...(facts.configuration === undefined
            ? {}
            : { path: facts.configuration.path }),
        };
      }

      return {
        explanation: `${fileOf(facts)} is not valid JSON at line ${String(location.line)}, column ${String(location.column)}.`,
        remediation: `Correct the syntax at line ${String(location.line)}, column ${String(location.column)}.`,
        ...(facts.configuration === undefined
          ? {}
          : { path: facts.configuration.path }),
      };
    },
  },

  [HealthCode.ConfigurationTooLarge]: {
    severity: DiagnosticSeverity.Error,
    describe: (facts) => {
      const result = facts.configuration;

      // The size and the bound are both printed, because "too large" without a number sends the reader to check a
      // five-kilobyte file. `too-large` is the only outcome that carries them.
      return result?.kind === "too-large"
        ? {
            explanation: `${result.path} is ${String(result.sizeBytes)} bytes, and QAT reads at most ${String(result.limitBytes)}.`,
            remediation:
              "Check that the path points at your configuration file, then reduce it to the settings you need.",
            path: result.path,
          }
        : {
            explanation: `${fileOf(facts)} is larger than QAT will read.`,
            remediation:
              "Check that the path points at your configuration file.",
            ...(facts.configuration === undefined
              ? {}
              : { path: facts.configuration.path }),
          };
    },
  },

  [HealthCode.EnvironmentUndeclared]: {
    severity: DiagnosticSeverity.Error,
    describe: (facts) => {
      const selected = facts.environment?.selected;
      const declared = facts.environment?.declared ?? [];

      return {
        // A name typed on a command line is quoted only when it is a name the schema would accept. Anything else could
        // be a token pasted into the wrong field, and a diagnostic is the one thing guaranteed to be printed. The rule
        // is restated rather than imported — the schema exposes a validator, not a pattern — and a test feeds a value
        // the schema accepts and asserts it is quoted.
        explanation:
          selected === undefined
            ? "A command selected an environment, and the configuration declares none."
            : `The environment ${PROFILE_NAME.test(selected) ? `"${selected}"` : "selected on the command line"} is not declared in the configuration.`,
        remediation:
          declared.length === 0
            ? "Declare the environment in the configuration, or remove the selection."
            : `Declare it, or choose one of: ${declared.join(", ")}.`,
      };
    },
  },
};

/**
 * Renders one health code into a finding.
 *
 * Severity comes from the guidance entry rather than from the caller, so a check cannot report the same condition with
 * two different weights — and the text is rendered once, here, rather than assembled at the point of failure.
 *
 * @param code Which condition was found.
 * @param facts What the check knew, which the entry uses to name the file, the version or the declared environments.
 * @param path Overrides the path the entry would set. Used by the two output checks alone: they share one code, the
 *   entry cannot know which directory failed, and the check that raised it does.
 */
export function healthFinding(
  code: HealthCode,
  facts: CheckFacts,
  path?: string,
): CheckFinding {
  const guidance = HEALTH_GUIDANCE[code];
  const text = guidance.describe(facts);
  const resolved = path ?? text.path;

  return {
    code,
    severity: guidance.severity,
    explanation: text.explanation,
    ...(text.remediation === undefined
      ? {}
      : { remediation: text.remediation }),
    ...(resolved === undefined ? {} : { path: resolved }),
  };
}

/**
 * The finding for an output directory that cannot be written.
 *
 * A second renderer for one code, because the shape it needs — the target, and nothing else — is narrower than the
 * fact set the other six entries read. It exists so the path is exact rather than guessed: the check knows which
 * directory it probed, and a message that named the wrong one would send a reader to fix a directory that is fine.
 */
export function unwritableFinding(target: OutputTarget): CheckFinding {
  const guidance = HEALTH_GUIDANCE[HealthCode.OutputUnwritable];
  const text = guidance.describe({});

  return {
    code: HealthCode.OutputUnwritable,
    severity: guidance.severity,
    explanation: text.explanation,
    remediation: text.remediation ?? "Choose a writable output directory.",
    path: target.path,
  };
}
