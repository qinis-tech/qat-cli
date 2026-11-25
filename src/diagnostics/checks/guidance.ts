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
 *
 * ## Why this file no longer states a Node.js version
 *
 * It used to hold the supported floor as a constant, restated from `engines.node` because a module of pure functions
 * cannot open a manifest. The restatement was defended by a test asserting the number matched the manifest — which is a
 * good guard, and the wrong shape: it made every release that changed the supported runtime a two-place edit, and the
 * failure mode when someone forgot the second place was a message confidently quoting a requirement QAT no longer had.
 *
 * The range now arrives as evidence. `RuntimeFacts.required` carries the declared range and its provenance, the check
 * compares against exactly that value, and these entries quote it back verbatim. There is nothing left to keep in
 * step, so there is nothing left to drift — and a test that used to compare two copies now asserts that the sentence
 * quotes the range it was given.
 *
 * ## Guarding evidence: extract the value, then test the parent
 *
 * Every runtime entry below starts by lifting the value it needs through an optional chain and then testing both the
 * value and the object it came from. That looks like one test too many, and it is not: `facts.runtime?.nodeVersion
 * === undefined` cannot tell the compiler *why* the value was missing, so the parent stays unnarrowed and the good
 * branch cannot read `facts.runtime.required`. Two separate facts, two separate tests, each of which also reads as a
 * single question.
 */
import {
  HealthCode,
  type CheckFinding,
} from "../../core/application/checks.js";
import { DiagnosticSeverity } from "../../core/application/diagnostics.js";

import type { CheckFacts, OutputTarget } from "./contracts.js";

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
  /**
   * The runtime is readable and outside the declared range.
   *
   * Both numbers are printed — what is running and what is required — because a reader can act on a pair and cannot
   * act on "unsupported". The provenance is printed too: it turns a disagreement with QAT into a file the reader can
   * open, and it is the honest answer to "says who?" when the range has changed under them.
   *
   * The detected version is shown as the process reports it — `v18.19.0`, leading `v` and all — because that is the
   * string the reader will compare against `node --version`, and trimming it here would make the message and their
   * terminal disagree about the same runtime.
   */
  [HealthCode.RuntimeUnsupported]: {
    severity: DiagnosticSeverity.Error,
    describe: (facts) => {
      const runtime = facts.runtime;
      // Lifted through the optional chain, then tested on its own line. `runtime === undefined ||
      // runtime.nodeVersion === undefined` says the same thing, but the second half is unreachable once the first
      // fires — a reader has to work that out, and the lint rules refuse the shape outright.
      const version = runtime?.nodeVersion;

      // Reachable only when a caller renders this code without the evidence it needs — a mistake in a check rather
      // than a condition of the project. Say the honest minimum instead of composing a sentence around a value that
      // is not there, and never print an empty range as though it were a requirement.
      if (runtime === undefined || version === undefined) {
        return {
          explanation:
            "The running Node version does not satisfy QAT's declared requirement.",
          remediation:
            "Run the command again on a supported Node release; if this repeats, report it.",
        };
      }

      return {
        explanation: `Node ${version} is running, and QAT supports ${runtime.required.range} (declared in ${runtime.required.origin}).`,
        remediation: `Install a Node release inside ${runtime.required.range}, confirm it with \`node --version\`, then run the command again. A newer major is not automatically compatible: support is only claimed for versions that have been tested.`,
      };
    },
  },

  /**
   * The condition could not be established.
   *
   * Warning, not Error, and not silence. A question we failed to answer must not block work we can still perform, and
   * it must not be counted as clean either — which is exactly what a warning is for.
   *
   * The three cases share an entry because they share a remedy: get a readable interpreter and a readable requirement,
   * then ask again. They are not distinguished by a code of their own because the distinction lives on the verdict the
   * check already produced; if a future report needs to render it, it arrives as its own code rather than being
   * re-derived here by re-inspecting strings.
   *
   * The two guards are separate statements rather than one chain, because they lead to different sentences. Merging
   * them would force one message to cover an assembly defect and a runtime defect at once, which is how a diagnostic
   * ends up saying nothing specific about either.
   */
  [HealthCode.RuntimeUnknown]: {
    severity: DiagnosticSeverity.Warning,
    describe: (facts) => {
      const runtime = facts.runtime;
      const version = runtime?.nodeVersion;

      if (runtime === undefined) {
        return {
          explanation:
            "The running Node version was not available, so it could not be checked against QAT's requirement.",
          remediation: "Run the command again; if this repeats, reinstall QAT.",
        };
      }

      if (version === undefined) {
        return {
          explanation:
            "QAT could not read the running Node version, so compatibility with its requirement could not be confirmed.",
          remediation:
            "Run the command on a released Node interpreter — `node --version` should print a plain major.minor.patch value — and report the result if this repeats.",
        };
      }

      return {
        explanation: `QAT could not confirm that Node ${version} satisfies ${runtime.required.range} (declared in ${runtime.required.origin}).`,
        remediation:
          "Check that `node --version` prints a released major.minor.patch value, then reinstall QAT if the declared requirement cannot be read.",
      };
    },
  },

  /**
   * The project's framework release needs a runtime QAT's own requirement does not describe.
   *
   * Its own code, on purpose. The two requirements have different owners — one is fixed by moving QAT, the other by
   * moving the project — and a finding that merged them would name a problem without naming whose it is. QAT's own
   * range is repeated here so the reader can see whether the two overlap before deciding anything.
   */
  [HealthCode.FrameworkRuntimeUnsupported]: {
    severity: DiagnosticSeverity.Warning,
    describe: (facts) => {
      const runtime = facts.runtime;
      const version = runtime?.nodeVersion;
      const framework = runtime?.frameworkRequired;

      // Three facts, one guard, no member access inside the condition — so each operand is a name whose meaning is
      // visible on the line above, and the compiler narrows all three for the branch below.
      if (
        runtime === undefined ||
        version === undefined ||
        framework === undefined
      ) {
        return {
          explanation:
            "The project's framework release declares a Node.js requirement that could not be checked.",
          remediation: "Run the command again once the project is resolvable.",
        };
      }

      return {
        explanation: `Node ${version} is running. This project's framework release requires ${framework.range} (declared in ${framework.origin}), while QAT itself supports ${runtime.required.range}.`,
        remediation:
          "Install a Node release that satisfies both requirements, or move the project's framework to a release that supports the runtime you are on.",
      };
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
            : PROFILE_NAME.test(selected)
              ? `The environment "${selected}" is not declared in the configuration.`
              : "The environment selected on the command line is not declared in the configuration.",
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
 * fact set the other entries read. It exists so the path is exact rather than guessed: the check knows which
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
