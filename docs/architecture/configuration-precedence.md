# Configuration Precedence

One value can arrive from five places. When more than one supplies it, this is the order that decides.

| Order | Source                       | Scope                   | Set by                                                           |
| ----- | ---------------------------- | ----------------------- | ---------------------------------------------------------------- |
| 1     | Command-line flag            | This invocation         | The person running the command                                   |
| 2     | Environment variable         | This process            | A shell, a CI job, a container                                   |
| 3     | Selected environment profile | This run's target       | Whoever committed the file, and whoever selected the environment |
| 4     | Configuration file           | This project, over time | Whoever committed it                                             |
| 5     | Built-in default             | The tool                | Nobody                                                           |

The rule behind the order: **the narrower the scope, the more deliberate the act, and the more
deliberate the act the more it should win.** A flag exists for one command. An environment variable
is set for one machine or one pipeline. A profile applies to one selected environment. A
configuration file is shared and long-lived. A default is nobody's decision.

## Environment above file, specifically

This is the part people argue about, so it is recorded separately in a decision record.

A configuration file is committed and shared; changing it is a review. An environment variable is
set by whoever is running the command, right now, and is the standard mechanism for a CI job or a
container to override a committed value without editing it. Putting the file first would mean the
only way to override a committed setting is to edit code and push — which is not an override.

## The profile is a narrower file, not a fifth document

Rung 3 is stored inside rung 4. An environment profile lives in the same `qat.config.json`, under
`environments.<name>`, and the schema validates it with the same rules. Calling it a level is a
statement about _scope_, not about storage.

It earns the higher rank because it is narrower in the way that matters: a profile applies only when
that environment has been selected, whereas the file's own fields apply to every run of the project.
The person who selects an environment for a run is making a more specific decision than the person
who wrote the shared file, and a value that only applies to one target is more specific than one that
applies to all of them.

Two things it cannot do, both by construction rather than by policy:

- **It cannot supply `version` or `framework`.** Those fields exist only at the root, so no profile
  can reinterpret the document or change what the tool drives.
- **It cannot supply a path.** An environment describes a target and a set of values; where reports
  and evidence are written is a property of the project, not of the target.

## The bottom rung is written down

Rung 5 used to be an assumption: "there is a default somewhere". It is now a published table, in
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

| Rung        | Applied in                                                                           | When                                                                   |
| ----------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| Flag        | `src/cli/` — command parsing                                                         | Before anything is read                                                |
| Environment | `core/environment/precedence.ts`, with a parser the caller supplies for that setting | Per setting, once the flag is known                                    |
| Profile     | `config/resolver/environment.ts`                                                     | After the document is validated, and only for the environment selected |
| File        | `config/schema` while parsing, then `config/resolver` for anchoring                  | After the bytes are read                                               |
| Default     | `config/schema` (`OUTPUT_DEFAULTS`) and `config/resolver/defaults.ts`                | Last in precedence — see the paragraph below                           |

One honesty note about that last row. Defaults are last **in precedence**, but not always last **in
time**: the schema fills `output.reports` and `output.evidence` while parsing, so the document that
reaches the environment overlay already contains defaulted values. That is safe today for a reason
worth stating so it survives: **no defaulted field is also settable from the environment, and no
defaulted field is settable per environment.** The two never contest a value.

`baseUrl` — the one setting that can arrive from three different rungs — has no default at all, so
there is nothing for a materialised default to outrank. If a defaulted field ever needs to be
overridable, the overlay has to be applied before the schema fills anything in, and this paragraph
is the note that says so.

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

The consequence interacts with the other rungs in a way worth spelling out: an empty environment
variable does not shadow a profile value, does not shadow a file value, and does not suppress a
default. `QAT_LOG_LEVEL=` yields the configured level or the built-in one; `QAT_BASE_URL=` yields the
selected profile's target.

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

**An override is validated with the constraint the file uses — the same function, not an equivalent
one.** `QAT_BASE_URL` and `--base-url` are parsed by the schema's own base-URL constraint, so an
override cannot introduce a target the file would have refused. A rule with a bypass is not a rule,
and the bypass is never noticed by a test of the file.

**A requested name is validated before it is looked up.** `Production` is a malformed environment
name, not an unknown environment: reporting it as unknown sends the reader to check their profiles
instead of their typing.

## Secrets

A secret is the one setting where precedence is not a merge but a **lookup**, and the two halves live
at different rungs:

| Half                                                     | Where it lives                            | Rung              |
| -------------------------------------------------------- | ----------------------------------------- | ----------------- |
| The _name_ of the secret, and which variable supplies it | The profile's `secrets` map               | 3 — configuration |
| The _value_                                              | The ambient environment, read at run time | 2 — environment   |

There is no contest, because there is no file value to compete with: the file never holds a secret
value, by design and by constraint. A profile that carried `https://user:pass@host` as its target is
refused by the base-URL constraint, and a secret reference that carried a `value` beside its `name`
is refused as an unknown property.

An environment variable is classified as sensitive by its name, before its value is read. A sensitive
value is never displayed: diagnostics show `[redacted]`. The classification is a judgement about
names, not a guarantee about content, so the surrounding rule still applies — do not put a credential
where it will be printed.

Resolved values are carried in a container that redacts itself when serialised, printed or spread,
with one accessor for the adapter that must put them into a child process's environment. See
[environment-resolution.md](environment-resolution.md) §4.

`describeEnvironment` cannot be asked for the whole environment. It requires a prefix or an explicit
list, because dumping a process environment into diagnostic output is how unrelated credentials end up
in bug reports.

One related rule lives in the path layer: a configured value that looks like a URL is described rather
than repeated, because userinfo is the one place a path-shaped string routinely carries a credential —
see [path-resolution.md](path-resolution.md).

## One setting through every rung

`baseUrl` is the only setting that can arrive from more than one place, and walking it through the five
rungs is the shortest way to see the model — including the two rungs that deliberately supply nothing.

| Rung | Supplies `baseUrl` | How, or why not                                                                                                                                                            |
| ---- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | yes                | `--base-url`                                                                                                                                                               |
| 2    | yes                | `QAT_BASE_URL`                                                                                                                                                             |
| 3    | yes                | The selected profile's `baseUrl`                                                                                                                                           |
| 4    | no                 | There is no file-level target. A target that applied to every run would be a target chosen without naming an environment, which is the guess this format exists to prevent |
| 5    | no                 | A default target would point every project at one address — and it is the address most likely to be somebody's production                                                  |

The result carries `baseUrlSource` — `flag`, `environment`, `configuration` or `none` — so "why is it
talking to staging?" is answerable after the fact rather than re-derived.

## What each rung may supply today

Not every setting is reachable from every source, and the gaps are deliberate rather than pending.

| Setting                             | Flag         | Environment     | Profile  | File     | Default                                           |
| ----------------------------------- | ------------ | --------------- | -------- | -------- | ------------------------------------------------- |
| Log level                           | yes          | `QAT_LOG_LEVEL` | —        | —        | `info`                                            |
| `version`, `framework`              | —            | —               | —        | required | **none** — a guess would reinterpret the file     |
| `output.reports`, `output.evidence` | —            | —               | —        | optional | `OUTPUT_DEFAULTS`                                 |
| `defaultEnvironment`                | —            | —               | —        | optional | **derived**, never fixed                          |
| `environments`                      | —            | —               | —        | optional | none — an absent map means no named environments  |
| `cypress.configFile`                | —            | —               | —        | optional | **none** — project detection supplies it          |
| `environments.<name>.baseUrl`       | `--base-url` | `QAT_BASE_URL`  | optional | —        | **none** — a wrong default tests the wrong target |
| `environments.<name>.variables`     | —            | —               | optional | —        | none                                              |
| `environments.<name>.secrets`       | —            | values only¹    | optional | —        | none                                              |

¹ The profile names the variable; the ambient environment supplies the value at run time. Neither is
overridable, which is the whole of the "only approved properties" rule: an override that could
re-point a secret would let a run authenticate as something nobody reviewed.

Three entries are worth reading twice. `defaultEnvironment` is the only rung-5 value that is _derived_
rather than constant, because a run's target is decided from what the project declares; the derivation
and its four outcomes are in [configuration-defaults.md](configuration-defaults.md). `output.*` is
reachable from the file and a default only — never from a flag, the environment, or a profile —
because where a project writes is a property of the project, not of the machine invoking it. And
`baseUrl` is the mirror image: no file-level value and no default, because a target only means
something once somebody has said which environment they mean.

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

Six things to do alongside it, in the same change:

1. **Decide which rungs may supply it, and write the refusals down.** A per-machine output path and a
   default target are both easy to add and both wrong; if the table above gains a row, the reason it
   has the shape it has belongs in this file.
2. **Validate every rung with the same constraint.** Two constraints for one setting means one of
   them is a bypass.
3. **If a flag or a variable may supply it, add a member to `EnvironmentOverrides`.** The override
   surface is closed by that type, and a setting that skips this step is not overridable no matter
   what the documentation claims.
4. **If it lives per environment, put it in the profile**, not at the file root — and if it is a
   secret, give it a reference shape rather than a value.
5. **If it has a default, add a catalogue row** in `defaults.ts` with its rationale, and regenerate
   the published table. A default that exists in code and not in the catalogue fails the coverage
   test.
6. **Record which rung answers a bad value.** A flag is answered, an environment variable is skipped,
   a file is refused by the schema. The choice depends on who can fix it.
