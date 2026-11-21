# ADR-0005: Separate diagnostic logs from user-facing output

Date: 2026-11-21

## Status

Accepted

## Context

QAT writes two kinds of text, for two different audiences, and they have nothing in common
except that both are produced while a command runs.

The first is the command's result: which suites ran, which tests failed, where the report was
written. Someone asked a question by running the command, and this is the answer. A pipeline
may parse it. A person may read it. Either way it is the output the command exists to produce,
and it should be stable enough that a contract can be written about it.

The second is diagnosis: which configuration file was resolved, how long an adapter took to
start, which spec was skipped. This is not the answer to anything — it is the reasoning behind
the answer, useful only when something needs explaining.

Nothing in the tooling forces a separation. Node makes it equally easy to write to either
stream, and the logging library in use defaults to standard output: its own default destination
is file descriptor 1. Adopting it without an explicit decision would therefore place
diagnostics in the middle of results, and the decision would have been made by a default rather
than by anyone.

Two earlier decisions make this relevant now. The error model already distinguishes rendering
for a user from serialising for a log, and deliberately keeps a stack trace out of the first
while retaining it in the second. And the result of a run is a structured record intended to be
consumed by reports, storage and diagnostics — which is only possible if it is not interleaved
with prose.

An honest note on timing: no user has yet reported a parsing failure caused by log output. This
is decided before the pain, because the cost of the decision is a convention and the cost of
retrofitting it is every command that already writes somewhere.

## Decision

We will treat standard output as the command's result and standard error as diagnostics, and
never mix them.

**stdout** carries the command's result, rendered by the CLI output layer. It is part of the
command's contract: stable across releases, stable regardless of log level, formatted for
reading or, under `--json`, one JSON document. Nothing else writes to it.

**stderr** carries diagnostics, produced by the logger. One JSON object per line, or
human-readable text in development. It is explicitly not a contract: it may change in any
release without a version bump, and no consumer should parse it.

The logger never writes to stdout, and the logger is never used to render a result. A failure
is not a result: an error message goes to stderr, because stdout is where the answer to a
successful question goes.

Where information seems to belong in both places, that is a question about what the command
reports — not a reason to emit it twice. Doubling is how outputs become unstable.

## Consequences

**Easier**

- A pipeline can parse the result without filtering. `qat run --json | jq` works because
  nothing else is on that stream.
- Output formatting becomes testable in isolation, without asserting anything about logging —
  and log verbosity can be raised for one user without changing what any user sees.
- A failing run and a noisy run are independent concerns. `--log-level debug` cannot alter the
  output a script depends on, which is the property that makes the flag safe to add.
- Tests can capture the two streams separately, so an assertion about a result cannot pass
  because of a diagnostic that happened to contain the same text.
- Redaction is confined to logs. Output is under the command's control by construction, so a
  command that prints a token has chosen to, rather than leaked it through a debugging
  convenience.

**Harder**

- A developer who wants to see the result and the diagnostics together must redirect stderr
  into stdout, and the two then interleave. That is a mild regression in everyday ergonomics
  in exchange for a guarantee about every other consumer.
- Every piece of information a command produces now requires a classification before it can be
  written: is this a result or a diagnostic? The answer is usually obvious and occasionally
  not, and the occasional ones will be argued about.
- A consumer reading only stdout sees nothing at all when a command fails. This is the
  significant ergonomic cost. Whether `--json` mode should emit a structured error document on
  stdout is an open question, and answering it would be a separate record.
- The logging library's default destination is the wrong stream, so any new transport or
  transport configuration has to be checked against this rule. A single default left unoverridden
  reintroduces the problem silently.
- Pretty printing in development adds a branch on whether the output is a terminal, and a
  branch that is only exercised locally is a branch that breaks unnoticed.

**Neutral**

- Logs are unversioned. Because they are not a contract, a log line can change shape whenever
  it is useful to change it, which is the point and also means nobody can build on it.
- Errors go to stderr in both modes, so the two-stream rule holds under `--json` as well as
  under human output. Only the _rendering_ of the error changes.
- Whether a destination is a terminal is a runtime property, so identical invocations can
  produce different log formats. That is acceptable for a diagnostic channel and would not be
  for output.

## Options considered

| Option                                                      | Why not                                                                                                                                                                                                                |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Everything to stdout, diagnostics included                  | What many tools do, and it makes every consumer responsible for filtering. It also means a logging change can silently break a parsing contract, because a logging change is not reviewed as a format change           |
| Everything to stderr, leaving stdout unused                 | Keeps stdout clean but makes the ordinary case — `qat report > results.txt` — write an empty file, which is worse than noise                                                                                           |
| Both on stdout, distinguished by a prefix or by shape       | Requires the consumer to know the prefix, and a consumer can never be certain it has read the whole result rather than the whole result so far. The prefix is also a permanent formatting constraint on every log line |
| Results on stdout, diagnostics on stderr                    | Chosen. Costs the developer a redirect and buys every consumer a guarantee                                                                                                                                             |
| No logs by default, with a `--log-file` flag to enable them | Puts diagnostics nowhere by default, so a user reporting a failure has nothing to attach unless they knew to ask for it first                                                                                          |

## References

- `docs/development/logging.md` — the conventions and the anti-pattern list
- `src/core/logging/logger.ts` and `src/core/logging/destination.ts` — where the stream choice is enforced
- `docs/architecture/error-model.md` — rendering for a user versus serialising for a log
- POSIX convention: standard output for results, standard error for diagnostics
- The logging library's default destination is file descriptor 1, which is why the default is overridden explicitly
