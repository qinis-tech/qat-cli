/**
 * The composition root.
 *
 * The only place in the program that names an implementation. Everything else declares what it needs and receives
 * it, which is what makes a service testable without a database, a terminal or a clock — and what makes this file
 * the single place to look when the question is "where does this come from".
 *
 * The shape it returns is declared in `core/application/ports`, not here: a command handler receives a contract, and
 * depending on the assembly's own type would make the CLI depend on what builds it.
 *
 * ## Why this is not in `src/cli`
 *
 * It was, in the architecture as first written: `src/cli/index.ts` was both the entry point and the assembler. Those
 * are different jobs. The entry point parses arguments, installs signal handlers and sets an exit code — all of
 * which happens on import, so any test that wanted to check the wiring would have launched the CLI. Assembly has no
 * such side effects and can be called freely.
 *
 * ## What is deliberately not constructed
 *
 * The filesystem and process helpers are modules of functions with no state. Wrapping them in objects so that
 * something can be "constructed" would add a layer that exists only to be injected, and every caller would then need
 * the wrapper instead of the function. They are imported where they are used.
 *
 * What *is* adapted here is only what the port's shape requires, and the five adaptations are one of three kinds:
 *
 * | Port member | Implementation | Adaptation |
 * | --- | --- | --- |
 * | `resolveWorkingDirectory(candidates)` | `resolveWorkingDirectory(candidates, processDirectory?)` | Narrowed — the second argument is a test seam |
 * | `diagnose(root)` | `diagnoseProject(root, options?)` | Narrowed — the search depth is a test seam |
 * | `assess(root)` | `assessProject(root, options?)`, then the resolved configuration | Narrowed *and* composed — see below |
 * | `discover(root)` | `discoverProject({ cwd: root })` | Reshaped — the function takes options |
 * | `configuration.resolve(root, loaded)` | `resolveConfiguration({ loaded, projectRoot })` | Reshaped — one options object; the result is also translated into the port's own vocabulary |
 *
 * Four of the five narrow a test seam or reshape an argument. The fifth changes a value's shape. That is the rule worth
 * keeping: **narrow a test seam, reshape an argument, or translate a vocabulary — and know which of the three you are
 * doing.** A member that needed none of them should be assigned directly rather than wrapped for symmetry, because an
 * adapter with no translation in it is a second name for the same thing.
 *
 * The narrowing is deliberate rather than incidental. A command should not be able to tune the parent search depth:
 * the engine's default is right for every real invocation, and putting it on a port turns a constant into a decision
 * each command has to make — and eventually make differently. The same reasoning withholds the `defaults` argument
 * from `configuration.resolve`: it exists so a test or a future profile can substitute a table, not so a command can
 * invent one.
 *
 * `assess` is the one member that does more than pass through, and it earns the exception: where a run would write is
 * part of "may I act on this project", the question that operation already answers. Composing it here means one read of
 * one tree and one place that decides what a usable project is. A command that read the configuration itself would
 * either repeat the assessment's work or form a second opinion about it.
 *
 * ## What is still not orchestrated
 *
 * The loader's six outcomes are not published. A command that needs them — one that reports why a file could not be read
 * — calls the loader directly, where those messages are rendered. An assembly that swallowed that branch would be
 * choosing a user-visible sentence from inside a factory, which is the one thing this file refuses to do.
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
  ProjectDiscovery,
} from "../core/application/ports.js";
import type { ProjectAssessment } from "../core/application/validation.js";
import type { EnvironmentSource } from "../core/environment/index.js";
import { ErrorCode, InvalidArgumentError } from "../core/errors/index.js";
import {
  createLogger,
  isLogLevel,
  LOG_LEVELS,
  resolveLogLevel,
  type LogLevel,
} from "../core/logging/index.js";
import { InMemoryExecutionRepository } from "../persistence/index.js";
import {
  assessProject,
  diagnoseProject,
  discoverProject,
  resolveWorkingDirectory,
} from "../project/index.js";

import type { ApplicationOptions } from "./contracts.js";

/**
 * Assembles an application.
 *
 * Synchronous on purpose: nothing here is awaited. A repository that opens a database file will make this
 * asynchronous, and the only caller is the entry point — one line to change, which is cheaper than a signature
 * claiming to wait when it does not.
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

  const configuration: ConfigurationResolver = {
    resolve: (projectRoot, loaded) => {
      // No assertion here, and that is worth a sentence rather than a shrug: core's
      // structural `LoadedConfigurationDocument` happens to be assignable to the resolver's
      // branded type, so the two vocabularies meet without a cast. What keeps that safe is
      // not the compiler but the marker — `resolveConfiguration` checks it at runtime, so a
      // hand-built `{ source, document }` that satisfies the structural type is refused
      // there, inside the stage that needs the guarantee.
      //
      // Re-branding such a value with `markLoaded` to "make it valid" would be the wrong
      // repair, and the tempting one: it would make this factory a second place able to
      // declare a document loaded, which is precisely what the marker exists to prevent.
      const resolution = resolveConfiguration({ loaded, projectRoot });

      if (!resolution.ok) {
        return { ok: false, findings: resolution.issues.map(toFinding) };
      }

      const { paths } = resolution.resolved;

      return {
        ok: true,
        // Renaming `cypressConfigFile` to `frameworkConfigFile` is not cosmetic: core names
        // the concept and never the framework, which is the same rule that keeps this file
        // from mentioning Cypress anywhere. Two extra fields on `ResolvedPath` are dropped
        // rather than carried, because `form` and `withinProjectRoot` describe how the
        // anchor was decided — a detail for the resolver and its tests, not for a writer.
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
   * `assess` answers "may I act on this project", and where output would land is part of that answer — so the read
   * happens here rather than in the command, which stays at one call. It is also the same tree the assessment already
   * touched: one pass, one answer.
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
    // Wrapped rather than assigned directly, so only the port's one-argument shape is exposed. The implementation
    // also accepts a process directory for tests; nothing outside a test has any business supplying one.
    resolveWorkingDirectory: (candidates) =>
      resolveWorkingDirectory(candidates),

    // The second parameter is the search depth, which is a test seam rather than something a command should tune —
    // the engine's default is the right answer for every real caller, and exposing it here would make a constant into
    // a decision each command has to make.
    diagnose: (root) => diagnoseProject(root),

    // Bound beside `diagnose` rather than folded into it because the two answer different questions, and because a
    // command that only wants a report should not be charged for a verdict it will not read. The assessment embeds the
    // diagnosis, so nothing is gathered twice — and it embeds the resolved configuration for the same reason: a report
    // that could not say where a run would write would be answering a narrower question than it claims to.
    assess: async (root) => withConfiguration(root, await assessProject(root)),

    // The port takes a directory; the function takes options. Adapting here rather than widening either keeps the
    // port shaped like the thing it describes.
    discover: (root) => discoverProject({ cwd: root }),
  };

  let disposed = false;

  return {
    logger,
    repository,
    discovery,
    configuration,

    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;

      // Reverse construction order. The logger goes last, so anything the repository would want to report on the way
      // down still has somewhere to go.
      await repository.close();
      logger.flush();
    },
  };
}

/**
 * Resolves the effective log level, refusing a bad flag rather than falling back.
 *
 * The shared resolver deliberately ignores an invalid value from either source, because the environment is not a
 * place to fail a run. A flag is different: it was typed for this invocation, and quietly using a different level
 * than the one asked for is exactly the kind of wrongness this project spends effort avoiding.
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
        // `remediation`, matching every other error construction in the project. `remedy`
        // was a guess at the option name and the type checker was right to refuse it.
        remediation: `Use one of: ${LOG_LEVELS.join(", ")}.`,
      },
    );
  }

  return resolveLogLevel({ flag, environment: environment["QAT_LOG_LEVEL"] });
}

/**
 * Presents a resolver finding in the application's diagnostic vocabulary.
 *
 * The code is carried unchanged rather than prefixed: it is already a permanent identifier for the rule that refused
 * the value, and rewriting it here would give the same rule two names depending on which layer reported it.
 *
 * `remediation` rather than `remedy`, so this finding and a schema diagnostic read the same way to whoever renders
 * them — the CLI should not have to know which layer produced a message in order to find the advice beside it.
 */
function toFinding(issue: PathIssue): ConfigurationFinding {
  return {
    code: issue.code,
    path: issue.field,
    message: issue.message,
    ...(issue.hint === undefined ? {} : { remediation: issue.hint }),
  };
}
