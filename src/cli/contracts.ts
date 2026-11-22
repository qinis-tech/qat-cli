/**
 * What the CLI layer needs to know about the world.
 *
 * Deliberately narrow. The command layer knows the shape of the application it is handed and nothing
 * about how it was built, which is what lets a command be tested with a fake and keeps the assembly
 * from leaking into every handler.
 *
 * It also holds the whole documentation surface of a command: its description, its arguments, its
 * options and its examples. Help is generated from these rather than written separately, so an
 * argument a command accepts but does not describe cannot be expressed.
 */
import type { Application } from "../core/application/ports.js";

/** Options every command accepts, before any command-specific ones. */
export interface GlobalOptions {
  /** Directory to run as if started in. Absent means the process working directory. */
  readonly cwd?: string;
  /** Log level as typed. Validated where it is used, not here. */
  readonly logLevel?: string;
  /** Machine-readable output. */
  readonly json: boolean;
  /** Include developer diagnostics in error output. */
  readonly debug: boolean;
}

/**
 * What the entry point knows how to tell the assembly.
 *
 * Narrower than the assembly's own options on purpose: the CLI knows about a log level, and does not
 * know that a log destination or an injected repository exist. If it did, every one of those would
 * become a flag by accident.
 */
export interface ApplicationOverrides {
  readonly logLevel?: string;
}

/**
 * A positional argument.
 *
 * The brackets are not part of `name`: the parser adds `<…>` for a required argument and `[…]` for an
 * optional one, so the required flag is stated in one place and cannot contradict what the user sees.
 */
export interface CommandArgument {
  /** Without brackets. Lowercase, hyphenated if it needs two words. */
  readonly name: string;
  /** One line, shown beside the argument in help. */
  readonly description: string;
  readonly required: boolean;
  /** Shown to the user and applied when the argument is omitted. Only meaningful when optional. */
  readonly defaultValue?: string;
}

/**
 * A command-specific option.
 *
 * Global options are declared once on the program and are not repeated here. An option that applies
 * to every command belongs in `GlobalOptions`, and declaring it per command is how two commands end up
 * with subtly different behaviour for the same flag.
 */
export interface CommandOption {
  /** Parser flag syntax, including the value placeholder where one is expected, e.g. `--suite <name>`. */
  readonly flags: string;
  readonly description: string;
  /** The value a handler receives when the flag is omitted. Shown in help when present. */
  readonly defaultValue?: string;
}

export interface CommandContext {
  readonly application: Application;

  /** What the user typed globally, before the command name or after it. */
  readonly options: GlobalOptions;

  /**
   * Positional values by the name the definition gave them.
   *
   * An omitted optional argument is an absent key rather than an empty string, so a command can tell
   * "not provided" from "provided as nothing" — the same distinction the environment utilities make,
   * for the same reason.
   */
  readonly arguments: Readonly<Record<string, string | undefined>>;

  /** Command-specific options, already defaulted by the parser. */
  readonly commandOptions: Readonly<Record<string, unknown>>;
}

export interface CommandDefinition {
  /** The word the user types. Lowercase, no spaces. */
  readonly name: string;

  /** One line, shown in the command list. No trailing full stop, no line break. */
  readonly summary: string;

  /**
   * The longer form, shown in the command's own help.
   *
   * Prose, not a restatement of the summary, and not a list of arguments — those have their own
   * fields and repeating them here is how the two drift apart.
   */
  readonly description: string;

  /** Positional arguments, in the order the user supplies them. */
  readonly arguments?: readonly CommandArgument[];

  /** Command-specific options. Global ones are declared on the program. */
  readonly options?: readonly CommandOption[];

  /**
   * At least one, using the real syntax.
   *
   * Required rather than optional, because an example is the first thing a user looks for and the
   * first thing an author skips. The registry test asserts there is at least one and that it begins
   * with the command it belongs to, since an example that omits the command name teaches something
   * that does not run.
   */
  readonly examples: readonly string[];

  /**
   * The handler. Receives everything it needs and returns nothing; output goes through the output
   * layer, so a command cannot accidentally return a value a caller might treat as a result.
   */
  readonly run: (context: CommandContext) => Promise<void>;
}

export interface ProgramDependencies {
  /** Builds an application for one invocation. Injected so a test supplies a fake. */
  readonly createApplication: (overrides: ApplicationOverrides) => Application;
}
