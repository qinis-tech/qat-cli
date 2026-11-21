# ADR-0007: Treat a non-zero exit code as a result, not an error

Date: 2026-11-21

## Status

Accepted

## Context

QAT has to invoke external programs. The first is the Cypress CLI; later it will be other test
runners, package managers and possibly browsers. Whatever runs them has to answer one question
afterwards: what happened?

The operating system gives a child process exactly one way to answer. It exits with a number. If it
does not exit — killed by a signal, never started, terminated for exceeding a limit — there is no
number at all. Those are the only two possibilities, and they mean very different things.

The convention in the Node ecosystem is to treat a non-zero exit as an exception. `exec` throws,
and the most common wrapper library throws by default. That convention makes the ordinary case
awkward: a test run in which some tests fail is exactly what the tool exists to report, and it
would arrive as an exception the caller has to catch in order to read a number it expects most of
the time.

It also collapses a distinction the project has already committed to. The CLI's exit-code contract
reserves `1` for "the tests ran and some failed" and permits nothing else to mean that, because a
continuous integration job reading only the number cannot otherwise tell a failing test from a
failing tool. That contract is only implementable if the layer invoking Cypress can tell the two
apart — and it cannot, if both arrive as an exception of the same shape.

The process layer's job is to report facts: the exit code, the output, the duration. What a
particular number means is knowledge about Cypress, and belongs to the adapter that knows about
Cypress.

No user has yet encountered a misreported outcome here, because nothing invokes anything yet. The
decision is made before the pain, which is the only time it is cheap.

## Decision

We will return a non-zero exit code as part of the result, and reserve exceptions for the case where
no exit code was produced.

`runProcess` returns a `ProcessResult` containing the exit code whenever the child produced one,
regardless of its value. It throws a `ProcessExecutionError` only when there is no exit code: the
executable was not found, was not executable, exceeded its time limit, was cancelled, was killed by
a signal, or produced more output than the configured cap.

Two corollaries follow, and both are load-bearing:

- **The result's `exitCode` is a `number`, not `number | undefined`.** A result cannot carry an
  unknown outcome, so the question "did it run at all?" is answered by whether a result exists
  rather than by inspecting a field inside one.
- **The process layer interprets nothing.** It does not know that `1` means failing tests, or that
  Cypress uses particular codes for configuration errors. Interpretation belongs to the adapter
  that knows the framework.

## Consequences

**Easier**

- The common case is not an exception. Reading `result.exitCode` needs no `try` block, and a
  sequence of commands can be written without nesting error handling around each one.
- The two outcomes are structurally distinct in a way a caller cannot accidentally confuse. Wrapping
  the call in `catch` means handling "could not run". Reading `exitCode` means handling "ran and
  answered". Neither accidentally performs the other's job.
- The Cypress adapter can map framework exit codes onto execution status without working through an
  exception hierarchy first — which is what makes the CLI's own exit-code contract implementable at
  all.
- Tests become one assertion instead of a matcher against a thrown object, and failures read as
  numbers rather than as error messages that have to be parsed.
- A failed run still carries its captured output, so diagnosing it does not require a second
  invocation.

**Harder**

- **A caller that ignores `exitCode` treats a failed run as a success.** This is the real hazard of
  the decision and it cannot be prevented by the type system: the field is an ordinary number, and
  a caller that only reads `stdout` will silently accept a failure. The mitigation is documentation
  and review, which is exactly the kind of mitigation this project has otherwise tried to replace
  with a check.
- Every consumer has to decide what a non-zero code means, and no single place does that. The policy
  is distributed across adapters. That is deliberate — only the adapter knows the framework — but if
  several adapters exist, the shape of the mapping is repeated and can diverge.
- The boundary between "killed by a signal" (an error) and "exited non-zero" (a result) is subtle.
  A reader can reasonably expect both to be errors, and will not discover otherwise without reading
  this record or the code.
- Anyone familiar with `child_process` or with the wrapping library's defaults will assume the
  opposite behaviour. The code passes an option that inverts a default, and that option is the only
  thing making every other statement in the module true.
- A caller that wants the conventional behaviour has to build it, and a caller that builds it badly
  can throw away the captured output while throwing.

**Neutral**

- The result carries `stdout` and `stderr` as strings even for a failed run. Uniformity here is what
  makes diagnosis possible, and it costs nothing for a caller that ignores them.
- There is no partially-successful category. A process that ran for twenty minutes and was then
  stopped is an error, not a result with a footnote — the caller learns nothing from an exit code it
  does not have.
- The distinction survives only as long as the library option implementing it holds. A test asserts
  that a non-zero exit returns rather than throws, so a library change would be caught rather than
  silently inverted.

## Options considered

| Option                                                           | Why not                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Throw on any non-zero exit, as the ecosystem convention does     | Makes the ordinary case an exception, forcing every caller to use error handling to read a number it expects to receive. It also collapses "the tests failed" and "the tool broke" into one error type unless every call site unwraps carefully                                                              |
| Return a result with a nullable exit code                        | Pushes the ambiguity into every caller: `if (exitCode === undefined)` becomes load-bearing, and a caller that skips it treats an unknown outcome as an ordinary number. Making the field non-nullable and moving the unknown case onto the error path carries the same information with a guarantee attached |
| Return a result with an explicit `failed: boolean`               | Duplicates `exitCode !== 0`, giving two fields that can disagree. It also does not distinguish "ran and failed" from "never ran", which is the distinction that actually matters here                                                                                                                        |
| Return a result when an exit code exists, throw when it does not | Chosen. The type guarantees that a result has an exit code, so the question of whether the child ran is answered by the shape of what came back                                                                                                                                                              |
| Offer both behaviours behind an option                           | The option would be set at whichever call site needed it most and left inconsistent elsewhere. One contract stated once is cheaper to teach than two stated badly                                                                                                                                            |

## References

- `src/core/process/contracts.ts` — `ProcessRequest`, `ProcessResult`
- `src/core/process/run.ts` — where the library default is inverted
- `docs/architecture/error-model.md` — why exit code 1 is reserved for test failures
- ADR-0004 — the exit-code contract this decision makes implementable
- Node's `child_process.exec` and the wrapping library's default `reject: true`, as the convention being declined
