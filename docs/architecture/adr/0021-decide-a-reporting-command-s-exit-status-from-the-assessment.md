# ADR-0021: Decide a reporting command's exit status from the assessment

Date: 2026-11-23

## Status

Accepted

## Context

The exit-code contract has one home. A code is assigned where a failure is raised, the category it belongs to decides the
status, and a table in `core/errors` is the only place that mapping exists. That arrangement is deliberate and it has
held: a caller that reads nothing but `$?` can rely on `2` meaning bad input and `4` meaning the machine is wrong,
without knowing which command produced it.

The command layer has a different rule, and it also holds: a handler writes its result to standard output and returns
nothing, so a command cannot accidentally hand a caller a value it might treat as a result. Errors propagate; the entry
point renders them and sets the status. Before the validation layer existed, these two rules agreed, because every
condition a project could be in produced an exception.

They no longer agree.

Validation answers per operation, and the operation a user can actually invoke is `inspect`, which is never blocked. A
directory with no framework configuration, two competing configurations, or a configuration in a format nothing reads is
_perfectly reportable_ — that is what inspection is for — and is simultaneously not runnable. The command that reports
has nothing to throw for any of those conditions. It has findings, and they are part of the answer.

So the reporting command has no error to raise and still has to fail. A continuous-integration check that runs `qat
doctor` before a suite is entitled to learn, from the exit status, that the project cannot be used; otherwise the check
passes on a repository where nothing will run. But the report has already said so, in detail, with codes and remedies,
on standard output. Both facts are true at once: **the command has failed, and the failure message has already been
printed.**

That combination is what the current contract cannot express. Printing and then throwing would say everything twice, on
two streams, with a script seeing one code and a reader seeing two explanations. Saying nothing and exiting zero makes
the command useless in the one place it is most valuable.

Three constraints bound the answer. A command must not set the process status itself: exiting is reserved for the entry
point, and a lint rule enforces it. A command must not compute: the verdict it would base a status on is already on the
assessment, decided by the layer that owns the rules. And whatever the status is derived from must be the same value the
report was rendered from, or the two can disagree — a report that reads `blocked` while the process exits `0` is worse
than either failure alone, because only one of the two is usually checked.

Nothing has been released. There is one command, and it is the one that needs this. The shape is cheapest to decide now,
before a second command inherits whatever it does.

## Decision

We will let a command return an exit status instead of raising one.

A handler's return type becomes `Promise<ExitCode | void>`. A reporting command derives its status from the assessment
through a pure mapping — ready and ready-with-warnings are success, blocked is invalid input — and returns it. A command
with nothing to declare returns nothing and is unaffected.

The status is recorded by the action wrapper in `program.ts`, after the handler has returned and the application has
been disposed, so nothing competes with it. The command layer still does not end the process; it records an intent, and
the entry point remains the only place that exits.

No error code is introduced per condition. The status is a category, and the reason is the finding codes already
rendered into the report. A project condition therefore produces one status, one report, and one stream: standard output.

Warnings exit zero. A warning is advice; a tool that fails on advice is a tool whose callers add `|| true`, at which
point it stops failing on blockers too.

For a command that intends to _act_ on a project, the refusal remains an error, raised by the gate as `QAT2005`. That is
a different question from reporting one, and it keeps a single code for "the project is unusable" without giving the
reporting command an exception to throw.

## Consequences

**Easier**

- The command that exists to explain a broken project can run on one. Until now it was the one command that refused.
- Output and status are derived from one value, so they cannot disagree. The report and `$?` are two readings of the same
  assessment, which is what makes a report that says `blocked` and a process that exits `0` structurally impossible
  rather than merely unlikely.
- A pipeline can fail without parsing prose, and can still read the prose when it wants to know why.
- The failure is written once. Nothing prints a report and then an error about the same condition, on a different
  stream, in a different vocabulary.
- A handler with nothing to declare is unchanged: `Promise<void>` still satisfies the return type.
- The mapping is one function of one field. Everything that decided _why_ the project is blocked is already on the
  findings, so the command has nothing left to judge.

**Harder**

- **The exit-code contract now has a second author.** A status can come from the error model _or_ from a command's
  return value. They agree on the category — a blocked project is invalid input either way — but nothing enforces that,
  and a future command could return a status the error model would never produce for that class of problem. The single
  table is still the reference; it is no longer the only source.
- **`process.exitCode` is written in two places**: the entry point's error path and the action wrapper's success path.
  They cannot both run, and a reader has to check that. The next person to add a third exit path will find two
  precedents rather than one rule.
- **Four codes stopped reaching standard error.** `QAT2001`, `QAT2002`, `QAT2003` and `QAT2004` were what `doctor`
  emitted for project conditions; those conditions now arrive as printed findings under `QAT-D` and `QAT-V` codes, with
  the same exit status of `2`. Anything matching on the old codes — a CI script, a troubleshooting document, an
  assertion — breaks, and the status it was checking does not.
- **A returned status that nobody applies is invisible.** A handler returning `InvalidInput` while the wrapper ignores
  the value produces a report ending `blocked` and a process exiting `0`. Nothing in a unit test notices; only an
  end-to-end assertion on `$?` does. The mechanism is one line in a file nobody edits.
- **The command now owns a policy.** "Warnings exit zero" is a judgement, and a defensible argument exists for the
  opposite: a project with an undeclared dependency is one a clean install will break. If that judgement is ever
  reversed, it reverses for every reporting command at once.
- **A user now reads two permanent vocabularies.** The report says `QAT-V001 error`; the error model says `QAT2005`. Both
  are permanent, both are quoted in bug reports, and the second one is reachable only from a command that acts — which
  does not exist. Today the second vocabulary is almost invisible, and it will not stay that way.
- **Every future reporting command inherits the decision.** It must decide what its own status means, and the default it
  will copy is this one — including the warning rule, which may not suit a command whose output is consumed by
  something stricter than a person.

**Neutral**

- Exit code numbers are unchanged. A blocked project is `2`, exactly as the four retired codes were, so a script that
  branches on the status keeps working while a script that greps the message does not.
- `void` rather than `undefined` in the return type. It looks untidy and is load-bearing: `Promise<void>` satisfies
  `Promise<ExitCode | void>` and does not satisfy `Promise<ExitCode | undefined>`. Tidying it breaks every handler with
  nothing to declare.
- The gate that raises `QAT2005` lives beside the validation rules rather than in the application contract, so it is
  reachable from the composition root and from tests and not from `src/cli`. The first command that acts will have to
  move it, which is the moment its message becomes part of the CLI's vocabulary.
- `discover` now has no caller among the commands. It remains the committed form for a command that executes, and its
  failure table remains the reference for what a project condition is called.

## Options considered

| Option                                                                          | Why not                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Print the report, then throw the gate error                                     | Says everything twice, on two streams, in two vocabularies. The reader gets a report and then an exception about the same finding, and a script gets one code while a person gets two explanations                                             |
| Never fail: always exit zero, and let the caller parse the report               | `doctor` becomes unusable in the one place it matters most, and every caller either parses prose or stops checking                                                                                                                             |
| Set `process.exitCode` inside the handler                                       | Puts the end of the process in the layer that does not own it. The lint rule reserving exiting for the entry point exists for this, and a handler that exits is untestable without a subprocess                                                |
| Inject a status sink on `ProgramDependencies`                                   | Defensible, and it is the fallback if the rule objects to the action wrapper writing the status. It costs a member every caller must supply, or an optional one that silently drops the status — the same invisible failure, moved one file up |
| Throw a dedicated "already reported" error that the entry point recognises      | Keeps one owner of `process.exitCode` and one exit path. It also adds an error type whose meaning is "do not print", which is a control-flow exception carrying a decision that is not exceptional                                             |
| Keep `doctor` on `discover` and accept that it cannot describe a broken project | The cheapest option, and it defeats the layer beneath it: the assessment exists so that a report can be produced for the projects that need one                                                                                                |
| Put the status mapping in the application contract                              | The CLI would import a policy it does not own, and a non-CLI consumer of the assessment would inherit an opinion about process statuses. Where a status comes from is a CLI decision                                                           |

## References

- `docs/development/cli-commands.md` — the handler contract, and the two ways out of a command
- `docs/development/cli-output.md` — the streams, and why a finding is a result rather than a message
- `docs/architecture/validation.md` — the gate and the per-operation verdict the status is read from
- `src/cli/program.ts` — the action wrapper that records the status
- `src/cli/output/diagnostics.ts` — `reportLines` and `exitCodeFor`, the two pure functions a reporting command uses
- ADR-0004, which derived exit codes from the error category and is the arrangement this record adds a second author to
- ADR-0015, which put every message on standard error and every result on standard output
- ADR-0018, which separated detection from validation and produced the verdict a status can be read from
- ADR-0020, which made readiness per operation and inspection never blocked — the decision that left this command with
  nothing to throw
