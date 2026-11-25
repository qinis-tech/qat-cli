# ADR-0030: Model an environment as a typed profile rather than a map of variables

Date: 2026-11-24

## Status

Proposed

## Context

The configuration format declares `environments` as a map of names to maps of variables: `Record<profileName,
Record<variableName, value>>`. A profile is therefore a flat bag of strings, and nothing else can be expressed inside one.

Three forces made that shape insufficient.

**A run needs a target, and the map had nowhere to put one.** A suite driven against development, staging and production
differs first by _where it points_. With only variables available, the target has to be carried as an ordinary variable —
a name such as `BASE_URL` that every consumer learns to special-case — or set in the framework's own configuration and
edited between runs, which is the same problem moved somewhere else. Any list of "variables with special meaning" is a
second schema, spread across the codebase, that nobody reviews.

**A committed file is a published file.** Anything in `qat.config.json` is in the repository history, in every clone and in
every CI log that prints the file. A token pasted into a variable map therefore cannot be removed by deleting the line.
Before this decision the format had no way to name a secret's source without also having somewhere to paste the secret
itself, and the only separation available was a naming convention (`SECRET_*`), which is followed by whoever read the
documentation and invisible to everything that parses the file.

**Two consumers were guessing at the structure.** The resolution stage reads `environments` to decide which environment a
run targets, and it treats the map's keys as names. The initialisation workflow writes a file the schema accepts. Neither
can say anything about a profile's contents, because the schema does not describe them: a value that spans two lines, a
name that is not uppercase, and a variable called `constructor` all reach a consumer as equal-looking strings.

Adjacent decisions constrain the answer rather than determining it. Unknown fields are refused everywhere (ADR-0022), so a
new field is a deliberate addition and not an invitation to carry extra keys. Configuration lives in one file at the
project root (ADR-0023), so a profile cannot be split into a per-environment file. Defaults apply only to fields a
document omitted (ADR-0027), so nothing here may be defaulted into existence. And a file that cannot be read is a failure
that never reaches defaulting (ADR-0024, ADR-0025), which means an environment whose shape is wrong has to be refused at
the point of reading, not repaired later.

## Decision

We will model a named environment as a profile: an object with three optional fields, rather than a map of variables.

A profile carries a target (`baseUrl`), non-sensitive values (`variables`), and references to secrets (`secrets`). It is a
strict object, so a property the format does not declare is refused, and it must declare at least one of the three — a
profile that declares nothing is refused rather than accepted as an empty declaration. A present `variables` or `secrets`
map must be non-empty for the same reason.

A secret reference is an object with a source and a name — `{ "from": "environment", "name": "QAT_STAGING_API_TOKEN" }` —
and the source is a closed set with one member. The value itself never appears in the file, and the strict shape refuses a
`value` written beside the name.

`environments` remains the field that holds profiles, keyed by the same names, so selection by `--environment` and by
`defaultEnvironment` is unchanged.

## Consequences

**Easier**

- A run's target has a home. `--environment staging` can mean "point here" without a special variable name that every
  consumer has to know about.
- A secret is structurally distinguishable from a value: a variable is a string, a reference is an object, and putting one
  where the other belongs is a validation error naming the field. No convention to document, no prefix to remember.
- A credential pasted where a reference belongs is refused by the parser rather than discovered in a pull request. That is a
  rule the tool enforces, in place of advice it can only repeat.
- A profile that declares nothing is caught while the file is read. Previously it validated, could be selected as the
  default, applied nothing, and reported the new profile's name — so the first symptom was a run against whatever the
  previous command left behind.
- `CONFIG_FIELD_PATHS` still lists `environments` as one leaf. A profile's properties are properties of a value rather than
  paths through the document, so neither the field list nor the defaults catalogue grows with the profile, and the
  documentation checks keep meaning what they meant.

**Harder**

- **Every existing document changes shape.** `"staging": { "API_URL": "…" }` becomes `"staging": { "variables": { "API_URL":
"…" } }`. The schema version literal was not incremented, on the assumption that no `version: 1` document exists outside
  this repository; if one does, this is a field changing meaning and the literal must move to `2`. The assumption is what
  makes the omission safe, so it is recorded rather than left implicit.
- **Nothing resolves a secret reference yet.** A reference is a promise, and the thing that keeps it — reading the named
  variable, handing the value to the framework, failing with a message that names the profile and the variable when it is
  unset — does not exist. Until it does, a profile with a valid reference describes an intent rather than a configured run.
- **The refusal messages had to be written by hand.** A record given a key schema reports a bad key as _"Invalid key in
  record"_; the key schema's own sentence, the part that says what a name must look like, never reaches the reader. Keys
  are therefore validated by a small wrapper that applies the name schema per key and reports at the key's own path. Any
  further user-keyed map in the format needs the same treatment.
- **The reserved-name guard now covers three kinds of key** — profile names, variable names, secret names — and still has to
  run on the raw value, because a record's rebuild turns `__proto__` into a prototype assignment before a key schema can
  see it. That is a pipeline stage, not a check, and it is the part most likely to be "simplified" away.
- **A "declare the names now, fill them in later" workflow is gone.** Refusing an empty profile is deliberate, and it costs
  the ability to sketch a document's shape before its contents are known.
- **`timeout` is the key somebody will try first**, and it is refused as an unknown property. A profile deliberately carries
  no execution settings yet — no command reads one, and inventing the shape now means changing it later — so the refusal is
  the intended answer until the command that needs it exists.
- **A value that is both a variable and a secret has to be decided at the point of use.** The format offers two maps and no
  rule about a name appearing in both; whether that is an error, an override, or a legitimate pairing belongs to whatever
  applies a profile, and it is not decided here.

**Neutral**

- `environments` remains optional, and an absent one still means a project with no named environments — a legitimate state.
  An empty map is likewise still valid; it is the empty _profile_ that is refused, because that is the one that can be
  selected and apply nothing.
- Selection is unchanged: `--environment`, or `defaultEnvironment` naming a declared profile, which is still checked as a
  cross-field rule reported at `defaultEnvironment`.
- The name, variable and value constraints are the ones the format already had. Only the container changed.

## Options considered

| Option                                                                             | Why not                                                                                                                                                                   |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keep the map, and reserve variable names for the target and for secrets            | A reserved-name list is a second schema spread across every consumer, and a secret would still be a string indistinguishable from a value to anything that reads the file |
| Add one top-level `baseUrl` for the file                                           | It gives the file a target but not each environment one, so switching environments still means editing the file — which is the problem                                    |
| Keep the map and mark secrets with a prefix, `"env:NAME"`                          | The convention is invisible to the parser, so a mistyped prefix becomes a variable whose value is the literal string `env:NAME`. Enforcement was the point                |
| Accept either shape — a variable map or a profile — so existing files keep working | A permanent union in the format for a compatibility window nobody has asked for, and every consumer pays for it forever                                                   |
| Put profiles under a new `profiles` key and leave `environments` alone             | Two concepts for one idea. `defaultEnvironment` would name a key of which map, and a reader would have to know why both exist                                             |
| Allow a profile with no fields, so names can be declared first                     | It validates, can be the default, and applies nothing, so the first symptom is a run against the previous configuration reported under the new name                       |

## References

- ADR-0022 — reject unknown configuration fields
- ADR-0023 — read configuration from one file at the project root
- ADR-0024 — treat a missing configuration as a result rather than a failure
- ADR-0025 — never fall back to defaults for a configuration file that exists and cannot be used
- ADR-0027 — apply defaults only to omitted fields and resolve paths against the project root
- `docs/architecture/environment-profiles.md` — the model, the naming rules and the five refusals
- `docs/architecture/configuration-format.md` — §4, the shape as a user writes it; §8, secrets
- `docs/architecture/configuration-schema.md` — §5, the same shape as the schema enforces it
