/**
 * The composition root.
 *
 * The only place in the program that names an implementation. Everything else declares what it needs and
 * receives it, which is what makes a service testable without a database, a terminal or a clock — and
 * what makes this file the single place to look when the question is "where does this come from".
 *
 * The shape it returns is declared in `core/application/ports`, not here: a command handler receives a
 * contract, and depending on the assembly's own type would make the CLI depend on what builds it.
 *
 * ## Why this is not in `src/cli`
 *
 * It was, in the architecture as first written: `src/cli/index.ts` was both the entry point and the
 * assembler. Those are different jobs. The entry point parses arguments, installs signal handlers and sets
 * an exit code — all of which happens on import, so any test that wanted to check the wiring would have
 * launched the CLI. Assembly has no such side effects and can be called freely.
 *
 * ## What is deliberately not constructed
 *
 * The filesystem and process helpers are modules of functions with no state. Wrapping them in objects so
 * that something can be "constructed" would add a layer that exists only to be injected, and every caller
 * would then need the wrapper instead of the function. They are imported where they are used.
 *
 * What *is* adapted here is only what the port's shape requires: a function that takes one argument
 * instead of two, or a directory instead of an options object. An adapter with no translation in it would
 * be a second name for the same thing.
 */
import type {
  Application,
  ProjectDiscovery,
} from "../core/application/ports.js";
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
import { discoverProject, resolveWorkingDirectory } from "../project/index.js";

import type { ApplicationOptions } from "./contracts.js";

/**
 * Assembles an application.
 *
 * Synchronous on purpose: nothing here is awaited. A repository that opens a database file will make this
 * asynchronous, and the only caller is the entry point — one line to change, which is cheaper than a
 * signature claiming to wait when it does not.
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

  const discovery: ProjectDiscovery = {
    // Wrapped rather than assigned directly, so only the port's one-argument shape is exposed. The
    // implementation also accepts a process directory for tests; nothing outside a test has any business
    // supplying one.
    resolveWorkingDirectory: (candidates) =>
      resolveWorkingDirectory(candidates),

    // The port takes a directory; the function takes options. Adapting here rather than widening either
    // keeps the port shaped like the thing it describes.
    discover: (root) => discoverProject({ cwd: root }),
  };

  let disposed = false;

  return {
    logger,
    repository,
    discovery,

    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;

      // Reverse construction order. The logger goes last, so anything the repository would want to report
      // on the way down still has somewhere to go.
      await repository.close();
      logger.flush();
    },
  };
}

/**
 * Resolves the effective log level, refusing a bad flag rather than falling back.
 *
 * The shared resolver deliberately ignores an invalid value from either source, because the environment is
 * not a place to fail a run. A flag is different: it was typed for this invocation, and quietly using a
 * different level than the one asked for is exactly the kind of wrongness this project spends effort
 * avoiding.
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
