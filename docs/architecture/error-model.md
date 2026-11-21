# Error Model

|                     |                            |
| ------------------- | -------------------------- |
| **Status**          | Normative                  |
| **Applies to**      | Every module that can fail |
| **Implementation**  | `src/core/errors/`         |
| **Public contract** | Exit codes, below          |

Every failure QAT can produce belongs to one of two kinds. Which kind it is decides
everything else: what the user sees, what the exit code is, and whether a reader is told to
fix something or to report a bug.

## 1. The two kinds of failure

|             | Expected                                                      | Unexpected                                                    |
| ----------- | ------------------------------------------------------------- | ------------------------------------------------------------- |
| What it is  | A condition the program anticipated                           | A defect in QAT                                               |
| Examples    | No project here, invalid configuration, Cypress not installed | `TypeError` from a wrong assumption, an escaping schema error |
| Carries     | Code, category, recoverability, usually remediation           | Nothing but a cause                                           |
| Rendered as | One actionable sentence                                       | One generic sentence plus guidance to report it               |
| Exit code   | 2 or 3                                                        | 4                                                             |

Conflating them is what produces tools whose output is a wall of stack for a typo in a
config file. Separating them is what produces a line that says what to do next.

## 2. Anatomy of an expected failure

| Element          | Purpose                                                             |
| ---------------- | ------------------------------------------------------------------- |
| `code`           | Permanent identifier, e.g. `QAT3002`. Never reused, never redefined |
| `category`       | Drives the exit code. Answers "which layer failed"                  |
| `recoverability` | Answers "who can fix it" — independent of category                  |
| `message`        | One actionable sentence. Not a stack, not JSON                      |
| `context`        | Chosen primitives attached by the raiser                            |
| `remediation`    | What to do next. Omitted when no action is available                |
| `cause`          | The original error. Never rendered by default                       |

## 3. The classes

Raise the narrowest class that fits. The category and recoverability are fixed by the class,
so choosing a class is choosing both.

| Class                         | Raise when                                                                | Category         | Recoverability | Exit |
| ----------------------------- | ------------------------------------------------------------------------- | ---------------- | -------------- | ---- |
| `InvalidArgumentError`        | The user typed something the command cannot honour                        | `user-input`     | UserActionable | 2    |
| `InvalidProjectError`         | Not a project, no framework detected, or an unsupported framework version | `project`        | UserActionable | 2    |
| `InvalidConfigurationError`   | Configuration missing or failing validation                               | `configuration`  | UserActionable | 2    |
| `MissingDependencyError`      | A required package is absent or not executable                            | `environment`    | UserActionable | 3    |
| `UnsupportedEnvironmentError` | Node.js major too low, unsupported platform or architecture               | `environment`    | Fatal          | 3    |
| `FilesystemError`             | Permission, missing path, no space                                        | `infrastructure` | Retryable      | 3    |
| `ProcessExecutionError`       | A child process could not start or produced nothing interpretable         | `infrastructure` | Retryable      | 3    |
| `FrameworkExecutionError`     | The framework could not run at all                                        | `execution`      | Retryable      | 3    |
| `StorageError`                | Persisting or reading records failed                                      | `storage`        | Retryable      | 3    |
| `ReportGenerationError`       | A report could not be generated or written                                | `reporting`      | Retryable      | 3    |
| `InternalError`               | Anything unexpected. Wraps, never invented                                | `internal`       | Fatal          | 4    |

### Why `MissingDependencyError` and `UnsupportedEnvironmentError` are separate

They share a category and differ only in recoverability, which sounds minor and is not. One
tells the reader to run an install command; the other tells them this cannot work on their
machine. A single class with a flag would make that choice opt-in at every call site, and
the default would become wrong for roughly half of them.

### Why an unsupported framework version is a project error

`frameworkUnsupported` is in the 2xxx range. Discovery established it by reading the
project, and it does not depend on the machine. An unsupported _runtime_ is the environment
case.

## 4. Codes

Ranges, by the thousands digit:

| Range | Meaning                                         |
| ----- | ----------------------------------------------- |
| 1xxx  | How the command was invoked                     |
| 2xxx  | The project                                     |
| 3xxx  | The configuration                               |
| 4xxx  | The environment                                 |
| 5xxx  | Infrastructure — filesystem and child processes |
| 6xxx  | Execution — the framework could not run         |
| 7xxx  | Storage                                         |
| 8xxx  | Reporting                                       |
| 9xxx  | Internal and unexpected                         |

**Codes are permanent.** A code's meaning never changes, and a withdrawn condition leaves its
code unused. This mirrors HTTP status codes: the value is a promise to whatever reads it, so
stability matters more than tidiness. Someone who searched for `QAT3002` last year must find
the same explanation this year.

Adding a code:

1. Append to the end of the relevant range. Never renumber, never reuse.
2. Add the value to that category's union in `codes.ts`.
3. Assign it at the raise site — the narrowed union makes a mismatched category a compile
   error.

## 5. Exit codes

The CLI's contract with automation.

| Code | Meaning                                             |
| ---- | --------------------------------------------------- |
| 0    | Success                                             |
| 1    | The tests ran and some failed                       |
| 2    | The command or its inputs were wrong                |
| 3    | The environment or infrastructure prevented the run |
| 4    | An unexpected internal error                        |
| 130  | Interrupted by a signal                             |

### 1 is reserved, and this is the point

`1` means "your code is broken". Nothing else may mean that.

A CI script distinguishes "the change under test is faulty" from "the tool is faulty" solely
by this number, because a CI script cannot read a stack trace. Spending `1` on a
configuration typo — which is what most CLIs do — destroys that distinction permanently and
silently: the build goes red, the developer investigates their own code, and the real problem
is a missing dependency.

`exitCodeForError` can never return `TestsFailed`. A test asserts it.

### Test outcomes are not errors

A failing test is a **completed execution with a bad result**. It never reaches the error
model. The mapping is:

| `ExecutionStatus` | Exit code |
| ----------------- | --------- |
| `succeeded`       | 0         |
| `failed`          | 1         |
| `errored`         | 3         |
| `cancelled`       | 130       |

`errored` means the tests never ran; `failed` means they ran and some disagreed. If this
mapping is ever collapsed — a failed assertion arriving at the error model — CI receives 3
instead of 1 and the distinction is gone.

This table is the CLI's responsibility and is not yet implemented; it belongs with the first
command that produces an `ExecutionResult`.

## 6. Writing a message

The message completes the sentence "QAT could not …". It states what failed and, where
useful, what was expected.

|      | Example                                            |
| ---- | -------------------------------------------------- |
| Good | `No Cypress project found in /repo/api.`           |
| Bad  | `Project detection failed.`                        |
| Good | `Unknown flag --headles. Did you mean --headless?` |
| Bad  | `Invalid arguments.`                               |
| Good | `environments.staging.baseUrl is not a valid URL.` |
| Bad  | `Validation error (3 issues).`                     |

Rules:

1. **Say what, not that.** "Project detection failed" tells the reader nothing they did not
   already know from the failure.
2. **One sentence.** If it needs three, the condition is too broad and should be split.
3. **No stack, no JSON, no framework phrasing.** Translate a library message; do not forward
   it.
4. **No trailing full stop on the tool name.** Not a rule anyone enforces, but consistent
   punctuation across messages is what makes a CLI feel composed rather than assembled.

## 7. Context

Attached with the `context` option. Rendered as `key: value`, sorted.

**Values are primitives only** — `string`, `number`, `boolean`. This is deliberate and not an
inconvenience to work around. Allowing objects invites passing a whole response body, a
client instance or a parsed configuration tree, which is how credentials and file contents
reach a log line. A caller has to choose what to record, visibly.

|      | Example                                                   |
| ---- | --------------------------------------------------------- |
| Good | `{ specPath: 'cypress/e2e/login.cy.ts', failedTests: 3 }` |
| Bad  | `{ config: resolvedConfiguration }`                       |
| Bad  | `{ response }`                                            |
| Bad  | `{ token: process.env.API_TOKEN }`                        |

Name keys for a reader: `specPath`, not `sp`.

## 8. Remediation

Omitted when no action is available. An empty instruction reads as one that was forgotten,
which is worse than none.

|      | Example                                              |
| ---- | ---------------------------------------------------- |
| Good | `Install it with npm install --save-dev cypress.`    |
| Good | `Set environments.staging.baseUrl in qat.config.ts.` |
| Bad  | `Check your configuration.`                          |
| Bad  | `Something went wrong.`                              |

The weakest link in the model is a message that is accurate and a remediation that is
useless, because it implies an action exists. Review remediation text as carefully as code.

`InternalError` gets guidance automatically through `INTERNAL_ERROR_HINT`. Every other
class gets one only if the raise site supplies it.

## 9. Rendering versus logging

Two representations, two audiences, never mixed.

| Function        | Audience     | Contains                                                             |
| --------------- | ------------ | -------------------------------------------------------------------- |
| `describeError` | The user     | Code, message, remediation, context. No stack, no cause              |
| `toLogObject`   | The log file | Code, category, recoverability, message, context. No stack, no cause |

Developer detail exists only under `describeError(error, { includeDiagnostics: true })`,
which is wired to `--debug` and nothing else. There is no configuration key for it: a setting
that silently switched it on would defeat the reason it is off. Debug output contains
absolute paths and file contents, so it must never be attached to a bug report
automatically.

## 10. The top-level catch

One place converts a caught value into output and an exit code. It lives in
`src/cli/index.ts`, the composition root, because it is the only place that may import the
output layer and the error model together.

```ts
try {
  await program.parseAsync(process.argv);
} catch (error) {
  const rendered = describeError(error, { includeDiagnostics: debugEnabled });
  outputError(rendered);
  process.exitCode = exitCodeForError(error);
}
```

Three things this does deliberately:

- **Accepts `unknown`.** `exitCodeForError` and `describeError` both take anything, so no
  narrowing or assertion is needed on the path that most needs to be correct.
- **Assigns `process.exitCode` rather than calling `process.exit()`.** Calling `exit()`
  truncates piped stdout, which loses the message the user needs, and it is banned by
  `no-process-exit` outside `src/core/process`. Assignment is allowed everywhere.
- **Never rethrows.** One failure produces one message and one code.

## 11. Anti-patterns

| Pattern                                                                       | Why it is wrong                                                                                                             |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `throw new Error(message)` in application code                                | Loses code, category and recoverability. Becomes exit code 4, which claims a defect that is not there                       |
| `throw new InternalError()` for a known condition                             | Internal means "we have a bug". Using it for a known condition hides a design gap and trains users to file bad reports      |
| Re-throwing a framework error unchanged                                       | Carries framework phrasing to the user and skips classification                                                             |
| Wrapping without `cause`                                                      | Discards the only detail a maintainer needs                                                                                 |
| Logging and rethrowing                                                        | Produces two log lines for one failure and, with a top-level catch, often three                                             |
| `catch {}`                                                                    | Silently swallows. If a failure is genuinely ignorable, say so in a comment and narrow the catch to the expected error type |
| Adding a class that shares category _and_ recoverability with an existing one | A name without information. The list stops being a decision aid                                                             |
| Exiting with 1 to mean "something went wrong"                                 | Destroys the only distinction CI can make                                                                                   |

## 12. Adding a class

1. Confirm it needs a different exit code **or** a different recoverability. If neither, use
   an existing class with a new code.
2. Add the code to the right range in `codes.ts`, and to the category's union.
3. Add the class to `errors.ts`, fixing category and recoverability, narrowing `code`.
4. Add a row to the classification table in `errors.test.ts`. That table is the
   specification; a class without a row is an untested decision.
5. Add a row to the table in §3 of this document.
6. If the class carries its own exit code, update §5.

## 13. References

- `src/core/errors/` — implementation
- `docs/architecture/module-boundaries.md` — why the error model imports nothing
- `docs/development/code-standards.md` — `preserve-caught-error`, `only-throw-error`,
  `no-process-exit`
- ADR-0005, for why exit codes derive from category rather than from the call site
