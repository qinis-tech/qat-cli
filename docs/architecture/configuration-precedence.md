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

## The bottom rung is written down

Rung 4 used to be an assumption: "there is a default somewhere". It is now a published table, in
[configuration-defaults.md](configuration-defaults.md), with two rules that decide how it behaves.

**A default fills a gap and never closes one.** It applies only where a field is absent. `false`,
`0` and `""` are values somebody typed, so a default never replaces them — the merge tests for
`undefined` and for nothing else.

**Having no default is a decision, and it is recorded.** Two of the tool's fields cannot be
defaulted at all: `version` identifies the schema the file was written against, and `framework`
names the system under test. A plausible guess at either produces a run that looks correct and
means something else. The table states those refusals beside the defaults, with the reasoning, so
"this field has no fallback" is a reviewed position rather than an oversight.

That has a consequence at every rung above: **absence is a legitimate state, and the stage that
needs the value is the one that reports it.** A project declaring no environments has no default
target, and the resolution stage says `none` rather than choosing one; a command that requires a
target then fails with the field to set.

## Where each rung is applied

| Rung        | Applied in                                                                           | When                                         |
| ----------- | ------------------------------------------------------------------------------------ | -------------------------------------------- |
| Flag        | `src/cli/` — command parsing                                                         | Before anything is read                      |
| Environment | `core/environment/precedence.ts`, with a parser the caller supplies for that setting | Per setting, once the flag is known          |
| File        | `config/schema` while parsing, then `config/resolver` for anchoring                  | After the bytes are read                     |
| Default     | `config/schema` (`OUTPUT_DEFAULTS`) and `config/resolver/defaults.ts`                | Last in precedence — see the paragraph below |

One honesty note about that last row. Defaults are last **in precedence**, but not always last **in
time**: the schema fills `output.reports` and `output.evidence` while parsing, so the document that
reaches the environment overlay already contains defaulted values. That is safe today because no
defaulted field is also settable by an environment variable — the two never contest a value. The
rule that keeps it safe is worth stating so it survives: **a field with a default must not also be
supplied from the environment**; if that ever needs to change, the overlay has to be applied before
the schema fills anything in.

The resolution stage then re-applies the same defaults idempotently at the end. That is not a second
authority — the values are imported from one constant — it is a guarantee that the last stage to run
holds the last word on precedence.

## Empty is not the same as absent

`NAME=` is not `NAME` unset. The variable utilities distinguish three states — present, empty,
missing — so a caller can act on the difference.

The **precedence resolver treats empty as absent**, and only there. A shell that exports `NAME=` is
far more often passing on a blank it inherited than instructing the tool to use nothing, and a
parser handed an empty string can only report a problem the operator did not create. A caller that
needs the distinction asks the variable utilities directly.

The consequence interacts with rung 4 in a way worth spelling out: an empty environment variable does
not shadow a file value, and it does not suppress a default. `QAT_LOG_LEVEL=` yields the configured
level or the built-in one, not an empty level.

## Validation

Each level supplies a value of the right type or an error. The environment's parser is supplied by
the caller that knows what the setting means, and it raises its own error with its own remediation —
a malformed environment value is a configuration problem, and reporting it as "invalid" without
saying what would be valid leaves the reader guessing.

**A value that is present but wrong does not fall through to the next rung.** A `--log-level chatty`
fails the command; it does not quietly use `QAT_LOG_LEVEL`, and it does not quietly use `info`. The
narrower scope was chosen deliberately, so the tool reports the mistake rather than substituting its
own judgement for the operator's.

That is the opposite of how the _environment_ treats a bad value, and the difference is scope again:
an environment variable may belong to a container image or a shared CI configuration that the person
running the command cannot edit, so an unusable value there is ignored in favour of the next rung. A
flag was typed for this invocation, so it is answered.

## Secrets

An environment variable is classified as sensitive by its name, before its value is read. A sensitive
value is never displayed: diagnostics show `[redacted]`. The classification is a judgement about
names, not a guarantee about content, so the surrounding rule still applies — do not put a credential
where it will be printed.

`describeEnvironment` cannot be asked for the whole environment. It requires a prefix or an explicit
list, because dumping a process environment into diagnostic output is how unrelated credentials end up
in bug reports.

One related rule now lives in the path layer: a configured value that looks like a URL is described
rather than repeated, because userinfo is the one place a path-shaped string routinely carries a
credential — see [path-resolution.md](path-resolution.md).

## What each rung may supply today

Not every setting is reachable from every source, and the gaps are deliberate rather than pending.

| Setting                             | Flag | Environment     | File     | Default                                       |
| ----------------------------------- | ---- | --------------- | -------- | --------------------------------------------- |
| Log level                           | yes  | `QAT_LOG_LEVEL` | —        | `info`                                        |
| `version`, `framework`              | —    | —               | required | **none** — a guess would reinterpret the file |
| `output.reports`, `output.evidence` | —    | —               | optional | `OUTPUT_DEFAULTS`                             |
| `defaultEnvironment`                | —    | —               | optional | **derived**, never fixed                      |
| `environments`                      | —    | —               | optional | none — an absent map means no named profiles  |
| `cypress.configFile`                | —    | —               | optional | **none** — project detection supplies it      |

Two entries are worth reading twice. `defaultEnvironment` is the only rung-4 value that is _derived_
rather than constant, because a run's target is decided from what the project declares; the
derivation and its four outcomes are in [configuration-defaults.md](configuration-defaults.md).
And `output.*` is reachable from the file and from a default only — never from a flag or the
environment — because where a project writes is a property of the project, not of the machine
invoking it.

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
