# CLI Bootstrap

|                 |                                                                                                                                                                            |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**      | Normative                                                                                                                                                                  |
| **Entry point** | `src/cli/index.ts` → `dist/cli/index.js`                                                                                                                                   |
| **Assembler**   | `src/app/composition.ts`                                                                                                                                                   |
| **Companion**   | [application-composition.md](../architecture/application-composition.md), [module-boundaries.md](../architecture/module-boundaries.md), [cli-commands.md](cli-commands.md) |

How a command reaches the application, and what the entry point is allowed to do on the way.

## 1. The files, and their jobs

| File                     | Job                                                       | Side effects on import |
| ------------------------ | --------------------------------------------------------- | ---------------------- |
| `src/app/composition.ts` | Builds and connects every dependency                      | None                   |
| `src/cli/program.ts`     | Turns command definitions into a program                  | None                   |
| `src/cli/version.ts`     | Finds and validates the package version                   | None                   |
| `src/cli/index.ts`       | Resolves the version, runs the program, sets an exit code | Parses argv            |

Splitting assembly from the entry point is what makes the wiring testable: a file that assembles
dependencies **and** parses arguments does both on import, so anything wanting to check the wiring would
have launched the CLI. See [ADR-0011](../architecture/adr/0011-separate-dependency-assembly-from-the-cli-entry-point.md).

`program.ts` sits between them. It builds a program but does not run one, so a test can construct a
program and invoke it with a synthetic argv.

## 2. The entry point, step by step

```
resolve the version from the nearest package manifest
  → build the program
    → parse argv
      → no command given?            → exit 2
      → a command ran                → exit 0, unless it set a code
      → it threw                     → render, map to an exit code
      → the parser rejected the argv → exit 2, message already printed
  → any of the above → set process.exitCode, never call process.exit()
```

Five properties this sequence is designed to preserve:

**The exit code is assigned, not called.** `process.exit()` truncates piped stdout, so the message a
user needs is the message that gets lost — and it is banned outside `src/core/process` for that reason.

**The code is only defaulted, never forced.** `process.exitCode ??= ExitCode.Success` leaves a code a
command has already set untouched. A command that ran tests is entitled to report `1`, and an
unconditional assignment here would silently turn every failing run into a passing one.

**The parser is overridden.** By default Commander calls `process.exit()` on a usage error, which is
untestable and bypasses the exit-code contract. `exitOverride()` makes it throw, and the entry point
decides the code.

**The parser's message is not re-rendered.** It has already written a good one — `error: unknown option
'--nope'` — and wrapping it in this project's error rendering would print it twice. A `CommanderError`
contributes an exit code and nothing else.

**A failure before the program exists is handled separately.** If the version cannot be resolved, no
options have been parsed, so `--json` and `--debug` are unavailable. That path writes one plain line to
stderr, including the error code, rather than pretending to have a rendering choice.

## 3. Exit codes

The contract is in [error-model.md](../architecture/error-model.md) §5. What the bootstrap adds is the
mapping for the cases it owns:

| Situation                                     | Code         | Produced by                                                    |
| --------------------------------------------- | ------------ | -------------------------------------------------------------- |
| A command completed                           | `0`          | The entry point, on a resolved `parseAsync`                    |
| `--help`, `--version`                         | `0`          | The parser, via a `CommanderError` with `exitCode === 0`       |
| Unknown option, missing argument, bad value   | `2`          | The parser, via a `CommanderError` with a non-zero code        |
| No command given, or a word that matched none | `2`          | An `InvalidArgumentError` thrown from the program's own action |
| The package manifest cannot be read           | `3`          | `resolveVersion`, before the program exists                    |
| Anything a command throws                     | per category | `exitCodeForError`                                             |

`1` does not appear. It is reserved for a completed run in which tests failed, and nothing in the
bootstrap can produce that. **An exit code of `1` from the binary means Node died**, not that the CLI
decided anything — a build that emitted nothing, or an installation whose dependencies cannot resolve.
The evidence is always in stderr.

## 4. Global options

| Flag                  | Read into                | Validated                                                          |
| --------------------- | ------------------------ | ------------------------------------------------------------------ |
| `--cwd <directory>`   | `GlobalOptions.cwd`      | Not at parse time. A path that does not exist fails in discovery   |
| `--log-level <level>` | `GlobalOptions.logLevel` | **Not here.** The assembly rejects an unknown level with `QAT1001` |
| `--json`              | `GlobalOptions.json`     | n/a                                                                |
| `--debug`             | `GlobalOptions.debug`    | n/a                                                                |
| `--version`           | Printed, exit 0          | n/a                                                                |
| `--help`              | Printed, exit 0          | n/a                                                                |

**The log level is deliberately not validated at parse time.** Commander could list the accepted
values, but the list lives in the logging module and the CLI may not import an implementation. The
assembly already raises a structured error naming the supported values, which is both the right message
and one place to maintain.

`readGlobalOptions` narrows the whole bag in one function, so the rest of the CLI has real types rather
than `any` inherited from the parser.

## 5. How a command receives its dependencies

A command never constructs anything. It is given a `CommandContext`:

```ts
interface CommandContext {
  readonly application: Application; // logger, repository, discovery, dispose
  readonly options: GlobalOptions; // what the user typed globally
  readonly arguments: Readonly<Record<string, string | undefined>>;
  readonly commandOptions: Readonly<Record<string, unknown>>;
}
```

The program builds the application immediately before calling the handler and disposes it in a
`finally`. Four consequences:

- **Disposal cannot be forgotten per command.** A failing command must still release what it opened; a
  failing run that also leaks a database handle is two problems, and the second outlives the first.
- **A handler is testable with a fake.** It receives an interface, so no database, terminal or clock is
  needed.
- **The assembly is not reachable from a handler.** A command that could call `createApplication` could
  assemble a second application, and nothing would notice.
- **An omitted optional argument is absent, not empty.** A handler can tell "not provided" from
  "provided as nothing" — the same distinction the environment utilities make.

`Application.logger` is the `Logger` **port**, not the concrete service. A command reports; it does not
derive correlated children. When run-scoped logging is needed, the command receives a bound logger as a
parameter.

## 6. Commands are data

Commands live in `src/cli/commands/index.ts` as `CommandDefinition` values, and `createProgram` turns
them into parser commands.

```ts
export interface CommandDefinition {
  readonly name: string;
  readonly summary: string; // one line, in the command list
  readonly description: string; // prose, in the command's own help
  readonly arguments?: readonly CommandArgument[];
  readonly options?: readonly CommandOption[];
  readonly examples: readonly string[]; // required, and must begin with `qat <name>`
  readonly run: (context: CommandContext) => Promise<void>;
}
```

Help is **generated** from these fields, so an argument a command accepts but does not describe cannot
be expressed. The indirection costs a reader one hop — to find what `qat run` does, they look in the
registry rather than at a `.command('run')` call. It buys three things: a command can be registered in a
test with a fake application, the disposal wrapper cannot be omitted per command, and the entry point
never grows. See [ADR-0012](../architecture/adr/0012-register-commands-as-data.md) and
[cli-commands.md](cli-commands.md).

## 7. What the CLI may import

Enforced by lint, not by convention:

| From                   | May import                                                | May not import                          |
| ---------------------- | --------------------------------------------------------- | --------------------------------------- |
| `src/cli/index.ts`     | `src/app`, anything under `core/`, `node:`                | —                                       |
| `src/cli/**` otherwise | `core/application`, `core/domain`, `core/errors`, `node:` | any implementation, including `src/app` |
| Anything               | —                                                         | `src/cli` from outside it               |

The entry point is the one file permitted to reach the assembly. A command module that imported
`src/app` would be depending on wiring rather than on a contract, and no test would be able to give it a
fake.

`src/cli/version.ts` reads the filesystem with `node:fs/promises` directly rather than through
`core/filesystem`, because it must work before anything else is known — before a project has been
discovered, before options are parsed. That is the one place raw filesystem access in the CLI is
justified, and it is about fifteen lines.

## 8. Adding a command

1. Write `CommandDefinition` in `src/cli/commands/<name>.ts`. Its `run` receives a `CommandContext` and
   constructs nothing.
2. Declare its arguments and options as data, and read them from the context.
3. Give it at least one example using the real syntax.
4. Add the definition to `COMMANDS` in `src/cli/commands/index.ts`.
5. Add a unit test in `tests/unit/cli/` that registers it with a fake application.
6. Add an end-to-end case in `tests/e2e/cli.test.ts` if it changes the exit-code surface.

No change to the entry point is required, and none should be needed.

## 9. Testing

| Kind       | Where                            | What it proves                                                                                                                                          |
| ---------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit       | `tests/unit/cli/program.test.ts` | Metadata, options, argument passing, registration, disposal on both paths, usage errors                                                                 |
| Unit       | `tests/unit/cli/help.test.ts`    | Registry invariants and generated help, for every command                                                                                               |
| Unit       | `tests/unit/cli/version.test.ts` | Resolution depth, missing and unusable metadata, isolation from the working directory                                                                   |
| End-to-end | `tests/e2e/cli.test.ts`          | The built binary launches, exits with the right code, writes to the right stream, and resolves its version from a package layout outside the repository |

The end-to-end suite needs a build and spawns real processes, so it has its own configuration and runs
via `npm run test:e2e`, which builds first and runs the binary once before the suite. A build that
produces no output therefore fails with its own error rather than as a cascade of exit-code failures.

It is deliberately absent from `npm run verify`, which must stay fast enough to run on every save. CI
runs both.

The binary tests use the tool's own process runner to spawn the tool, which is the first place in this
project where that happens.

## 10. Not here yet

| Item                                       | Trigger                                                                                             |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Result output on stdout                    | The first command that produces one. The bootstrap writes nothing to stdout except help and version |
| Command-specific options on a real command | The first command that needs a flag                                                                 |
| Colour and terminal width                  | When someone reads the output and complains, not before                                             |
| Shell completion                           | A user asking for it                                                                                |
| Signal handling beyond Node's defaults     | A command that must clean up on interrupt                                                           |

## 11. Things that will bite

**`--help` and `--version` write to stdout, and everything else diagnostic writes to stderr.** That is
not an inconsistency: help and version _are_ the result of the command that was run. Nothing else in the
bootstrap writes to stdout at all.

**The version is resolved by walking up to the nearest manifest, not by a fixed relative path.** The
bootstrap starts at its own module directory and climbs, bounded at six levels, until it finds a
`package.json`. That is correct at any depth inside the package — `src/cli` in development, `dist/cli`
after a build, `node_modules/qat-cli/dist/cli` once installed — where `../../package.json` is correct
only for the layout it was written against.

If the nearest manifest is missing or declares no usable version, the binary fails with `QAT4003` and
exit `3` rather than printing a plausible but wrong number. A version quoted in a bug report has to be
true; `0.0.0` is worse than an error, because it looks like an answer. Note that an _unparseable_
manifest never reaches this code: Node reads the same file to decide the module format and refuses the
script first.

**`src/cli/output/report.ts` is named that, not `index.ts`.** Coverage excludes `src/**/index.ts` as a
barrel containing no logic, so a module with a rendering function placed in `index.ts` would be excluded
from the measurement while containing exactly the kind of code a coverage report exists to show. The
rule is in [testing-standards.md](testing-standards.md) §5; this is what it looks like when it applies.

**A `CommanderError` with a non-zero code always maps to `2`.** The parser's own value is `1`, and using
it would tell a pipeline that a test run failed when the user typed the command wrong.

**The program's own action owns two cases.** "No command given" and "a word that matched no command"
both reach it, because an operand that matches no subcommand is passed to the program's action rather
than reported by the parser. Handling them apart is what once produced `too many arguments for 'qat'`
for a typo.
