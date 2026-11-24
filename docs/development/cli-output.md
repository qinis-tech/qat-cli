# CLI Output

|               |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**    | Normative                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Module**    | `src/cli/output/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Companion** | [cli-bootstrap.md](cli-bootstrap.md), [validation.md](../architecture/validation.md), [configuration-defaults.md](../architecture/configuration-defaults.md), [path-resolution.md](../architecture/path-resolution.md), [ADR-0005](../architecture/adr/0005-separate-diagnostic-logs-from-user-facing-output.md), [ADR-0015](../architecture/adr/0015-send-every-message-to-standard-error-and-only-results-to-sta.md), [ADR-0021](../architecture/adr/0021-decide-a-reporting-command-s-exit-status-from-the-assessment.md) |

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
| Failure of the command              | stderr | `reportError`                           |
| Diagnostic log                      | stderr | the logger, never these utilities       |

Three consequences worth stating, because each is a property someone will otherwise erode:

- A redirect of standard output contains the answer and nothing else: `qat doctor --json > out.json`.
- Raising the log level cannot change what a consumer receives on standard output, because the logger never writes there.
- A success message is commentary, not the answer, which is why it is on the second stream even though it sounds like a
  result.

## 2. Message kinds

| Kind     | Renders as        | Use for                                            |
| -------- | ----------------- | -------------------------------------------------- |
| Success  | `success: …`      | The command did what was asked                     |
| Note     | `note: …`         | Something worth knowing that is not a problem      |
| Warning  | `warning: …`      | Something unexpected that did not stop the command |
| Progress | _(no prefix)_     | A line describing what is happening now            |
| Error    | `error <CODE>: …` | The command failed                                 |

Progress is unprefixed because the line is usually already a sentence about the work.

**`reportError` lives beside `writeMessage`**, in `messages.ts`, because it is the same kind of thing: commentary about
a run, written to the second stream, filtered the same way. It differs only in having a code and a second, structured
form.

## 3. A finding is a result, not a message

A finding about the project goes to **standard output**, as part of the report, even when its severity is `error`.

This looks like a contradiction of §1 and it is not. Two things were being conflated:

|               | What it is                                                                        | Stream | Function           |
| ------------- | --------------------------------------------------------------------------------- | ------ | ------------------ |
| A **failure** | The command could not do its job: a bad argument, a directory that does not exist | stderr | `reportError`      |
| A **finding** | The command did its job and the answer is "this project cannot be run"            | stdout | part of the result |

`qat doctor` on a broken project exits `2` and writes **nothing** to standard error. The failure is the report. That
separation is the entire reason a detection command can run on the projects that need detecting, and it is what lets a
caller distinguish "this command found something to say" from "this command broke".

The temptation to "fix" this — moving a finding to standard error because it says `error` — reinstates exactly the
behaviour the assessment layer was built to remove. Findings are data; a failure is an event.

## 4. What is not done, and why

**No colour.** It needs terminal detection, a `--no-color` flag, an environment-variable convention, and a decision
about `NO_COLOR` versus `FORCE_COLOR` — all before the first useful line of output. When someone reads the output and
complains, not before.

**No symbols or box drawing.** A tick renders as mojibake in a Windows console using a legacy code page, and the
failure is not obvious to the person who wrote it on a machine where it looked fine.

**No terminal control.** Every message and every result line is passed through `sanitiseForTerminal`, which removes
escape sequences and control characters while keeping newlines and tabs. Text routinely arrives from a subprocess or a
file, and a sequence that clears the screen can make a user believe output came from this tool. The filter applies to
an error's message, its details and its remediation as well — those are the values most likely to carry foreign output.

**No wrapping.** The terminal wraps. Re-wrapping breaks greppability and produces different output at different widths,
which makes an assertion about it a test of the terminal.

**No progress rewriting.** A line-based progress message appends; it does not overwrite with a carriage return.
Overwriting needs TTY detection, corrupts a redirected log, and gains a spinner nobody asked for.

**No tables or frames.** A grid of pipes looks deliberate and breaks the moment a path is longer than the column. Two
spaces and a fixed label column do the same job and stay greppable.

## 5. The report shape

A command that reports a structured result renders it through **one** presenter, in `src/cli/output/diagnostics.ts`,
rather than building strings in its handler. One module means one answer to "what does QAT's report look like", and a
command stays the handful of lines that decide _when_ to print.

The report has three blocks: the summary, the output locations, and the findings. The middle one is present only when the
project has a configuration to resolve.

### The summary

Nine labelled lines, in a fixed order:

```
project    demo
root       /repo/packages/api
package    present
framework  cypress 13.15.0 (project install)
declared   devDependencies (^13.15.0)
config     cypress.config.ts
detection  detected
compatibility consistent
result     ready
```

| Rule                                                | Why                                                                                                                                                                                 |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Labels are padded to ten columns, then one space    | Computed, not typed: a longer label added later cannot misalign the eight beside it. A label wider than the column takes a single space and pushes its value right                  |
| Absent facts are stated, not omitted                | `framework  cypress (not installed)`, `config     (none)`, `declared   nowhere in this package`. A line that disappears makes "nothing there" indistinguishable from "not reported" |
| The verdict is last                                 | It is the conclusion the lines above argue for, and the one line a script or a reader looks for                                                                                     |
| `result` is printed from the gate, never recomputed | The presenter lays out; it does not decide. A presenter that recomputed readiness would agree today and diverge the moment a rule changed                                           |

### The output locations

Where a run would write, and against which environment:

```
reports    /repo/packages/api/results/reports
evidence   /repo/packages/api/results/evidence
env        staging (from defaultEnvironment)
```

| Rule                                                    | Why                                                                                                                                                                                                                              |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Absolute paths only, never the configured form          | The reader can see what they wrote by opening the file they just edited. What they cannot see is where the tool decided to land                                                                                                  |
| The block is present only when a configuration resolved | A project with no configuration has no output location. Inventing one would tell a reader their reports are going somewhere they are not, and absence then means "not known" rather than "the usual place"                       |
| `env` states which environment, and how it was chosen   | Four derivations, four sentences. "The only one declared" tells an operator that a second environment will stop this being automatic, and "none selected" says what to do — that sentence is the one thing here that saves a run |
| The same label appears in two blocks                    | `config` in the summary names the framework's configuration file; `config` here gives the anchored location of one, and only when the configuration supplied it. Both answer "which file", at two different levels of detail     |
| No `form` or containment flags                          | They describe how an anchor was decided, which is a detail for the resolver and its tests. A writer needs the path                                                                                                               |

### The findings

One block per condition, blocking conditions first, then warnings:

```
QAT-V001 error
  A Cypress configuration was found at cypress/cypress.config.ts, where Cypress does not load it.
  at:  cypress/cypress.config.ts
  fix: Move it to the project root as cypress.config.ts.
```

| Rule                                                        | Why                                                                                                                                    |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| The code and the severity share the first line, code first  | The code is what gets quoted in a bug report and grepped by a script; the severity is what tells a reader whether to keep reading      |
| The detail lines are indented two spaces; the header is not | The codes form one scannable column while their sentences hang beneath them. With two conditions in a report this stops being cosmetic |
| `at:` and `fix:` are omitted when absent                    | A line reading `at: (none)` is noise, and a consumer should be able to tell "no file" from "a file with an unhelpful name"             |
| One blank line between blocks, and between severity groups  | A reader who stops after the first block has still read the reason the command failed                                                  |
| No blank line when there is nothing to report               | A clean report is the summary plus the output block, and no findings — which is what makes it recognisably clean                       |

**Plain ASCII throughout.** No em dash, no arrow, no bullet: each renders correctly in a document and as mojibake in a
console using a legacy code page, and the reader who gets a broken character has no way to tell whether the tool is
broken. A colon and two spaces cost nothing.

## 6. Machine-readable output

Under `--json`, the human lines are **absent**, not filtered or prefixed. Exactly one document is written to standard
output, on one line, so a streaming consumer can read it without buffering.

Every `CommandResult` requires a `document`. Making it optional is how a command ends up with no `--json` support and
nobody noticing until somebody pipes it.

**The document is the contract, not a presentation of it.** `qat doctor --json` emits the assessment itself, wrapped in
the document envelope:

```json
{
  "assessment": {
    "diagnosis": {
      "identity": {},
      "framework": {},
      "detection": "detected",
      "compatibility": "consistent",
      "findings": []
    },
    "findings": [],
    "requirements": [],
    "gates": { "inspect": {}, "execute": {} },
    "configuration": {
      "reportsDirectory": {
        "source": "results/reports",
        "absolute": "/repo/packages/api/results/reports"
      },
      "evidenceDirectory": {
        "source": "results/evidence",
        "absolute": "/repo/packages/api/results/evidence"
      },
      "environment": { "origin": "configured", "name": "staging" }
    }
  }
}
```

A consumer parses the same shapes the command read, so a field added to the assessment appears without the document
changing shape. A presentation would have to be kept in step by hand, and would be the copy that lagged.

`configuration` is **absent** — not `null`, not an empty object — when the project has no configuration to resolve. A
consumer can therefore tell "not known" from "the usual place", which is the same distinction the human report makes by
omitting the block rather than printing `(none)`.

Errors under `--json` are written to standard error as `{ "error": … }`. A pipeline reading standard output therefore
sees nothing at all when a command _fails_, while a command that _reports_ a blocking condition writes its document to
standard output and exits non-zero — see §3.

## 7. Sensitive information

The utilities cannot recognise a secret: they receive a string. Three rules sit upstream of them.

1. **Environment values are classified by name before they are read**, and a sensitive value is never placed in a
   message. See `core/environment`.
2. **Error context accepts primitives only**, so a caller cannot paste a response body into it. See `core/errors`.
3. **The logger redacts; the terminal does not.** Anything passed to `writeMessage` is displayed as given.

The terminal sanitiser removes control characters, not secrets. It is a defence against a forged line, and it is not a
substitute for any of the three.

One further rule now arrives from the path layer: a configured value that looks like a URL is described rather than
repeated, because userinfo is the one place a path-shaped string routinely carries a credential. That decision is made
where the message is authored, in `resolver/paths.ts`, so this module inherits it without doing anything.

## 8. Rendering versus writing

| Function                                      | Returns                            | Tested by                                   |
| --------------------------------------------- | ---------------------------------- | ------------------------------------------- |
| `renderMessage`                               | A line, without its newline        | Unit tests                                  |
| `renderResult`                                | The text for standard output       | Unit tests                                  |
| `renderError`                                 | The text for standard error        | Unit tests                                  |
| `reportLines`                                 | The lines of a report, as an array | Unit tests                                  |
| `configurationLines`                          | The lines of the output block      | Unit tests                                  |
| `exitCodeFor`                                 | A status, and no text at all       | Unit tests                                  |
| `writeMessage`, `reportResult`, `reportError` | Nothing; they write                | The end-to-end suite, by running the binary |

The split exists so that a formatting assertion never needs a stream, a spy or a timing. An assertion on what a user
sees is a comparison of two strings.

`reportLines` returns lines rather than writing them, which is what lets the report shape be pinned with literal
expected strings in a unit test — including their spacing — and lets a future generator reuse the presentation. Its
siblings are pure decisions of the same kind: `configurationLines` renders one block from one value, and `exitCodeFor`
returns a status. A command that reports does not throw, so its failure is expressed by a value rather than by an event.

## 9. Known gaps

Two, both deliberate and both recorded rather than discovered later.

**A configuration that exists but is invalid contributes no finding.** The assessment attaches a resolved configuration
when the file loads, and nothing when it does not — so `qat doctor` on a project whose `qat.config.json` is malformed
reports no output block and no finding about it. Closing that means merging the loader's diagnostics into the
assessment's gate, which decides the exit status and therefore belongs with the validation layer.

**Path refusals are therefore reachable only through validation.** An escaping or absolute output path is refused by the
schema while the document is read, so it appears as an ordinary configuration diagnostic — and that diagnostic has no
route into the report yet, for the same reason as the entry above.
