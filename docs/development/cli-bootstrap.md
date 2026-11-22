# CLI Bootstrap

|                 |                                                                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Status**      | Normative                                                                                                                                  |
| **Entry point** | `src/cli/index.ts` → `dist/cli/index.js`                                                                                                   |
| **Assembler**   | `src/app/composition.ts`                                                                                                                   |
| **Companion**   | [`application-composition.md`](../architecture/application-composition.md), [`module-boundaries.md`](../architecture/module-boundaries.md) |

How a command reaches the application, and what the entry point is allowed to do on the way.

## 1. Two files, two jobs

| File                     | Job                                             | Side effects on import          |
| ------------------------ | ----------------------------------------------- | ------------------------------- |
| `src/app/composition.ts` | Builds and connects every dependency            | None                            |
| `src/cli/index.ts`       | Reads argv, runs the program, sets an exit code | Reads the manifest, parses argv |

Splitting them is what makes the wiring testable. A file that assembles dependencies **and** parses
arguments does both on import, so anything wanting to check the wiring would have launched the CLI.
See [ADR-0011](../architecture/adr/0011-separate-dependency-assembly-from-the-cli-entry-point.md).

`src/cli/program.ts` sits between them: it turns command definitions into a Commander program, but it
does not run one, so a test can build a program and invoke it with a synthetic argv.

## 2. The entry point, step by step

```
read the manifest for the version
  → build the program
    → parse argv
      → no command given?            → exit 2
      → a command ran                → exit 0
      → it threw                     → render, map to an exit code
      → Commander rejected the argv  → exit 2, message already printed
  → any of the above → set process.exitCode, never call process.exit()
```

Four properties this sequence is designed to preserve:

**The exit code is assigned, not called.** `process.exit()` truncates piped stdout, so the message a
user needs is the message that gets lost — and it is banned outside `src/core/process` for that
reason.

**Commander is overridden.** By default it calls `process.exit()` on a usage error, which is
untestable and bypasses the exit-code contract. `exitOverride()` makes it throw, and the entry point
decides the code.

**Commander's message is not re-rendered.** It has already written a good one — `error: unknown option
'--nope'` — and wrapping it in this project's error rendering would print it twice. A `CommanderError`
contributes an exit code and nothing else.

**A failure to build the program is handled separately.** If the manifest cannot be read, no options
have been parsed, so `--json` and `--debug` are unavailable. That path writes one plain line to stderr
rather than pretending to have a rendering choice.

## 3. Exit codes

The contract is in [`error-model.md`](../architecture/error-model.md) §5. What the bootstrap adds is
the mapping for the cases it owns:

| Situation                                   | Code         | Produced by                                                    |
| ------------------------------------------- | ------------ | -------------------------------------------------------------- |
| A command completed                         | `0`          | The entry point, on a resolved `parseAsync`                    |
| `--help`, `--version`                       | `0`          | Commander, via a `CommanderError` with `exitCode === 0`        |
| Unknown option, missing argument, bad value | `2`          | Commander, via a `CommanderError` with a non-zero code         |
| No command given                            | `2`          | An `InvalidArgumentError` thrown from the program's own action |
| Anything a command throws                   | per category | `exitCodeForError`                                             |

`1` does not appear. It is reserved for a completed run in which tests failed, and nothing in the
bootstrap can produce that.

## 4. Global options

| Flag                  | Read into                | Validated                                                          |
| --------------------- | ------------------------ | ------------------------------------------------------------------ |
| `--cwd <directory>`   | `GlobalOptions.cwd`      | Not at parse time. A path that does not exist fails in discovery   |
| `--log-level <level>` | `GlobalOptions.logLevel` | **Not here.** The assembly rejects an unknown level with `QAT1001` |
| `--json`              | `GlobalOptions.json`     | n/a                                                                |
| `--debug`             | `GlobalOptions.debug`    | n/a                                                                |
| `--version`           | Printed and exit 0       | n/a                                                                |
| `--help`              | Printed and exit 0       | n/a                                                                |

**The log level is deliberately not validated at parse time.** Commander could list the accepted
values, but the list lives in the logging module and the CLI may not import an implementation. The
assembly already raises a structured error naming the supported values, which is both the right
message and one place to maintain.

`readGlobalOptions` narrows the whole bag in one function, so the rest of the CLI has real types
rather than `any` inherited from Commander.

## 5. How a command receives its dependencies

A command never constructs anything. It is given a `CommandContext`:

```ts
interface CommandContext {
  readonly application: Application; // logger, repository, discovery, dispose
  readonly options: GlobalOptions; // what the user typed
}
```

The program builds the application immediately before calling the handler, and disposes it in a
`finally`. Three consequences:

- **Disposal cannot be forgotten per command.** A failing command must still release what it opened;
  a failing run that also leaks a database handle is two problems, and the second outlives the first.
- **A handler is testable with a fake.** It receives an interface, so no database, terminal or clock is
  needed.
- **The assembly is not reachable from a handler.** A command that could call `createApplication` could
  assemble a second application, and nothing would notice.

`Application.logger` is the `Logger` **port**, not the concrete service. A command reports; it does not
derive correlated children. When run-scoped logging is needed, the command receives a bound logger as
a parameter.

## 6. Commands are data

Commands live in `src/cli/commands/index.ts` as `CommandDefinition` values, and `createProgram` turns
them into Commander commands.

```ts
export interface CommandDefinition {
  readonly name: string;
  readonly summary: string;
  readonly run: (context: CommandContext) => Promise<void>;
}
```

The indirection costs a reader one hop — to find what `qat run` does, they look in the registry rather
than at a `.command('run')` call. It buys three things: a command can be registered in a test with a
fake application, the disposal wrapper cannot be omitted per command, and the entry point never grows.
See [ADR-0012](../architecture/adr/0012-register-commands-as-data.md).

## 7. What the CLI may import

Enforced by lint, not by convention:

| From                   | May import                                                                     | May not import                          |
| ---------------------- | ------------------------------------------------------------------------------ | --------------------------------------- |
| `src/cli/index.ts`     | `src/app`, `core/application`, `core/domain`, `core/errors`, `core/filesystem` | —                                       |
| `src/cli/**` otherwise | `core/application`, `core/domain`, `core/errors`                               | any implementation, including `src/app` |
| Anything               | —                                                                              | `src/cli` from outside it               |

The entry point is the one file permitted to reach the assembly. A command module that imported
`src/app` would be depending on wiring rather than on a contract, and no test would be able to give it
a fake.

## 8. Adding a command

1. Write `CommandDefinition` in `src/cli/commands/<name>.ts`. Its `run` receives a `CommandContext`
   and does not construct anything.
2. Add a `.command()` argument shape if it needs one, and read it from the context's options.
3. Add the definition to `COMMANDS` in `src/cli/commands/index.ts`.
4. Add a unit test in `tests/unit/cli/` that registers it with a fake application.
5. Add an end-to-end case in `tests/e2e/cli.test.ts` if it changes the exit-code surface.

No change to the entry point is required, and none should be needed.

## 9. Testing

| Kind       | Where                            | What it proves                                                                       |
| ---------- | -------------------------------- | ------------------------------------------------------------------------------------ |
| Unit       | `tests/unit/cli/program.test.ts` | Metadata, options, command registration, disposal on both paths, usage errors        |
| End-to-end | `tests/e2e/cli.test.ts`          | The built binary launches, exits with the right code, and writes to the right stream |

The end-to-end suite needs a build and spawns real processes, so it has its own configuration and runs
via `npm run test:e2e`. It is deliberately absent from `npm run verify`, which must stay fast enough to
run on every save. CI runs both.

The binary tests use the tool's own process runner to spawn the tool, which is the first place in this
project where that happens.

## 10. Not here yet

| Item                                   | Trigger                                                                                                |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Any command                            | The first feature                                                                                      |
| Result output on stdout                | The first command that produces one. Nothing in the bootstrap writes to stdout except help and version |
| Colour and terminal width              | When someone reads the output and complains, not before                                                |
| Shell completion                       | A user asking for it                                                                                   |
| Signal handling beyond Node's defaults | A command that must clean up on interrupt                                                              |

## 11. Things that will bite

**`--help` and `--version` write to stdout, and everything else diagnostic writes to stderr.** That is
not an inconsistency: help and version _are_ the result of the command that was run. Nothing else in
the bootstrap writes to stdout at all.

**The version is read from `../../package.json` at runtime, not compiled in.** That resolves correctly
from both `dist/cli/index.js` and `src/cli/index.ts`, so the same code works compiled and under a
runner. A build step that inlined the version would drift from the manifest the first time it was
forgotten.

**`src/cli/output/report.ts` is named that, not `index.ts`.** Coverage excludes `src/**/index.ts` as a
barrel containing no logic — so a module with a rendering function, placed in `index.ts`, would be
excluded from the measurement while containing exactly the kind of code a coverage report exists to
show. The rule is in [`testing-standards.md`](testing-standards.md) §5; this is what it looks like
when it applies.

**A `CommanderError` with a non-zero code always maps to `2`.** Commander's own value is `1`, and using
it would tell a pipeline that a test run failed when the user typed the command wrong.
