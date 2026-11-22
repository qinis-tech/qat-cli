/**
 * The Commander program.
 *
 * A function that builds a program, not a module that has one. A module-level program would be
 * created on import, shared by every test in the file, and impossible to configure twice with
 * different options.
 *
 * ## Two decisions worth reading before changing anything
 *
 * **`exitOverride` is not optional.** By default Commander calls `process.exit()` on a usage error,
 * which is untestable, bypasses the exit-code contract, and trips the lint rule that reserves
 * exiting for one module. Overriding makes it throw instead, and the entry point decides the code.
 *
 * **The log level is not validated here.** Commander could list the accepted values, but the list
 * lives in the logging module and the CLI is not permitted to import an implementation. It is
 * validated by the assembly, which already raises a structured error naming the supported values.
 */
import { Command } from "commander";

import type { Application } from "../core/application/ports.js";
import { ErrorCode, InvalidArgumentError } from "../core/errors/index.js";

import type {
  CommandDefinition,
  GlobalOptions,
  ProgramDependencies,
} from "./contracts.js";

/**
 * Builds the program.
 *
 * @param version The version string to report. Passed in rather than read, so the program can be
 *   built in a test without a filesystem.
 * @param dependencies What a command handler is given.
 * @param commands The commands to register. Empty by default: this is the foundation, and the
 *   registry is where they will be listed.
 */
export function createProgram(
  version: string,
  dependencies: ProgramDependencies,
  commands: readonly CommandDefinition[] = [],
): Command {
  const program = new Command();

  program
    .name("qat")
    .description(
      "Quality Automation Toolkit — test automation engineering, from the command line",
    )
    .version(version)
    .exitOverride()
    .showSuggestionAfterError(true)
    .configureHelp({ sortSubcommands: true });

  program
    .option("--cwd <directory>", "run as if started in this directory")
    .option("--log-level <level>", "trace, debug, info, warn, error or fatal")
    .option("--json", "write machine-readable output")
    .option("--debug", "include developer diagnostics in error output");

  // No subcommand given. Reported as invalid input rather than silently succeeding, because a
  // command that does nothing and exits zero tells a script that its work was done.
  program.action(() => {
    throw new InvalidArgumentError(
      ErrorCode.invalidArgument,
      "No command was given.",
      {
        context: {
          commands: commands.map((command) => command.name).join(", "),
        },
        remediation: "Run qat --help to see the available commands.",
      },
    );
  });

  for (const definition of commands) {
    program
      .command(definition.name)
      .description(definition.summary)
      .action(async () => {
        const options = readGlobalOptions(program);

        await withApplication(
          () => dependencies.createApplication(buildOverrides(options)),
          (application) => definition.run({ application, options }),
        );
      });
  }

  return program;
}

/**
 * Reads the global options into a typed shape.
 *
 * `opts` is a bag of `unknown` by declaration and `any` by default. Narrowing every field here means
 * the rest of the file has a real type, and the assertion lives in one place instead of spreading.
 */
export function readGlobalOptions(program: Command): GlobalOptions {
  const raw = program.opts<Record<string, unknown>>();

  const cwd =
    typeof raw["cwd"] === "string" && raw["cwd"].length > 0
      ? raw["cwd"]
      : undefined;
  const logLevel =
    typeof raw["logLevel"] === "string" && raw["logLevel"].length > 0
      ? raw["logLevel"]
      : undefined;

  return {
    ...(cwd === undefined ? {} : { cwd }),
    ...(logLevel === undefined ? {} : { logLevel }),
    json: raw["json"] === true,
    debug: raw["debug"] === true,
  };
}

function buildOverrides(options: GlobalOptions): {
  readonly logLevel?: string;
} {
  return options.logLevel === undefined ? {} : { logLevel: options.logLevel };
}

/**
 * Runs a command with an assembled application, and disposes it afterwards.
 *
 * Disposal is in a `finally` because a command that fails must release what it opened: a failing run
 * that also leaks a database handle is two problems, and the second outlives the first.
 */
async function withApplication(
  create: () => Application,
  run: (application: Application) => Promise<void>,
): Promise<void> {
  const application = create();

  try {
    await run(application);
  } finally {
    await application.dispose();
  }
}
