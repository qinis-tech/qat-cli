# Configuration schema

|                 |                                                                                                                                                                                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Status**      | Normative                                                                                                                                                                                                                                                                |
| **Module**      | `src/config/schema/`                                                                                                                                                                                                                                                     |
| **Entry point** | `qatConfigSchema`, `SUPPORTED_CONFIG_VERSION`, `OUTPUT_DEFAULTS`, `CONFIG_FIELD_PATHS`, `SecretSource`, `QatConfig`, `QatConfigInput`, `EnvironmentProfile`, `SecretReference`                                                                                           |
| **Companion**   | [configuration-format.md](configuration-format.md), [environment-profiles.md](environment-profiles.md), [configuration-defaults.md](configuration-defaults.md), [configuration-precedence.md](configuration-precedence.md), [module-boundaries.md](module-boundaries.md) |

What a QAT configuration file may contain, and what happens when it contains something else.

## 1. One schema, four consumers

The schema is the only place that states the configuration's shape. Four callers read it rather than restating it:

| Consumer                    | Asks                                                       |
| --------------------------- | ---------------------------------------------------------- |
| The loader                  | Does this file parse, and if not, at which field?          |
| The initialisation workflow | What should a correct file contain, so it can write one    |
| The environment resolver    | Which profile is active, and which variables does it carry |
| The tests                   | One fixture per rule, each asserting the field it breaks   |

A constraint written at a call site instead of in the schema is a constraint the next consumer will not have. The
practical form of that rule: a primitive used twice lives in `constraints.ts`, and nothing outside this directory
declares a configuration field.

## 2. Two policies

### Unknown fields are rejected

A key the schema does not declare is an error, not a value to ignore or to carry through.

A configuration file is written by hand, so a misspelled key is the most common defect it can have. Ignoring one produces
a run that behaves as though the reader had not written it — the worst kind of failure, because nothing says anything is
wrong. Rejecting one names the key.

The cost is real: a file written for a newer build is refused rather than partly honoured. That is the intended trade. A
tool that silently ignores half a configuration is a tool whose output cannot be trusted, and the version field exists so
that "this file is newer than I am" is a message rather than a guess.

Strictness applies at every level — `cypress`, `output` and each profile — so a key nested one level down is refused too.

### The version is required, and is a literal

`version` must be present and must be `1`. There is no default.

A file without a version cannot be distinguished from a file written before the field existed, so there is no safe value
to assume. And a _range_ of accepted versions would be a promise this build cannot keep: it validates one shape, and
claiming to validate another is how a file parses and then behaves unexpectedly.

Any other value fails at `version`, with the number that was found. The message a user sees is the loader's to write —
the schema's job is to reject and to say where.

## 3. Fields

| Field                | Type                                 | Required | Default                     | Constraint                                        |
| -------------------- | ------------------------------------ | -------- | --------------------------- | ------------------------------------------------- |
| `version`            | literal `1`                          | **yes**  | —                           | The only version this build reads                 |
| `framework`          | enum                                 | **yes**  | —                           | `cypress`. An unrecognised identifier is rejected |
| `cypress`            | object, strict                       | no       | —                           | No key other than `configFile`                    |
| `cypress.configFile` | path                                 | no       | framework detection         | Project-relative; §4                              |
| `defaultEnvironment` | profile name                         | no       | —                           | Must name a key of `environments`; §6             |
| `environments`       | map of profile name → profile object | no       | —                           | §5                                                |
| `output`             | object, strict                       | no       | `{}` — both paths defaulted | No key other than the two below                   |
| `output.reports`     | path                                 | no       | `results/reports`           | Project-relative; §4                              |
| `output.evidence`    | path                                 | no       | `results/evidence`          | Project-relative; §4                              |

**Required means the tool cannot proceed sensibly without it.** Optional means its absence is a legitimate state rather
than an unfinished file: `environments` absent is a project with no named profiles, `cypress` absent is a project whose
configuration detection can find.

**`framework` is required even though it has one member.** A default would mean that the day a second framework exists,
every configuration written before it silently means Cypress — including the ones whose author would have chosen
otherwise. A default is a decision made on somebody else's behalf, forever.

**`output` is always present after parsing,** because both of its paths have defaults. A consumer reads
`config.output.reports` without branching on whether anybody configured it. A partially written `output` block fills in
the rest.

**`environments` is not always present,** and this is the one asymmetry in the table. The schema leaves it absent when
the project declares no profiles; the resolution stage fills an empty map so a consumer never has to distinguish "absent"
from "empty". Both are legitimate, and neither is a field the schema invents.

### A worked file

```json
{
  "version": 1,
  "framework": "cypress",
  "cypress": { "configFile": "config/cypress.config.ts" },
  "defaultEnvironment": "staging",
  "environments": {
    "smoke": {
      "baseUrl": "https://smoke.example.test",
      "variables": { "API_URL": "https://smoke.example.test/api" }
    },
    "staging": {
      "baseUrl": "https://staging.example.test",
      "variables": {
        "API_URL": "https://staging.example.test/api",
        "RETRIES": "2"
      },
      "secrets": {
        "API_TOKEN": { "from": "environment", "name": "QAT_STAGING_API_TOKEN" }
      }
    }
  },
  "output": {
    "reports": "results/reports/nightly",
    "evidence": "results/evidence"
  }
}
```

## 4. Paths

Every path in the file is **relative to the project root**, and six rules apply to all of them. They are stated once, in
`constraints.ts`, and used by `cypress.configFile`, `output.reports` and `output.evidence` alike.

| Rule                                                               | Because                                                                                                                                |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Not empty                                                          | An empty string resolves to the project root, so every report would be written over the project                                        |
| At most 256 characters                                             | Long enough for a dated directory, short enough to read in an error                                                                    |
| No control characters                                              | The path is written into reports and logs, and an escape sequence can act on whatever prints it                                        |
| Forward slashes only                                               | A configuration committed on Windows is read on Linux in CI; one spelling works on both                                                |
| Not absolute — no leading `/`, no `C:`, no `\\`                    | An absolute path embeds one machine and breaks every other                                                                             |
| No `.` or `..` segments, no leading, trailing or doubled separator | A path that resolves outside the project is a _write_ outside the project, which is a different class of defect from a wrong directory |

A profile's `baseUrl` is **not** covered by these rules, because it is not a path: it is an address, checked as a URL and
never joined to anything. Its own rule is in §5.

**The schema validates the path, not the existence of what it names.** `cypress.configFile` pointing at a file that is
not there is a valid configuration and an invalid project — resolving it is the loader's and the resolver's job, where the
filesystem is already being read and where a missing file has a remedy the schema cannot supply.

## 5. Environment profiles

An environment is a **profile**: an object with a target, variables and secret references, keyed by name and selected by
`--environment <name>` or by `defaultEnvironment`. It is not a bare map of variables, because a map has nowhere to put a
target and makes a secret and a variable the same kind of entry.

Everything a profile may contain is optional:

| Part      | Rule                                                                                    | Because                                                                                              |
| --------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Target    | `baseUrl`: absolute `http` or `https`, at most 2048 characters, no username or password | A relative address would be resolved against something nobody chose; credentials in a URL are a leak |
| Variables | `variables`: map of variable name → value, non-empty when present                       | A present-but-empty map says "these apply" and applies none of them                                  |
| Secrets   | `secrets`: map of variable name → reference, non-empty when present                     | A name for where the value lives, never the value                                                    |

A secret reference has exactly two parts, both required:

| Part            | Rule                                                      | Because                                                             |
| --------------- | --------------------------------------------------------- | ------------------------------------------------------------------- |
| Source          | `from`: the literal `"environment"`                       | A closed set, so a source nothing implements cannot be promised     |
| Source variable | `name`: an environment variable name, `^[A-Z][A-Z0-9_]*$` | It is read from the process environment, where the spelling matters |

Names and values:

| Part          | Rule                                                        | Because                                                                                              |
| ------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Profile name  | 1–32 characters, `^[a-z][a-z0-9-]*$`                        | It is typed on a command line and may become part of a directory name; one casing, no quoting        |
| Variable name | 1–128 characters, `^[A-Z][A-Z0-9_]*$`                       | It is also passed to the framework as an environment variable, where casing is not neutral           |
| Value         | At most 4096 characters, single line, no control characters | A newline is almost always a paste accident, and an escape sequence acts on whatever prints it later |

**An empty profile is refused.** `{ "smoke": {} }` would validate as an object, be selectable as the default, and apply
nothing — so the first symptom would be a run against whatever the previous command left behind, reported under the new
name. Refusing it turns that into a message at the moment the file is read. A present but empty `variables` or `secrets`
map is refused for the same reason, one level down.

**A secret that carries a `value` is refused**, as an unrecognised key. This is a security control rather than tidiness:
the message names the line the reader typed, instead of the file publishing a credential.

**A profile's unknown property is refused.** The object is strict, so a `timeout` key is a named error rather than a field
quietly ignored — and the most likely such key is an execution setting that has not been defined yet.

**Three names are refused as profile names, variable names and secret names: `__proto__`, `prototype`, `constructor`.**
Assigning `__proto__` on a plain object changes its prototype rather than adding a key, and any code that builds a record
out of untrusted keys — which a parser is — is one assignment away from polluting every object in the process. Refusing the
names here is cheaper and more auditable than a defensive check in every consumer.

The refusal has to happen in two places, and the reason is worth knowing. A key schema would reject `__proto__`, but a
record builds its result by _assigning_ each key, and the assignment to `__proto__` **replaces the object's prototype
instead of creating a property** — the key is gone before a key schema can look at it. So `environments` is a pipeline: a
stage that walks the raw value for reserved names, then the record that validates the shape. The walk is part of the
schema, so no consumer can obtain a validated map without it having run.

## 6. Default environment

`defaultEnvironment` must name a key of `environments`. It is checked in the schema, as a cross-field rule, and the issue
is reported at `defaultEnvironment`.

The alternative — accepting it and failing at the point of use — produces a run that stops for a reason nothing in the
configuration explains. Validating it where the file is read is what turns "the environment is missing" into "the default
names a profile you did not declare", which is a one-line fix.

An `environments` block that is absent, or empty, is fine on its own; it is only a problem when something names a profile
inside it.

The name is quoted in the message only when it is provably a name this schema defines. Anything else is described as _a
profile_, because a value in that position could be a token pasted into the wrong field, and a schema message reaches a
terminal, a log and a pasted issue.

## 7. Types are derived

```ts
export type QatConfig = z.infer<typeof qatConfigSchema>;
export type QatConfigInput = z.input<typeof qatConfigSchema>;

export type EnvironmentProfile = z.output<typeof profileSchema>;
export type SecretReference = z.output<typeof secretReferenceSchema>;
```

`QatConfig` is the parsed shape: defaults applied, constraints satisfied. A function that accepts it can assume every
rule has been checked. `QatConfigInput` is the shape as written, where every defaulted field is optional — useful for the
initialisation workflow, which builds a file rather than reading one.

Both are derived rather than declared. A hand-written interface beside a schema is a copy, and a copy is what lags: a
constraint added to the schema would leave the type describing the previous rules, and nothing would notice until a
consumer relied on a field the schema no longer permits. The profile's types are derived the same way, which is why a
consumer reading `profile.baseUrl` gets the checked type rather than a description of one.

**The projection onto the domain is the loader's job.** `core/domain/configuration.ts` declares `ConfigurationInput` and
`ConfigurationResult`, and this schema is a validator rather than a vocabulary — it does not import the domain, and the
domain does not import it. If those contracts already declare a configuration shape, the inferred type wins, because it is
the one with validation behind it.

## 8. What a validation result looks like

`safeParse` returns either the parsed value or `ZodIssue[]`. Every issue carries:

| Field     | Use                                                                                          |
| --------- | -------------------------------------------------------------------------------------------- |
| `path`    | Which field — a dotted path a caller uses to put the message beside the right line of a file |
| `message` | The rule, stated with its reason                                                             |
| `code`    | The kind of failure, for a caller that wants to branch                                       |

**Every independent failure is reported in one pass.** A configuration with a wrong version and an unknown framework
produces two issues, not one, because a reader fixing a file needs the whole list rather than one item per round trip.
The same holds inside a profile: three bad fields produce three issues, each at its own path.

**An unrecognised key is reported at the object that refused it.** At the root that means an empty path with the key named
in the message; inside a profile it means that profile's path. Any surface rendering these issues has to handle the empty
case, or the most common defect in a hand-written file will be reported as "something is wrong at the top level".

**A bad key is reported by the key schema, not by `zod`.** A record given a key schema refuses a bad key with the fixed
sentence _"Invalid key in record"_, and the schema's own message — the part that says what a name must look like — never
reaches the reader. So keys are validated by a small record wrapper that applies the name schema per key and reports its
sentence at the key's own path. That is why a message reads _"variable name `api_url` must be uppercase letters…"_ rather
than naming the record.

## 9. What is not here

Each of these has been considered and is absent on purpose. The reason is not "later" — it is that no consumer needs it
yet, and a field with no consumer is a field whose shape will be guessed wrong.

| Not modelled                                          | Why                                                                                                                                                                                                               |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `specPattern`, `supportFile`                          | They belong to the framework's own configuration, which QAT does not evaluate. A project that needs one sets it there                                                                                             |
| An execution setting: `timeout`, `retries`, `browser` | Each belongs to the command that uses it, and none exists. Inventing the shape now means changing it when the command is written — including inside a profile, where `timeout` is the key somebody will try first |
| A storage path for `.qat/`                            | The output paths cover what a run writes. A database location is a second decision, and it arrives with the command that reads one                                                                                |
| A log level, a colour mode                            | These come from a flag or an environment variable, and live in [configuration-precedence.md](configuration-precedence.md) — a value with two sources needs a precedence rule, not two schemas                     |
| `plugins`, `hooks`, `beforeRun`                       | Executable code in a data file, which is the thing [ADR-0008](./adr/0008-do-not-evaluate-the-framework-configuration-during-discovery.md) refuses                                                                 |
| A list of supported frameworks                        | It is the field's own enum. A second list would be a copy, and this file would be the one that lagged                                                                                                             |
| A source other than `environment` for a secret        | The field exists so a second source can be added without changing what an existing entry means. Nothing promises a source that is not implemented                                                                 |

One entry has moved out of this table: **a base URL**. A profile's `baseUrl` selects the target for one run, which is
exactly what a named environment is for. It does not replace the framework's own base URL, and QAT never writes it back.

## 10. Extending the schema

Adding a field is five steps, and the fourth is the one that gets skipped:

1. **Decide whether it is required.** Required means the tool cannot sensibly proceed without it. If a default is
   tempting, add it as optional with a default rather than as required — and see §3 on why `framework` is the exception.
2. **Reuse a primitive or add one.** A path uses `relativeProjectPath`; a name uses `environmentName`; a target uses
   `profileBaseUrl`. A constraint that exists only at the field is one the next field will not have.
3. **Decide whether the version bumps.** Adding an _optional_ field does not: an older file remains valid. Changing what an
   existing field means, or removing one, does — and that is the only thing a version number is for.
4. **Add two fixtures.** One valid configuration using the field, one invalid violating its constraint, with the field
   named in the test table. A rule with no negative fixture is a rule nothing proves.
5. **Extend the table in §3.** The document is the review artefact; a field that is not in it is a field nobody agreed to.

A field added **inside a profile** is a different change, and a shorter one: it needs no row in §3, no catalogue entry in
`resolver/defaults.ts`, and no addition to `CONFIG_FIELD_PATHS`, because it is a property of a value rather than a path
through the document. It needs a row in §5, a paragraph in `environment-profiles.md`, and a fixture. The one question
worth asking first: does the profile's "declares nothing" rule still mean what it says once the new field exists, or has it
become possible for a profile to declare only the new thing and change nothing?

## 11. Things that will bite

**The schema validates shape, not existence.** A path that points nowhere is valid configuration. If a missing file needs
a message, it belongs where the filesystem is read — not here, where there is nothing to check against.

**The reserved-name check runs on the raw value, and it has to.** §5 explains why: the record's own rebuild destroys the
key before a key schema can refuse it. A refactor that "simplifies" the pipeline into a plain `z.record` would remove the
protection and pass every test that does not parse a document containing `__proto__`.

**`zod`'s own message for a bad record key is unusable.** _"Invalid key in record"_ is what a reader would get without the
wrapper in §8, and it says nothing about what a name must look like. Any new user-keyed record needs the same treatment.

**A strict object is strict at every level.** `cypress`, `output` and each profile are strict as well as the root, so a key
nested one level down is rejected too. That is deliberate and it is also why the unrecognised-key issue can point at a
path rather than the root when the key is nested — the root case in §8 is the top-level one.

**The default output paths bypass validation.** `output`'s default is a constant this module owns, substituted at the
_output_ type rather than parsed, so the paths in it are not re-checked when they are used. That is safe while they are
constants. A default assembled from input — a value that depends on a flag, say — would need parsing, and the ordering
between "the schema applied a default" and "the schema validated it" is exactly where that mistake would hide.

**`QatConfigInput` is not what a consumer should accept.** It is the shape as written, so every defaulted field is
optional and every constraint is unchecked. It exists for the workflow that _builds_ a file, not for one that reads one.

**This document is normative and the schema is not self-documenting.** A constraint in code that is missing from §3 or §5
is a defect in this document, and a rule in either section that the schema does not enforce is a defect in the code —
either way, the two disagree and one of them is wrong.
