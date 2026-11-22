# ADR-0015: Reserve standard output for command results

Date: 2026-11-21

## Status

Accepted

## Context

An earlier decision established what the two streams are for: standard output carries the command's
result, standard error carries diagnostics, and the logger never writes to the first. That record decided
where _logs_ go relative to _output_.

It did not decide where a success message, a note, a warning or a progress line goes, because when it was
written nothing produced one. The CLI had `--help`, `--version` and a single command whose output was
plainly a result.

A set of message utilities is now being added, and each kind needs a stream. The assignment is not
obvious. A success message reads like a result — "Project initialised" is the answer to what the user
asked for — and the instinct is to put it where the user is already looking.

The cost of getting it wrong is specific and arrives in two places. If a success message goes to standard
output, then a redirect captures a sentence where the user expected the answer, and a consumer piping the
output of a command that supports machine-readable results receives a human line before the document. The
parser fails on line one, and the report is "your tool emits invalid JSON" rather than "this command
prints a greeting".

Once a single message kind sits on standard output, every future command has to remember which kinds are
exempt. That is a list, and a list is a rule that will be misread.

The machine-readable case makes it sharper. Under a machine-readable mode, a message on standard output
is either a parse error or a line the consumer must skip. "Skip any line you cannot parse" is not a
contract anyone can rely on, and it is not a contract this project is willing to offer.

Nothing has been released, so no user has been surprised by either arrangement. The decision is made at
the moment the utilities are written, which is when it costs nothing.

## Decision

We will write only the command's result to standard output: human-readable lines from the result
renderer, or one JSON document when a machine-readable mode is requested.

Every other kind of output — success, note, warning, progress, error, and diagnostic logging — goes to
standard error.

The sentence that makes the assignment non-arbitrary: **a success message is commentary on the work, not
the work.** "Project initialised" describes something that was produced; what was produced goes on the
first stream, and the sentence about it goes on the second.

The rule is enforced structurally rather than by convention. The output module contains no function that
writes a message to standard output, and the entry point writes nothing directly.

## Consequences

**Easier**

- One rule with no exceptions, so no command has to remember which kinds are exempt.
- A redirect of standard output contains the answer and nothing else, for every command, without the
  caller filtering anything.
- Machine-readable output is exactly one document on one line, so a streaming consumer needs no
  buffering and no line-skipping.
- Raising the log level cannot change what a consumer receives, because neither messages nor logs share
  that stream.
- The whole contract can be tested by checking which of two streams received anything, which is two
  assertions rather than a formatting comparison.

**Harder**

- **A command that only reports success prints nothing on standard output.** Its message is on the second
  stream, so redirecting the first produces an empty file while the terminal shows a sentence. That reads
  as a defect to anyone accustomed to tools that announce success where they print results, and it will
  be reported at least once.
- A user redirecting only the first stream sees silence on success and the explanation on failure. That
  is coherent and it is initially surprising.
- The rule pushes against a strong convention. Many tools put human-readable status on standard output
  and reserve standard error for failures, and a reader will assume that arrangement until told otherwise
  — including a reader reviewing this code.
- Progress on the second stream means a caller capturing both gets them interleaved, and separating them
  becomes the caller's problem rather than the tool's.
- The decision depends on commands having a result worth protecting. A command with no machine-readable
  output at all gets no benefit from the reservation and pays its cost in full.
- **Nothing detects a violation.** A command that writes to standard output directly bypasses the output
  module, and no lint rule prevents it — the `no-console` rule catches `console.log` and not
  `process.stdout.write`.

**Neutral**

- Help and version write to standard output, and they are not exceptions: they _are_ the result of the
  command that was run.
- The error document under a machine-readable mode goes to the second stream, so a consumer reading only
  the first sees nothing when a command fails. That cost was recorded in the earlier decision and this
  record inherits it rather than creating it.
- Progress lines are unprefixed while other kinds carry a label. That is a formatting decision recorded
  in the output conventions, not part of this one.

## Options considered

| Option                                                                                 | Why not                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Messages on standard output, errors on standard error — the common convention          | The arrangement most users expect, and it puts a human sentence into every redirect and every machine-readable pipe. One exempt kind is enough to turn the rule into a list                                                     |
| Route by whether the stream is a terminal: results when piped, messages when displayed | Behaves well in both cases and produces two different contracts depending on where the output is going, so the same command means different things on a laptop and in a pipeline. Also needs terminal detection in every writer |
| A single stream, with messages formatted so they can be distinguished                  | Removes the question and makes every consumer responsible for the interleaving                                                                                                                                                  |
| Standard output for results only, everything else on standard error                    | Chosen. One rule, no exemptions, and the reservation is what makes a redirect meaningful                                                                                                                                        |
| Messages on standard output but suppressed in machine-readable mode                    | Solves the pipe case and leaves the redirect case, and suppression is a second rule to remember on top of the first                                                                                                             |

## References

- `docs/development/cli-output.md` — the conventions, including the message kinds and the machine-readable form
- `src/cli/output/report.ts` — the only functions that write to standard output
- `src/cli/output/messages.ts` — the only functions that write messages, all to standard error
- ADR-0005, which decided the streams' purposes and left messages unassigned
