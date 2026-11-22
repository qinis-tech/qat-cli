# ADR-0012: Register commands as data rather than as Commander calls in the entry point

Date: 2026-11-21

## Status

Accepted

## Context

The CLI needs commands, and the framework's idiom is direct: `program.command('run')`, a description,
options, and an action handler, written where the program is created. It is compact, familiar, and
found by searching for the command's name.

That form works when a handler needs nothing. Here a handler needs three things that the idiom does not
provide: an assembled application, a guarantee that the application is disposed afterwards, and the
global options the user typed. Written directly, each command either repeats that setup or the file
owning the program grows a helper — and then becomes the place where command behaviour lives, which is
what the previous record moved out of it.

The constraint that decides it is testability. Checking that "a command receives the application" needs
a command. If commands exist only inside the entry point, checking it means launching the process and
observing a terminal, which is a slow test that asserts on output rather than on the object graph. The
separation of assembly from the entry point only pays for itself if command registration is also
reachable without running the CLI.

Two further constraints come from earlier decisions. The CLI may not import implementations, so a
command module cannot build its own application — it must be given one. And disposal must happen on
both paths, which means a `finally`; repeating a `finally` in every command is a place to forget it,
and the failure would be a leaked handle that nothing reports.

No command exists yet. The decision is taken at the moment the mechanism would be written, which is the
only point at which it costs nothing.

## Decision

We will define a command as a value, and let one function turn values into framework commands.

A command is a `CommandDefinition`: a name, a one-line summary, and a `run` handler that receives a
`CommandContext` — the assembled application and the parsed global options — and returns a promise.

Definitions live beside each other in `src/cli/commands/` and are listed in a single `COMMANDS` array.
`createProgram` registers each of them, wrapping every handler in one lifecycle that builds the
application from an injected factory, calls the handler, and disposes the application in a `finally`.

The entry point supplies the registry and the factory. It does not name a single command.

## Consequences

**Easier**

- A command can be tested with a fake application and a synthetic argv. No process is spawned, no
  terminal is involved, and the assertion is about the object a handler received rather than about
  text on a screen.
- Disposal is written once, in one lifecycle, so no command can forget it and no command can implement
  it differently. A command that fails still releases what it opened.
- The entry point never grows. Adding a command is a new file and one array entry; the bootstrap is
  unchanged, which is what keeps it small enough to read in one sitting.
- The lifecycle is uniform: build, run, dispose, for every command. A behaviour added to that sequence
  — timing, a correlation identifier, a signal guard — reaches every command at once.
- Registration being data means a test can register an ad-hoc command to exercise the program itself,
  which is how the mechanism is verified before any real command exists.

**Harder**

- **One hop to find a command.** `program.command('run')` is discoverable by searching for the string;
  a registry entry is discoverable only by someone who knows the registry exists. The first reader of
  this CLI pays for that.
- `CommandContext` becomes a contract that every command shares. Adding a field to it changes every
  command at once, and there is no per-command escape hatch short of bypassing the mechanism
  entirely — which would then be invisible to the disposal wrapper.
- **Command-specific options are not modelled.** The framework's `.command()` builder is the natural
  place for declaring a command's own flags, and the current mechanism passes only a name and a
  summary. The first command with a flag will require extending this record's design, and that
  extension has not been designed.
- Every handler is asynchronous, including one that does nothing asynchronous, because the type says
  so. The alternative is two kinds of command distinguished by their return type, which is worse.
- The wrapper hides the moment the application is built. A command that needs to validate an argument
  before assembly — because assembly depends on it — has nowhere to put that check.
- A command cannot customise how its own failure is rendered. The entry point catches and renders, so a
  command's only lever is the error model itself.

**Neutral**

- The application is built once per command invocation rather than once per process. For the in-memory
  repository that is free; for a database-backed one it means opening and closing a connection per
  invocation, which is what a command-line tool does anyway.
- A handler returns nothing. Output goes through the output layer, so a command cannot accidentally
  return a value that a caller might mistake for a result.
- The registry is an array, so declaration order is the order commands are added — and help is sorted
  independently, so the order is not visible to users.

## Options considered

| Option                                                                         | Why not                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Write `.command()` calls directly in `src/cli/program.ts`                      | The framework's idiom, and one file to read. The handler then needs the application, disposal and the parsed options wired around it in place — repeated per command, or factored into a helper that turns the file into the place where commands live, which is what the previous record moved out |
| Write `.command()` calls in the entry point                                    | The arrangement the previous record rejected. The entry point's import is execution, so nothing about any command could be tested without running the process                                                                                                                                       |
| One module per command exporting a command that is already built               | Familiar to anyone who has used the framework, and it puts the option builder where it belongs. It loses on one specific point: wrapping the handler needs the assembly, which the CLI may not import — and disposal becomes per command again                                                      |
| Commands as data in a registry, turned into framework commands by one function | Chosen. The handler receives what it needs, disposal happens in one place, and a command is testable without a process                                                                                                                                                                              |
| Discover command modules from the filesystem at startup                        | More machinery than a command needs, and it makes the set of commands unknown until execution — the opposite of what a program's own metadata should be                                                                                                                                             |

## References

- `docs/development/cli-bootstrap.md` — the entry point contract and how to add a command
- `src/cli/contracts.ts` — `CommandDefinition`, `CommandContext`, `GlobalOptions`
- `src/cli/program.ts` — the single lifecycle every command runs inside
- `src/cli/commands/index.ts` — the registry
- ADR-0011, which separated assembly from the entry point and makes this decision possible
