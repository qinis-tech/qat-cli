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
 * ## Why the environment codes multiplied the same way
 *
 * The same reasoning, applied to a group that had been left at one entry because one entry was easy to write. The
 * conditions a reader actually hits — nothing was selected, something unusable was selected, the selection names no
 * declared profile, the file's default names no declared profile, the profile fails the schema, its paths escape the
 * project, a required variable is unset, a required variable is set to nothing, a reference reads from a source QAT does
 * not approve, a name cannot be passed to a child process — have ten different fixes between them.
 *
 * Three splits inside that list are worth defending, because each looks like an over-elaboration until the failure mode
 * is stated:
 *
 * - **"Not selected" is two codes, not one with a conditional severity.** Severity is a property of the code in this
 *   file — that is what stops two call sites reporting one condition at two weights. A selection that is a non-event for
 *   `doctor` and a blocker for a command about to execute tests is therefore two codes, and the caller picks by asking
 *   one question it already knows the answer to.
 * - **"Missing" and "empty" are four codes.** Set-to-nothing is the failure this layer's presence vocabulary exists to
 *   name: a deployment that sets `API_TOKEN=` is not one that forgot it, and a token of spaces authenticates exactly as
 *   badly while looking present to the obvious check. Telling a reader "it is missing" when they can see it in their
 *   shell is how a diagnostic loses its credibility in one sentence.
 * - **The profile check and the variable check keep separate codes even where the profile is the cause.** A reference
 *   inside a profile that could not be parsed is not a fact about the variable; reporting both would show two problems
 *   when the reader has one.
 *
 * ## Why nothing in the environment entries can print a secret
 *
 * Every other group in this file has to be careful with what it quotes. This one is different in kind, not in degree:
 * the environment inspection carries variable *names* and *presence states*, and the port beneath it returns an enum
 * with no value member — so a value never enters this layer, and no entry here can leak one however it is written.
 *
 * That is worth stating rather than assuming, because it changes what a future reviewer should do. A proposed entry
 * here that needs a value does not need a redaction step; it needs a different requirement. Redacting at this layer
 * would imply values were arriving and merely being hidden, which is exactly the assumption the presence port exists to
 * prevent.
 *
 * ## Why the configuration entries are keyed to the inspection, not to the loader outcome
 *
 * `facts.configuration` is no longer the loader's result. It is the composed inspection: one value that already
 * distinguishes absent from unreadable from malformed from unsupported-version from schema-invalid from usable. The
 * loader could only answer the first half of that question, which meant the schema verdict had to be composed somewhere
 * — and composing it in a check would have produced a second ordering that eventually contradicted the one the `run`
 * preflight performs.
 *
 * So these entries read `state`, never `kind`. They also do not decide *which* code applies: that decision belongs to the
 * reason returned by the configuration classifier, so that one condition cannot be reported as two different codes by two
 * different call sites. An entry here is handed a code and retrieves the details that make its sentence specific.
 *
 * The environment entries follow the same rule for the same reason: the selection, its provenance and the per-reference
 * verdicts are decided once, in the environment classifier, and these entries are handed the code that was chosen.
 *
 * ## Why one state still becomes several codes
 *
 * `schema-invalid` is one state and four sentences, because it has four fixes: correct the schema version, set a
 * framework QAT can run, keep an output path inside the project, or correct the reported fields. Seven-plus entries for
 * one file is not verbosity; each one ends in a different action, and a single message would name none of them.
 *
 * The same reasoning forces `missing` to be two codes rather than one code with a conditional severity. Severity is a
 * property of the code in this file — that is what stops a check reporting the same condition at two weights — so
 * "absent, and that is fine" and "absent, and this command cannot continue" are two codes. The alternative, a severity
 * function over facts, would move the same decision to every call site that remembered to pass the right flag.
 *
 * ## Guarding evidence: extract the value, then test the parent
 *
 * Several entries below lift a value through an optional chain and then test both the value and the object it came
 * from. That looks like one test too many, and it is not: `facts.runtime?.nodeVersion === undefined` cannot tell the
 * compiler *why* the value was missing, so the parent stays unnarrowed and the good branch cannot read
 * `facts.runtime.required`. Two separate facts, two separate tests, each of which also reads as a single question.
 *
 * ## Why the inline-code helper is called `inlineCode`
 *
 * It was called `code`, which shadowed the `code` parameter of `healthFinding` and — more importantly — gave the word a
 * second meaning in a file where it already means a diagnostic code. The parameter kept its name because it mirrors
 * `CheckFinding.code`; the helper was renamed because it produces markup, not identity.
 *
 * It exists for one reason, and the reason is visible in this file's own history: a backtick inside a template literal
 * must be escaped, and escaping it inline by hand is how four remediations here once shipped with unbalanced quotes and
 * truncated flags — `corepack prepare pnpm --activat`, `pnpm --versio`, `chmod 644 cypress.config.ts` with no closing
 * quote, `corepack use pnpm@9.1.0` cut off mid-expression. Every command below is now built through one function, and a
 * test asserts that every backtick it emits is balanced and every emitted command ends where it should.
 */
import type {
  EnvironmentInspection,
  VariableStatus,
} from "../../config/environment/index.js";
import {
  MAX_CONFIG_BYTES,
  toSafeIssue,
  type ConfigDiagnosticIssue,
} from "../../config/index.js";
import {
  HealthCode,
  type CheckFinding,
} from "../../core/application/checks.js";
import { DiagnosticSeverity } from "../../core/application/diagnostics.js";
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
 * knows which directory failed, and a configuration that was never found has no path to print.
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

/**
 * The file an entry is about, or a phrase standing in for it when the facts carried no name.
 *
 * A missing configuration has no path — only the location that was searched — so the fallback is a phrase rather than a
 * stand-in path. Printing `.` as though it were a filename is the kind of detail that makes a reader trust the rest of
 * the message less.
 */
function fileOf(facts: CheckFacts): string {
  const configuration = facts.configuration;
  if (configuration === undefined) return "The configuration file";
  if (configuration.state === "missing") return "The project root";
  return configuration.path;
}

/**
 * The `path` clause for an entry, omitted when there is no file to name.
 *
 * Replaces the repeated `...(facts.configuration === undefined ? {} : { path: … })` spread, which appeared eleven times in
 * this section and would have become eleven opportunities to forget the guard.
 */
function pathOf(facts: CheckFacts): { path?: string } {
  const configuration = facts.configuration;
  if (configuration === undefined || configuration.state === "missing")
    return {};
  return { path: configuration.path };
}

/**
 * Schema issues, reduced through the sanctioned projection.
 *
 * `toSafeIssue` is imported from the configuration module rather than reimplemented here: it is the function that
 * decides a rejected value becomes a *type summary* instead of a value. Duplicating that decision in a prose catalogue
 * is exactly how a secret ends up in a remediation.
 */
function issuesOf(facts: CheckFacts): readonly ConfigDiagnosticIssue[] {
  const configuration = facts.configuration;
  return configuration?.state === "schema-invalid"
    ? configuration.issues.map(toSafeIssue)
    : [];
}

/** The field paths implicated by a schema failure; safe by construction. */
function issuePathsOf(facts: CheckFacts): readonly string[] {
  return issuesOf(facts).map((issue) => issue.path);
}

/**
 * The environment inspection, when the gatherer supplied one.
 *
 * Hoisted into a function because nine entries below need it and each one would otherwise repeat the optional chain.
 * Reading it once per entry also keeps the narrowing visible: a state check on the returned value narrows for the rest
 * of that entry.
 */
function inspectionOf(facts: CheckFacts): EnvironmentInspection | undefined {
  return facts.environment?.inspection;
}

/**
 * Variable names carrying a given verdict.
 *
 * Names only, and filtered through the portable-name pattern before they reach a sentence. Validation upstream already
 * rejects anything else, so the filter is redundant in the happy path — which is the point: a name is user text, and
 * this is the last place before it becomes a line in a report that may be attached to a public issue.
 */
const SAFE_VARIABLE_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

function variableNamesByReason(
  facts: CheckFacts,
  reason: VariableStatus["reason"],
): readonly string[] {
  const inspection = inspectionOf(facts);
  if (inspection?.state !== "profile-valid") return [];
  return inspection.variables
    .filter((variable) => variable.reason === reason)
    .map((variable) => variable.name)
    .filter((name) => SAFE_VARIABLE_NAME.test(name));
}

/** The paths a profile declared that QAT could not resolve. Field paths only; never the declared value. */
function unresolvedPathFieldsOf(facts: CheckFacts): readonly string[] {
  const inspection = inspectionOf(facts);
  if (inspection?.state !== "profile-valid") return [];
  return inspection.paths
    .filter((path) => path.reason !== "ENV_PATH_RESOLVED")
    .map((path) => path.field);
}

/**
 * The selected profile's name, when it can be quoted.
 *
 * Returns `undefined` for a name the schema would not accept, so the sentence says "the selected environment" instead of
 * echoing something pasted from the wrong buffer. Deliberately derived from the inspection rather than from a separate
 * `selected` field: there is no second copy of the selection to disagree with the verdict.
 */
function selectedProfileOf(facts: CheckFacts): string | undefined {
  const inspection = inspectionOf(facts);
  if (inspection === undefined || inspection.state === "not-selected")
    return undefined;
  if (inspection.state === "selection-invalid")
    return PROFILE_NAME.test(inspection.raw) ? inspection.raw : undefined;
  return PROFILE_NAME.test(inspection.name) ? inspection.name : undefined;
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
 * Exists because a backtick inside a template literal must be escaped, and doing that inline several times is how
 * four of the remediations below once ended up with unbalanced quotes — and, in two cases, with a truncated flag that
 * made the printed command fail when pasted. One function, one escape, and every command in this file is built the same
 * way.
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
 * Agreement for a list of names, so one- and many-variable sentences read correctly.
 *
 * Written as a helper rather than as three inline ternaries because each of those ternaries was one more place for
 * "them" to end up attached to a single variable, which reads as carelessness in the one artefact the reader is meant
 * to trust.
 */
function pronounFor(values: readonly string[]): "it" | "them" {
  return values.length === 1 ? "it" : "them";
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

/** The reason a file could not be read, in the words a reader would use. */
function accessDetail(code: string): string {
  switch (code) {
    case "EACCES":
    case "EPERM":
      return "permission denied";
    case "EISDIR":
      return "the path is a directory, not a file";
    case "ENOTDIR":
      return "part of the path is not a directory";
    case "ELOOP":
      return "the path is a symbolic link loop";
    case "EIO":
      return "an I/O error occurred while reading it";
    case "AMBIGUOUS":
      return "more than one candidate file was found";
    default:
      return "it could not be read";
  }
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
   *
   * The Corepack route is only printed when the manager's name is known. `corepack prepare the manager --activate` is a
   * command that fails when pasted, and a remediation that cannot be run is worse than one that is merely incomplete.
   */
  [HealthCode.PackageManagerExecutableMissing]: {
    severity: DiagnosticSeverity.Warning,
    describe: (facts) => {
      const selection = facts.packageManager?.selection;
      const name =
        selection?.status === "identified" ? selection.name : undefined;
      const known = isQuotable(name) ? name : undefined;
      const corepack =
        known === undefined
          ? ""
          : `${inlineCode("corepack enable")} and ${inlineCode(`corepack prepare ${known} --activate`)}, or `;
      return {
        explanation: `This project installs with ${known ?? "a package manager"}, which is not available on PATH. Installing with a different tool would create a second lockfile alongside the one you have.`,
        remediation: `Install it — ${corepack}install it globally with npm — then re-run ${inlineCode("qat doctor")}.`,
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
      // which one it was about — so the path is supplied by the caller (`unwritableFinding`) rather than guessed here
      // from a facts object that holds both. A message that said "the reports directory" while the evidence directory
      // was the problem would be worse than saying nothing.
      explanation: "The configured output directory cannot be written to.",
      remediation:
        "Choose a writable output directory, or correct the permissions on it.",
    }),
  },

  // ───────────────────────────────────────────────────────────────────────────
  // Configuration — QAT's own file
  //
  // Eleven entries for one file, keyed to the states the inspection can report. Each one ends in a different action:
  // create a file, create a file *because this command needs one*, fix permissions, fix JSON, write something into it,
  // shrink it, install a QAT that understands it, add a version, set a framework QAT can run, keep a path inside the
  // project, or correct the reported fields. A single "invalid configuration" message would name none of them.
  //
  // None of them quotes the file. A line of a configuration file can hold an environment value, and a schema message can
  // echo one; findings print paths, kinds and line numbers, and point at the command that will print the rest.
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * No configuration, and that is fine.
   *
   * Information, not a warning: the documented defaults are the product's intended behaviour for a project that never
   * ran `qat init`, and marking a normal state as a problem is how a doctor teaches people to ignore it. The remediation
   * says the file is optional in as many words, because "create one" would imply otherwise.
   */
  [HealthCode.ConfigurationMissing]: {
    severity: DiagnosticSeverity.Information,
    describe: () => ({
      explanation:
        "No QAT configuration was found at the project root, so QAT is using its documented defaults.",
      remediation: `Nothing to do if the defaults suit you. To choose your own settings, create a file with ${inlineCode("qat init")} and commit it.`,
    }),
  },

  /**
   * No configuration, and this command cannot proceed.
   *
   * A separate code rather than a severity flag on the entry above: severity is a property of the code, decided once
   * here, and a conditional severity would put the same decision in every call site that remembered to pass it.
   */
  [HealthCode.ConfigurationMissingRequired]: {
    severity: DiagnosticSeverity.Error,
    describe: () => ({
      explanation:
        "This command needs a QAT configuration file, and none was found at the project root.",
      remediation: `Create one with ${inlineCode("qat init")}, commit it, then run the command again.`,
    }),
  },

  /**
   * Present, and not readable.
   *
   * Its own code rather than "missing": the file is *there*, so telling the reader to create one would send them to
   * overwrite something. The cause is named because "permission denied" and "that path is a directory" are different
   * afternoons.
   */
  [HealthCode.ConfigurationUnreadable]: {
    severity: DiagnosticSeverity.Error,
    describe: (facts) => {
      const configuration = facts.configuration;
      if (configuration?.state !== "inaccessible") {
        return {
          explanation: "The QAT configuration file could not be read.",
          remediation:
            "Check that it is a readable regular file, then run the command again.",
          ...pathOf(facts),
        };
      }
      return {
        explanation: `${configuration.path} could not be read: ${accessDetail(configuration.code)}.`,
        remediation: `Make it a readable regular file — for example ${inlineCode(`chmod 644 ${configuration.path}`)} — then run the command again. QAT will not replace it for you.`,
        path: configuration.path,
      };
    },
  },

  /**
   * Present, readable, and not JSON.
   *
   * Line and column only. The parser's message can quote the offending fragment, and a fragment of a configuration file
   * is file content — which is exactly what a finding must not carry.
   */
  [HealthCode.ConfigurationNotJson]: {
    severity: DiagnosticSeverity.Error,
    describe: (facts) => {
      const configuration = facts.configuration;
      const position =
        configuration?.state === "malformed" ? configuration : undefined;
      if (position?.line === undefined) {
        return {
          explanation: `${fileOf(facts)} is not valid JSON.`,
          remediation:
            "Correct the syntax of the file, or restore it from version control.",
          ...pathOf(facts),
        };
      }
      const at = `line ${String(position.line)}, column ${String(position.column ?? 0)}`;
      return {
        explanation: `${position.path} is not valid JSON at ${at}.`,
        remediation: `Correct the syntax at ${at}, then run the command again. QAT reads the file but never rewrites it.`,
        path: position.path,
      };
    },
  },

  /**
   * Present, readable, and carrying nothing.
   *
   * Reachable only when the loader tells an empty document apart from a malformed one. Where it cannot, the entry above
   * speaks instead — and a contract test asserts that whichever path is taken, the reader gets one of these two
   * sentences rather than a silent pass.
   */
  [HealthCode.ConfigurationEmpty]: {
    severity: DiagnosticSeverity.Error,
    describe: (facts) => ({
      explanation: `${fileOf(facts)} is empty.`,
      remediation:
        "Write a configuration, or delete the file to run with the defaults.",
      ...pathOf(facts),
    }),
  },

  /**
   * Larger than QAT will read.
   *
   * The bound is quoted from policy and the actual size is not, because the file was never read — printing a number we
   * did not measure would be a small lie in a file whose whole purpose is to be trusted.
   */
  [HealthCode.ConfigurationTooLarge]: {
    severity: DiagnosticSeverity.Error,
    describe: (facts) => {
      const configuration = facts.configuration;
      const path =
        configuration?.state === "inaccessible" &&
        configuration.code === "TOO_LARGE"
          ? configuration.path
          : undefined;
      return {
        explanation:
          path === undefined
            ? `The QAT configuration is larger than QAT will read (at most ${String(MAX_CONFIG_BYTES)} bytes).`
            : `${path} is larger than QAT will read (at most ${String(MAX_CONFIG_BYTES)} bytes).`,
        remediation: `Check that the path points at your configuration rather than a build artefact, then reduce it to the settings you need. The limit is ${String(MAX_CONFIG_BYTES)} bytes.`,
        ...(path === undefined ? pathOf(facts) : { path }),
      };
    },
  },

  /**
   * The declared schema version is outside the set this release understands.
   *
   * One sentence, and no field complaints, because there is nothing meaningful to say about fields in a document whose
   * version we do not understand. Declared and supported are both printed: "unsupported version" without the pair leaves
   * the reader unable to tell whether they should upgrade QAT or edit the file.
   */
  [HealthCode.ConfigurationVersionUnsupported]: {
    severity: DiagnosticSeverity.Error,
    describe: (facts) => {
      const configuration = facts.configuration;
      if (configuration?.state !== "version-unsupported") {
        return {
          explanation:
            "The QAT configuration declares a schema version this release does not support.",
          remediation:
            "Upgrade QAT, or bring the file to a version this release supports, then run the command again.",
          ...pathOf(facts),
        };
      }
      const supported = configuration.supported.map(String).join(", ");
      const declared =
        typeof configuration.declared === "number"
          ? String(configuration.declared)
          : "an unsupported value";
      return {
        explanation: `${configuration.path} declares schema version ${declared}, and this release of QAT supports ${supported}.`,
        remediation: `Upgrade QAT to a release that supports schema version ${declared}, or bring the file to a supported version (${supported}). QAT will not migrate or rewrite the file for you.`,
        path: configuration.path,
      };
    },
  },

  /**
   * The version field itself is missing or not a number.
   *
   * Splitting this from the entry above is not pedantry: `"schemaVersion": "1"` is a typo with a one-character fix,
   * while `7` means the reader is on the wrong release of QAT. One message covering both would be wrong for whoever it
   * was not written for.
   *
   * The offending value is not echoed — the evidence for a schema-invalid file deliberately carries paths and type
   * summaries only — so the message names the field and the expected kind, never the text that was there.
   */
  [HealthCode.ConfigurationVersionInvalid]: {
    severity: DiagnosticSeverity.Error,
    describe: (facts) => ({
      explanation: `${fileOf(facts)} does not declare a usable schema version. A number is required at ${inlineCode("schemaVersion")}.`,
      remediation: `Set ${inlineCode("schemaVersion")} to the version this release of QAT writes, then run the command again. Example: ${inlineCode('"schemaVersion": 1')}.`,
      ...pathOf(facts),
    }),
  },

  /**
   * The framework identifier is not one this release can run.
   *
   * Its own code because its own fix: the rest of the file may be perfectly correct, and the reader's next action is to
   * change one word. The declared value is not echoed, for the same reason as above — and a framework name pasted from
   * the wrong buffer is exactly the kind of user text a diagnostic must not print back verbatim.
   */
  [HealthCode.ConfigurationFrameworkUnsupported]: {
    severity: DiagnosticSeverity.Error,
    describe: (facts) => ({
      explanation: `${fileOf(facts)} declares a framework QAT cannot run.`,
      remediation: `Set ${inlineCode("framework")} to an adapter this release supports — this release runs ${inlineCode("cypress")}. See the adapters page in the documentation before adding another.`,
      ...pathOf(facts),
    }),
  },

  /**
   * An output path is absolute, escapes the project, or is otherwise not portable.
   *
   * Distinct from the general field report because the fix is a shape, not a value: a path inside the project, written
   * with forward slashes. The offending field paths are listed, and their values are not — a path is configuration
   * content, and on a developer machine it routinely contains a username.
   */
  [HealthCode.ConfigurationOutputPathInvalid]: {
    severity: DiagnosticSeverity.Error,
    describe: (facts) => {
      const fields = issuePathsOf(facts);
      const named = fields.length === 0 ? "An output path" : listOf(fields);
      return {
        explanation: `${fileOf(facts)} declares an output location QAT cannot use: ${named}. Output paths must be relative to the project root and stay inside it.`,
        remediation: `Use a relative path inside the project, for example ${inlineCode('"reports": { "directory": "./reports" }')}, then run the command again.`,
        ...pathOf(facts),
      };
    },
  },

  /**
   * The file parsed and the schema rejected one or more fields.
   *
   * The field paths are listed and nothing else: a value that failed validation is precisely the value a diagnostic must
   * not repeat, and the schema's own message can quote it. The command that prints the full detail is given so the reader
   * can decide how much to disclose and where.
   */
  [HealthCode.ConfigurationSchemaInvalid]: {
    severity: DiagnosticSeverity.Error,
    describe: (facts) => {
      const issues = issuesOf(facts);
      const paths = issues.map((issue) => issue.path);
      if (paths.length === 0) {
        return {
          explanation: `${fileOf(facts)} does not match the configuration schema.`,
          remediation: `Compare it with the documented example, correct the fields it names, then run the command again. ${inlineCode("qat doctor --format json")} lists every field that was rejected.`,
          ...pathOf(facts),
        };
      }
      // Built as a value rather than spliced inline: the parenthesis pair is exactly the shape that has been lost before
      // when a ternary and a template literal met on one long line.
      const firstExpected = issues[0]?.expected;
      const expectation =
        firstExpected === undefined ? "" : ` (expected ${firstExpected})`;
      return {
        explanation: `${fileOf(facts)} does not match the configuration schema. Rejected: ${listOf(paths)}${expectation}.`,
        remediation: `Correct the listed fields and run the command again. ${inlineCode("qat doctor --format json")} reports every rejected field with what the schema expected; the file is never modified.`,
        ...pathOf(facts),
      };
    },
  },

  // ───────────────────────────────────────────────────────────────────────────
  // Environment — the selected profile inside QAT's own configuration
  //
  // Fourteen entries, and the number is the argument: "nothing was selected", "nothing was selected and this command
  // needs one", "something unusable was selected", "the selection names no declared profile", "the file's default names
  // no declared profile", "the profile fails the schema", "its paths escape the project", and four shapes of variable
  // problem each ending in a different action.
  //
  // Not one of them can print a secret, and not because they are careful. The environment inspection carries names and
  // presence states; the port beneath it has no value member. Redaction here would be a lie about where the risk lives.
  //
  // None of them decides which code applies either: the environment classifier chooses, from the verdict it produced,
  // so one condition cannot be reported as two different codes by two call sites — the same rule the configuration
  // entries follow.
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Nothing was selected, and this command does not need a selection.
   *
   * Information, and a pass in everything but name. Most projects have no environment-specific settings at all, and a
   * doctor that flagged every one of them would be teaching its readers to skim. The remediation mentions how to opt in
   * without implying that opting in is expected.
   */
  [HealthCode.EnvironmentNotSelected]: {
    severity: DiagnosticSeverity.Information,
    describe: (facts) => {
      const declared = facts.environment?.declared ?? [];
      return {
        explanation:
          "No environment is selected, and this command does not need one, so nothing environment-specific was checked.",
        remediation:
          declared.length === 0
            ? `Nothing to do. To check a specific environment, select one with ${inlineCode("--env <name>")} after declaring it in the configuration.`
            : `Nothing to do. To check one of the declared environments, select it with ${inlineCode("--env <name>")}: ${listOf(declared)}.`,
      };
    },
  },

  /**
   * Nothing was selected, and this command cannot run without one.
   *
   * The pair to the entry above, and a separate code for the reason this file always gives: severity belongs to the
   * code, so the same absence at two weights is two codes rather than a flag the caller must remember to pass.
   */
  [HealthCode.EnvironmentNotSelectedRequired]: {
    severity: DiagnosticSeverity.Error,
    describe: (facts) => {
      const declared = facts.environment?.declared ?? [];
      return {
        explanation:
          "This command needs an environment, and none was selected: no selection on the command line, nothing in QAT_ENV, and no defaultEnvironment in the configuration.",
        remediation:
          declared.length === 0
            ? `Select one with ${inlineCode("--env <name>")}, or declare environments in the configuration first.`
            : `Select one with ${inlineCode("--env <name>")}, or set ${inlineCode("defaultEnvironment")}. Declared: ${listOf(declared)}.`,
      };
    },
  },

  /**
   * Something was selected and it is not usable.
   *
   * Reported rather than replaced. The tempting convenience — fall through to the default when the flag is empty — is
   * how a run ends up against an environment nobody chose, and it is the one outcome worth failing on.
   */
  [HealthCode.EnvironmentSelectionInvalid]: {
    severity: DiagnosticSeverity.Error,
    describe: (facts) => {
      const inspection = inspectionOf(facts);
      const raw =
        inspection?.state === "selection-invalid" ? inspection.raw : undefined;
      const origin =
        inspection === undefined || inspection.state === "not-selected"
          ? "the command"
          : inspection.origin;
      if (raw === undefined || raw.trim() === "") {
        return {
          explanation: `An environment selection arrived from ${origin} and it is empty.`,
          remediation: `Pass a name, for example ${inlineCode("--env staging")}. An empty selection cannot be treated as "no selection", because that would run a different environment than the one asked for.`,
        };
      }
      return {
        explanation: isQuotable(raw)
          ? `The environment "${raw}" is not a usable environment name.`
          : `The environment selected by ${origin} is not a usable environment name.`,
        remediation: `Use a name starting with a letter or digit, containing only letters, digits, dots, dashes and underscores — for example ${inlineCode("--env staging")}.`,
      };
    },
  },

  /**
   * A name was selected and no such profile is declared.
   *
   * The declared names are listed, because a typo is by far the most common cause and the reader can spot it in a list
   * they cannot in a file they have to open. A name is quoted only when it is one the schema would have accepted.
   */
  [HealthCode.EnvironmentUndeclared]: {
    severity: DiagnosticSeverity.Error,
    describe: (facts) => {
      const inspection = inspectionOf(facts);
      const available =
        inspection?.state === "profile-not-found"
          ? inspection.available
          : (facts.environment?.declared ?? []);
      const selected = selectedProfileOf(facts);
      return {
        explanation:
          selected === undefined
            ? "The environment selected for this command is not declared in the configuration."
            : `The environment "${selected}" is not declared in the configuration.`,
        remediation:
          available.length === 0
            ? "Declare the environment in the configuration, or remove the selection."
            : `Declare it, or choose one of: ${listOf(available)}.`,
        ...pathOf(facts),
      };
    },
  },

  /**
   * The configuration's own default names a profile that does not exist.
   *
   * Its own code, and its own owner: the previous entry is a person naming something, this one is a file naming
   * something. The fixes differ — correct a command versus correct a committed default — and the consequence differs
   * too, because a dangling default means *no* command gets an environment, not one.
   */
  [HealthCode.EnvironmentReferenceDangling]: {
    severity: DiagnosticSeverity.Error,
    describe: (facts) => {
      const inspection = inspectionOf(facts);
      const name =
        inspection?.state === "profile-not-found" ? inspection.name : undefined;
      const available =
        inspection?.state === "profile-not-found"
          ? inspection.available
          : (facts.environment?.declared ?? []);
      const quoted = PROFILE_NAME.test(name ?? "") ? name : undefined;
      return {
        explanation:
          quoted === undefined
            ? "The configuration's defaultEnvironment names a profile that is not declared."
            : `The configuration's defaultEnvironment names "${quoted}", and no such profile is declared.`,
        remediation:
          available.length === 0
            ? `Add the profile, or point ${inlineCode("defaultEnvironment")} at one that exists. Until it does, no command gets an environment by default.`
            : `Add the profile, or point ${inlineCode("defaultEnvironment")} at one that exists: ${listOf(available)}.`,
        ...pathOf(facts),
      };
    },
  },

  /**
   * The profile exists and the schema rejected it.
   *
   * Field paths only. A profile holds variable *references* and URLs, and a rejected value from either is the last thing
   * a finding should repeat — a base URL can carry credentials, which is why the schema refuses them in the first place.
   */
  [HealthCode.EnvironmentProfileInvalid]: {
    severity: DiagnosticSeverity.Error,
    describe: (facts) => {
      const inspection = inspectionOf(facts);
      const issues =
        inspection?.state === "profile-invalid" ? inspection.issues : [];
      const fields = issues.map((issue) => issue.path ?? "<profile>");
      const name = selectedProfileOf(facts);
      const subject =
        name === undefined ? "The selected profile" : `The "${name}" profile`;
      const expectation =
        issues[0]?.expected === undefined
          ? ""
          : ` (expected ${issues[0].expected})`;
      return {
        explanation:
          fields.length === 0
            ? `${subject} does not match the environment profile schema.`
            : `${subject} does not match the environment profile schema. Rejected: ${listOf(fields)}${expectation}.`,
        remediation: `Correct the listed fields, then run the command again. ${inlineCode("qat doctor --format json")} reports every rejected field; the file is never modified.`,
        ...pathOf(facts),
      };
    },
  },

  /**
   * The profile is valid, and a path it declares is not usable.
   *
   * Field paths are named and the declared values are not: a path on a developer machine routinely contains a username,
   * and one that escapes the project routinely contains somebody else's directory names. The fix is a shape, so the
   * shape is what the remediation shows.
   */
  [HealthCode.EnvironmentPathInvalid]: {
    severity: DiagnosticSeverity.Error,
    describe: (facts) => {
      const fields = unresolvedPathFieldsOf(facts);
      const name = selectedProfileOf(facts);
      const subject =
        name === undefined ? "The selected profile" : `The "${name}" profile`;
      return {
        explanation:
          fields.length === 0
            ? `${subject} declares a path QAT cannot use.`
            : `${subject} declares paths QAT cannot use: ${listOf(fields)}. Paths must be relative to the project root and stay inside it.`,
        remediation: `Use a relative path inside the project — for example ${inlineCode('"fixtures": { "directory": "./cypress/fixtures" }')} — then run the command again.`,
        ...pathOf(facts),
      };
    },
  },

  /**
   * A variable the profile marks as required is not set.
   *
   * The name and nothing else. "API_TOKEN is not set" is fully actionable; adding a value would be the one thing this
   * layer structurally cannot do, and asking for it in a bug report would be the second.
   *
   * The remediation says in as many words that QAT never reads the value, because a reader who suspects otherwise will
   * hesitate before exporting a credential — and hesitating is where people start pasting tokens into configuration files.
   */
  [HealthCode.EnvironmentVariableMissing]: {
    severity: DiagnosticSeverity.Error,
    describe: (facts) => {
      const missing = variableNamesByReason(facts, "ENV_VARIABLE_MISSING");
      const name = selectedProfileOf(facts);
      const subject =
        name === undefined ? "the selected profile" : `the "${name}" profile`;
      if (missing.length === 0) {
        return {
          explanation: `A variable required by ${subject} is not set.`,
          remediation: `Set it in your shell or CI secret store, then re-run ${inlineCode("qat doctor")}.`,
        };
      }
      return {
        explanation: `${subject} requires ${listOf(missing)}, and nothing is set for ${pronounFor(missing)}.`,
        remediation: `Set ${listOf(missing)} in your shell or CI secret store, then re-run ${inlineCode("qat doctor")}. QAT checks that the value exists; it never reads or prints it.`,
      };
    },
  },

  /**
   * A referenced variable is not set, and the profile does not say whether it must be.
   *
   * Warning, and deliberately not an error. The catalogue's rule is that a missing variable blocks only when the profile
   * explicitly requires it; where nothing states the requirement, the honest answer is "I could not establish this" —
   * which is reported, and is neither a pass nor a failure.
   *
   * The remediation asks for the declaration rather than for the value. Fixing the ambiguity is what makes the next run
   * able to give a real answer, and it costs one word in a file the reader already owns.
   */
  [HealthCode.EnvironmentVariableMissingUnconfirmed]: {
    severity: DiagnosticSeverity.Warning,
    describe: (facts) => {
      const missing = variableNamesByReason(facts, "ENV_VARIABLE_MISSING");
      const name = selectedProfileOf(facts);
      const subject =
        name === undefined ? "the selected profile" : `the "${name}" profile`;
      return {
        explanation:
          missing.length === 0
            ? `${subject} references a variable that is not set, and does not say whether it is required.`
            : `${subject} references ${listOf(missing)}, which ${pronounFor(missing)} not set. The profile does not say whether ${pronounFor(missing)} must be.`,
        remediation:
          missing.length === 0
            ? "Mark the variable required or optional in the profile so this check can decide whether to fail."
            : `Mark ${listOf(missing)} required or optional in the profile so this check can decide whether to fail, and set ${pronounFor(missing)} if the tests need ${pronounFor(missing)}.`,
      };
    },
  },

  /**
   * A variable the profile requires is set to nothing.
   *
   * The split from "missing" is the whole reason the presence vocabulary has three states. `export API_TOKEN=` is a
   * deliberate act in some pipelines and an inheritance accident in others, and either way it is not the same as
   * forgetting — telling this reader "it is not set" when they can see it in their shell costs the diagnostic its
   * credibility in a single sentence.
   */
  [HealthCode.EnvironmentVariableBlank]: {
    severity: DiagnosticSeverity.Error,
    describe: (facts) => {
      const blank = variableNamesByReason(facts, "ENV_VARIABLE_BLANK");
      const name = selectedProfileOf(facts);
      const subject =
        name === undefined ? "the selected profile" : `the "${name}" profile`;
      return {
        explanation:
          blank.length === 0
            ? `A variable required by ${subject} is set to an empty value.`
            : `${subject} requires ${listOf(blank)}, and ${pronounFor(blank)} set to an empty value. An empty value is not the same as an absent one, and neither will authenticate.`,
        remediation: `Set ${blank.length === 0 ? "it" : listOf(blank)} to a non-empty value in your shell or CI secret store, then re-run ${inlineCode("qat doctor")}. If it is deliberately empty, remove the reference instead.`,
      };
    },
  },

  /**
   * A referenced variable is set to nothing, and the profile does not say whether it must be.
   *
   * Warning, for the same reason as its missing counterpart. Kept apart from it because "empty" is evidence about the
   * environment a reader can act on immediately, while "missing" may mean the variable is supplied by something that has
   * not run yet.
   */
  [HealthCode.EnvironmentVariableBlankUnconfirmed]: {
    severity: DiagnosticSeverity.Warning,
    describe: (facts) => {
      const blank = variableNamesByReason(facts, "ENV_VARIABLE_BLANK");
      const name = selectedProfileOf(facts);
      const subject =
        name === undefined ? "the selected profile" : `the "${name}" profile`;
      return {
        explanation:
          blank.length === 0
            ? `${subject} references a variable that is set to an empty value, and does not say whether it is required.`
            : `${subject} references ${listOf(blank)}, which ${pronounFor(blank)} set to an empty value. The profile does not say whether ${pronounFor(blank)} must be set.`,
        remediation: `Mark ${blank.length === 0 ? "the variable" : listOf(blank)} required or optional in the profile, then set a non-empty value if the tests need one.`,
      };
    },
  },

  /**
   * A reference reads from a source QAT does not approve.
   *
   * Error, not warning. A reference whose source QAT will not read is not an environmental condition the reader can live
   * with — it is a declaration QAT will never honour, and the run that follows will fail on a variable that looks
   * declared. Only one source is approved, and the remediation shows the shape rather than describing it.
   */
  [HealthCode.EnvironmentVariableSourceUnapproved]: {
    severity: DiagnosticSeverity.Error,
    describe: (facts) => {
      const rejected = variableNamesByReason(
        facts,
        "ENV_REFERENCE_SOURCE_NOT_APPROVED",
      );
      const name = selectedProfileOf(facts);
      const subject =
        name === undefined ? "The selected profile" : `The "${name}" profile`;
      return {
        explanation:
          rejected.length === 0
            ? `${subject} reads a variable from a source QAT does not approve. Only ${inlineCode("env")} is supported.`
            : `${subject} reads ${listOf(rejected)} from a source QAT does not approve. Only ${inlineCode("env")} is supported.`,
        remediation: `Declare the reference with ${inlineCode('{ "source": "env", "name": "API_TOKEN" }')} so the value comes from the environment, and never write the value itself into the configuration file.`,
        ...pathOf(facts),
      };
    },
  },

  /**
   * A declared name cannot be passed to a child process faithfully.
   *
   * Its own code because it is a different act: the variable may well be set, and QAT still cannot deliver it. Names are
   * printed only when they pass the portable-name pattern — which, for this code, they by definition do not — so the
   * sentence describes the shape instead of quoting what was typed.
   */
  [HealthCode.EnvironmentVariableNameInvalid]: {
    severity: DiagnosticSeverity.Error,
    describe: (facts) => {
      const invalid = variableNamesByReason(
        facts,
        "ENV_REFERENCE_NAME_INVALID",
      );
      const name = selectedProfileOf(facts);
      const subject =
        name === undefined ? "The selected profile" : `The "${name}" profile`;
      return {
        explanation:
          invalid.length === 0
            ? `${subject} declares a variable name QAT cannot pass to a child process.`
            : `${subject} declares variable names QAT cannot pass to a child process: ${listOf(invalid)}.`,
        remediation: `Use upper-case letters, digits and underscores, starting with a letter — for example ${inlineCode("API_TOKEN")}. A name QAT cannot pass faithfully is refused rather than silently altered.`,
        ...pathOf(facts),
      };
    },
  },

  /**
   * Presence could not be established.
   *
   * Warning, never a pass. "I could not look" and "it is not set" lead a reader to different places, and collapsing them
   * is how a diagnostic starts inventing facts about someone's machine. The remediation asks for the JSON output because
   * this is the case where QAT genuinely has no opinion.
   */
  [HealthCode.EnvironmentVariableUnverifiable]: {
    severity: DiagnosticSeverity.Warning,
    describe: (facts) => {
      const unverifiable = variableNamesByReason(
        facts,
        "ENV_VARIABLE_UNVERIFIABLE",
      );
      const name = selectedProfileOf(facts);
      const subject =
        name === undefined ? "the selected profile" : `the "${name}" profile`;
      return {
        explanation:
          unverifiable.length === 0
            ? `QAT could not establish whether a variable referenced by ${subject} is set.`
            : `QAT could not establish whether ${listOf(unverifiable)}, referenced by ${subject}, ${pronounFor(unverifiable)} set.`,
        remediation:
          "Run the command again. If this repeats, include the JSON output in a bug report — QAT is not claiming the value is present.",
      };
    },
  },

  // ───────────────────────────────────────────────────────────────────────────
  // Cypress configuration
  //
  // Twelve entries for one file: ten about locating it and two about validating it. Every one names what was found and
  // what to do, and none of them quotes the file — a line of a Cypress configuration can hold an environment value, and
  // a loader's message can carry a code frame of one. Kind, line and path are printed; content never is.
  //
  // The remedy for each is the reason they are separate codes: "create one", "delete the others", "rename it", "move
  // it", "put a file there", "keep it inside the project", "make it readable", "write something in it" and "migrate it"
  // are nine different actions, and one message covering all of them would name none.
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Nothing configures the project.
   *
   * One code for two openings because the remedy is the same sentence with a different first clause — create a
   * configuration — and the context decides which opening is honest. Derived from evidence rather than re-read: this
   * entry must not open a directory to decide what to say.
   */
  [HealthCode.CypressConfigurationMissing]: {
    severity: DiagnosticSeverity.Error,
    describe: (facts) => {
      const location = facts.cypressConfiguration?.location;
      const context =
        location?.reason === "CYPRESS_CONFIG_MISSING"
          ? location.context
          : undefined;
      return context === "cypress-evidenced"
        ? {
            explanation:
              "This project references Cypress but has no configuration file, so Cypress cannot start.",
            remediation: `Generate the configuration with ${inlineCode("npx cypress open")}, commit it, then re-run ${inlineCode("qat doctor")}.`,
          }
        : {
            explanation:
              "No Cypress configuration was found, and nothing else in the project identifies it as a Cypress project.",
            remediation: `If this repository should run Cypress, generate the configuration with ${inlineCode("npx cypress open")} and commit it.`,
          };
    },
  },

  /**
   * Two configuration files.
   *
   * Both are named and the choice is left to the reader, because naming one would be a guess — and a guess here decides
   * which file the next install rewrites. Cypress itself refuses to start in this state, so the message reports a fact
   * rather than expressing a preference.
   */
  [HealthCode.CypressConfigurationAmbiguous]: {
    severity: DiagnosticSeverity.Error,
    describe: (facts) => {
      const location = facts.cypressConfiguration?.location;
      const files =
        location?.reason === "CYPRESS_CONFIG_AMBIGUOUS"
          ? location.files
          : undefined;
      return files === undefined
        ? {
            explanation:
              "More than one Cypress configuration file is present, and Cypress will not start with more than one.",
            remediation:
              "Keep the file your project uses and delete the others, then commit.",
          }
        : {
            explanation: `Cypress refuses to start when more than one configuration file is present. Found: ${listOf(files)}.`,
            remediation: `Keep the file your project actually uses and delete the others (${listOf(files)}), then commit. Do not run an install first — it may rewrite the file you meant to keep.`,
          };
    },
  },

  /**
   * A configuration-looking file Cypress does not load.
   *
   * Distinct from missing on purpose: something here is plainly intended as configuration, so telling the reader nothing
   * was found sends them looking for a file they already have.
   */
  [HealthCode.CypressConfigurationUnsupportedFormat]: {
    severity: DiagnosticSeverity.Error,
    describe: (facts) => {
      const location = facts.cypressConfiguration?.location;
      const files =
        location?.reason === "CYPRESS_CONFIG_UNSUPPORTED_NAME"
          ? location.files
          : undefined;
      return {
        explanation:
          files === undefined
            ? "A Cypress-looking configuration exists in a form Cypress does not load."
            : `A Cypress-looking configuration exists in a form Cypress does not load: ${listOf(files)}.`,
        remediation: `Rename it to ${inlineCode("cypress.config.ts")} (or ${inlineCode(".js")}, ${inlineCode(".mjs")}, ${inlineCode(".cjs")}) at the project root. Cypress only reads a supported configuration filename in that location.`,
      };
    },
  },

  /**
   * Configured, but not where Cypress looks.
   *
   * Advisory when it accompanies a working configuration — which is how it reaches here — because the project runs and
   * the stale copy is worth mentioning rather than blocking. The fix is to move a file, not to write one.
   */
  [HealthCode.CypressConfigurationMisplaced]: {
    severity: DiagnosticSeverity.Warning,
    describe: (facts) => {
      const location = facts.cypressConfiguration?.location;
      const files =
        location?.reason === "CYPRESS_CONFIG_MISPLACED"
          ? location.files
          : undefined;
      return {
        explanation:
          files === undefined
            ? "A Cypress configuration exists somewhere Cypress never reads."
            : `A Cypress configuration exists somewhere Cypress never reads: ${listOf(files)}.`,
        remediation: `Move it to the project root and rename it to ${inlineCode("cypress.config.ts")}. Cypress only loads a configuration from the directory it is started in.`,
      };
    },
  },

  /**
   * A configuration path is not a regular file.
   *
   * Two reasons arrive here, and they share a code because they share a remedy: put a regular file there. The first is
   * the case a file probe cannot see at all — a directory sitting on `cypress.config.ts` — and it is the one fact that
   * turns an otherwise baffling "no configuration found" into something a reader can act on.
   */
  [HealthCode.CypressConfigurationPathNotAFile]: {
    severity: DiagnosticSeverity.Error,
    describe: (facts) => {
      const location = facts.cypressConfiguration?.location;
      const occupied =
        location?.reason === "CYPRESS_CONFIG_PATH_OCCUPIED"
          ? location.paths
          : undefined;
      const notAFile =
        location?.reason === "CYPRESS_CONFIG_NOT_A_FILE"
          ? location.file
          : undefined;
      if (occupied !== undefined) {
        return {
          explanation: `A directory is occupying a Cypress configuration path: ${listOf(occupied)}. Cypress needs a file there, so no configuration can be found.`,
          remediation:
            "Remove or rename the directory, then re-run the command.",
        };
      }
      if (notAFile !== undefined) {
        return {
          explanation: `${notAFile} exists but is not a regular file, so Cypress cannot load it.`,
          remediation:
            "Replace it with a regular file containing the configuration.",
          path: notAFile,
        };
      }
      return {
        explanation:
          "A Cypress configuration path is not a regular file, so Cypress cannot load it.",
        remediation:
          "Replace it with a regular file containing the configuration.",
      };
    },
  },

  /**
   * The configuration is a link out of the project.
   *
   * The destination is printed, because it is the fact the reader needs to see where the link goes — and because a
   * boundary they cannot see is a boundary they cannot respect. This is the one entry in the group that prints an
   * absolute path, and it prints it for exactly that reason.
   */
  [HealthCode.CypressConfigurationOutsideProject]: {
    severity: DiagnosticSeverity.Error,
    describe: (facts) => {
      const location = facts.cypressConfiguration?.location;
      if (location?.reason !== "CYPRESS_CONFIG_OUTSIDE_PROJECT") {
        return {
          explanation:
            "The Cypress configuration resolves to a location outside the project, so it does not describe this project.",
          remediation:
            "Replace the link with a real file inside the project, or with a relative link that stays inside it.",
        };
      }
      return {
        explanation: `${location.file} is a symbolic link that resolves outside the project (${location.resolvedPath}), so its contents do not describe this project.`,
        remediation:
          "Replace the link with a real file inside the project, or with a relative link that stays inside it. QAT will not read configuration from outside the project root.",
        path: location.file,
      };
    },
  },

  /**
   * Present, and not readable.
   *
   * Its own code rather than "missing" because the file is *there* — telling the reader to create one would be actively
   * misleading, and the fix is a permission or a lock, not a new file.
   */
  [HealthCode.CypressConfigurationUnreadable]: {
    severity: DiagnosticSeverity.Error,
    describe: (facts) => {
      const location = facts.cypressConfiguration?.location;
      if (location?.reason !== "CYPRESS_CONFIG_UNREADABLE") {
        return {
          explanation: "The Cypress configuration could not be read.",
          remediation:
            "Make the file readable by your user and check nothing else holds it open, then re-run the command.",
        };
      }
      return {
        explanation: `${location.file} could not be read (${location.cause === "permissions" ? "permission denied" : "I/O error"}).`,
        remediation: `Make the file readable by your user (for example ${inlineCode(`chmod 644 ${location.file}`)}) and check it is not locked by another process, then re-run the command.`,
        path: location.file,
      };
    },
  },

  /** Present, readable, and carrying nothing. Cypress cannot load a configuration with no content. */
  [HealthCode.CypressConfigurationEmpty]: {
    severity: DiagnosticSeverity.Error,
    describe: (facts) => {
      const location = facts.cypressConfiguration?.location;
      const file =
        location?.reason === "CYPRESS_CONFIG_EMPTY" ? location.file : undefined;
      return {
        explanation:
          file === undefined
            ? "The Cypress configuration file is empty."
            : `${file} is empty, so Cypress cannot load a configuration from it.`,
        remediation: `Write the configuration into it, or delete it and regenerate one with ${inlineCode("npx cypress open")}.`,
        ...(file === undefined ? {} : { path: file }),
      };
    },
  },

  /**
   * Readable, and in the pre-v10 format.
   *
   * Advisory, because it works today: failing a project that runs would be wrong, and silence would let a team meet this
   * during an upgrade instead of now. The migration command is named because "migrate" alone is not an instruction.
   */
  [HealthCode.CypressConfigurationLegacyFormat]: {
    severity: DiagnosticSeverity.Warning,
    describe: (facts) => {
      const location = facts.cypressConfiguration?.location;
      const file =
        location?.reason === "CYPRESS_CONFIG_LEGACY_FORMAT"
          ? location.file
          : undefined;
      return {
        explanation:
          file === undefined
            ? "The Cypress configuration uses the pre-v10 format."
            : `The Cypress configuration at ${file} uses the pre-v10 format.`,
        remediation: `Migrate to ${inlineCode("cypress.config.ts")}: run ${inlineCode("npx cypress open")} to generate one, port the settings across, then delete the old file.`,
        ...(file === undefined ? {} : { path: file }),
      };
    },
  },

  /**
   * Located, and never inspected.
   *
   * A question we could not answer, so a warning: never a pass, because silence must not read as consent, and never a
   * failure, because a question we failed to answer must not block work we can still perform.
   */
  [HealthCode.CypressConfigurationNotInspected]: {
    severity: DiagnosticSeverity.Warning,
    describe: (facts) => {
      const location = facts.cypressConfiguration?.location;
      const file =
        location?.reason === "CYPRESS_CONFIG_NOT_INSPECTED"
          ? location.file
          : undefined;
      return {
        explanation:
          file === undefined
            ? "The Cypress configuration was reported but could not be inspected, so QAT cannot say whether it is usable."
            : `${file} was reported as the project's configuration but could not be inspected, so QAT cannot say whether it is usable.`,
        remediation:
          "Run the command again. If this repeats, include the JSON output in a bug report — this is the case where QAT has no opinion and should not pretend otherwise.",
        ...(file === undefined ? {} : { path: file }),
      };
    },
  },

  /**
   * A mechanism established that the configuration is invalid.
   *
   * The only configuration code that can honestly block, and the only one that names its authority: a JSON parser and the
   * project's own loader are not equally strong witnesses. Kind and line are printed; the message is not, because a
   * loader's message can carry a code frame and a code frame is file content. The command that will print it is given
   * instead, which puts the decision in the reader's hands.
   */
  [HealthCode.CypressConfigurationInvalid]: {
    severity: DiagnosticSeverity.Error,
    describe: (facts) => {
      const validation = facts.cypressConfiguration?.validation;
      if (validation?.reason !== "CYPRESS_CONFIG_INVALID") {
        return {
          explanation: "The Cypress configuration could not be loaded.",
          remediation: "Correct the configuration and run the command again.",
        };
      }
      const where =
        validation.failure.line === undefined
          ? ""
          : `at line ${String(validation.failure.line)}`;
      const what =
        validation.failure.kind === "syntax"
          ? "is not syntactically valid"
          : validation.failure.kind === "shape"
            ? "does not have the expected shape"
            : "could not be loaded by Cypress";
      const authority =
        validation.tier === "T1-json"
          ? "the JSON parser"
          : "the project's Cypress loader";
      return {
        explanation: `${validation.file} ${what}${where} (established by ${authority}).`,
        remediation: `Correct the problem${where} and run the command again. To see ${authority === "the JSON parser" ? "the parser's" : "the loader's"} own message, run ${inlineCode("npx cypress config")}.`,
        path: validation.file,
      };
    },
  },

  /**
   * No mechanism was entitled to a verdict.
   *
   * Six causes under one code, for the reason `RuntimeUnknown` covers three: the remedy is one thing — get a mechanism,
   * then ask again — and a code per cause would put QAT's own default behaviour in the same list as the project's
   * defects.
   *
   * The cause still decides the sentence, and one of them deliberately does not sound alarming: deep validation being
   * off is the *default*, and a healthy TypeScript project must not show green on a check that never ran nor red on one
   * that was never asked to.
   */
  [HealthCode.CypressConfigurationUnverified]: {
    severity: DiagnosticSeverity.Warning,
    describe: (facts) => {
      const validation = facts.cypressConfiguration?.validation;
      if (validation?.reason !== "CYPRESS_CONFIG_NOT_VALIDATED") {
        return {
          explanation:
            "The Cypress configuration was not validated, so QAT cannot say whether it is valid.",
          remediation:
            "Run the command again, or validate the configuration with Cypress directly.",
        };
      }
      const file = validation.file;
      const cause = validation.cause;
      // Not a defect: the default. Saying so plainly is what stops the check from claiming a verification it never
      // performed, without dressing the gap up as a problem.
      if (cause === "deep-validation-disabled") {
        return {
          explanation: `${file} was read and is decodable text, but its syntax was not validated: deep validation is off.`,
          remediation: `Re-run with deep validation enabled to load the configuration through Cypress, or accept that only its readability was confirmed.`,
          path: file,
        };
      }
      const detail =
        cause === "probe-timeout"
          ? "the loader did not answer in time"
          : cause === "size-budget-exceeded"
            ? "the file is larger than QAT will read"
            : cause === "undecodable-text"
              ? "the file is not valid UTF-8"
              : cause === "deep-validation-unavailable"
                ? "no configuration loader is available for this project"
                : "the file's text could not be established";
      return {
        explanation: `${file} could not be validated: ${detail}. QAT is not claiming the configuration is valid.`,
        remediation:
          cause === "deep-validation-unavailable"
            ? `Install the project's dependencies so its Cypress loader is available, then run the command again.`
            : `Run the command again once the condition above is resolved. To see the loader's own message, run ${inlineCode("npx cypress config")}.`,
        path: file,
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
