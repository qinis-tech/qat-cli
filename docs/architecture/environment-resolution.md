# Environment resolution

|                  |                                                                                                                                                                                                                                                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**       | Normative                                                                                                                                                                                                                                                                                                                                               |
| **Module**       | `src/config/resolver/environment.ts`                                                                                                                                                                                                                                                                                                                    |
| **Entry points** | `resolveEnvironment(input)`, `BASE_URL_ENVIRONMENT_VARIABLE`                                                                                                                                                                                                                                                                                            |
| **Companion**    | [environment-profiles.md](environment-profiles.md), [configuration-precedence.md](configuration-precedence.md), [configuration-defaults.md](configuration-defaults.md), [path-resolution.md](path-resolution.md), [cli-output.md](../development/cli-output.md), [ADR-0031](./adr/0031-resolve-one-approved-override-instead-of-merging-configurati.md) |

Selecting the environment a run targets, and turning one profile into the values a framework adapter needs — without
reading a file, spawning anything, or re-implementing precedence.

## 1. The chain, and which levels this stage owns

| #   | Level                         | Applied by                                      | Owned here                         |
| --- | ----------------------------- | ----------------------------------------------- | ---------------------------------- |
| 1   | Built-in default              | schema (`OUTPUT_DEFAULTS`), `defaults.ts`       | No — over before this stage runs   |
| 2   | Configuration-file value      | schema                                          | No                                 |
| 3   | Selected environment profile  | **this stage**                                  | Yes — lookup, then contribution    |
| 4   | Approved environment variable | `core/environment` precedence, called from here | Yes, as one of two override inputs |
| 5   | Explicit CLI override         | same                                            | Yes, as the other                  |

The stage does not implement levels 4 and 5. It calls the precedence resolver that already exists — the same one the
log level goes through — and passes it the flag, the variable name and the profile's value. A second merge written here
would be a second opinion about the same question, and the day the two disagreed a run would use a value nobody chose.

Concretely, `baseUrl` is resolved by one call:

```ts
resolveValue({
  flag: input.fromFlag?.baseUrl,
  environment: { name: BASE_URL_ENVIRONMENT_VARIABLE, parse: parseBaseUrl },
  configuration: profile.baseUrl,
  fallback: undefined,
});
```

## 2. Selection: explicit, default, or none

| Situation                                                      | Outcome                                                                    |
| -------------------------------------------------------------- | -------------------------------------------------------------------------- |
| A name was requested and the project declares it               | `origin: "requested"`                                                      |
| A name was requested and the project does not                  | `ENVIRONMENT_UNKNOWN`, with the declared names sorted in the remedy        |
| A name was requested and is not a valid name                   | `ENVIRONMENT_NAME_INVALID` — reported **before** the lookup                |
| Nothing requested; the configuration declared a default        | `origin: "default"`                                                        |
| Nothing requested; the project declares exactly one            | `origin: "default"` — the derivation happened upstream, in `defaulting.ts` |
| Nothing requested, nothing derivable, environment required     | `ENVIRONMENT_NONE_SELECTED`                                                |
| Nothing requested, nothing derivable, environment not required | `ok`, `origin: "none"`, no target, no variables, no secrets                |

Two decisions worth reading twice.

**The name is validated before it is looked up.** `Production` is a malformed name, not an unknown environment, and the
two have different fixes — correct the spelling, or choose from the list. Reporting every malformed name as unknown sends
the reader to check their profiles instead of their typing.

**The default is not re-derived here.** It arrives as `defaultEnvironment`, the value the configuration stage already
computed. Re-deriving it would let this stage and `qat doctor` disagree about which environment a project declares, and
the report a reader had just seen would be the one that was wrong.

`requireEnvironment` exists because "is there a target" is a question about the caller, not about the project. Execution
needs one: running against no environment means running against whatever the framework happens to default to, which
produces a result nobody can explain. Inspection does not.

## 3. What can be overridden

| Property             | Overridable                                      | Why                                                                                                                                                        |
| -------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `baseUrl`            | yes — `QAT_BASE_URL`, and the corresponding flag | Running the same suite against a preview deployment is the ordinary CI need, and a URL is not a secret                                                     |
| `variables`          | **no**                                           | A variable is written down per environment precisely so that what a run uses is reviewable. Overriding one out of band makes the file a lie about what ran |
| `secrets`            | **no**                                           | A secret's _name_ is configuration; letting it be swapped at run time is how a run authenticates as something nobody reviewed                              |
| `timeoutMs` (future) | no, until approved                               | An execution setting changes results, so it gets its own decision                                                                                          |

The surface is closed by the type: `EnvironmentOverrides` has one optional field, so an override for anything else
cannot be expressed. There is no loop over keys anywhere in the stage, and no `Record<string, unknown>` an override could
travel in.

**An override is held to the file's constraint.** `QAT_BASE_URL` and the flag are parsed by `profileBaseUrl` — the same
`Zod` constraint the profile's own field uses. An override that could introduce `https://user:pass@host` while the file
refuses it would make the override a way around a security rule, and a rule with a bypass is not a rule.

An **empty** override is not an override: `QAT_BASE_URL=` is treated as absent by the precedence resolver, the same way
a blank log level is, so the profile's value applies.

## 4. Secrets

A profile names secrets; it never stores them.

```json
"secrets": { "API_TOKEN": { "from": "environment", "name": "QAT_STAGING_API_TOKEN" } }
```

Resolution reads the named variable through an injected `readSecret` and collects the value into a container that
**redacts itself** — `ResolvedSecrets` in `core/domain/secret-values.ts`. Its `toJSON`, `toString`, template
interpolation and object spread all produce `[redacted]`, and one deliberately loud accessor,
`entriesForFramework()`, returns the values for the adapter that must put them into a child process's environment.

Three properties follow, and each has a test:

- A resolved value cannot reach a log line by accident, because the accident is what the container is shaped to survive.
- A diagnostic may name the **variable** (`QAT_STAGING_API_TOKEN`) and never a value — an unresolved secret has no value
  to print, and a resolved one must not be printed.
- The secret's _name in the profile_ (`API_TOKEN`) is configuration and may appear in a message; the variable it reads
  from may too; nothing else may.

**Every missing secret is reported, not just the first.** A reader with three expired variables should fix three, not
rediscover the second and third one command at a time.

## 5. The resolved value, and what it deliberately does not contain

| Field           | Meaning                                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------------------ |
| `baseUrl`       | The target, after every approved source has been consulted. **Absent**, not empty, when nothing supplied one       |
| `baseUrlSource` | `flag`, `environment`, `configuration` or `none` — so "why is it talking to staging?" is answerable after the fact |
| `variables`     | The profile's non-sensitive values, byte-identical                                                                 |
| `secrets`       | The redacting container                                                                                            |

The environment's **name** and **origin** (`requested` / `default` / `none`) are on the _result_, not inside the value.
`ExecutionRequest.environment` already carries the identifier, and a second field holding the same string is how a run
recorded under one name ends up targeting another — a defect that looks entirely ordinary in a report.

The value answers _what does this environment provide_. The result answers _which one, and why that one_.

## 6. Determinism and immutability

The stage is pure apart from two injected readers: the ambient environment and the secret reader. No clock, no
filesystem, no `process.env` reached directly. Two calls with the same inputs are deeply equal.

The returned value is frozen at every level, including the variables map and the secrets container. A caller that mutated
it would change what a later consumer reads, and nothing would say so — reporting and execution both hold this value.

## 7. What this stage does not do

| Not done                                 | Because                                                                                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Read the configuration file              | It receives the validated profiles and the derived default. One reader of one document                                                |
| Re-derive the default environment        | `defaulting.ts` did, and a second derivation can disagree with the report a reader just saw                                           |
| Anchor paths                             | That happened once, with the project root. A second join would double-resolve an already absolute path                                |
| Rewrite variables that "look like paths" | A variable is opaque text handed to the framework. A heuristic that rewrote some would break the one it guessed wrong about, silently |
| Validate the profiles                    | The schema did that when the document was read. This stage is not a second validator; see §8                                          |
| Spawn anything                           | The adapter drives the process. A resolver that ran tests could not be tested without them                                            |

## 8. Known limits

| Limit                                                                                                                                                                                                                   | Why it is one                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **This stage trusts its input.** A profile that never passed the schema would be used as given — a non-string `baseUrl` would flow into the precedence resolver, a non-object `variables` would be spread into nonsense | The input type says "already validated", and re-validating would be a second opinion about a format with one owner. The protection is upstream; the failure mode here is a bad target rather than a crash                                                                  |
| **A set-but-empty secret resolves.** `readSecret` returning `""` is treated as present                                                                                                                                  | An empty value is a value somebody set, the same as `NAME=` in a shell. A run that needs a token and gets `""` fails at the far end with an authentication error. Refusing it here is a defensible stricter rule and is not the rule today — worth deciding, not asserting |
| **Nothing calls this yet.** The run command is the consumer                                                                                                                                                             | No command starts a run, so no command selects an environment. The specification is the test suite until that lands                                                                                                                                                        |
| **`baseUrlSource` maps unknown levels to `none`.** The precedence resolver knows a `fallback` level that a _target_ can never have                                                                                      | Mapping rather than casting: an operator asking why a run is pointed somewhere is asking for the level, and "fallback" would name the absence of one. A new level in the resolver degrades to "we cannot say which", which is honest                                       |
| **No environment is not an empty environment.** With `requireEnvironment: false` the result has `origin: "none"`, no `baseUrl`, an empty variables map and an empty secrets container                                   | The alternative — refusing — would make inspection of a project with no environments impossible. The distinction between "nothing chosen" and "chosen and empty" is carried by `origin`                                                                                    |

## 9. Testing

| Scenario                                                | Asserted                                                                                                 |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| No request, a default declared                          | selects it, `origin: "default"`                                                                          |
| A request that differs from the default                 | `origin: "requested"`                                                                                    |
| A request equal to the default                          | still `origin: "requested"` — an explicit act is explicit even when it agrees                            |
| An unknown name                                         | `ENVIRONMENT_UNKNOWN`, remedy lists the declared names                                                   |
| A malformed name (`Production`, `-prod`, 33 characters) | `ENVIRONMENT_NAME_INVALID`, reported before the lookup                                                   |
| No profiles, required                                   | `ENVIRONMENT_NONE_SELECTED`, remedy says what to add                                                     |
| No profiles, not required                               | `ok`, `origin: "none"`, no `baseUrl` key at all                                                          |
| Two profiles, no default, no request                    | `ENVIRONMENT_NONE_SELECTED`, remedy lists both                                                           |
| `QAT_BASE_URL` set                                      | the override wins, `baseUrlSource: "environment"`                                                        |
| Flag and variable both set                              | the flag wins — the level order in one assertion                                                         |
| Neither set                                             | the profile's value, `baseUrlSource: "configuration"`                                                    |
| Nothing supplies a target                               | `baseUrlSource: "none"`, `"baseUrl" in environment` is `false`                                           |
| `QAT_BASE_URL=""`                                       | treated as absent; the profile's value applies                                                           |
| `QAT_BASE_URL="https://user:pass@host"`                 | rejected — the override cannot bypass the file's constraint                                              |
| A variable value that looks like a path                 | passed through byte-identical                                                                            |
| Secrets: all present / one absent / two of three absent | resolved; one issue naming the variable; three issues in one pass                                        |
| Serialisation                                           | `JSON.stringify` and `console.log` of the resolved value contain `[redacted]` and neither secret's value |
| Two calls, equal inputs                                 | `toStrictEqual`; the input profiles are unmodified                                                       |
| The module's imports                                    | no `child_process`, no `fs`, no direct `process.env`                                                     |

## 10. Things that will bite

**`baseUrl` absent and `baseUrl` empty are different answers**, and only one is expressible. `exactOptionalPropertyTypes`
forbids an optional property holding `undefined`, so "nothing supplied one" is an absent key plus `baseUrlSource: "none"`
— asserted with `"baseUrl" in environment`, not with a truthiness check, which would pass for both.

**A secret that is present but empty is a resolved secret.** It will fail somewhere in the framework, with a message
about authentication and no mention of the configuration. If that turns out to be the common case in practice, the
stricter rule belongs here with its own issue code.

**The identifier and the value can be built from different facts.** `ExecutionRequest.environment` is a string the caller
already had; `resolvedEnvironment` is what resolution produced. A caller that fills one from `--environment` and the other
from the project's default creates a run recorded under one name and pointed at another — which is exactly why the name
is not duplicated inside the value, and why a future request builder should set both from one `EnvironmentResolution`.

**An override validated with a copy of the rule is not validated.** `parseBaseUrl` calls `profileBaseUrl`, the same
function the file's field uses. If it ever imports an equivalent — a regex, a second `z.string().url()` — the override
stops being held to the constraint, and the file's security rule acquires a bypass that no test of the file will notice.
