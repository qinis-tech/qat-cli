# Logging Conventions

The logger writes diagnostics to **stderr**. The command's result goes to **stdout** through
the output layer. These are different audiences with different contracts and must not be
mixed.

## 1. Output is not a log, and a log is not output

|           | Output                                      | Logs                                                                                  |
| --------- | ------------------------------------------- | ------------------------------------------------------------------------------------- |
| Stream    | stdout                                      | stderr                                                                                |
| Audience  | The user, and whatever consumes the command | Whoever is debugging                                                                  |
| Stability | Part of the command's contract              | Not a contract; may change                                                            |
| Format    | Rendered, human-readable or `--json`        | One JSON object per line                                                              |
| Example   | `3 suites, 41 tests, 2 failed`              | `{"level":"info","component":"cypress-adapter","runId":"…","message":"spec started"}` |

The rule that follows: **a pipeline consuming stdout must never see a log line**, and a user
reading a result must be able to ignore stderr entirely. If something belongs in both, that is
a question about what the command reports, not a reason to emit it twice.

Using the logger as the output layer is the specific failure to avoid: it makes the output
unstable, unformatted, and impossible to parse.

## 2. Levels

| Level   | Use for                                                      | Emitted by default |
| ------- | ------------------------------------------------------------ | ------------------ |
| `trace` | Diagnosing the logger or a transport itself                  | No                 |
| `debug` | Decisions the reader would need while investigating a report | No                 |
| `info`  | Normal lifecycle milestones: run started, suite finished     | Yes                |
| `warn`  | Something unexpected that did not stop the run               | Yes                |
| `error` | A failure the user will be told about                        | Yes                |
| `fatal` | The process is about to exit                                 | Yes                |

`trace` is almost never correct in application code. `fatal` is used once, at the top level,
immediately before the process exits — by that point there is no second chance to report.

Choose the level by asking who would act on the entry: nobody (`trace`), a maintainer
investigating a report (`debug`), a person watching the command (`info`), or someone who needs
to know something went wrong (`warn`/`error`).

## 3. Context

Bind it once, at the edge:

```ts
const logger = createLogger({ level, destination })
  .forComponent("cypress-adapter")
  .forRun(request.executionId);

logger.info("spec started", { specPath });
```

`component` and `runId` are bound to every entry from that logger and are what make a log file
searchable after the fact. Neither should be passed per call.

Context values should be primitives where possible. `specPath`, `durationMs`, `attempt` are
useful; a whole configuration object is not.

## 4. Redaction

Configured in `redaction.ts`, applied by the logger. It censors named fields at the top level
and one level deep, plus HTTP-shaped headers.

**Redaction is a safety net, not a guarantee.** Path matching is finite and cannot recognise a
secret in an unexpected place. The primary defence is upstream: `ErrorContext` accepts
primitives only, so a caller must choose what to record instead of passing an object wholesale.

Do not add a path and consider the problem solved. If a value is secret, stop logging it.

## 5. Errors

Log the error object; do not stringify it.

```ts
logger.error("spec execution failed", { err: error, specPath });
```

Pino serialises `err` with type, message and stack. Unlike `describeError`, which renders for a
user and deliberately omits the stack, a log is for someone diagnosing — the stack belongs
there.

For an `ApplicationError`, `toLogObject()` gives the structured form without a stack:

```ts
logger.error("command failed", { err: error, ...error.toLogObject() });
```

## 6. Configuration

| Source          | Precedence |
| --------------- | ---------- |
| `--log-level`   | Highest    |
| `QAT_LOG_LEVEL` | Middle     |
| `info`          | Default    |

An invalid flag value is rejected as a user-input error. An invalid environment value is
ignored — a mistyped variable must not stop a run.

## 7. Destinations

| Environment               | Destination                                         |
| ------------------------- | --------------------------------------------------- |
| Production                | JSON to stderr                                      |
| Development, TTY detected | `pino-pretty` to stderr, if the module is installed |
| Tests                     | An in-memory capture passed to `createLogger`       |

`pino-pretty` is a development dependency, loaded lazily. If it is absent — which is the case
for anyone who installed QAT — the loader falls back to JSON and says so, once.

## 8. Logging must never break a command

The destination is wrapped so a write failure cannot propagate. The failure this prevents: a
log call inside a catch block throws because a pipe is closed, and the user sees a logging
failure instead of the reason their run failed.

If writing a log entry fails, the failure is reported once to stderr and the entry is dropped.
The command continues.

## 9. Testing

```ts
const lines: string[] = [];
const logger = createLogger({
  destination: { write: (chunk) => lines.push(chunk) },
});
```

Assert on the parsed JSON, not on mocked method calls — a mock passes while the output is
malformed.

## 10. Anti-patterns

| Pattern                                       | Why                                                                       |
| --------------------------------------------- | ------------------------------------------------------------------------- |
| `logger.info` used to print a result          | Output belongs on stdout. The logger is diagnostic                        |
| Logging the same thing at two levels          | Doubles the noise and makes filtering useless                             |
| `logger.error` and rethrow                    | Produces two entries for one failure once the top-level catch logs it too |
| Logging inside a tight loop                   | Dominates the log and the runtime. Log a summary                          |
| Passing a whole config or response as context | Redaction will not save you, and the log becomes unreadable               |
| `trace` in application code                   | It exists for diagnosing the logger itself                                |
| Stringifying an error into the message        | Loses the stack and the structured `err` field                            |
