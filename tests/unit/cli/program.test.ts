import { describe, expect, it } from "vitest";

import type { CommandDefinition } from "~/cli/contracts.js";
import { createProgram, readGlobalOptions } from "~/cli/program.js";
import type { Application } from "~/core/application/ports.js";
import { ErrorCode, InvalidArgumentError } from "~/core/errors/index.js";

/**
 * The program is built per test rather than shared, and its output is silenced.
 *
 * A module-level program would carry state between tests, which is the thing the builder function
 * exists to avoid; and Commander writes help and usage errors to the real streams, which would make a
 * passing suite look like a failing one.
 */
function build(commands: readonly CommandDefinition[] = []) {
  const disposed: string[] = [];

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
    discovery: { discover: () => Promise.reject(new Error("unused")) },
    dispose: () => {
      disposed.push("dispose");
      return Promise.resolve();
    },
  };

  const program = createProgram(
    "9.9.9",
    { createApplication: () => application },
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

    // `--version` is in this list because `.version()` registers it as an option like any other. It is
    // first because that call happens before the `.option()` calls, and asserting the order documents
    // that rather than leaving it to be discovered.
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

    // `parseOptions` rather than `parseAsync`: this test is about reading flags, and `parseAsync` would
    // also run the program — which for a bare invocation is the "no command" path asserted below.
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

    expect("cwd" in options).toBe(false);
    expect("logLevel" in options).toBe(false);
  });
});

describe("usage errors", () => {
  it("throws instead of exiting, so the entry point decides the code", async () => {
    const { program } = build();

    // The default behaviour would be `process.exit(1)`, which no test can observe and which bypasses
    // the exit-code contract.
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
    let received: Application | undefined;

    const { program } = build([
      {
        name: "demo",
        summary: "a command that does nothing",
        run: ({ application }) => {
          received = application;
          return Promise.resolve();
        },
      },
    ]);

    await program.parseAsync(["node", "qat", "demo", "--json"]);

    expect(received).toBeDefined();
  });

  it("disposes the application after a successful command", async () => {
    const { program, disposed } = build([
      { name: "demo", summary: "ok", run: () => Promise.resolve() },
    ]);

    await program.parseAsync(["node", "qat", "demo"]);

    expect(disposed).toStrictEqual(["dispose"]);
  });

  it("disposes the application when the command throws, and propagates the error", async () => {
    const { program, disposed } = build([
      {
        name: "demo",
        summary: "fails",
        run: () =>
          Promise.reject(
            new InvalidArgumentError(ErrorCode.invalidArgument, "boom"),
          ),
      },
    ]);

    await expect(
      program.parseAsync(["node", "qat", "demo"]),
    ).rejects.toMatchObject({
      code: ErrorCode.invalidArgument,
    });

    // A failing command that also leaks what it opened is two problems, and the second outlives the
    // first.
    expect(disposed).toStrictEqual(["dispose"]);
  });

  it("passes the log level through to the assembly", async () => {
    let seen: string | undefined;

    const program = createProgram(
      "9.9.9",
      {
        createApplication: (overrides) => {
          seen = overrides.logLevel;
          return {
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
            discovery: { discover: () => Promise.reject(new Error("unused")) },
            dispose: () => Promise.resolve(),
          };
        },
      },
      [{ name: "demo", summary: "ok", run: () => Promise.resolve() }],
    );

    program.configureOutput({
      writeOut: () => undefined,
      writeErr: () => undefined,
    });

    await program.parseAsync(["node", "qat", "demo", "--log-level", "debug"]);

    expect(seen).toBe("debug");
  });
});
