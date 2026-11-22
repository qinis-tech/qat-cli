# ADR-0013: Register a command only when its capability exists

Date: 2026-11-21

## Status

Accepted

## Context

The product has an approved command inventory. It names more commands than exist: the ones for
initialising a project, running a suite, reporting, listing history, comparing two runs and
diagnosing a failure. One of them — describing the environment and the project — can already be
implemented, because discovery, the environment utilities and the error model exist.

The CLI now has a registry and a help system that reads it. That turns the registry into a public
statement: `qat --help` is the first thing anyone reads, and what it lists is what the tool appears to
be.

There is therefore a choice about what the registry contains, and both answers have a real cost.

Registering the whole inventory makes the help screen look like the product that was specified. It
also means that the first command a user types after reading help is one that does not work. That is
not a hypothetical ordering: reading help and then trying a command is the most natural thing to do,
so a stub fails at the precise moment trust is highest. Each stub would also need a definition, an
argument shape and examples, all of which will be wrong when the real command lands and all of which
would have to be revisited.

The error model makes the cost sharper. It draws a hard line between "the tool has a defect" and "the
tool is being used wrongly", and reserves an exit code for each. A stub has no honest code: it is
neither a defect nor a misuse, so it would have to borrow one and make the borrowed code mean two
things.

Against all of that, a help screen with one command on a tool with a seven-command roadmap looks
unfinished, and a reader comparing help against a specification will conclude the tool does less than
it does. That is a genuine cost, and it is the reason this is a decision rather than a formality.

Nothing has been released, so no user has yet been misled in either direction. The decision is taken
when the registry is first populated, which is the only point at which it is free.

## Decision

We will register a command when its handler does the thing the command claims, and not before.

No stubs, no placeholder handlers, no hidden commands for planned features. A command enters the
registry at the same moment its capability does.

A corollary that matters as much as the rule: **a command's registered scope must match what its
description says, not what its name suggests.** The one command registered today reports what the
tool can see and makes no attempt to diagnose or repair; its description says exactly that. A name
that implies more than the handler does is the same failure as a stub, one level down.

The inventory remains available in the documentation, where the gap between plan and capability is
visible as prose rather than implied by a help screen.

## Consequences

**Easier**

- Every command in `--help` works. What a user reads and what a user can run are the same list.
- No stub has to be maintained, argued about, or quietly deleted later. Each planned command is
  written once, when its dependencies exist.
- Exit codes stay honest. Nothing produces a code meaning "not built yet", because nothing is in that
  state, so no code has to acquire a second meaning.
- The distance between the plan and the tool is written down instead of being inferable from a help
  screen — and a reader who consults both learns something true rather than something flattering.
- A review of a new command is a review of the feature. Registration is one array entry, so there is
  nothing else in the change to argue about.

**Harder**

- **The help screen looks thin.** One command, on a tool whose roadmap names seven. Anyone judging
  capability from `--help` will under-estimate the project, and a first impression is hard to correct
  later.
- The roadmap has to be carried by documents, and documents are read less than `--help`.
- There is no artifact to point at when someone asks "does it do X yet?". The answer is prose in a
  document rather than a command that exists and says "not yet".
- **Nothing enforces the policy.** A contributor in a hurry can add a stub and no test objects: the
  registry tests assert that a command documents itself, not that it does anything. The rule is held by
  review, which is the kind of enforcement this project has spent considerable effort replacing
  elsewhere.
- The first command establishes what "capability exists" means, and the boundary is a judgement rather
  than a test. A command that works for one framework and not another is the obvious next question and
  has no answer here.
- Adding commands later means the help screen changes noticeably in a release, which users notice —
  a smaller version of the visibility problem that registering them all would have caused immediately.

**Neutral**

- The tool is pre-release, so no expectation exists to break in either direction.
- The registry is authoritative and the inventory document is a courtesy; if the document is not
  maintained it will drift, and the registry will be right.
- The first release's help screen is one line rather than a table, which is unusual for a tool and
  will be noticed.

## Options considered

| Option                                                                  | Why not                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Register the whole inventory with handlers that throw "not implemented" | Help looks complete immediately, and every stub fails on first use — exactly the moment the user trusted what the help said. Each also needs a definition, arguments and examples that will all be wrong once, and reviewed twice |
| Register the inventory but hide it from help                            | Nobody discovers them, so the stubs achieve nothing and the registry is dishonest in a quieter way                                                                                                                                |
| Register the inventory and mark each one "planned" in its own help      | Honest, and it still puts a command in the list that does nothing. The first-use failure is unchanged and now has an extra sentence in front of it                                                                                |
| Register only commands whose capability exists                          | Chosen. The help screen is smaller than the roadmap, which is a cost this project accepts in exchange for every listed command being true                                                                                         |
| Register nothing until the whole first release is complete              | Entirely honest, and it makes the tool appear to do nothing — understating it as badly as the first option overstates it, and leaving the help system with nothing to test against                                                |

## References

- `docs/development/cli-commands.md` — the inventory policy and the rules for adding a command
- `src/cli/commands/index.ts` — the registry, which is the authority
- ADR-0012, which made the registry a list of values and therefore a statement about the tool
- The approved command inventory
