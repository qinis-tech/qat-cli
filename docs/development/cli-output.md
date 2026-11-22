# CLI Output

|               |                                                                                                                                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Status**    | Normative                                                                                                                                                                                                    |
| **Module**    | `src/cli/output/`                                                                                                                                                                                            |
| **Companion** | [cli-bootstrap.md](cli-bootstrap.md), [ADR-0005](../architecture/adr/0005-separate-diagnostic-logs-from-user-facing-output.md), [ADR-0015](../architecture/adr/0015-send-every-message-to-standard-error.md) |

How QAT talks to the person or the program on the other end of a command.

## 1. The rule

> **Standard output carries the answer. Standard error carries everything about producing it.**

| What                                | Stream | Function                                |
| ----------------------------------- | ------ | --------------------------------------- |
| The command's result, for a person  | stdout | `reportResult`                          |
| The command's result, for a machine | stdout | `reportResult` with `--json`            |
| Success message                     | stderr | `writeMessage(MessageKind.Success, …)`  |
| Note                                | stderr | `writeMessage(MessageKind.Note, …)`     |
| Warning                             | stderr | `writeMessage(MessageKind.Warning, …)`  |
| Progress                            | stderr | `writeMessage(MessageKind.Progress, …)` |
| Error                               | stderr | `reportError`                           |
| Diagnostic log                      | stderr | the logger, never these utilities       |

Three consequences worth stating, because each is a property someone will otherwise erode:

- A redirect of standard output contains the answer and nothing else: `qat doctor --json > out.json`.
- Raising the log level cannot change what a consumer receives on standard output, because the logger never writes there.
- A success message is commentary, not the answer, which is why it is on the second stream even though it sounds like a result.

## 2. Message kinds

| Kind     | Renders as         | Use for                                            |
| -------- | ------------------ | -------------------------------------------------- |
| Success  | `success: …`       | The command did what was asked                     |
| Note     | `note: …`          | Something worth knowing that is not a problem      |
| Warning  | `warning: …`       | Something unexpected that did not stop the command |
| Progress | _(no prefix)_      | A line describing what is happening now            |
| Error    | `error: <CODE>: …` | The command failed                                 |

Progress is unprefixed because the line is usually already a sentence about the work.

## 3. What is not done, and why

**No colour.** It needs terminal detection, a `--no-color` flag, an environment-variable convention, and a decision about `NO_COLOR` versus `FORCE_COLOR` — all before the first useful line of output. When someone reads the output and complains, not before.

**No symbols or box drawing.** A tick renders as mojibake in a Windows console using a legacy code page, and the failure is not obvious to the person who wrote it on a machine where it looked fine.

**No terminal control.** Every message and every result line is passed through `sanitiseForTerminal`, which removes escape sequences and control characters while keeping newlines and tabs. Text routinely arrives from a subprocess or a file, and a sequence that clears the screen can make a user believe output came from this tool.

**No wrapping.** The terminal wraps. Re-wrapping breaks greppability and produces different output at different widths, which makes an assertion about it a test of the terminal.

**No progress rewriting.** A line-based progress message appends; it does not overwrite with a carriage return. Overwriting needs TTY detection, corrupts a redirected log, and gains a spinner nobody asked for.

## 4. Machine-readable output

Under `--json`, the human lines are **absent**, not filtered or prefixed. Exactly one document is written to standard output, on one line, so a streaming consumer can read it without buffering.

Every `CommandResult` requires a `document`. Making it optional is how a command ends up with no `--json` support and nobody noticing until somebody pipes it.

Errors under `--json` are written to standard error as `{ "error": … }`. A pipeline reading standard output therefore sees nothing at all when a command fails — the cost recorded in ADR-0005, and the reason the exit code matters.

## 5. Sensitive information

The utilities cannot recognise a secret: they receive a string. Three rules sit upstream of them.

1. **Environment values are classified by name before they are read**, and a sensitive value is never placed in a message. See `core/environment`.
2. **Error context accepts primitives only**, so a caller cannot paste a response body into it. See `core/errors`.
3. **The logger redacts; the terminal does not.** Anything passed to `writeMessage` is displayed as given.

## 6. Rendering versus writing

| Function                                      | Returns                      | Tested by                                   |
| --------------------------------------------- | ---------------------------- | ------------------------------------------- |
| `renderMessage`                               | A line, without its newline  | Unit tests                                  |
| `renderResult`                                | The text for standard output | Unit tests                                  |
| `renderError`                                 | The text for standard error  | Unit tests                                  |
| `writeMessage`, `reportResult`, `reportError` | Nothing; they write          | The end-to-end suite, by running the binary |

The split exists so that a formatting assertion never needs a stream, a spy or a timing. An assertion on what a user sees is a comparison of two strings.
