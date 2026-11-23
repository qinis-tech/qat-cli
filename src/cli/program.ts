/**
 * The Commander program.
 *
 * A function that builds a program, not a module that has one. A module-level program would be created on import,
 * shared by every test in the file, and impossible to configure twice with different options.
 *
 * ## Four decisions worth reading before changing anything
 *
 * **`exitOverride` is not optional.** By default Commander calls `process.exit()` on a usage error, which is
 * untestable, bypasses the exit-code contract, and trips the lint rule that reserves exiting for one module.
 * Overriding makes it throw instead, and the entry point decides the code.
 *
 * **The log level is not validated here.** Commander could list the accepted values, but the list lives in the logging
 * module and the CLI is not permitted to import an implementation. It is validated by the assembly, which already
 * raises a structured error naming the supported values.
 *
 * **Help is generated from the command definition.** A command's arguments, options and examples are declared as data
 * and turned into help text here, so an argument a command accepts but does not describe cannot be expressed. Writing
 * help separately is how the two drift apart.
 *
 * **A command's returned status is recorded here, and nowhere else.** A reporting command fails by describing a
 * condition rather than by raising one, so it returns a status instead of throwing — and something has to put that
 * status where the process can see it. The action wrapper does, after the command's output has been written and after
 * its application has been disposed. Nothing is printed twice, because the command has already said everything.
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
 * @param version The version string to report. Passed in rather than read, so the program can be built in a test
 *   without a filesystem.
 * @param dependencies What a command handler is given.
 * @param commands The commands to register, in the order they appear before help sorts them.
 */
export function createProgram(
  version: string,
  dependencies: ProgramDependencies,
  commands: readonly CommandDefinition[] = [],
): Command {
  const program = new Command();

  program
    .name("qat")
    .description("Quality Automation Toolkit - test automation engineering")
    .version(version)
    .exitOverride()
    .showSuggestionAfterError(true)
    .configureHelp({ sortSubcommands: true })
    // The program's own action receives operands that matched no command. Without this, Commander treats them as excess
    // arguments on the program and reports "too many arguments for 'qat'" — which names neither the typo nor the likely
    // correction.
    .allowExcessArguments(true);

  program
    .option("--cwd <directory>", "run as if started in this directory")
    .option("--log-level <level>", "trace, debug, info, warn, error or fatal")
    .option("--json", "write machine-readable output")
    .option("--debug", "include developer diagnostics in error output");

  /**
   * Operands that named no command.
   *
   * Two cases, and both are this project's decisions rather than the parser's, which is why one action handles them
   * together. Reporting "no command given" as invalid input means a script is told its invocation was wrong rather
   * than that its work succeeded; reporting an unknown word as a typo means the user is given the name they probably
   * meant.
   */
  program.action(() => {
    const [candidate] = program.args;
    const names = commands.map((command) => command.name);

    if (candidate === undefined) {
      throw new InvalidArgumentError(
        ErrorCode.invalidArgument,
        "No command was given.",
        {
          context: { commands: names.join(", ") },
          remediation: "Run qat --help to see the available commands.",
        },
      );
    }

    const suggestion = closestCommand(candidate, names);

    throw new InvalidArgumentError(
      ErrorCode.invalidArgument,
      `Unknown command '${candidate}'.`,
      {
        context: { supplied: candidate, commands: names.join(", ") },
        remediation:
          suggestion === undefined
            ? "Run qat --help to see the available commands."
            : `Did you mean '${suggestion}'? Run qat --help to see the available commands.`,
      },
    );
  });

  for (const definition of commands) {
    registerCommand(program, definition, dependencies);
  }

  return program;
}

/**
 * Reads the global options into a typed shape.
 *
 * `opts` is a bag of `unknown` by declaration and `any` by default. Narrowing every field here means the rest of the
 * file has a real type, and the assertion lives in one place instead of spreading.
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
 * Registers one command and everything it shows in its own help.
 *
 * @param program The program the command belongs to. Global options are read from it, so a command sees `--json`
 *   whether it was typed before or after the command name.
 */
function registerCommand(
  program: Command,
  definition: CommandDefinition,
  dependencies: ProgramDependencies,
): void {
  const command = program.command(definition.name);

  // Two different fields for two different places. `summary` is the one-line entry in the command list; `description`
  // is the prose in the command's own help. Using one call for both means the longer text never appears anywhere —
  // which is what a required field nobody reads looks like.
  command.summary(definition.summary).description(definition.description);

  // An extra positional is a typo, not input. Rejecting it turns a silently ignored word into a usage error that names
  // the offending value.
  command.allowExcessArguments(false);

  for (const argument of definition.arguments ?? []) {
    // Brackets come from `required` rather than from the name, so the two can never disagree.
    command.argument(
      argument.required ? `<${argument.name}>` : `[${argument.name}]`,
      argument.description,
      argument.defaultValue,
    );
  }

  for (const option of definition.options ?? []) {
    command.option(option.flags, option.description, option.defaultValue);
  }

  command.addHelpText("after", formatExamples(definition));

  command.action(async () => {
    const options = readGlobalOptions(program);

    const status = await withApplication(
      () => dependencies.createApplication(buildOverrides(options)),
      (application) =>
        definition.run({
          application,
          options,
          arguments: readPositionalArguments(definition, command),
          commandOptions: command.opts<Record<string, unknown>>(),
        }),
    );

    // Applied after the command has written its output and after the application has been disposed, so a report that
    // decided its own status is not competing with anything. `typeof` rather than a comparison with `undefined`,
    // because the handler's return type is `ExitCode | void` and narrowing `void` is a question about the type system
    // rather than about the value.
    //
    // This is the only place on the success path that touches the process status, and it records an intent rather than
    // ending the process: `src/cli/index.ts` still performs the exit. If the lint rule that reserves exiting for one
    // module objects to this as well, the alternative is a `onStatus` sink on `ProgramDependencies` — three lines, and
    // it moves the write into the entry point where that rule expects it.
    if (typeof status === "number") process.exitCode = status;
  });
}

/**
 * Reads positional values by the names the definition gave them.
 *
 * Read from the parsed command rather than from the action's parameters. Commander passes positionals as leading
 * parameters followed by an options bag and the command itself, so unpacking that positionally breaks as soon as a
 * command's arity changes. `command.args` is the same data without the ordering assumption.
 *
 * Read at action time rather than at registration time, because that is when it is populated.
 */
function readPositionalArguments(
  definition: CommandDefinition,
  command: Command,
): Readonly<Record<string, string | undefined>> {
  const values: Record<string, string | undefined> = {};

  for (const [index, argument] of (definition.arguments ?? []).entries()) {
    values[argument.name] = command.args[index] ?? argument.defaultValue;
  }

  return values;
}

/** The examples block appended to a command's `--help`. */
function formatExamples(definition: CommandDefinition): string {
  return [
    "",
    "Examples:",
    ...definition.examples.map((example) => `  ${example}`),
  ].join("\n");
}

/**
 * The registered command most similar to what was typed, if one is close enough to name.
 *
 * A bounded edit distance rather than a prefix test: a transposition (`rnu` for `run`) is a common typo that a prefix
 * test misses, and naming the wrong command is worse than naming none.
 */
function closestCommand(
  candidate: string,
  names: readonly string[],
): string | undefined {
  const threshold = 2;

  let best: { readonly name: string; readonly distance: number } | undefined;

  for (const name of names) {
    const distance = editDistance(candidate.toLowerCase(), name);

    if (
      distance <= threshold &&
      (best === undefined || distance < best.distance)
    ) {
      best = { name, distance };
    }
  }

  return best?.name;
}

/**
 * Levenshtein distance.
 *
 * Two rows rather than a full matrix: command names are short and few, so the cost is irrelevant and the smaller
 * version is the one nobody has to think about.
 */
function editDistance(left: string, right: string): number {
  const previous = Array.from(
    { length: right.length + 1 },
    (_, index) => index,
  );

  for (let row = 1; row <= left.length; row += 1) {
    let diagonal = previous[0] ?? 0;
    previous[0] = row;

    for (let column = 1; column <= right.length; column += 1) {
      const above = previous[column] ?? 0;
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;

      previous[column] = Math.min(
        above + 1,
        (previous[column - 1] ?? 0) + 1,
        diagonal + cost,
      );
      diagonal = above;
    }
  }

  return previous[right.length] ?? 0;
}

/**
 * Runs a command with an assembled application, and disposes it afterwards.
 *
 * Disposal is in a `finally` because a command that fails must release what it opened: a failing run that also leaks a
 * database handle is two problems, and the second outlives the first.
 *
 * The handler's value is returned rather than discarded, which is what lets a command that reported a condition hand
 * its status to the caller without writing to the process itself.
 */
async function withApplication<Result>(
  create: () => Application,
  run: (application: Application) => Promise<Result>,
): Promise<Result> {
  const application = create();

  try {
    return await run(application);
  } finally {
    await application.dispose();
  }
}
