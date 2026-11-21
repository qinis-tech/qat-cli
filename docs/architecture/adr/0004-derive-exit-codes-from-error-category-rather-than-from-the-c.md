# ADR-0004: Derive exit codes from error category rather than from the call site

Date: 2026-11-21

## Status

Accepted

## Context

Every failure path in a command-line tool must end in a process exit code. Node.js supplies a
default: an uncaught exception terminates the process with code 1.

That default is unusable here. QAT must report whether the tests it ran passed, and the only
number available to report that with is also 1. If an uncaught exception and a failing test
both exit 1, then a continuous integration job cannot tell "the change under test is faulty"
from "the tool is faulty" — and a CI job has only the number to work from, because it cannot
read an error message.

Nothing in the current codebase establishes the contract. There is a typed error taxonomy with
codes and categories, and there is an exit-code module, but the rule connecting them has only
been stated in prose. Without it recorded, the first contributor who needs a new failure mode
will choose a number locally, because that is the shortest path.

Two constraints from earlier decisions shape the answer. The error model lives in
`src/core/errors/`, which the module boundaries treat as an implementation layer the domain may
not import — so whatever the taxonomy is, it cannot reach into the domain. And the taxonomy is
a closed set of named categories, which is what allows the compiler to check that every one of
them is mapped.

An honest note on timing: no user has yet reported a wrong exit code. This is a decision made
before the pain it prevents has been observed. That is deliberate — the cost is small now and
the cost of retrofitting a contract across an established codebase is not — but it means the
argument rests on the shape of the problem rather than on evidence.

## Decision

We will derive the process exit code from the category of the error, and never from the call
site that raised it.

A raise site selects a typed error class. The class fixes a category. The category maps to an
exit code through a single table in `src/core/errors/exit-codes.ts`, expressed as a `Record`
over the category union so that adding a category fails to compile until it has been mapped.

The categories are a closed set of nine: user input, project, configuration, environment,
infrastructure, execution, storage, reporting and internal.

Exit codes are a closed set of six: 0 success, 1 tests failed, 2 invalid input, 3 environment
or infrastructure, 4 internal, 130 interrupted.

Exit code 1 is reserved for test failures and nothing else. `exitCodeForError` is incapable of
returning it, and a test asserts that no application error can.

A test failure is not an error and never enters this model. It is a completed execution with a
failed result, and the mapping from execution status to exit code belongs to the command, not
to the error taxonomy.

An unrecognised thrown value is wrapped as an internal error, preserving the original as
`cause`. It becomes exit code 4 and a generic message, never exit code 1.

## Consequences

**Easier**

- The exit-code contract is one table. A reviewer can audit it in seconds, and a change to it
  is visible in a diff rather than distributed across every module that raises or catches.
- A new failure kind cannot drift, because there is no number for a contributor to choose.
- The compiler enforces completeness: a category with no mapped exit code does not build.
- Recoverability is derivable from the class, so guidance can be produced automatically where
  it would otherwise be forgotten — which is how internal errors always tell the reader to
  report a defect rather than leaving them with nothing.
- Tests assert the property that matters, that no application error produces exit code 1,
  rather than asserting a table that could be updated to match a mistake.

**Harder**

- Raising a failure now requires a class and a category decision before any code runs. That is
  friction at the worst possible moment, and the temptation will be to throw a plain `Error`
  because it compiles. Nothing prevents it, and a plain `Error` silently becomes exit code 4 —
  a defect claim where there is no defect.
- The category set is closed, which is a real constraint rather than a formality. A failure
  mode that does not fit an existing axis — "the run completed but produced partial results",
  for example — cannot be expressed without extending the taxonomy, which means another record
  and a review of every existing classification.
- Nothing currently prevents a call site assigning `process.exitCode` directly. Only
  `process.exit()` is banned by lint. The contract is enforced by review for every path that
  does not go through the top-level catch.
- Exit code 130 exists in the exit-code union but is unreachable from the mapping, because an
  interruption is a signal rather than a classification. The union therefore contains a value
  the error model can never produce, and every reader has to be told that.
- The model lives in an implementation layer the domain may not import, so the domain carries
  plain-string error codes inside `ExecutionErrorInfo`. Two representations of "an error code"
  now exist, and keeping them aligned depends on the mapping being done where the error is
  raised rather than where the result is defined.

**Neutral**

- Exit codes 0–4 are a small, non-standard set. Shell conventions such as `sysexits` reserve
  64–78 for this purpose and were discarded, because a CI script branching on QAT's outcome
  cares about five cases and should not have to learn a taxonomy to read them.
- The stack is never rendered by default, which is a separate consequence of the same
  philosophy: the exit code and the message are both contracts with a machine and a person who
  cannot act on internals.
- The mapping from execution status to exit code is deliberately left to the command rather
  than folded in here, so the error taxonomy does not grow a dependency on the execution
  domain.

## Options considered

| Option                                                                               | Why not                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Choose the exit code at each raise site                                              | Local and obvious, and it drifts immediately. Two call sites reporting the same failure can disagree; auditing the contract means finding every assignment in the codebase; and a contributor adding a new path has no way to know what the existing ones chose |
| One generic error class carrying an `exitCode` field                                 | The same drift one level down. The field is filled in by the same person making the same judgement, and nothing catches a copy-paste between two failure kinds                                                                                                  |
| Numeric ranges alone, HTTP-style, with no categories                                 | A range can express severity but not recoverability, and it cannot be exhaustively checked by the compiler. The 4xx/5xx split answers "who is at fault" and not "who can fix it"                                                                                |
| Derive from a typed hierarchy whose category fixes both exit code and recoverability | Chosen. One place to change, compiler-enforced completeness, and the classification carries information a number cannot                                                                                                                                         |
| Exit 1 for every application error, with richer information in the message           | What most CLIs do, and it is exactly what makes them indistinguishable in CI. The message is not available to the caller that needs to decide whether to retry, page, or ignore                                                                                 |

## References

- `docs/architecture/error-model.md` — the model, the class table and the exit-code contract
- `src/core/errors/exit-codes.ts` — the mapping
- `src/core/errors/codes.ts` — codes, categories and recoverability classes
- `docs/architecture/module-boundaries.md` — why the error model is an implementation layer
- POSIX shell convention: 130 is 128 + SIGINT
