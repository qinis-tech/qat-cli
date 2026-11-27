/**
 * The composition root.
 *
 * The only place in the program that names an implementation. Everything else declares what it needs and receives it,
 * which is what makes a service testable without a database, a terminal or a clock — and what makes this file the single
 * place to look when the question is "where does this come from".
 *
 * The shape it returns is declared in `core/application/ports`, not here: a command handler receives a contract, and
 * depending on the assembly's own type would make the CLI depend on what builds it.
 *
 * ## Why this is not in `src/cli`
 *
 * It was, in the architecture as first written: `src/cli/index.ts` was both the entry point and the assembler. Those are
 * different jobs. The entry point parses arguments, installs signal handlers and sets an exit code — all of which happens
 * on import, so any test that wanted to check the wiring would have launched the CLI. Assembly has no such side effects
 * and can be called freely.
 *
 * ## What is deliberately not constructed
 *
 * The process helpers are modules of functions with no state. Wrapping them in objects so that something can be
 * "constructed" would add a layer that exists only to be injected, and every caller would then need the wrapper instead
 * of the function. They are imported where they are used — including by the gatherer that runs a bounded loader probe,
 * which builds that probe itself from the stateless process utility rather than receiving a wired one from here.
 *
 * The same is true of the filesystem helpers a *workflow* uses: detection, the path resolver and the configuration
 * inspector all call stateless functions directly, and none of them needs an assembly decision.
 *
 * What *is* adapted here is only what a port's shape requires. The port has nine members; six need an adaptation and
 * three need none, and those six fall into four kinds:
 *
 * | Port member | Implementation | Adaptation |
 * | --- | --- | --- |
 * | `resolveWorkingDirectory(candidates)` | `resolveWorkingDirectory(candidates, processDirectory?)` | Narrowed — the second argument is a test seam |
 * | `diagnose(root)` | `diagnoseProject(root, options?)` | Narrowed — the search depth is a test seam |
 * | `assess(root)` | `assessProject(root, options?)`, then the resolved configuration | Narrowed *and* composed — see below |
 * | `discover(root)` | `discoverProject({ cwd: root })` | Reshaped — the function takes options |
 * | `configuration.resolve(root, loaded)` | `resolveConfiguration({ loaded, projectRoot })` | Reshaped, and the result translated into the port's own vocabulary |
 * | `initialisation.initialise(root)` | `createInitialisationService({ assess: assessProject, readConfiguration, createFile })` | Composed — three existing operations, assigned directly |
 * | `runtime.readNodeVersion()` | `createProcessRuntime()` | **None** — assigned directly, because the factory *is* the implementation |
 * | `executables.locateExecutable(command)` | `createPathLocator()` | **None** — assigned directly, now that the factory's method carries the port's name |
 * | `files.inspect` / `resolveRealPath` / `readPrefix` | `createFileInspector()` | **None** — assigned directly, for the same reason: three methods named exactly as the port names them |
 *
 * Every adapted member does one of those, and some do a pair; that is the rule worth keeping: **narrow a test seam,
 * reshape an argument, translate a vocabulary, or compose a workflow — and know which of them you are doing.** A member
 * that needed none of them is assigned directly rather than wrapped for symmetry, because an adapter with no translation
 * in it is a second name for the same thing.
 *
 * Three members are the worked examples, and the second one arrived by deleting code rather than adding it. The runtime
 * probe is constructed and returned; the path locator was *wrapped* while its method was called `locate`, and the wrapper
 * existed solely to bridge that word to `locateExecutable`. Renaming the method removed the adapter, the option, and the
 * local that fed it — three things that existed to say one thing twice. The file inspector never had an adapter at all,
 * because its factory was written against the port in the first place.
 *
 * The narrowing is deliberate rather than incidental. A command should not be able to tune the parent search depth: the
 * engine's default is right for every real invocation, and putting it on a port turns a constant into a decision each
 * command has to make — and eventually make differently. The same reasoning withholds the `defaults` argument from
 * `configuration.resolve`: it exists so a test or a future profile can substitute a table, not so a command can invent
 * one.
 *
 * Two members do more than pass through, and both earn the exception the same way: they answer a question that the caller
 * cannot answer alone. `assess` attaches the resolved configuration, because where a run would write is part of "may I act
 * on this project". `initialisation` reads a file, judges a project and creates a configuration, because a command that
 * did any of that itself would either repeat the assessment's work or form a second opinion about what a usable project
 * is.
 *
 * ## Why the health checks are not assembled here
 *
 * The catalogue is static data — a keyed table of definitions, each a pure function of the evidence it declared a need for
 * — so there is nothing for a factory to build and nothing to inject. What assembly supplies is the *evidence*, not the
 * questions: the running interpreter, the range this build declares, the tool locator and the file inspector are exposed
 * for whichever workflow gathers facts, and the checks then read exactly the groups they asked for.
 *
 * The obvious design is the wrong one, which is why it is worth naming. Injecting a requirement into a check would make
 * every definition a closure over policy, and then the same catalogue entry would behave differently depending on who
 * constructed it — the last thing a report that quotes "the supported range" should be able to do. It would also put the
 * comparison back inside a map literal, where none of its branches can be tested on their own.
 *
 * ## Where the supported Node.js range comes from
 *
 * From the package's own declaration, read once, and exposed as a value. Nowhere else.
 *
 * The manifest's `engines.node` is the single authority: it is the field a package manager already enforces on install,
 * it travels with the published artefact, and it is the one place a release changes when the supported runtime changes. A
 * copy in a check, a README and a CI matrix is three copies, and the first one to drift produces a support claim that no
 * test covers.
 *
 * Four consequences worth stating, because all four are decisions rather than omissions:
 *
 * - The manifest is read from **this installation**, never from the working directory. `qat doctor` runs inside a user's
 *   project, so `cwd/package.json` is a stranger's manifest — reading it would make the range QAT supports depend on
 *   whichever project it was pointed at. The reader resolves from its own module location for exactly that reason.
 * - A **missing** declaration does not make this factory throw and does not acquire a default. The requirement is built
 *   with an empty range, and the check reports it as unreadable policy — a visible warning on the one command a user runs
 *   when their installation is broken, instead of a crash from the command that was supposed to explain it.
 * - The requirement is resolved **once per process** and frozen by its builder. Every consumer, now and later, reads the
 *   same value, so two findings cannot disagree about what "supported" means within a single run.
 * - It is **not** pushed into the checks. A check receives facts, and the range reaches it through `RuntimeFacts.required`
 *   — so the value the check compares against is the value the guidance table quotes back, not a second copy assembled
 *   somewhere else.
 *
 * A project-level framework runtime bound needs nothing from this file. The gatherer that inspects the project reads the
 * declaration and puts it in `RuntimeFacts.frameworkRequired`; the advisory check emits a finding when it is there and
 * stays silent when it is not. Assembly does not guess, and does not wire a placeholder for a value nobody declared.
 *
 * ## Where tooling evidence comes from
 *
 * The package-manager check needs one machine fact — where, if anywhere, a command lives — and that is the whole of this
 * file's involvement. It supplies `executables`, a locator that answers only that question, and stops there.
 *
 * Three consequences, again all decisions:
 *
 * - **PATH only, never a project-local binary directory.** The locator implementation refuses `node_modules/.bin` and
 *   refuses empty or relative PATH segments. A project-local directory is writable by any dependency install, so
 *   resolving a tool from there would run project-controlled code simply to learn its name — the one kind of risk a
 *   read-only health check must never introduce.
 * - **The check itself is composed elsewhere.** Which command to look for depends on project evidence (a lockfile, a
 *   declaration), so the *decision* belongs to the workflow that gathers it. Here we supply the primitive; the project
 *   layer composes it into a manager-shaped port; the workflow asks the question. There is no second opinion about what
 *   "the package manager" is anywhere in this file.
 * - **The rule for "is this file executable" is not decided here.** The locator supplies its own default probe — one
 *   `stat`, one `access`, and the Windows exception — because that definition belongs to the locator and is tested beside
 *   it. Assembly names the factory and nothing about how a file is inspected, which is the same reason it does not name
 *   how a directory listing is read.
 *
 * ## Where filesystem evidence comes from
 *
 * The configuration checks need file-level facts that no other layer gathers: is the path a regular file, where does a
 * symlink lead, what do the first bytes say. All of it is I/O, so none of it can live in a check, and it arrives through
 * one port with three methods.
 *
 * The implementation is **core's**, not the project layer's, and that is the point of naming it here. A project-layer
 * factory would be a second implementation of a machine concern — the exact shape this file exists to prevent — and the
 * snapshot code that first needed it would then own a copy of `stat`, `realpath` and a bounded read. Core owns the
 * factory; the project layer owns only the interpretation of what comes back, which is where its vocabulary actually is.
 *
 * The port is **read-only by construction**: no write member exists, so a diagnostic built on it cannot modify the project
 * it is diagnosing, whatever a future contributor intends. That matters more here than anywhere else in this file,
 * because the one writer in the system — `initialisation` — is deliberately a separate port with a separate purpose, and
 * a single object offering both would make "which of these can change my repository" a question a reader has to answer
 * from memory.
 *
 * The seam exists for the same reason `runtime` and `executables` do: a test of the snapshot matrix — unreadable, oversize,
 * a link escaping the project, a directory on the path — must supply those states as values rather than construct the
 * filesystem it is testing. One seam, on the port.
 *
 * ## One seam per port, never one per object
 *
 * `executables` is the only test seam for tooling, and `files` the only one for inspection. An option for the
 * implementation as well would let a caller swap the factory *without* swapping the port, which is a configuration with no
 * meaning: the port is what the workflow asks, and the implementation is what it happens to have. Every extra seam is a
 * question a reviewer has to answer about combinations that will never occur.
 */

import { join } from "node:path";

import {
  CONFIG_FILE_NAME,
  resolveConfiguration,
  type PathIssue,
} from "../config/index.js";
import {
  ConfigurationLoad,
  loadConfiguration,
} from "../config/loader/index.js";
import type {
  ConfigurationFinding,
  ConfigurationResolver,
} from "../core/application/configuration.js";
import type {
  Application,
  ExecutableLocator,
  FileInspector,
  ProjectDiscovery,
  RuntimeProbe,
} from "../core/application/ports.js";
import type { ProjectAssessment } from "../core/application/validation.js";
// The widened name, because there is now only one. What this value describes has grown — the same shape carries a
// framework advisory and a package-manager pin — and the runtime-era alias in `core/compatibility` survives only so that
// call sites in flight keep compiling. Using it here would keep a second vocabulary alive in the one file whose job is to
// name things once.
import {
  qatRuntimeRequirement,
  type VersionRequirement,
} from "../core/compatibility/index.js";
import {
  createProcessRuntime,
  type EnvironmentSource,
} from "../core/environment/index.js";
import { ErrorCode, InvalidArgumentError } from "../core/errors/index.js";
// Only what core actually exports: `writeNewFile` and `createFileInspector`. An `isExecutableFile` helper does not exist
// there and should not — that rule belongs to the locator, which supplies it as a default beside the tests that prove it.
// `createFileInspector` is here for the opposite reason: it *is* a machine concern, and the alternative is a duplicate of
// it living in the project layer.
import { createFileInspector, writeNewFile } from "../core/filesystem/index.js";
import {
  createLogger,
  isLogLevel,
  LOG_LEVELS,
  resolveLogLevel,
  type LogLevel,
} from "../core/logging/index.js";
import { createInitialisationService } from "../init/index.js";
import { InMemoryExecutionRepository } from "../persistence/index.js";
import {
  assessProject,
  diagnoseProject,
  discoverProject,
  resolveWorkingDirectory,
} from "../project/index.js";
// The PATH scan is a project-layer factory because it encodes the resolution rules a package-manager question depends on:
// PATH only, no `node_modules/.bin`, no empty or relative segment, and what counts as an executable file. Called with no
// arguments it uses its own filesystem probe, so this file names the factory and nothing else about it.
import { createPathLocator } from "../project/package-manager/index.js";
// Reads QAT's own manifest, resolved from the installed package rather than from the working directory — `qat doctor` runs
// inside a user's project, so `cwd/package.json` holds a manifest that has nothing to do with what *this* build supports.
// Not imported from `shared/utils/version.js`: that module interprets version strings and owns no I/O.
import { readOwnManifest } from "../shared/utils/package-manifest.js";

import type { ApplicationOptions } from "./contracts.js";

/**
 * Assembles an application.
 *
 * Synchronous on purpose: nothing here is awaited. A repository that opens a database file will make this asynchronous,
 * and the only caller is the entry point — one line to change, which is cheaper than a signature claiming to wait when it
 * does not.
 *
 * _@throws_ {InvalidArgumentError} when the log level is not one of the known levels.
 */
export function createApplication(
  options: ApplicationOptions = {},
): Application {
  const environment = options.environment ?? process.env;

  const logger = createLogger({
    level: resolveLevel(options.logLevel, environment),
    component: "qat",
    ...(options.logDestination === undefined
      ? {}
      : { destination: options.logDestination }),
  });

  const repository = options.repository ?? new InMemoryExecutionRepository();

  /**
   * The supported runtime range, read once from the package's own declaration.
   *
   * `qatRuntimeRequirement` freezes what it builds and refuses to substitute a default for a missing field: an unknown
   * policy must stay unknown so a check can report it. Nothing downstream re-reads the manifest, and nothing downstream
   * restates the range — which is what makes "change the supported version" a one-line change in one file.
   *
   * The reader returns `undefined` when the manifest is missing or unreadable, and the requirement treats that the same as
   * a manifest that declares no `engines.node`: an empty range that the check reports. That is deliberate — a broken
   * installation should produce a warning on `qat doctor`, which is the command a user runs *because* something is wrong,
   * not a crash from it.
   *
   * No import of `PackageManifest` here: the function takes the structural shape, so this file depends on the reader and
   * the policy, and not on the document's type as well.
   *
   * Overridable so a test can drive the whole boundary matrix without editing `package.json`. That seam exists for the same
   * reason `repository` and `environment` do: assembly is the only place that names real things, so it is also the only
   * place that has to be told about fakes.
   */
  const nodeRequirement: VersionRequirement =
    options.nodeRequirement ?? qatRuntimeRequirement(readOwnManifest());

  /**
   * The running interpreter, behind its port.
   *
   * One property read, no child process: a spawn would report whichever `node` happened to be first on `PATH`, which is not
   * necessarily the binary executing this code. Diagnostics must describe the runtime the user is actually in — and a probe
   * that reported the wrong one would be worse than no probe, because the message would be confident.
   */
  const runtime: RuntimeProbe = options.runtime ?? createProcessRuntime();

  /**
   * Where a tool lives, behind its port.
   *
   * Assigned directly: the factory returns an implementation whose method is already named `locateExecutable`, so there is
   * nothing to rename and no wrapper to write. Constructing it once here matters — the factory closes over the PATH value,
   * the platform and its filesystem probe, so building it per call would re-read the environment on every lookup and two
   * lookups within one run could answer differently.
   *
   * Called with no arguments, so the locator's own default probe decides what "an executable file" means on this platform —
   * including the Windows case, where the executable bit is not a meaningful concept and requiring it would reject every
   * legitimate `.cmd` shim.
   *
   * The port is the only seam. A second option for the locator would let a test replace the implementation while keeping a
   * different one behind the port, which is a combination with no meaning.
   *
   * Overridable for the same reason as `runtime`: a test that exercised a real PATH would be testing the machine it happens
   * to run on rather than the code.
   */
  const executables: ExecutableLocator =
    options.executables ?? createPathLocator();

  /**
   * What is on disk, behind its port.
   *
   * Assigned directly, like the two above: `createFileInspector()` returns an object whose three methods are already named
   * `inspect`, `resolveRealPath` and `readPrefix`, so an adapter here would be a second name for the same thing.
   *
   * Read-only by construction, and the factory is core's rather than the project layer's — see the note at the top of this
   * file. Constructing it once matters for the same reason it matters for the locator: the factory closes over its own
   * filesystem probe, and a per-call construction would make two inspections within one run answer differently.
   *
   * Overridable so the snapshot matrix can be driven from values rather than from a temporarily mangled directory tree:
   * unreadable, oversize, a symlink escaping the project, a directory occupying a configuration path. Testing those against
   * a real filesystem would test the machine the suite happens to run on.
   */
  const files: FileInspector = options.files ?? createFileInspector();

  const configuration: ConfigurationResolver = {
    resolve: (projectRoot, loaded) => {
      // No assertion here, and that is worth a sentence rather than a shrug: core's structural
      // `LoadedConfigurationDocument` happens to be assignable to the resolver's branded type, so the two vocabularies
      // meet without a cast. What keeps that safe is not the compiler but the marker — `resolveConfiguration` checks it at
      // runtime, so a hand-built `{ source, document }` that satisfies the structural type is refused there, inside the
      // stage that needs the guarantee.
      //
      // Re-branding such a value with `markLoaded` to "make it valid" would be the wrong repair, and the tempting one: it
      // would make this factory a second place able to declare a document loaded, which is precisely what the marker
      // exists to prevent.
      const resolution = resolveConfiguration({ loaded, projectRoot });

      if (!resolution.ok) {
        return { ok: false, findings: resolution.issues.map(toFinding) };
      }

      const { paths } = resolution.resolved;

      return {
        ok: true,
        // Renaming `cypressConfigFile` to `frameworkConfigFile` is not cosmetic: core names the concept and never the
        // framework, which is the same rule that keeps this file from mentioning Cypress anywhere. Two extra fields on
        // `ResolvedPath` are dropped rather than carried, because `form` and `withinProjectRoot` describe how the anchor
        // was decided — a detail for the resolver and its tests, not for a writer.
        configuration: {
          reportsDirectory: paths.reportsDirectory,
          evidenceDirectory: paths.evidenceDirectory,
          ...(paths.cypressConfigFile === undefined
            ? {}
            : { frameworkConfigFile: paths.cypressConfigFile }),
          environment: resolution.resolved.defaultEnvironment,
        },
        findings: resolution.issues.map(toFinding),
      };
    },
  };

  /**
   * Attach the project's resolved configuration to its assessment.
   *
   * `assess` answers "may I act on this project", and where output would land is part of that answer — so the read happens
   * here rather than in the command, which stays at one call. It is also the same tree the assessment already touched: one
   * pass, one answer.
   *
   * Three outcomes, and only one of them attaches anything:
   *
   * - no configuration file — a project that has not been initialised, which is a legitimate state. Absence means "not
   *   known", not "the usual place", and the report then says nothing rather than inventing a location.
   * - a file that exists but cannot be used — also no attachment, for now. Reporting it as a finding needs the loader's
   *   diagnostics merged into the gate, which changes the exit status and therefore deserves its own decision.
   * - a resolved configuration — attached, so every consumer of an assessment sees the same anchors the command printed.
   */
  async function withConfiguration(
    root: string,
    assessment: ProjectAssessment,
  ): Promise<ProjectAssessment> {
    const loaded = await loadConfiguration(join(root, CONFIG_FILE_NAME));

    if (loaded.kind !== ConfigurationLoad.Loaded) return assessment;

    const resolution = configuration.resolve(root, loaded.config);

    return resolution.ok
      ? { ...assessment, configuration: resolution.configuration }
      : assessment;
  }

  const discovery: ProjectDiscovery = {
    // Wrapped rather than assigned directly, so only the port's one-argument shape is exposed. The implementation also
    // accepts a process directory for tests; nothing outside a test has any business supplying one.
    resolveWorkingDirectory: (candidates) =>
      resolveWorkingDirectory(candidates),

    // The second parameter is the search depth, which is a test seam rather than something a command should tune — the
    // engine's default is the right answer for every real caller, and exposing it here would make a constant into a
    // decision each command has to make.
    diagnose: (root) => diagnoseProject(root),

    // Bound beside `diagnose` rather than folded into it because the two answer different questions, and because a command
    // that only wants a report should not be charged for a verdict it will not read. The assessment embeds the diagnosis,
    // so nothing is gathered twice — and it embeds the resolved configuration for the same reason: a report that could not
    // say where a run would write would be answering a narrower question than it claims to.
    assess: async (root) => withConfiguration(root, await assessProject(root)),

    // The port takes a directory; the function takes options. Adapting here rather than widening either keeps the port
    // shaped like the thing it describes.
    discover: (root) => discoverProject({ cwd: root }),
  };

  /**
   * Creating a project's configuration.
   *
   * Three existing operations, named here and nowhere else, and all three are handed over unchanged:
   *
   * - `assessProject` — the plain assessment, because initialisation reads no output locations. The enriched one from
   *   `discovery.assess` would read the configuration file a second time to attach a field this workflow never looks at,
   *   and the gate it does read is identical either way.
   * - `loadConfiguration` — takes a path, answers whether one is usable. Exactly what the workflow asks for.
   * - `writeNewFile` — takes a path and contents, reports whether it created the file or found one. Also exactly what the
   *   workflow asks for, including the answer rather than only the effect.
   *
   * None of the three needs an adapter, and none gets one. Each implementation's declared type is wider than the
   * workflow's — the optional second parameters are test seams — so the narrower type on the dependency is what keeps them
   * out of reach. That is the same narrowing the ports achieve by wrapping, obtained for free from the signature; an
   * adapter here would be a second name for the same function. If one of them ever needs a translation, that is the moment
   * to wrap it, and the moment will be visible as a type error rather than as a judgement call.
   *
   * `writeNewFile` is the create-only half of a module that also knows how to replace, and the type is what enforces the
   * distinction: `replaceFileWithBackup` returns different outcomes and demands a hash of the content it is replacing, so it
   * cannot be bound to this dependency at all. Replacement is not withheld from initialisation by discipline; it does not
   * fit.
   */
  const initialisation = createInitialisationService({
    assess: assessProject,
    readConfiguration: loadConfiguration,
    createFile: writeNewFile,
  });

  let disposed = false;

  return {
    logger,
    repository,
    discovery,
    configuration,
    initialisation,

    // All four pieces of compatibility and inspection evidence, exposed rather than combined here: the probe answers "what
    // is running", the requirement answers "what is required", the locator answers "where is the tool", and the inspector
    // answers "what is actually on disk". Whoever gathers facts pairs them into the shapes a check reads, because that
    // pairing is a gathering decision — this file supplies the inputs and takes no view on how a particular check shapes
    // them.
    runtime,
    nodeRequirement,
    executables,
    files,

    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;

      // Reverse construction order. The logger goes last, so anything the repository would want to report on the way down
      // still has somewhere to go.
      //
      // `finally` rather than a bare sequence: a shutdown that throws from `close()` must still flush, because the buffered
      // line explaining *why* close failed is the one worth keeping. The error still propagates — the caller decides
      // whether a failed close is worth failing the process over — but it can no longer take the log with it.
      try {
        await repository.close();
      } finally {
        logger.flush();
      }
    },
  };
}

/**
 * Resolves the effective log level, refusing a bad flag rather than falling back.
 *
 * The shared resolver deliberately ignores an invalid value from either source, because the environment is not a place to
 * fail a run. A flag is different: it was typed for this invocation, and quietly using a different level than the one asked
 * for is exactly the kind of wrongness this project spends effort avoiding.
 */
function resolveLevel(
  flag: string | undefined,
  environment: EnvironmentSource,
): LogLevel {
  if (flag !== undefined && !isLogLevel(flag)) {
    throw new InvalidArgumentError(
      ErrorCode.invalidArgument,
      `Unknown log level ${flag}.`,
      {
        context: { supplied: flag, supported: LOG_LEVELS.join(", ") },
        // `remediation`, matching every other error construction in the project. `remedy` was a guess at the option name and
        // the type checker was right to refuse it.
        remediation: `Use one of: ${LOG_LEVELS.join(", ")}.`,
      },
    );
  }

  return resolveLogLevel({ flag, environment: environment["QAT_LOG_LEVEL"] });
}

/**
 * Presents a resolver finding in the application's diagnostic vocabulary.
 *
 * The code is carried unchanged rather than prefixed: it is already a permanent identifier for the rule that refused the
 * value, and rewriting it here would give the same rule two names depending on which layer reported it.
 *
 * `remediation` rather than `remedy`, so this finding and a schema diagnostic read the same way to whoever renders them —
 * the CLI should not have to know which layer produced a message in order to find the advice beside it.
 */
function toFinding(issue: PathIssue): ConfigurationFinding {
  return {
    code: issue.code,
    path: issue.field,
    message: issue.message,
    ...(issue.hint === undefined ? {} : { remediation: issue.hint }),
  };
}
