# Configuration schema

|                 |                                                                                                          |
| --------------- | -------------------------------------------------------------------------------------------------------- |
| **Status**      | Normative                                                                                                |
| **Module**      | `src/config/schema/`                                                                                     |
| **Entry point** | `qatConfigSchema`, `SUPPORTED_CONFIG_VERSION`, `QatConfig`, `QatConfigInput`                             |
| **Companion**   | [configuration-precedence.md](configuration-precedence.md), [module-boundaries.md](module-boundaries.md) |

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

### The version is required, and is a literal

`version` must be present and must be `1`. There is no default.

A file without a version cannot be distinguished from a file written before the field existed, so there is no safe value
to assume. And a _range_ of accepted versions would be a promise this build cannot keep: it validates one shape, and
claiming to validate another is how a file parses and then behaves unexpectedly.

Any other value fails at `version`, with the number that was found. The message a user sees is the loader's to write —
the schema's job is to reject and to say where.

## 3. Fields

| Field                | Type                                     | Required | Default                     | Constraint                                        |
| -------------------- | ---------------------------------------- | -------- | --------------------------- | ------------------------------------------------- |
| `version`            | literal `1`                              | **yes**  | —                           | The only version this build reads                 |
| `framework`          | enum                                     | **yes**  | —                           | `cypress`. An unrecognised identifier is rejected |
| `cypress`            | object, strict                           | no       | —                           | No key other than `configFile`                    |
| `cypress.configFile` | path                                     | no       | framework detection         | Project-relative; §4                              |
| `defaultEnvironment` | profile name                             | no       | —                           | Must name a key of `environments`; §6             |
| `environments`       | map of profile → map of variable → value | no       | —                           | §5                                                |
| `output`             | object, strict                           | no       | `{}` — both paths defaulted | No key other than the two below                   |
| `output.reports`     | path                                     | no       | `results/reports`           | Project-relative; §4                              |
| `output.evidence`    | path                                     | no       | `results/evidence`          | Project-relative; §4                              |

**Required means the tool cannot proceed sensibly without it.** Optional means its absence is a legitimate state rather
than an unfinished file: `environments` absent is a project with no named profiles, `cypress` absent is a project whose
configuration detection can find.

**`framework` is required even though it has one member.** A default would mean that the day a second framework exists,
every configuration written before it silently means Cypress — including the ones whose author would have chosen
otherwise. A default is a decision made on somebody else's behalf, forever.

**`output` is always present after parsing,** because both of its paths have defaults. A consumer reads
`config.output.reports` without branching on whether anybody configured it. A partially written `output` block fills in
the rest.

### A worked file

```json
{
  "version": 1,
  "framework": "cypress",
  "cypress": { "configFile": "config/cypress.config.ts" },
  "defaultEnvironment": "staging",
  "environments": {
    "smoke": { "API_URL": "https://smoke.example.test" },
    "staging": { "API_URL": "https://staging.example.test", "RETRIES": "2" }
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

**The schema validates the path, not the existence of what it names.** `cypress.configFile` pointing at a file that is
not there is a valid configuration and an invalid project — resolving it is the loader's and the resolver's job, where the
filesystem is already being read and where a missing file has a remedy the schema cannot supply.

## 5. Environment profiles

A profile is a named set of variables, selected by `--environment <name>` or by `defaultEnvironment`.

| Part          | Rule                                                        | Because                                                                                              |
| ------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Profile name  | 1–32 characters, `^[a-z][a-z0-9-]*$`                        | It is typed on a command line and may become part of a directory name; one casing, no quoting        |
| Variable name | 1–128 characters, `^[A-Z][A-Z0-9_]*$`                       | It is also passed to the framework as an environment variable, where casing is not neutral           |
| Value         | At most 4096 characters, single line, no control characters | A newline is almost always a paste accident, and an escape sequence acts on whatever prints it later |

**Three names are refused as profile names and as variable names: `__proto__`, `prototype`, `constructor`.** Assigning
`__proto__` on a plain object changes its prototype rather than adding a key, and any code that builds a record out of
untrusted keys — which a parser is — is one assignment away from polluting every object in the process. Refusing the
names here is cheaper and more auditable than a defensive check in every consumer.

**An empty profile is valid.** `{ "smoke": {} }` declares a profile with no variables. The selection still changes which
environment is active, and a schema that refused it would force a placeholder into every configuration.

## 6. Default environment

`defaultEnvironment` must name a key of `environments`. It is checked in the schema, as a cross-field rule, and the issue
is reported at `defaultEnvironment`.

The alternative — accepting it and failing at the point of use — produces a run that stops for a reason nothing in the
configuration explains. Validating it where the file is read is what turns "the environment is missing" into "the default
names a profile you did not declare", which is a one-line fix.

An `environments` block that is absent, or empty, is fine on its own; it is only a problem when something names a profile
inside it.

## 7. Types are derived

```ts
export type QatConfig = z.infer<typeof qatConfigSchema>;
export type QatConfigInput = z.input<typeof qatConfigSchema>;
```

`QatConfig` is the parsed shape: defaults applied, constraints satisfied. A function that accepts it can assume every
rule has been checked. `QatConfigInput` is the shape as written, where every defaulted field is optional — useful for the
initialisation workflow, which builds a file rather than reading one.

Both are derived rather than declared. A hand-written interface beside a schema is a copy, and a copy is what lags: a
constraint added to the schema would leave the type describing the previous rules, and nothing would notice until a
consumer relied on a field the schema no longer permits.

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

**An unrecognised key has no path to point at.** It is reported at the document root, and the key is named in the
message. Any surface that renders these issues has to handle that case, or the most common defect in a hand-written file
will be reported as "something is wrong at the top level".

## 9. What is not here

Each of these has been considered and is absent on purpose. The reason is not "later" — it is that no consumer needs it
yet, and a field with no consumer is a field whose shape will be guessed wrong.

| Not modelled                                          | Why                                                                                                                                                                                           |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `baseUrl`, `specPattern`, `supportFile`               | They belong to the framework's own configuration, which QAT does not evaluate. A project that needs one sets it there, or passes it through an environment profile                            |
| `reporters`, `retries`, `timeout`, `browser`, `video` | Each belongs to the command that uses it, and none exists. Inventing the shape now means changing it when the command is written                                                              |
| A storage path for `.qat/`                            | The output paths cover what a run writes. A database location is a second decision, and it arrives with the command that reads one                                                            |
| A log level, a colour mode                            | These come from a flag or an environment variable, and live in [configuration-precedence.md](configuration-precedence.md) — a value with two sources needs a precedence rule, not two schemas |
| `plugins`, `hooks`, `beforeRun`                       | Executable code in a data file, which is the thing [ADR-0008](./adr/0008-do-not-evaluate-the-framework-configuration-during-discovery.md) refuses                                             |
| A list of supported frameworks                        | It is the field's own enum. A second list would be a copy, and this file would be the one that lagged                                                                                         |

## 10. Extending the schema

Adding a field is five steps, and the fourth is the one that gets skipped:

1. **Decide whether it is required.** Required means the tool cannot sensibly proceed without it. If a default is
   tempting, add it as optional with a default rather than as required — and see §3 on why `framework` is the exception.
2. **Reuse a primitive or add one.** A path uses `relativeProjectPath`; a name uses `environmentName`. A constraint that
   exists only at the field is one the next field will not have.
3. **Decide whether the version bumps.** Adding an _optional_ field does not: an older file remains valid. Changing what an
   existing field means, or removing one, does — and that is the only thing a version number is for.
4. **Add two fixtures.** One valid configuration using the field, one invalid violating its constraint, with the field
   named in the test table. A rule with no negative fixture is a rule nothing proves.
5. **Extend the table in §3.** The document is the review artefact; a field that is not in it is a field nobody agreed to.

## 11. Things that will bite

**The schema validates shape, not existence.** A path that points nowhere is valid configuration. If a missing file needs
a message, it belongs where the filesystem is read — not here, where there is nothing to check against.

**A strict object is strict at every level.** `cypress` and `output` are strict as well as the root, so a key nested one
level down is rejected too. That is deliberate and it is also why the unrecognised-key issue can point at a path rather
than the root when the key is nested — the root case in §8 is the top-level one.

**The default output paths bypass validation.** `output`'s default is a constant this module owns, substituted at the
_output_ type rather than parsed, so the paths in it are not re-checked when they are used. That is safe while they are
constants. A default assembled from input — a value that depends on a flag, say — would need parsing, and the ordering
between "the schema applied a default" and "the schema validated it" is exactly where that mistake would hide.

**`QatConfigInput` is not what a consumer should accept.** It is the shape as written, so every defaulted field is
optional and every constraint is unchecked. It exists for the workflow that _builds_ a file, not for one that reads one.

**This document is normative and the schema is not self-documenting.** A constraint in code that is missing from §3 is a
defect in this document, and a rule in §3 that the schema does not enforce is a defect in the code — either way, the two
disagree and one of them is wrong.
