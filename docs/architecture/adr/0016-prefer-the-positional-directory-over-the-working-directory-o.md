# ADR-0016: Prefer the positional directory over the working-directory option

Date: 2026-11-21

## Status

Accepted

## Context

A command that works on a project has to know which directory. Three inputs can supply it: a positional
argument the command declares, the global working-directory option, and the directory the process was
started in.

With two ways to name the same thing, one has to win, and the answer is not obvious because both read as
deliberate. The working-directory option reads as "behave as though started here" — a scoping instruction
for the whole invocation, which argues for it winning. A positional argument names the subject of the
command — "this directory, for this command" — which argues for the same, from the other side.

The cost of choosing wrongly is not a crash. It is a confident wrong answer. If the option wins, then
`qat doctor ./typo --cwd .` reports on the current directory, succeeds, and says nothing about the typo the
user was trying to diagnose. If the argument wins, the same command says `./typo` is not a directory, which
is exactly what the user wanted to know.

That asymmetry is the whole argument. One arrangement answers the question that was asked; the other
answers a different question and reports success.

Two earlier decisions constrain the mechanics. Precedence is resolved in one place, before discovery runs,
so an invalid directory never reaches detection. And the resolution records which input it used, because a
failure that says "not a directory" without saying which of three inputs is not actionable.

Nothing has been released and the CLI has one command, so nobody has been surprised in either direction.
The decision is made while the rule is being written, which is when it costs nothing.

## Decision

We will let the positional argument win. `qat doctor ./a --cwd ./b` describes `./a`.

The option is a fallback: it applies when no argument was given. The process working directory applies when
neither was given.

**The option is a fallback, not a base.** When an argument is present the option is ignored entirely,
including as a place to resolve a relative argument from. `qat doctor ./x --cwd /repo` resolves `./x`
against the process directory, not against `/repo`. That is a consequence of one input replacing another
rather than the two interacting, and it is recorded here because it is the part most likely to surprise
someone.

The source of the resolved directory is recorded and named in every failure.

## Consequences

**Easier**

- A directory the user named is never silently discarded. A typo is reported rather than substituted with
  something that happens to work.
- The precedence is one table with three rows and exactly one implementation, so two commands cannot
  disagree about which project they are describing.
- The option keeps a clear meaning: a default for the invocation rather than an override of explicit
  input. A reader who understands that will predict the behaviour correctly.
- A test can make the wrong answer visibly wrong, by pointing the option at an empty directory and
  asserting that the command still finds the project named as an argument.
- A future command that declares no positional argument gets the option's behaviour with no special case.

**Harder**

- **The option is not absolute.** Someone who thinks of it as "the directory for this invocation" will
  expect it to win, and will be wrong once. That is the cost of the choice, and it is paid by the reader
  who did not consult this record.
- **The option is not a base either.** Supplying both and expecting the second to scope the first does not
  work. `--cwd` sets where relative paths resolve only when it is the answer, which is defensible and
  reads as a limitation the first time it is noticed.
- Two ways to name a directory remains one more than ideal. This record orders them; it does not remove
  the second one.
- The behaviour is asymmetric with the shell. `cd /a && qat doctor /b` uses `/b`, which is correct and
  looks strange in a sequence of commands that appear to be operating in `/a`.
- **Nothing prevents a command from resolving its own directory**, which would reintroduce exactly the
  divergence the shared resolver exists to prevent. There is no lint rule and no test that would catch it.
- The source-aware failure messages cost a field threaded through three layers, for a benefit visible only
  when something has already gone wrong.
- The rule does not apply to a command whose positional means something other than a project directory —
  a spec path, a search term, a report identifier. Those commands must not use the shared resolver, and
  nothing distinguishes them from the ones that must.

**Neutral**

- The option still affects nothing else. This record is about which directory a command looks at, not about
  what `--cwd` means elsewhere.
- The resolved directory is absolute and normalised, so every consumer receives the same kind of value
  regardless of whether it arrived as `.`, a relative path, or an absolute one.
- A command with no positional argument and no option falls back to the process directory, which is what a
  user typing `qat doctor` in a project expects and never thinks about.

## Options considered

| Option                                                                           | Why not                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The option wins, because it scopes the whole invocation                          | Reads well and silently discards an explicit positional. `qat doctor ./typo --cwd .` would diagnose the current directory and report success, which is the opposite of what was asked                                                                  |
| Supplying both is an error                                                       | Removes the ambiguity completely, and rejects a combination that is likely to be sensible: a path named relative to a chosen location                                                                                                                  |
| The argument names the subject and the option provides the base for resolving it | The most faithful reading of "behave as though started here": a relative argument would resolve against the option, so the two inputs interact rather than one replacing the other. A larger change than it appears, and deferred rather than rejected |
| The argument wins and the option is a fallback                                   | Chosen. One rule, stated in one table, with the odd interaction recorded rather than hidden                                                                                                                                                            |
| Only a positional argument, no global option                                     | The simplest possible rule. It also removes the only way to scope an entire invocation to one directory without repeating the argument on every command                                                                                                |

## References

- `docs/architecture/project-discovery.md` — the precedence table and the failure that names its source
- `src/project/working-directory.ts` — the resolver
- `src/core/application/ports.ts` — `WorkingDirectorySource`, and the resolver's place on the discovery port
- ADR-0011, for why the resolver is reached through a port rather than imported by a command
