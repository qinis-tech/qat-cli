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
 * of the function. They are imported where they are used — including by the gatherer that runs a bounded loader probe.
 *
 * The same is true of the filesystem helpers a *workflow* uses: detection, the path resolver and the configuration
 * inspector all call stateless functions directly, and none of them needs an assembly decision.
 *
 * What *is* adapted here is only what a port's shape requires. The port has ten members; seven need an adaptation and
 * three need none, and those seven fall into four kinds:
 *
 * | Port member | Implementation | Adaptation |
 * | --- | --- | --- |
 * | `resolveWorkingDirectory(candidates)` | `resolveWorkingDirectory(candidates, processDirectory?)` | Narrowed — the second argument is a test seam |
 * | `diagnose(root)` | `diagnoseProject(root, options?)` | Narrowed — the search depth is a test seam |
 * | `assess(root)` | `assessProject(root, options?)`, then the resolved configuration | Narrowed *and* composed |
 * | `discover(root)` | `discoverProject({ cwd: root })` | Reshaped — the function takes options |
 * | `configuration.resolve(root, loaded)` | `resolveConfiguration({ loaded, projectRoot })` | Reshaped, and the result translated into the port's own vocabulary |
 * | `configuration.inspect(root)` | `inspectConfiguration(root, deps)`, then `toPortInspection` | **Composed and translated** — one memoised read, six states re-expressed in core's vocabulary |
 * | `initialisation.initialise(root)` | `createInitialisationService({ assess, readConfiguration, createFile })` | Composed — three existing operations, assigned directly |
 * | `runtime.readNodeVersion()` | `createProcessRuntime()` | **None** — the factory *is* the implementation |
 * | `executables.locateExecutable(command)` | `createPathLocator()` | **None** — the factory's method carries the port's name |
 * | `files.inspect` / `resolveRealPath` / `readPrefix` | `createFileInspector()` | **None** — three methods named exactly as the port names them |
 *
 * The rule worth keeping: **narrow a test seam, reshape an argument, translate a vocabulary, or compose a workflow —
 * and know which of them you are doing.** A member that needed none of them is assigned directly rather than wrapped for
 * symmetry, because an adapter with no translation in it is a second name for the same thing.
 *
 * ## Why the health checks are not assembled here
 *
 * The catalogue is static data — a keyed table of definitions, each a pure function of the evidence it declared a need for
 * — so there is nothing for a factory to build and nothing to inject. What assembly supplies is the *evidence*: the
 * running interpreter, the range this build declares, the tool locator, the file inspector and the configuration
 * inspection. Injecting a requirement into a check would make every definition a closure over policy, and then the same
 * catalogue entry would behave differently depending on who constructed it.
 *
 * ## Where the supported Node.js range comes from
 *
 * From the package's own declaration, read once, and exposed as a value. Nowhere else. The manifest's `engines.node` is
 * the single authority: it is the field a package manager already enforces on install, it travels with the published
 * artefact, and it is the one place a release changes when the supported runtime changes.
 *
 * Four consequences, all decisions rather than omissions:
 *
 * - Read from **this installation**, never from the working directory — `qat doctor` runs inside a user's project, so
 *   `cwd/package.json` is a stranger's manifest.
 * - A **missing** declaration does not throw and does not acquire a default: the requirement is built with an empty range
 *   and the check reports it, so a broken installation produces a warning rather than a crash.
 * - Resolved **once per process** and frozen by its builder, so two findings cannot disagree about "supported".
 * - **Not** pushed into the checks: the range reaches them through `RuntimeFacts.required`, so the value a check compares
 *   against is the value the guidance table quotes back.
 *
 * ## Where tooling evidence comes from
 *
 * One machine fact — where, if anywhere, a command lives. Three consequences: **PATH only** (a project-local directory is
 * writable by any install, so resolving a tool there would run project-controlled code to learn its name); the **check is
 * composed elsewhere** (which command to look for depends on project evidence); and **"is this file executable" is the
 * locator's rule**, supplied as its own default beside the tests that prove it.
 *
 * ## Where filesystem evidence comes from
 *
 * Read-only by construction: no write member exists, so a diagnostic built on it cannot modify the project it is
 * diagnosing. The one writer — `initialisation` — is deliberately a separate port, because a single object offering both
 * would make "which of these can change my repository" a question a reader has to answer from memory.
 *
 * ## Where the configuration verdict comes from
 *
 * The doctor asks two questions about QAT's own configuration — can it be read, and does it conform to a schema we
 * support — and they must be answered about the same bytes. So the pipeline is composed **once**, behind a facade that
 * returns a six-state verdict instead of throwing:
 *
 * - **One read per project root per run.** The memo caches the *promise*, not the result, so two callers starting at once
 *   share one read rather than racing to produce two.
 * - **The loader's failure vocabulary is translated, not re-derived.** `loadConfiguration` already knows *why* it failed —
 *   empty, malformed with a location, oversized, absent — so the adapter converts that into a
 *   `ConfigurationLoadFailure`, and the facade classifies a reason instead of inferring one.
 * - **The bundle is projected once, and this is the subtle one.** Loading hands over the document *plus* the provenance
 *   that proves it was loaded: a source path and a marker. The version gate and the schema judge the **document** and
 *   refuse the bundle — a schema handed `{ source, document }` reports every required field as missing, and a gate handed
 *   one reads `undefined` and skips itself. Both failures are silent, both produce a plausible-looking report, and the
 *   only defence is that the projection is a declared dependency (`documentOf`) rather than an assumption about the
 *   loader's shape. It is supplied here because this is the only layer that knows the loader.
 * - **The locator is one name at one place.** `CONFIG_FILE_NAME`, imported rather than restated.
 * - **The states are re-expressed at the seam.** The facade speaks the configuration module's vocabulary — errno-style
 *   access codes, structured issue paths; core must not depend on that module. `toPortInspection` is the one function
 *   allowed to know both, and it is the price of the dependency direction paid once.
 * - **Absence stays absence.** An uninitialised project is a supported state, so `assess` attaches nothing. What changes
 *   is that a file which exists and is broken is now *distinguishable* from that state — the difference between "not
 *   configured" and "configured incorrectly".
 *
 * ## One seam per port, never one per object
 *
 * `executables` is the only test seam for tooling, and `files` the only one for inspection. An option for the
 * implementation as well would let a caller swap the factory *without* swapping the port, which is a configuration with
 * no meaning: the port is what the workflow asks, and the implementation is what it happens to have.
 */

import { join } from "node:path";

import {
  CONFIG_FILE_NAME,
  ConfigurationLoadFailure,
  inspectConfiguration,
  resolveConfiguration,
  SUPPORTED_CONFIG_VERSION,
  type ConfigInspection,
  type InaccessibleConfig,
  type PathIssue,
  type SchemaInvalidConfig,
} from "../config/index.js";
import {
  ConfigurationLoad,
  loadConfiguration,
} from "../config/loader/index.js";
import {
  validateConfiguration,
  type ConfigurationDiagnostic,
} from "../config/validation/index.js";
import type {
  ConfigurationAccessCode,
  ConfigurationFinding,
  ConfigurationInspection,
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
// The widened name, because there is now only one. The runtime-era alias in `core/compatibility` survives only so that
// call sites in flight keep compiling; using it here would keep a second vocabulary alive in the one file whose job is to
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
import { createPathLocator } from "../project/package-manager/index.js";
import { readOwnManifest } from "../shared/utils/package-manifest.js";

import type { ApplicationOptions } from "./contracts.js";

/**
 * What the loader hands back.
 *
 * Derived from the resolver that consumes it, because two things must be the *same type* rather than merely similar:
 * the facade's document parameter and the resolver's parameter. This is the **bundle** — the document plus the provenance
 * that proves it was loaded — and it is deliberately not the same thing as the document inside it.
 */
type LoadedDocument = Parameters<typeof resolveConfiguration>[0]["loaded"];

/** The resolved-configuration payload, derived the same way. */
type ResolvedConfiguration = Extract<
  ReturnType<typeof resolveConfiguration>,
  { ok: true }
>["resolved"];

/** The configuration shape the application port publishes, taken from the contract itself. */
type PortConfiguration = Extract<
  ReturnType<ConfigurationResolver["resolve"]>,
  { ok: true }
>["configuration"];

/**
 * The façade's access vocabulary, taken from the state that carries it.
 *
 * Derived rather than imported because `ConfigAccessCode` is not part of the published surface, and a permanent name for
 * a shape exactly one adapter reads is a name that has to be maintained for no consumer.
 */
type ConfigAccessCode = InaccessibleConfig["code"];

/**
 * The façade's issue shape, taken from the state that carries it.
 *
 * Same reasoning: `SchemaInvalidConfig["issues"][number]` cannot describe a different shape from the one the inspection
 * actually carries, because it is read off the inspection's own type.
 */
type ConfigIssue = SchemaInvalidConfig["issues"][number];

/**
 * Assembles an application.
 *
 * Synchronous on purpose: nothing here is awaited. A repository that opens a database file will make this asynchronous,
 * and the only caller is the entry point — one line to change.
 *
 * @throws {InvalidArgumentError} when the log level is not one of the known levels.
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
   * Frozen by its builder, and refusing to substitute a default for a missing field: an unknown policy must stay unknown
   * so a check can report it. Overridable so a test can drive the whole boundary matrix without editing `package.json`.
   */
  const nodeRequirement: VersionRequirement =
    options.nodeRequirement ?? qatRuntimeRequirement(readOwnManifest());

  /**
   * The running interpreter, behind its port.
   *
   * One property read, no child process: a spawn would report whichever `node` happened to be first on `PATH`, which is
   * not necessarily the binary executing this code.
   */
  const runtime: RuntimeProbe = options.runtime ?? createProcessRuntime();

  /**
   * Where a tool lives, behind its port. Constructed once, because the factory closes over the PATH value, the platform
   * and its filesystem probe — per-call construction would let two lookups in one run answer differently.
   */
  const executables: ExecutableLocator =
    options.executables ?? createPathLocator();

  /** What is on disk, behind its read-only port. */
  const files: FileInspector = options.files ?? createFileInspector();

  /**
   * One inspection per project root, for the lifetime of this application.
   *
   * The *promise* is cached rather than the eventual value: two callers starting at once share the same in-flight read
   * instead of racing to produce two. Typed in the port's vocabulary, because that is what a consumer sees.
   */
  const inspections = new Map<string, Promise<ConfigurationInspection>>();

  const configuration: ConfigurationResolver = {
    resolve: (projectRoot, loaded) => {
      // No assertion here: core's structural `LoadedConfigurationDocument` is assignable to the resolver's branded
      // type, so the two vocabularies meet without a cast. What keeps that safe is not the compiler but the marker —
      // `resolveConfiguration` checks it at runtime, so a hand-built look-alike is refused there, inside the stage that
      // needs the guarantee. Re-branding such a value to "make it valid" would make this factory a second place able to
      // declare a document loaded, which is exactly what the marker prevents.
      const resolution = resolveConfiguration({ loaded, projectRoot });

      if (!resolution.ok) {
        return { ok: false, findings: resolution.issues.map(toFinding) };
      }

      return {
        ok: true,
        configuration: toPortConfiguration(resolution.resolved),
        findings: resolution.issues.map(toFinding),
      };
    },

    /** The composed verdict: locate, load, gate on version, validate, resolve — once, then translated. */
    inspect: (projectRoot) => {
      const cached = inspections.get(projectRoot);
      if (cached !== undefined) return cached;

      const pending = inspectConfiguration<
        LoadedDocument,
        ResolvedConfiguration
      >(projectRoot, {
        /**
         * Discovery for QAT's configuration is one name at the project root, with no ascent into a parent directory
         * and no second candidate list. That contract is `CONFIG_FILE_NAME`, imported rather than restated, so a
         * locator here is a join rather than a search — and it is synchronous, because a join does no I/O.
         */
        locator: {
          locate: (root) => ({ path: join(root, CONFIG_FILE_NAME) }),
        },

        /**
         * Translated: the loader returns an outcome union, not an exception; the facade classifies instead. Each
         * member becomes a `ConfigurationLoadFailure` so the reason the loader already knew survives the crossing.
         *
         * `value` is the **bundle** — `{ source, document }` — because that is what the resolver downstream requires
         * and because the facade must not learn the loader's field names. `documentOf` below is how the gate and the
         * schema get at the document inside it.
         */
        loader: {
          load: async (path) => {
            const outcome = await loadConfiguration(path);

            switch (outcome.kind) {
              case ConfigurationLoad.Loaded:
                return { value: outcome.config };

              case ConfigurationLoad.NotFound:
                throw new ConfigurationLoadFailure("ENOENT");

              case ConfigurationLoad.Empty:
                throw new ConfigurationLoadFailure("EMPTY");

              case ConfigurationLoad.TooLarge:
                throw new ConfigurationLoadFailure("TOO_LARGE");

              case ConfigurationLoad.Malformed:
                throw new ConfigurationLoadFailure(
                  "MALFORMED",
                  outcome.location.line,
                  outcome.location.column,
                );

              case ConfigurationLoad.Invalid:
                // Not reachable in practice: the facade validates after loading. Handled explicitly rather than
                // defaulted so a loader that ever validates early fails visibly here instead of masquerading as a
                // syntax error.
                throw new ConfigurationLoadFailure("MALFORMED");
            }
          },
        },

        /**
         * The projection, and the one line this assembly exists to get right.
         *
         * The version gate reads `version` off whatever this returns, and the schema parses it. Both judge a
         * *document*; the loader hands over a bundle. Handing the bundle to either is silent — the gate finds no
         * version and skips itself, the schema reports every required field as missing — so the projection is a
         * declared dependency rather than a habit, and it is supplied here because this is the only layer that knows
         * the loader's shape.
         */
        documentOf: (loaded) => loaded.document,

        /**
         * Translated again, in the other direction: validation publishes a discriminated verdict, the facade speaks
         * `ConfigIssue`.
         *
         * The union is read rather than assumed. `ConfigurationValidation` is
         * `{ valid: true; config } | { valid: false; diagnostics }`, so reaching for `diagnostics` unconditionally
         * does not merely risk an undefined — it reads a field that the successful branch does not have. An accepted
         * document produces no issues, and an empty list is this port's way of saying so.
         *
         * The parameter is the *projected document*, not the bundle: the project above already unwrapped it, and
         * unwrapping twice would be a second place that knows what a bundle looks like.
         *
         * `config` on the successful branch is deliberately dropped. It is the schema-defaulted document, and
         * resolution applies the same defaults to the same input; carrying it through would mean the facade owning a
         * validated-and-resolved document, which is a larger change than this adapter should make.
         */
        verifier: {
          verify: (document) => {
            const result = validateConfiguration(document);

            if (result.valid) return { issues: [] };

            return { issues: result.diagnostics.map(toIssue) };
          },
        },

        /**
         * Reshaped, and reused: the same call the `resolve` member above makes, so a caller that inspects and a
         * caller that resolves cannot arrive at different anchors for the same file. This one takes the bundle, which
         * is what the resolver is branded to accept.
         */
        resolver: {
          resolve: (document) => {
            const resolution = resolveConfiguration({
              loaded: document,
              projectRoot,
            });

            if (!resolution.ok) {
              // A failure here is an internal inconsistency, not a user condition: the document already passed
              // validation, so failing now is a defect in this program. Throwing keeps it visible rather than
              // reporting it as a schema problem nobody can fix.
              throw new Error(
                "Configuration resolved after validation failed.",
              );
            }

            return resolution.resolved;
          },
        },

        // Wrapped, not replaced: the schema module owns the version, this array is the gate's vocabulary. A legacy
        // version joining the set is a change to this line's *contents*, not to any signature.
        supportedVersions: [SUPPORTED_CONFIG_VERSION],
      }).then(toPortInspection);

      inspections.set(projectRoot, pending);

      return pending;
    },
  };

  /**
   * Attach the project's resolved configuration to its assessment.
   *
   * It goes through `configuration.inspect` rather than the loader directly, so the assessment and the doctor describe
   * **the same read** of the same file. Only a usable configuration attaches anything: an uninitialised project is a
   * supported state, and a broken file is distinguishable in the inspection and reported by the doctor's own checks —
   * merging its findings into the assessment gate would change the exit status of every command, which deserves its own
   * decision.
   */
  async function withConfiguration(
    root: string,
    assessment: ProjectAssessment,
  ): Promise<ProjectAssessment> {
    const inspection = await configuration.inspect(root);

    // No cast: `toPortInspection` already put the payload in the port's vocabulary, so the valid branch hands back
    // exactly what an assessment carries.
    return inspection.state === "valid"
      ? { ...assessment, configuration: inspection.configuration }
      : assessment;
  }

  const discovery: ProjectDiscovery = {
    // Wrapped rather than assigned directly, so only the port's one-argument shape is exposed. The implementation also
    // accepts a process directory for tests; nothing outside a test has any business supplying one.
    resolveWorkingDirectory: (candidates) =>
      resolveWorkingDirectory(candidates),

    // The second parameter is the search depth, a test seam rather than something a command should tune — exposing it
    // would make a constant into a decision each command has to make.
    diagnose: (root) => diagnoseProject(root),

    // Bound beside `diagnose` because the two answer different questions, and a command that only wants a report should
    // not be charged for a verdict it will not read.
    assess: async (root) => withConfiguration(root, await assessProject(root)),

    // The port takes a directory; the function takes options.
    discover: (root) => discoverProject({ cwd: root }),
  };

  /**
   * Creating a project's configuration.
   *
   * Three existing operations, handed over unchanged. None needs an adapter: each implementation's declared type is
   * wider than the workflow's — the optional second parameters are test seams — so the narrower type on the dependency is
   * what keeps them out of reach. `writeNewFile` is the create-only half of a module that also knows how to replace, and
   * `replaceFileWithBackup` demands a hash of the content it replaces, so it cannot be bound here at all: replacement is
   * not withheld from initialisation by discipline, it does not fit.
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

    // Compatibility and inspection evidence, exposed rather than combined: the probe answers "what is running", the
    // requirement answers "what is required", the locator answers "where is the tool", and the inspector answers "what is
    // actually on disk". Whoever gathers facts pairs them into the shapes a check reads, because that pairing is a
    // gathering decision — this file supplies the inputs and takes no view on how a check shapes them.
    runtime,
    nodeRequirement,
    executables,
    files,

    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;

      // Reverse construction order. The logger goes last, so anything the repository would want to report on the way down
      // still has somewhere to go. `finally` rather than a bare sequence: a shutdown that throws from `close()` must
      // still flush, because the buffered line explaining *why* close failed is the one worth keeping.
      try {
        await repository.close();
      } finally {
        inspections.clear();
        logger.flush();
      }
    },
  };
}

/* ------------------------------------------------------------------------- *
 * Boundary translation
 * ------------------------------------------------------------------------- */

/**
 * Re-expresses an inspection in core's vocabulary.
 *
 * The two sides deliberately use different words, and this is the only function allowed to know both:
 *
 * - **Access codes.** The configuration module reports the platform's errno names; core publishes reasons a reader can act
 *   on. `TOO_LARGE` and `UNKNOWN` both land on `io-error` — the first because "the file is bigger than the reader" is not
 *   a permission question, the second because we genuinely do not know, and inventing a cause would be worse.
 * - **Issue paths.** The schema library reports structured paths in the façade; core publishes the dotted form a command
 *   prints. Joining here keeps the structure available below and the string available above.
 * - **The resolved configuration.** The valid branch carries it already anchored, so a consumer never re-resolves.
 */
function toPortInspection(
  inspection: ConfigInspection<ResolvedConfiguration>,
): ConfigurationInspection {
  switch (inspection.state) {
    case "missing":
      return { state: "missing", searchedAt: inspection.searchedAt };

    case "inaccessible":
      return {
        state: "inaccessible",
        path: inspection.path,
        code: toAccessCode(inspection.code),
      };

    case "malformed":
      return {
        state: "malformed",
        path: inspection.path,
        ...(inspection.line === undefined ? {} : { line: inspection.line }),
        ...(inspection.column === undefined
          ? {}
          : { column: inspection.column }),
      };

    case "version-unsupported":
      return {
        state: "version-unsupported",
        path: inspection.path,
        declared: inspection.declared,
        supported: inspection.supported,
      };

    case "schema-invalid":
      return {
        state: "schema-invalid",
        path: inspection.path,
        version: inspection.version,
        issues: inspection.issues.map(toIssueFinding),
      };

    case "valid":
      return {
        state: "valid",
        path: inspection.path,
        version: inspection.version,
        configuration: toPortConfiguration(inspection.config),
      };
  }
}

/** Maps the platform's access vocabulary onto the reasons a reader can act on. */
function toAccessCode(code: ConfigAccessCode): ConfigurationAccessCode {
  switch (code) {
    case "EACCES":
    case "EPERM":
      return "permission-denied";
    case "EISDIR":
    case "ENOTDIR":
      return "not-a-file";
    case "ELOOP":
      return "link-loop";
    case "AMBIGUOUS":
      return "ambiguous";
    // TOO_LARGE and UNKNOWN: we know something went wrong and not which permission question it was, so the honest
    // answer is the general one.
    default:
      return "io-error";
  }
}

/**
 * One validation diagnostic, in the facade's issue shape.
 *
 * The route back from a dotted path to a path array, because the two stages genuinely disagree about the shape: the
 * schema library reports structure, the façade wants structure, and core wants a string. Splitting on the dot is the
 * inverse of the join in `toIssueFinding` — the two functions are a pair and should be read together.
 */
function toIssue(diagnostic: ConfigurationDiagnostic): ConfigIssue {
  return {
    code: diagnostic.code,
    message: diagnostic.message,
    path: diagnostic.path === "" ? [] : diagnostic.path.split("."),
  };
}

/**
 * One facade issue, in core's finding shape.
 *
 * No `remediation` is attached: the sentence the schema layer wrote is carried as-is, and inventing advice here would give
 * one problem two wordings.
 */
function toIssueFinding(issue: ConfigIssue): ConfigurationFinding {
  return {
    code: issue.code,
    path: issue.path.length === 0 ? "<root>" : issue.path.join("."),
    message: issue.message,
  };
}

/**
 * Translates the resolver's output into the port's vocabulary.
 *
 * Two renames and one omission: `cypressConfigFile` becomes `frameworkConfigFile` (core names the concept and never the
 * framework); `form` and `withinProjectRoot` are dropped, because they describe how the anchor was decided — a detail for
 * the resolver and its tests, not for a writer.
 *
 * Extracted rather than written twice because it has three callers: the resolver port, the inspection adapter and the
 * attach step. Three copies of a rename is three places for the next field to be forgotten.
 */
function toPortConfiguration(
  resolved: ResolvedConfiguration,
): PortConfiguration {
  const { paths } = resolved;

  return {
    reportsDirectory: paths.reportsDirectory,
    evidenceDirectory: paths.evidenceDirectory,
    ...(paths.cypressConfigFile === undefined
      ? {}
      : { frameworkConfigFile: paths.cypressConfigFile }),
    environment: resolved.defaultEnvironment,
  };
}

/**
 * Resolves the effective log level, refusing a bad flag rather than falling back.
 *
 * The shared resolver deliberately ignores an invalid value from either source, because the environment is not a place to
 * fail a run. A flag is different: it was typed for this invocation, and quietly using a different level is exactly the
 * kind of wrongness this project spends effort avoiding.
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
 * value, and rewriting it would give the same rule two names depending on which layer reported it.
 */
function toFinding(issue: PathIssue): ConfigurationFinding {
  return {
    code: issue.code,
    path: issue.field,
    message: issue.message,
    ...(issue.hint === undefined ? {} : { remediation: issue.hint }),
  };
}
