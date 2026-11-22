/**
 * What the CLI layer needs to know about the world.
 *
 * Deliberately narrow. The command layer knows the shape of the application it is handed and nothing
 * about how it was built, which is what lets a command be tested with a fake and keeps the assembly
 * from leaking into every handler.
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

export interface CommandContext {
  readonly application: Application;
  readonly options: GlobalOptions;
}

export interface CommandDefinition {
  /** The word the user types. Lowercase, no spaces. */
  readonly name: string;
  /** One line, shown in help. */
  readonly summary: string;
  /** The handler. Receives everything it needs and returns nothing; output goes through the output layer. */
  readonly run: (context: CommandContext) => Promise<void>;
}

export interface ProgramDependencies {
  /** Builds an application for one invocation. Injected so a test supplies a fake. */
  readonly createApplication: (overrides: ApplicationOverrides) => Application;
}
