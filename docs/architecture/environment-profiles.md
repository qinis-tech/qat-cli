# Environment profiles

|                  |                                                                                                                                                                                                                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Status**       | Normative                                                                                                                                                                                                                                                                                                          |
| **Module**       | `src/config/schema/profiles.ts`                                                                                                                                                                                                                                                                                    |
| **Entry points** | `environmentsSchema`, `profileSchema`, `secretReferenceSchema`, `SecretSource`                                                                                                                                                                                                                                     |
| **Companion**    | [configuration-schema.md](configuration-schema.md), [configuration-format.md](configuration-format.md), [configuration-defaults.md](configuration-defaults.md), [configuration-validation.md](configuration-validation.md), [ADR-0030](./adr/0030-model-an-environment-as-a-typed-profile-rather-than-a-map-of.md) |

A named environment — development, staging, production — and what one is allowed to contain.

## 1. Why an environment is an object

The obvious shape is a map of variables:

```json
"staging": { "API_URL": "https://staging.example.test", "API_TOKEN": "…" }
```

It is wrong twice, and both failures appear only once something depends on them.

**It has nowhere to put anything that is not a string.** A target address would have to be smuggled in as a variable
whose name happens to look special, and every consumer would then carry a list of reserved variable names — a second
schema, spread across the codebase, that nobody reviews.

**It makes a secret and a variable the same kind of thing.** Telling them apart would be a naming convention, which is to
say no mechanism at all the first time a token is written into the wrong map.

So an environment is a profile: an object with fields that mean something, each of which may be absent.

## 2. The shape

```json
{
  "version": 1,
  "framework": "cypress",
  "defaultEnvironment": "staging",
  "environments": {
    "development": {
      "baseUrl": "http://localhost:3000",
      "variables": { "API_URL": "http://localhost:8080" }
    },
    "staging": {
      "baseUrl": "https://staging.example.test",
      "variables": { "FEATURE_FLAGS": "beta" },
      "secrets": {
        "API_TOKEN": { "from": "environment", "name": "QAT_STAGING_API_TOKEN" }
      }
    },
    "production": {
      "baseUrl": "https://example.test"
    }
  }
}
```

| Field       | Required | What it is                                                       |
| ----------- | -------- | ---------------------------------------------------------------- |
| `baseUrl`   | no       | The target this environment addresses                            |
| `variables` | no       | Non-sensitive values, handed to the framework exactly as written |
| `secrets`   | no       | References to secrets, resolved at run time. Never values        |

Three rules govern the object as a whole:

- **Unknown properties are refused.** The profile is `.strict()`, like every other object in the format, so a `timeout`
  key is a named error rather than a field quietly ignored.
- **At least one field must be present.** `{}` validates as an object and changes nothing — which means it can be selected
  as a default, apply nothing, and leave the run using whatever was configured before, reported as though the profile had
  applied. Refusing it turns that into a message at the point the file is read.
- **A present map must not be empty.** `{ "variables": {} }` is the same defect one level down: it says _these apply_ and
  applies none of them.

Everything is optional within those rules, because an environment that only sets a target is a legitimate environment.

## 3. Naming

A profile name is the **existing** `environmentName` constraint, reused rather than restated:

| Rule     | Value                                                                           |
| -------- | ------------------------------------------------------------------------------- |
| Pattern  | `^[a-z][a-z0-9-]*$` — lowercase letter, then lowercase letters, digits, hyphens |
| Length   | 1 to 32 characters                                                              |
| Reserved | `__proto__`, `prototype`, `constructor` refused                                 |

Lowercase and hyphenated so a name can be typed on a command line and used inside a directory name without quoting or
case-folding surprises. `Staging` is refused, not normalised: two spellings of one environment is a class of bug this
format does not need.

## 4. `variables` and `secrets` are different maps

This is the load-bearing decision in the model, and it is enforced by the types rather than by a convention.

|                           | `variables`                         | `secrets`                                |
| ------------------------- | ----------------------------------- | ---------------------------------------- |
| Value type                | A string                            | An object: `{ from, name }`              |
| Where the value lives     | In the file                         | Nowhere. The file names where to find it |
| What a mistake looks like | A validation error naming the field | A validation error naming the field      |

A single map with a prefix — `"SECRET_API_TOKEN": "env:NAME"` — is a string convention: followed by whoever read the
documentation, broken by whoever did not, and invisible to everything that parses the file. Two maps cannot be confused,
because putting one where the other belongs fails the type.

`variables` reuses the existing variable constraints: uppercase names, values of at most 4096 characters, no control
characters. Those rules are not restated here; they are the ones every variable in the format already obeys.

## 5. A secret is a reference, never a value

```json
"secrets": { "API_TOKEN": { "from": "environment", "name": "QAT_STAGING_API_TOKEN" } }
```

The **key** is the variable name the framework will receive. `name` is where to read the value from, and the value itself
never appears in the file.

| Field  | Required | Rule today                                                              |
| ------ | -------- | ----------------------------------------------------------------------- |
| `from` | yes      | The literal `"environment"`. A closed set with one member               |
| `name` | yes      | An environment variable name: uppercase letters, digits and underscores |

`from` exists rather than a bare name being enough, so that the day a second source — a file, a keychain — is added, every
existing entry keeps meaning exactly what it meant before.

**`.strict()` here is a security control, not tidiness.** A reader who writes the credential beside the name gets _"the
key `value` is not part of the configuration"_ addressed to the line they typed, rather than a secret in a pull request and
a rotation nobody planned. A rule the parser enforces is a rule; "never put secrets in this file" is advice, and advice
loses to a deadline.

What resolves a reference is a separate concern and does not exist yet: nothing today reads `secrets`. When a runner does,
it will read the named environment variable, hand the value to the framework, and fail with a message naming the profile
and the variable when it is unset — never printing the value.

## 6. `baseUrl` is a target, not a string

| Rule                        | Why                                                                                                                                                      |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No control characters       | `new URL` strips tabs and newlines while parsing, so an embedded one would be silently repaired and then written into a report                           |
| Parses as a URL             | `example.test` and `/api` both look like addresses and neither is one; a runner handed either resolves it against something nobody chose                 |
| Scheme is `http` or `https` | A `file:` or `ftp:` target is not something a run can address, and accepting one moves the refusal somewhere the reader cannot see it                    |
| No username or password     | `https://user:secret@host` is a valid URL and a leaked secret. Secrets have a field of their own, and this rule is what stops this one being used as one |

The length bound is 2048 characters — generous enough for a path and a query, bounded so a paste accident produces a
sentence about the field.

## 7. What a profile does not contain, yet

**Execution settings.** The scope for this model lists them as a _potential_ property, and `schema/config.ts` opens with
the rule that governs the answer: _"No field exists because a later command might want it… Anything else waits for the
consumer that needs it."_ No command reads an execution setting today, so none is defined. When the execution command
lands, adding `timeoutMs` is one key in `profileSchema`, one constraint reused from wherever the runtime bound ends up
living, and — if it has a default — one catalogue row.

This is recorded rather than omitted, so that "where are the execution settings?" has an answer other than the reader
wondering whether they missed a section.

## 8. Where the profile is validated, and the guard that cannot live in it

The profile is composed into the root schema — `environmentsSchema` is the value of the `environments` field — so a
profile error appears at its own path (`environments.staging.baseUrl`) and the document is refused whole. There is one
`zod` instance, one set of constraint primitives, and no second validator anywhere.

One rule genuinely cannot be a key schema: **reserved names.** `JSON.parse` keeps `__proto__` as an own enumerable key,
and a key schema would refuse it — but a record builds its result by _assigning_ each key, and assigning `__proto__` on an
ordinary object changes that object's prototype instead of adding a property. The key is gone before a key schema could
look at it, and the parse succeeds with the profile silently missing.

So `environmentsSchema` is a pipeline: a stage that walks the raw value for reserved names, then the record that
validates the shape. The walk is part of the schema rather than part of the caller, which means no consumer can obtain a
validated environments map without it having run.

It checks three kinds of key, and reports each at its own path:

| Where           | Path                                         |
| --------------- | -------------------------------------------- |
| A profile name  | `environments.__proto__`                     |
| A variable name | `environments.staging.variables.constructor` |
| A secret name   | `environments.staging.secrets.__proto__`     |

## 9. Known limits

| Limit                                             | Why it is one                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A duplicate profile name is silently the last one | `JSON.parse` cannot report it: `{"staging": {…}, "staging": {…}}` parses to one entry and nothing notices. Detecting it needs a custom parser, and the same limit already applies to every other object in the file                                                                                  |
| Two profiles may address the same target          | Sharing a `baseUrl` between `qa` and `staging` is a plausible mistake and not a schema error — the schema does not compare values across profiles, and a rule that did would grow into a policy                                                                                                      |
| Secrets are not resolved by this format           | A reference is a promise; something has to keep it. A profile whose secret is unset is a valid file and a failing run                                                                                                                                                                                |
| A `1`-version file using the old map shape        | If any `version: 1` document was shared before this change, it now needs `variables` around its keys, and the version literal should have moved to `2`. The loader reports an unsupported version as one clean diagnostic rather than a page of field errors, so the migration is legible either way |

## 10. Testing

| Scenario                                                            | Asserted                                                              |
| ------------------------------------------------------------------- | --------------------------------------------------------------------- |
| A profile with all three fields                                     | `parses; values preserved verbatim`                                   |
| A profile with only a target                                        | `parses — optional means optional`                                    |
| Names: `development`, `staging`, a 32-character name                | Accepted                                                              |
| Names: capitalised, leading digit, underscore, empty, 33 characters | Refused at `environments.<name>`, message naming the rule             |
| `__proto__` as a profile, variable or secret name                   | Refused at each of the three paths, and absent from the parsed result |
| `{}`, `{ "variables": {} }`, `{ "secrets": {} }`                    | Each refused with a message about what is missing                     |
| An unknown property                                                 | Refused — the profile is strict                                       |
| `baseUrl` with credentials                                          | Refused, and the refusal is a security test rather than a style one   |
| `baseUrl` relative, another scheme, not a URL, 2049 characters      | Each refused; 2048 accepted                                           |
| A secret without `name`, or with another `from`                     | Refused, with the required field named                                |
| A secret carrying a `value`                                         | Refused as an unknown key                                             |
| The root schema accepting the whole document                        | Proves composition rather than a second validator                     |
| `defaultEnvironment` naming a profile that is not declared          | The existing cross-field check, unchanged                             |

## 11. Things that will bite

**An empty profile looks configured.** It validates, it can be selected as the default, and it applies nothing — so the
first symptom is a run against whatever the previous command left behind, reported under the new name. The refinement
refuses it for that reason, and the same reasoning applies to an empty `variables` map.

**A prefix convention will be proposed again.** "Why not just write `env:NAME` and be done?" Because a string convention
is invisible to the parser, and the whole value of the two-map split is that the mistake is a validation error instead of
a run against a literal `env:NAME`.

**`new URL` repairs input rather than rejecting it.** It strips tabs and line breaks while parsing, so a value with one
embedded is accepted unless the control-character check runs first. That ordering is load-bearing and easy to lose in a
refactor that tidies the checks into a different sequence.

**The reserved-name walk reports at the profile's path, not the root's, and that is deliberate.** It runs on the raw
`environments` value, so its issue paths are relative to that field. If it is ever moved to the root pipeline, the
reported paths change — and a test that matched on the path will fail for a reason that looks like a wording problem.
