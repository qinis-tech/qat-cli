# Configuration Precedence

One value can arrive from four places. When more than one supplies it, this is the order that
decides.

| Order | Source               | Scope                   | Set by                         |
| ----- | -------------------- | ----------------------- | ------------------------------ |
| 1     | Command-line flag    | This invocation         | The person running the command |
| 2     | Environment variable | This process            | A shell, a CI job, a container |
| 3     | Configuration file   | This project, over time | Whoever committed it           |
| 4     | Built-in default     | The tool                | Nobody                         |

The rule behind the order: **the narrower the scope, the more deliberate the act, and the more
deliberate the act the more it should win.** A flag exists for one command. An environment variable
is set for one machine or one pipeline. A configuration file is shared and long-lived. A default is
nobody's decision.

## Environment above file, specifically

This is the part people argue about, so it is recorded separately in a decision record.

A configuration file is committed and shared; changing it is a review. An environment variable is
set by whoever is running the command, right now, and is the standard mechanism for a CI job or a
container to override a committed value without editing it. Putting the file first would mean the
only way to override a committed setting is to edit code and push — which is not an override.

## Empty is not the same as absent

`NAME=` is not `NAME` unset. The variable utilities distinguish three states — present, empty,
missing — so a caller can act on the difference.

The **precedence resolver treats empty as absent**, and only there. A shell that exports `NAME=` is
far more often passing on a blank it inherited than instructing the tool to use nothing, and a
parser handed an empty string can only report a problem the operator did not create. A caller that
needs the distinction asks the variable utilities directly.

## Validation

Each level supplies a value of the right type or an error. The environment's parser is supplied by
the caller that knows what the setting means, and it raises its own error with its own remediation —
a malformed environment value is a configuration problem, and reporting it as "invalid" without
saying what would be valid leaves the reader guessing.

## Secrets

An environment variable is classified as sensitive by its name, before its value is read. A sensitive
value is never displayed: diagnostics show `[redacted]`. The classification is a judgement about
names, not a guarantee about content, so the surrounding rule still applies — do not put a credential
where it will be printed.

`describeEnvironment` cannot be asked for the whole environment. It requires a prefix or an explicit
list, because dumping a process environment into diagnostic output is how unrelated credentials end up
in bug reports.

## Implementing a new setting

```ts
const timeout = resolveValue<number>({
  flag: options.timeoutMs,
  environment: { name: "QAT_TIMEOUT_MS", parse: parsePositiveInteger },
  configuration: suite.timeoutMs,
  fallback: 30_000,
});
```

The result reports which source won, so a diagnostic can answer "why is it using this?" without
re-deriving the answer.
