import type { Command } from "commander";
import { describe, expect, it } from "vitest";

import { COMMANDS } from "~/cli/commands/index.js";
import { createProgram } from "~/cli/program.js";
import type { Application } from "~/core/application/ports.js";
import { ErrorCode, InvalidArgumentError } from "~/core/errors/index.js";

/**
 * The registry is the source of truth for what the tool claims to do, so its invariants are tested
 * rather than assumed. Every one of these would pass with zero commands registered, which is why the
 * first asserts there is at least one.
 */
const application: Application = {
  logger: {
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    fatal: () => undefined,
  },
  repository: {
    create: () => Promise.resolve(),
    complete: () => Promise.resolve(),
    findById: () => Promise.resolve(undefined),
    list: () => Promise.resolve([]),
    close: () => Promise.resolve(),
  },
  discovery: {
    resolveWorkingDirectory: () => Promise.reject(new Error("unused")),
    discover: () => Promise.reject(new Error("unused")),
  },
  dispose: () => Promise.resolve(),
};

/**
 * Collapses every run of whitespace to one space.
 *
 * Help text is wrapped by the renderer, so a description that is present in full is present with line
 * breaks the source never had. Comparing without normalising would assert on the renderer's width
 * rather than on the documentation.
 */
function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function build() {
  const program = createProgram(
    "9.9.9",
    { createApplication: () => application },
    COMMANDS,
  );

  silence(program);

  return program;
}

/**
 * Stops a command writing to the real streams.
 *
 * Subcommands copy the program's output configuration when they are created, which happens inside
 * `createProgram` — so silencing the program afterwards does not reach them.
 */
function silence(command: Command): void {
  command.configureOutput({
    writeOut: () => undefined,
    writeErr: () => undefined,
  });

  for (const subcommand of command.commands) {
    silence(subcommand);
  }
}

/**
 * Everything a user sees for one command.
 *
 * `helpInformation()` returns only the generated part. Text added with `addHelpText` — which is where
 * the examples block lives — is emitted during `outputHelp`, through listeners attached for that call.
 * Asserting on `helpInformation` would therefore test a rendering the user never sees, and would
 * silently ignore the examples entirely.
 */
function renderCommandHelp(name: string): string {
  const command = build().commands.find(
    (candidate) => candidate.name() === name,
  );

  if (command === undefined) {
    throw new Error(`No command named ${name} is registered.`);
  }

  const written: string[] = [];

  command.configureOutput({
    writeOut: (text: string) => {
      written.push(text);
    },
    writeErr: () => undefined,
  });

  command.outputHelp();

  return written.join("");
}

describe("the command inventory", () => {
  it("is not empty", () => {
    expect(COMMANDS.length).toBeGreaterThan(0);
  });

  it("has unique names", () => {
    const names = COMMANDS.map((command) => command.name);

    expect(new Set(names).size).toBe(names.length);
  });

  it.each(COMMANDS)(
    "$name documents itself",
    ({ description, examples, summary }) => {
      expect(summary.length).toBeGreaterThan(0);
      expect(summary).not.toContain("\n");
      // The contract says a summary is a fragment, not a sentence. A full stop is the visible symptom of
      // one that has grown into a paragraph.
      expect(summary.endsWith(".")).toBe(false);
      // The long form must be at least as substantial as the short one, or there is no reason for it.
      expect(description.length).toBeGreaterThanOrEqual(summary.length);
      expect(examples.length).toBeGreaterThan(0);
    },
  );

  it.each(COMMANDS)(
    "$name has examples using its real syntax",
    ({ examples, name }) => {
      // A usage example is documentation of the syntax, so it has to be the syntax. One that omits the
      // command name teaches the user something that does not run.
      for (const example of examples) {
        expect(example).toMatch(new RegExp(`^qat ${name}( |$)`));
      }
    },
  );

  it.each(COMMANDS)(
    "$name declares arguments and options consistently",
    ({ arguments: args, options }) => {
      const names = (args ?? []).map((argument) => argument.name);
      expect(new Set(names).size).toBe(names.length);

      for (const option of options ?? []) {
        expect(option.flags).toMatch(/^-{1,2}[a-z]/);
      }
    },
  );
});

describe("global help", () => {
  it("lists every registered command", () => {
    const help = build().helpInformation();

    for (const command of COMMANDS) {
      expect(help).toContain(command.name);
      expect(help).toContain(command.summary);
    }
  });

  it("shows the global options", () => {
    const help = build().helpInformation();

    for (const flag of [
      "--cwd",
      "--log-level",
      "--json",
      "--debug",
      "--version",
    ]) {
      expect(help).toContain(flag);
    }
  });
});

describe("command help", () => {
  it.each(COMMANDS)(
    "$name shows its description, usage, arguments and examples",
    ({ name, description, arguments: args, examples }) => {
      const help = renderCommandHelp(name);

      expect(help).toContain("Usage:");
      // Normalised: the renderer wraps, so the description appears with line breaks the source does
      // not contain.
      expect(normalize(help)).toContain(normalize(description));

      for (const argument of args ?? []) {
        expect(help).toContain(
          argument.required ? `<${argument.name}>` : `[${argument.name}]`,
        );
      }

      // The block comes from `addHelpText`, which `helpInformation` does not include — the reason this
      // test renders the help rather than reading it.
      expect(help).toContain("Examples:");

      for (const example of examples) {
        expect(help).toContain(example);
      }
    },
  );
});

describe("unknown input", () => {
  it("rejects an unknown command with its name and a likely correction", async () => {
    const error = await build()
      .parseAsync(["node", "qat", "doctr"])
      .catch((caught: unknown) => caught);

    // No longer the parser's own error. The program's action handles operands that matched no command,
    // so the failure travels through this project's error model and renders with a code and a remedy.
    expect(error).toBeInstanceOf(InvalidArgumentError);
    expect(error).toMatchObject({ code: ErrorCode.invalidArgument });
    expect((error as InvalidArgumentError).message).toContain("'doctr'");
    expect((error as InvalidArgumentError).remediation).toContain("'doctor'");
  });

  it("rejects an unknown option on a registered command", async () => {
    await expect(
      build().parseAsync(["node", "qat", "doctor", "--nope"]),
    ).rejects.toMatchObject({
      code: "commander.unknownOption",
    });
  });

  it("rejects a positional the command did not declare", async () => {
    await expect(
      build().parseAsync(["node", "qat", "doctor", "one", "two"]),
    ).rejects.toMatchObject({
      code: "commander.excessArguments",
    });
  });
});
