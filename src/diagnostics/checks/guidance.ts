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
 * cannot open a manifest. The restatement was defended by a test asserting the number matched the manifest — a good
 * guard and the wrong shape: it made every release that changed the supported runtime a two-place edit, and the failure
 * mode when someone forgot the second place was a message confidently quoting a requirement QAT no longer had.
 *
 * The range now arrives as evidence. `RuntimeFacts.required` carries the declared range and its provenance, the check
 * compares against exactly that value, and these entries quote it back verbatim. There is nothing left to keep in step,
 * so there is nothing left to drift — and the test that used to compare two copies now asserts that the sentence quotes
 * the range it was given.
 *
 * ## Why the package-manager codes multiplied
 *
 * One `PackageManagerUnknown` entry used to stand for the whole group, and it could only ever describe one of them. The
 * conditions a reader actually hits — nothing identified the tool, two lockfiles disagree, the field is unusable, the
 * tool is not installed, the tool's version disagrees with the pin, the dependencies were never installed, someone else
 * installed them — have different fixes, and a single message naming one of them sends every other reader to the wrong
 * place.
 *
 * Splitting them is the cheap half of the fix; the expensive half is that the split is enforced. `HealthCode` gained the
 * members, and this `Record` will not compile until each has prose. A new condition cannot be added by quietly reusing a
 * neighbouring message. The order of work is therefore: add the member, then the union complains, then this table
 * complains — never the other way round.
 *
 * ## Guarding evidence: extract the value, then test the parent
 *
 * Several entries below lift a value through an optional chain and then test both the value and the object it came
 * from. That looks like one test too many, and it is not: `facts.runtime?.nodeVersion === undefined` cannot tell the
 * compiler *why* the value was missing, so the parent stays unnarrowed and the good branch cannot read
 * `facts.runtime.required`. Two separate facts, two separate tests, each of which also reads as a single question.
 *
 * ## Why the code-span helper is called `inlineCode`
 *
 * It was called `code`, which shadowed the `code` parameter of `healthFinding` and — more importantly — gave the word a
 * second meaning in a file where it already means a diagnostic code. The parameter kept its name because it mirrors
 * `CheckFinding.code`; the helper was renamed because it produces markup, not identity.
 */

import {
  HealthCode,
  type CheckFinding,
} from "../../core/application/checks.js";
import { DiagnosticSeverity } from "../../core/application/diagnostics.js";
// The install command is *policy*, not prose: which invocation respects a committed lockfile is a fact about a package
// manager, kept in one table and asserted against its own documentation. Quoting it from there is the same rule as
// quoting the supported range from evidence — a second copy is a copy that will drift.
import {
  installCommandFor,
  PACKAGE_MANAGER_POLICY,
  type PackageManagerName,
} from "../../project/package-manager/index.js";

import type { CheckFacts, OutputTarget } from "./contracts.js";

/**
 * One rendered message.
 *
 * `remediation` is required rather than optional: a finding exists only when something needs attention, and every
 * condition in this table has a next step. Making it optional would let an entry ship without one and push an
 * `undefined` into a contract that requires a string — a mistake this type can prevent instead of a reviewer having to.
 *
 * `path` stays optional because it is genuinely not always known: two output checks share a code and only the caller
 * knows which directory failed.
 */
interface HealthText {
  readonly explanation: string;
  readonly remediation: string;
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

/**
 * A token that is safe to echo back: a manager name, a declaration or a tool name.
 *
 * Deliberately conservative. Anything a reader typed could have been pasted from the wrong buffer, and a diagnostic is
 * the one artefact guaranteed to be printed, logged and attached to an issue. A value that does not look like a name is
 * described instead of quoted.
 */
const SAFE_TOKEN = /^[A-Za-z0-9@._+-]{1,64}$/;

function isQuotable(value: string | undefined): value is string {
  return value !== undefined && SAFE_TOKEN.test(value);
}

/**
 * Renders an inline code span.
 *
 * Exists because a backtick inside a template literal must be escaped, and doing that inline several times is how three
 * of the remediations below once ended up with unbalanced quotes — and, in two cases, with a closing brace that ended up
 * *inside* the command. One function, one escape, and every command in this file is built the same way.
 */
function inlineCode(text: string): string {
  return `\`${text}\``;
}

/** A bounded, readable list. Evidence can hold more lockfiles than a sentence can carry. */
function listOf(values: readonly string[]): string {
  const shown = values.slice(0, 4);
  return shown.join(", ") + (values.length > shown.length ? ", …" : "");
}

/**
 * Narrows a name that arrived as a string to one the policy knows.
 *
 * The facts carry manager names as `string`, because the gathering layer should not have to import this module's
 * vocabulary. The policy table is the authority on which names are real, so the guard reads it rather than listing the
 * names again — and a name that is not in the table never reaches `installCommandFor`, which is why the cast below is
 * guarded rather than hopeful.
 */
function asManagerName(
  value: string | undefined,
): PackageManagerName | undefined {
  if (value === undefined) return undefined;
  if (!Object.prototype.hasOwnProperty.call(PACKAGE_MANAGER_POLICY, value))
    return undefined;

  return value as PackageManagerName;
}

/** The install command for a manager, or a neutral phrase when the name is not one the policy knows. */
function installHint(manager: string | undefined): string {
  const known = asManagerName(manager);

  if (known === undefined)
    return "the install command for the package manager this project uses";

  return inlineCode(installCommandFor(known));
}

export const HEALTH_GUIDANCE: Readonly<Record<HealthCode, Guidance>> = {
  /**
   * The runtime is readable and outside the declared range.
   *
   * Both numbers are printed — what is running and what is required — because a reader can act on a pair and cannot act
   * on "unsupported". The provenance is printed too: it turns a disagreement with QAT into a file the reader can open,
   * and it is the honest answer to "says who?" when the range has changed under them.
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

      // Reachable only when a caller renders this code without the evidence it needs — a mistake in a check rather than
      // a condition of the project. Say the honest minimum instead of composing a sentence around a value that is not
      // there, and never print an empty range as though it were a requirement.
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
        remediation: `Install a Node release inside ${runtime.required.range}, confirm it with ${inlineCode("node --version")}, then run the command again. A newer major is not automatically compatible: support is only claimed for versions that have been tested.`,
      };
    },
  },

  /**
   * The condition could not be established.
   *
   * Warning, not Error, and not silence. A question we failed to answer must not block work we can still perform, and it
   * must not be counted as clean either — which is exactly what a warning is for.
   *
   * The three cases share an entry because they share a remedy: get a readable interpreter and a readable requirement,
   * then ask again. They are not distinguished by a code of their own because the distinction lives on the verdict the
   * check already produced; if a future report needs to render it, it arrives as its own code rather than being
   * re-derived here by re-inspecting strings.
   *
   * The two guards are separate statements rather than one chain, because they lead to different sentences. Merging them
   * would force one message to cover an assembly defect and a runtime defect at once, which is how a diagnostic ends up
   * saying nothing specific about either.
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
          remediation: `Run the command on a released Node interpreter — ${inlineCode("node --version")} should print a plain major.minor.patch value — and report the result if this repeats.`,
        };
      }

      return {
        explanation: `QAT could not confirm that Node ${version} satisfies ${runtime.required.range} (declared in ${runtime.required.origin}).`,
        remediation: `Check that ${inlineCode("node --version")} prints a released major.minor.patch value, then reinstall QAT if the declared requirement cannot be read.`,
      };
    },
  },

  /**
   * The project's framework release needs a runtime QAT's own requirement does not describe.
   *
   * Its own code, on purpose. The two requirements have different owners — one is fixed by moving QAT, the other by
   * moving the project — and a finding that merged them would name a problem without naming whose it is. QAT's own range
   * is repeated here so the reader can see whether the two overlap before deciding anything.
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

  // ───────────────────────────────────────────────────────────────────────────
  // Package manager
  //
  // Eight entries for eight fixes. Every one says what was found and what to do about it, in the reader's vocabulary:
  // no sentence says "inconsistent state" when it can say "two lockfiles, delete the one you do not use".
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Nothing identifies the manager: no lockfile, no `packageManager` field.
   *
   * A warning rather than an error. The project may run perfectly; we simply cannot say how it installs, and a question
   * we could not answer must not block work we can still perform.
   */
  [HealthCode.PackageManagerUnknown]: {
    severity: DiagnosticSeverity.Warning,
    describe: () => ({
      explanation:
        "No package manager could be identified: the project has no lockfile and its manifest declares none.",
      remediation:
        "Declare one in the packageManager field, or commit the lockfile your project installs with.",
    }),
  },

  /**
   * Something was declared, but it cannot be used as written.
   *
   * The two problems share this code because they share a fix — read the field, correct it — and because they are the
   * same sentence with a different clause. `missing-version` is by far the common one: the package manager needs an
   * exact version, and `"pnpm"` alone looks like a declaration without being one.
   *
   * The raw value is quoted only when it looks like a name. It is user text from a file that a diagnostic may print
   * anywhere, and a pasted token in the wrong field must not be echoed back as if it were a version.
   */
  [HealthCode.PackageManagerDeclarationInvalid]: {
    severity: DiagnosticSeverity.Warning,

    describe: (facts) => {
      const selection = facts.packageManager?.selection;
      const declaration =
        selection?.status === "undeclared" ? selection.declaration : undefined;
      const quoted =
        declaration !== undefined && isQuotable(declaration.raw)
          ? declaration.raw
          : undefined;

      if (declaration === undefined) {
        return {
          explanation:
            "The packageManager field could not be used to identify the package manager.",
          remediation:
            'Set it to name@version, for example "pnpm@9.1.0", and re-run the command.',
          path: "package.json",
        };
      }

      // Wording follows the cause; one sentence covering both would send half the readers the wrong way.
      const explanation =
        declaration.problem === "missing-version"
          ? quoted === undefined
            ? "The packageManager field names a package manager without a version, which cannot be used as written."
            : `The packageManager field declares "${quoted}" without a version, which cannot be used as written.`
          : quoted === undefined
            ? "The packageManager field is not a value QAT can use."
            : `The packageManager field declares "${quoted}", which is not a value QAT can use.`;

      return {
        explanation,
        remediation:
          declaration.problem === "missing-version"
            ? 'Add the exact version you install with, for example "pnpm@9.1.0".'
            : 'Set the field to name@version, for example "pnpm@9.1.0".',
        path: "package.json",
      };
    },
  },

  /**
   * The project installs with a manager outside the supported policy.
   *
   * Distinct from "unknown" on purpose: the tool was identified, we do not support it. Saying "not identified" to a Bun
   * user sends them looking for a missing file that is not missing.
   */
  [HealthCode.PackageManagerUnsupported]: {
    severity: DiagnosticSeverity.Warning,

    describe: (facts) => {
      const selection = facts.packageManager?.selection;
      const name =
        selection?.status === "unsupported" ? selection.name : undefined;

      return {
        explanation: isQuotable(name)
          ? `This project installs with ${name}, which QAT does not support. QAT supports npm, pnpm and yarn.`
          : "This project installs with a package manager QAT does not support. QAT supports npm, pnpm and yarn.",
        remediation:
          "Install with a supported package manager, or expect reduced support for this project. QAT will not modify your lockfile.",
        path: "package.json",
      };
    },
  },

  /**
   * Two or more managers are implicated.
   *
   * The files are named and the choice is left to the reader. Naming one would be a guess, and a guess here rewrites a
   * lockfile in the next install. "Delete the one you do not use" is the actual instruction, so it is the one printed.
   */
  [HealthCode.PackageManagerConflicting]: {
    severity: DiagnosticSeverity.Warning,

    describe: (facts) => {
      const group = facts.packageManager;
      const selection = group?.selection;
      const lockfiles =
        selection?.status === "conflicting"
          ? selection.lockfiles
          : (group?.lockfiles ?? []);
      const managers =
        selection?.status === "conflicting" ? selection.managers : [];

      if (lockfiles.length === 0) {
        return {
          explanation:
            "The project contains lockfiles for more than one package manager.",
          remediation:
            "Keep the lockfile that matches packageManager, delete the other, then commit. Do not run an install first.",
        };
      }

      // The leading space belongs inside the value: the clause is spliced directly after the filename list, and a
      // missing space there produces "pnpm-lock.yaml, package-lock.json(npm, pnpm)".
      const namedBy = managers.length === 0 ? "" : ` (${listOf(managers)})`;

      return {
        explanation: `The project contains lockfiles for more than one package manager: ${listOf(lockfiles)}${namedBy}. QAT cannot tell which one your CI installs from.`,
        remediation:
          "Keep the lockfile that matches packageManager and delete the others, then commit. Do not run an install first — it may rewrite the file you meant to keep.",
      };
    },
  },

  /**
   * The manager is identified and supported, but its binary is not on PATH.
   *
   * The remediation names the two realistic routes: enable the shim that ships with Node, or install the tool globally.
   * Both are given because the correct one depends on how the reader manages their toolchain, and a single answer would
   * be wrong for half of them.
   */
  [HealthCode.PackageManagerExecutableMissing]: {
    severity: DiagnosticSeverity.Warning,

    describe: (facts) => {
      const selection = facts.packageManager?.selection;
      const name =
        selection?.status === "identified" ? selection.name : undefined;
      const manager = isQuotable(name) ? name : "the manager";

      return {
        explanation: `This project installs with ${isQuotable(name) ? name : "a package manager"}, which is not available on PATH. Installing with a different tool would create a second lockfile alongside the one you have.`,
        remediation: `Install it — for example ${inlineCode("corepack enable")} and ${inlineCode(`corepack prepare ${manager} --activate`)}, or install it globally with npm — then re-run ${inlineCode("qat doctor")}.`,
      };
    },
  },

  /**
   * The binary answered, and its version disagrees with what the project declared.
   *
   * The expectation and its provenance are both printed, because "wrong version" without saying *whose* version sends the
   * reader to the wrong file. The pin and the engines range are different documents, and only the one that decided the
   * outcome is quoted.
   */
  [HealthCode.PackageManagerVersionMismatch]: {
    severity: DiagnosticSeverity.Warning,

    describe: (facts) => {
      const group = facts.packageManager;
      const selection = group?.selection;
      const name =
        selection?.status === "identified" ? selection.name : undefined;
      const installed = group?.executable?.version;
      const required = group?.required;

      if (installed === undefined || required === undefined) {
        return {
          explanation:
            "The installed package manager does not match the version this project declares.",
          remediation: `Install the version the project declares, then re-run ${inlineCode("qat doctor")}.`,
        };
      }

      const managerLabel = isQuotable(name) ? name : "The package manager";
      const useTarget = isQuotable(name)
        ? `${name}@${installed}`
        : "the declared version";

      return {
        explanation: `${managerLabel} ${installed} is installed, and the project declares ${required.range} (${required.origin}).`,
        remediation: `Install a version inside ${required.range} — ${inlineCode(`corepack use ${useTarget}`)} changes only the pin — then re-run ${inlineCode("qat doctor")}.`,
      };
    },
  },

  /**
   * A version was expected and none could be read.
   *
   * Indeterminate, not a failure: the toolchain answered oddly, which is not the project's fault and must not be reported
   * as though it were. The reason is named because "timed out" and "printed nothing usable" are different mornings for
   * whoever has to debug it.
   */
  [HealthCode.PackageManagerVersionUnverified]: {
    severity: DiagnosticSeverity.Warning,

    describe: (facts) => {
      const group = facts.packageManager;
      const selection = group?.selection;
      const name =
        selection?.status === "identified" ? selection.name : undefined;
      const reason = group?.executable?.reason;
      const expected = group?.required?.range ?? "the declared requirement";
      const managerLabel = isQuotable(name) ? name : "The package manager";
      const manager = isQuotable(name) ? name : "the manager";

      // `not-probed` is not a problem: it means no version was declared, or the platform needs a shell we refuse to
      // enable. Reported plainly, and never dressed up as a defect.
      if (reason === "not-probed") {
        return {
          explanation: `${managerLabel} is installed. Its version was not read, so it was not compared with ${expected}.`,
          remediation: `Re-run ${inlineCode("qat doctor")} where the tool can be queried, or declare the version the project expects.`,
        };
      }

      const detail =
        reason === "timeout"
          ? "did not answer in time"
          : reason === "failed"
            ? "could not be run"
            : "printed no usable version";

      return {
        explanation: `${managerLabel} is installed but ${detail}, so its version could not be compared with ${expected}.`,
        remediation: `Confirm ${inlineCode(`${manager} --version`)} prints a version, then re-run ${inlineCode("qat doctor")}.`,
      };
    },
  },

  /**
   * The manager is fine; the installation never happened.
   *
   * The one entry in this group that names the command, because the reader's next action is exactly one command and
   * guessing it is where people install with the wrong tool. The command comes from policy, so it is the invocation that
   * respects the committed lockfile rather than one that rewrites it.
   */
  [HealthCode.PackageManagerNotInstalled]: {
    severity: DiagnosticSeverity.Warning,

    describe: (facts) => {
      const selection = facts.packageManager?.selection;
      const name =
        selection?.status === "identified" ? selection.name : undefined;

      return {
        explanation: `${isQuotable(name) ? name : "The package manager"} identifies this project, and its dependencies are not installed.`,
        remediation: `Install them with ${installHint(name)}, then re-run ${inlineCode("qat doctor")}.`,
      };
    },
  },

  /**
   * Dependencies exist, and a different tool created them.
   *
   * Worth its own code and a warning: everything looks installed, so the failure surfaces later as a resolution error that
   * names a package nobody edited. Naming both managers is the whole value of the message.
   */
  [HealthCode.PackageManagerForeignInstall]: {
    severity: DiagnosticSeverity.Warning,

    describe: (facts) => {
      const group = facts.packageManager;
      const selection = group?.selection;
      const name =
        selection?.status === "identified" ? selection.name : undefined;
      const foreign = group?.foreignMarker;

      if (foreign === undefined) {
        return {
          explanation:
            "Dependencies were installed by a different package manager than the one this project declares.",
          remediation: `Remove node_modules and reinstall with ${installHint(name)} so the tree matches the lockfile.`,
        };
      }

      return {
        explanation: `Dependencies were installed by ${isQuotable(foreign.createdBy) ? foreign.createdBy : "a different package manager"}, and this project installs with ${isQuotable(name) ? name : "its declared manager"}.`,
        remediation: `Remove node_modules and reinstall with ${installHint(name)} so the tree matches the lockfile.`,
      };
    },
  },

  // ───────────────────────────────────────────────────────────────────────────
  // Output
  // ───────────────────────────────────────────────────────────────────────────

  [HealthCode.OutputUnwritable]: {
    severity: DiagnosticSeverity.Error,
    describe: () => ({
      // Deliberately does not name a directory. One code covers both output paths, and the check that raised it knows
      // which one it was about — so the path is supplied by the caller (`unwritableFinding`) rather than guessed here from
      // a facts object that holds both. A message that said "the reports directory" while the evidence directory was the
      // problem would be worse than saying nothing.
      explanation: "The configured output directory cannot be written to.",
      remediation:
        "Choose a writable output directory, or correct the permissions on it.",
    }),
  },

  // ───────────────────────────────────────────────────────────────────────────
  // Configuration
  // ───────────────────────────────────────────────────────────────────────────

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

  // ───────────────────────────────────────────────────────────────────────────
  // Environment
  // ───────────────────────────────────────────────────────────────────────────

  [HealthCode.EnvironmentUndeclared]: {
    severity: DiagnosticSeverity.Error,

    describe: (facts) => {
      const selected = facts.environment?.selected;
      const declared = facts.environment?.declared ?? [];

      return {
        // A name typed on a command line is quoted only when it is a name the schema would accept. Anything else could be
        // a token pasted into the wrong field, and a diagnostic is the one thing guaranteed to be printed. The rule is
        // restated rather than imported — the schema exposes a validator, not a pattern — and a test feeds a value the
        // schema accepts and asserts it is quoted.
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
 * Severity comes from the guidance entry rather than from the caller, so a check cannot report the same condition with two
 * different weights — and the text is rendered once, here, rather than assembled at the point of failure.
 *
 * @param code Which condition was found.
 * @param facts What the check knew, which the entry uses to name the file, the version or the declared environments.
 * @param path Overrides the path the entry would set. Used by the two output checks alone: they share one code, the entry
 *   cannot know which directory failed, and the check that raised it does.
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
    remediation: text.remediation,
    ...(resolved === undefined ? {} : { path: resolved }),
  };
}

/**
 * The finding for an output directory that cannot be written.
 *
 * A second renderer for one code, because the shape it needs — the target, and nothing else — is narrower than the fact
 * set the other entries read. It exists so the path is exact rather than guessed: the check knows which directory it
 * probed, and a message that named the wrong one would send a reader to fix a directory that is fine.
 */
export function unwritableFinding(target: OutputTarget): CheckFinding {
  const guidance = HEALTH_GUIDANCE[HealthCode.OutputUnwritable];
  const text = guidance.describe({});

  return {
    code: HealthCode.OutputUnwritable,
    severity: guidance.severity,
    explanation: text.explanation,
    remediation: text.remediation,
    path: target.path,
  };
}
