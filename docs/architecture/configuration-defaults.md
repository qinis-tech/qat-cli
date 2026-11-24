# Configuration defaults

A QAT configuration file may omit most of its fields. This document states, for every field the schema declares,
whether the tool supplies a value, derives one, or refuses to invent one — and the reasoning for each. It is the
authority a reader should consult before asking "why is my report in `results/reports`?" or "why won't QAT pick an
environment?".

The table below is **generated**. It is rendered from `DEFAULT_CATALOGUE` in
`src/config/resolver/defaults.ts` by `defaultsAsMarkdown()`, and a test compares this file against that output, so the
prose around the table may be edited freely while the table itself may not.

## The table

| Field                | Rule    | Default              | Rationale                                                                                                                                                      |
| -------------------- | ------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`            | none    | _none_               | Identifies the schema the file was written against. Guessing it would silently reinterpret the document against different rules.                               |
| `framework`          | none    | _none_               | Names the system under test. A default would let QAT assume a framework and appear to work on a project it does not understand.                                |
| `cypress.configFile` | none    | _none_               | Supplied by project-layout detection. A default would create a second, drifting source of truth for a fact the project already states.                         |
| `defaultEnvironment` | derived | _derived_            | An environment named "default" when the project declares one, otherwise the only declared environment, otherwise none. QAT never guesses which target to test. |
| `environments`       | default | `{}`                 | No implicit variables, so anything a run depends on is visible in the file rather than inherited from the operator.                                            |
| `output.reports`     | default | `"results/reports"`  | Deterministic and project-relative: no timestamp, hostname or working-directory fragment can make two runs of one configuration disagree.                      |
| `output.evidence`    | default | `"results/evidence"` | The same reasoning as the reports directory, and deliberately beside it: output that lands in two unrelated trees is output nobody can archive.                |

Every leaf field the schema declares appears exactly once. A field missing from this table is a field whose behaviour
nobody has agreed on, and two tests fail the build in that case: one compares the catalogue against
`CONFIG_FIELD_PATHS` in both directions, the other compares this document against the rendered table.

## Two owners, and why that is not two answers

**The schema owns the values.** `SUPPORTED_CONFIG_VERSION` and `OUTPUT_DEFAULTS` live in `schema/config.ts`, because
that file is what decides a field may be omitted at all — and a default is part of that decision. When a document is
parsed, `output` arrives already filled.

**The resolution stage owns the reasoning and the one group the schema leaves open.** `environments` is absent in a
valid document, which is a legitimate state: a project with no named profiles. The resolution stage fills it with an
empty map so no consumer has to distinguish "no environments" from "an empty set of them".

The output paths are re-applied there as well. That is deliberate redundancy, not a second authority: the values are
imported from `OUTPUT_DEFAULTS` rather than restated, and the operation is idempotent on a validated document. A test
asserts that the defaults table and the schema agree, so they cannot drift into two answers.

## Where defaults sit in the precedence chain

```
environment override   (highest)
configuration file
defaults               (lowest)
```

Defaults are applied **after** the file and any environment overrides have been merged, which is the only ordering in
which they cannot outrank a value a human supplied. The chain itself is described in
`configuration-precedence.md`; the relevant consequence here is that a default can fill a gap and can never close one.

## Why four fields have no default

Refusing to default a field is a decision with a cost, and each of these costs less than the alternative:

- **`version`** — a file without one cannot be told apart from a file written for a version that predates the field, so
  there is no safe value to assume. Guessing means interpreting the document against rules nobody chose.
- **`framework`** — Cypress is the only member today. A default would mean that the day a second framework exists, every
  configuration written before it silently means Cypress, including the ones whose author would have chosen otherwise.
- **`cypress.configFile`** — project detection reads the conventional filenames. A default here would be a second,
  drifting description of a project's layout, and detection is the one that can see the filesystem.
- **`defaultEnvironment`** — derived, not fixed. It resolves to an environment literally named "default" when one is
  declared, otherwise to the only declared environment, otherwise to **none**. Falling back to the first of several
  declared environments would point a run at an arbitrary target, and a suite that passes against the wrong environment
  is the most expensive failure this tool can produce. When nothing can be chosen, the run says so and names the field
  to set.

## A default path must be deterministic

Both defaulted paths obey four rules, and a test asserts them:

1. **Project-relative.** Never absolute, never a drive letter, never a home alias. An absolute default would be a value
   one machine could not carry to another.
2. **No clock, hostname or working directory.** Two runs of the same configuration must agree, from a shell, a
   continuous-integration job and an editor task runner alike.
3. **Anchored to the project root at use.** The configured string is relative; the resolution stage joins it to the
   project root, never to `process.cwd()`.
4. **Created only when written to.** Configuration supplies a location, not a directory. `qat init` leaves a project
   containing one file, and an empty `results/` appears only when a run first has something to put in it.

## What defaults must never do

- **Repair a file that failed to load.** A document that could not be parsed, or declares a version this build does not
  read, never reaches the defaulting service at all: the loader brands a document only on success, and the resolver
  refuses anything unbranded. Defaults over a broken file produce a run that looks correct and cannot be explained
  afterwards.
- **Overwrite a supplied value.** `undefined` is the only signal that a field was omitted. `false`, `0` and `""` are
  values somebody typed.
- **Repair a malformed group.** `"output": "reports"` is a validation problem. Replacing it with a plausible object
  would delete the diagnostic the reader needs.
- **Extend a defaulted group into a field the schema does not know.** A default for an invented field makes validation
  reject every project for something the user never wrote.

## Changing a default

1. If the value belongs to the schema, change it in `OUTPUT_DEFAULTS` in `schema/config.ts`. Do not restate it elsewhere.
2. Update the catalogue entry in `resolver/defaults.ts` — value and rationale — or add a new entry if a field was added
   to the schema.
3. Regenerate the table above by pasting the output of `defaultsAsMarkdown()`.
4. Run the configuration tests. `defaults.test.ts` fails if the table, the catalogue and the defaults disagree, or if a
   schema field has no documented rule; `defaulting.test.ts` fails if the merge stops honouring a supplied value.

## Related

- `configuration-schema.md` — what a configuration file may contain.
- `configuration-precedence.md` — how environment, file and defaults rank.
- `configuration-loading.md` — the six load outcomes, and why a failure carries no configuration.
- `path-resolution.md` — how a project-relative path becomes an absolute one.
- `adr/0026-stop-at-an-unsupported-version-rather-than-listing-field-err.md`
- `adr/0028-apply-defaults-only-to-omitted-fields-and-resolve-paths-against-the-project-root.md`
