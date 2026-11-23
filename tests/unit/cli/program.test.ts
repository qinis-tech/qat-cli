import { describe, expect, it } from "vitest";

import { fakeApplication } from "./fake-application.js";

import type {
  ApplicationOverrides,
  CommandContext,
  CommandDefinition,
} from "~/cli/contracts.js";
import { createProgram, readGlobalOptions } from "~/cli/program.js";
import { ErrorCode, InvalidArgumentError } from "~/core/errors/index.js";

/**
 * A minimal definition.
 *
 * The four documentation fields are present because the contract requires them; a fixture that omitted them would
 * compile only if the contract were loosened, which is the thing it exists to prevent.
 */
function command(
  overrides: Partial<CommandDefinition> = {},
): CommandDefinition {
  return {
    name: "demo",
    summary: "a command that does nothing",
    description: "A command that does nothing, used to exercise registration.",
    examples: ["qat demo"],
    run: () => Promise.resolve(),
    ...overrides,
  };
}

function build(
  commands: readonly CommandDefinition[] = [],
  onCreate: (overrides: ApplicationOverrides) => void = () => undefined,
) {
  const disposed: string[] = [];
  const application = fakeApplication({
    onDispose: () => {
      disposed.push("dispose");
    },
  });

  const program = createProgram(
    "9.9.9",
    {
      createApplication: (overrides) => {
        onCreate(overrides);
        return application;
      },
    },
    commands,
  );

  program.configureOutput({
    writeOut: () => undefined,
    writeErr: () => undefined,
  });

  return { program, disposed, application };
}

describe("program metadata", () => {
  it("registers the executable name, description and version", () => {
    const { program } = build();

    expect(program.name()).toBe("qat");
    expect(program.description()).toContain("Quality Automation Toolkit");
    expect(program.version()).toBe("9.9.9");
  });

  it("registers every global option", () => {
    const { program } = build();

    const flags = program.options.map((option) => option.long);

    // `--version` is in this list because `.version()` registers it as an option like any other. It is first because
    // that call happens before the `.option()` calls, and asserting the order documents that rather than leaving it to
    // be discovered.
    expect(flags).toStrictEqual([
      "--version",
      "--cwd",
      "--log-level",
      "--json",
      "--debug",
    ]);
  });
});

describe("reading global options", () => {
  it("narrows supplied values and defaults the flags to false", () => {
    const { program } = build();

    // `parseOptions` rather than `parseAsync`: this test is about reading flags, and `parseAsync` would also run the
    // program — which for a bare invocation is the "no command" path asserted below.
    program.parseOptions(["node", "qat", "--cwd", "/tmp/project", "--json"]);

    expect(readGlobalOptions(program)).toStrictEqual({
      cwd: "/tmp/project",
      json: true,
      debug: false,
    });
  });

  it("omits absent optional values rather than setting them undefined", () => {
    const { program } = build();
    program.parseOptions(["node", "qat"]);

    const options = readGlobalOptions(program);

    // Absent, not present-and-undefined: the shape is compared and serialised.
    expect("cwd" in options).toBe(false);
    expect("logLevel" in options).toBe(false);
  });
});

describe("usage errors", () => {
  it("throws instead of exiting, so the entry point decides the code", async () => {
    const { program } = build();

    // The default behaviour would be `process.exit(1)`, which no test can observe and which bypasses the exit-code
    // contract.
    await expect(
      program.parseAsync(["node", "qat", "--nope"]),
    ).rejects.toMatchObject({
      code: "commander.unknownOption",
    });
  });

  it("rejects a run with no command rather than exiting zero", async () => {
    const { program } = build();

    await expect(program.parseAsync(["node", "qat"])).rejects.toMatchObject({
      code: ErrorCode.invalidArgument,
    });
  });
});

describe("command registration", () => {
  it("hands the command an application and the parsed options", async () => {
    let received: CommandContext | undefined;

    const { program } = build([
      command({
        run: (context) => {
          received = context;
          return Promise.resolve();
        },
      }),
    ]);

    await program.parseAsync(["node", "qat", "demo", "--json"]);

    // Both halves of the context: the application it can act with, and the flags the user typed. A test asserting only
    // the first would pass while every global flag was silently discarded.
    expect(received?.application).toBeDefined();
    expect(received?.options.json).toBe(true);
  });

  it("passes declared arguments through by name", async () => {
    let received: CommandContext | undefined;

    const { program } = build([
      command({
        arguments: [
          { name: "directory", description: "where", required: false },
        ],
        examples: ["qat demo ./somewhere"],
        run: (context) => {
          received = context;
          return Promise.resolve();
        },
      }),
    ]);

    await program.parseAsync(["node", "qat", "demo", "./somewhere"]);

    expect(received?.arguments["directory"]).toBe("./somewhere");
  });

  it("leaves an omitted optional argument absent rather than empty", async () => {
    let received: CommandContext | undefined;

    const { program } = build([
      command({
        arguments: [
          { name: "directory", description: "where", required: false },
        ],
        examples: ["qat demo"],
        run: (context) => {
          received = context;
          return Promise.resolve();
        },
      }),
    ]);

    await program.parseAsync(["node", "qat", "demo"]);

    // A handler must be able to tell "not provided" from "provided as nothing" — the same distinction the environment
    // utilities make, for the same reason.
    expect(received?.arguments["directory"]).toBeUndefined();
  });

  it("rejects an extra positional rather than ignoring it", async () => {
    const { program } = build([
      command({
        arguments: [
          { name: "directory", description: "where", required: false },
        ],
        examples: ["qat demo"],
      }),
    ]);

    await expect(
      program.parseAsync(["node", "qat", "demo", "one", "two"]),
    ).rejects.toMatchObject({ code: "commander.excessArguments" });
  });

  it("disposes the application after a successful command", async () => {
    const { program, disposed } = build([command()]);

    await program.parseAsync(["node", "qat", "demo"]);

    expect(disposed).toStrictEqual(["dispose"]);
  });

  it("disposes the application when the command throws, and propagates the error", async () => {
    const { program, disposed } = build([
      command({
        run: () =>
          Promise.reject(
            new InvalidArgumentError(ErrorCode.invalidArgument, "boom"),
          ),
      }),
    ]);

    await expect(
      program.parseAsync(["node", "qat", "demo"]),
    ).rejects.toMatchObject({
      code: ErrorCode.invalidArgument,
    });

    // A failing command that also leaks what it opened is two problems, and the second outlives the first.
    expect(disposed).toStrictEqual(["dispose"]);
  });

  it("passes the log level through to the assembly", async () => {
    let seen: string | undefined;

    const { program } = build([command()], (overrides) => {
      seen = overrides.logLevel;
    });

    await program.parseAsync(["node", "qat", "demo", "--log-level", "debug"]);

    expect(seen).toBe("debug");
  });
});
