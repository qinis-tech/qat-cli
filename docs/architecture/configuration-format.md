# Configuration file format

|               |                                                                                                                                                                                                                                                                                                                                                      |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**    | Normative                                                                                                                                                                                                                                                                                                                                            |
| **File**      | `qat.config.json`, at the project root                                                                                                                                                                                                                                                                                                               |
| **Contract**  | [`qatConfigSchema`](../../src/config/schema/config.ts)                                                                                                                                                                                                                                                                                               |
| **Companion** | [configuration-schema.md](configuration-schema.md), [environment-profiles.md](environment-profiles.md), [configuration-defaults.md](configuration-defaults.md), [configuration-precedence.md](configuration-precedence.md), [path-resolution.md](path-resolution.md), [ADR-0023](./adr/0023-read-configuration-from-one-file-at-the-project-root.md) |

What a QAT configuration file is called, where it lives, what may go in it, and what to keep out of it.

## 1. The file

**`qat.config.json`**, at the project root. One file, one place, no search.

- There is no ascent to a parent directory. A command run inside `packages/api` reads `packages/api/qat.config.json` or
  no configuration at all; it does not read one three levels above.
- There is no `qat.config.local.json`, no `.qatrc`, and no per-developer variant.
- The file is JSON. Not YAML, and not JavaScript — a configuration file that is a program has to run to be understood,
  which is the same refusal that keeps the framework's own configuration unevaluated.

A project with no configuration file is a legitimate state: the defaults below apply and nothing else. QAT does not treat
its absence as a defect.

## 2. Shape

```json
{
  "version": 1,
  "framework": "cypress"
}
```

Two fields are required. Everything else is optional and has a default, because a configuration file should say what is
unusual about a project rather than restate the ordinary.

### What a generated file contains

`qat init` writes exactly the document above and nothing more, which is the same statement as §3's "everything else has a
default", seen from the other side. A file that spelled out `output` would turn today's default into a decision that
survives the next change to it, and nobody reading the file would be able to tell which values were chosen and which were
copied. The options are documented; the file records only what has no default.

## 3. Fields

| Field                | Type                                 | Required | Default              | What it is for                                                         |
| -------------------- | ------------------------------------ | -------- | -------------------- | ---------------------------------------------------------------------- |
| `version`            | literal `1`                          | yes      | —                    | Which version of this format the file was written against              |
| `framework`          | `"cypress"`                          | yes      | —                    | The framework to drive                                                 |
| `cypress`            | object                               | no       | —                    | Cypress-specific settings; absent when none are needed                 |
| `cypress.configFile` | path                                 | no       | detection            | An explicit configuration file, for a project detection cannot find    |
| `defaultEnvironment` | profile name                         | no       | —                    | The profile to use when a command does not name one                    |
| `environments`       | map of profile name → profile object | no       | —                    | Named environments: a target, variables and references to secrets (§4) |
| `output`             | object                               | no       | both paths defaulted | Where a run's output goes                                              |
| `output.reports`     | path                                 | no       | `results/reports`    | Rendered reports                                                       |
| `output.evidence`    | path                                 | no       | `results/evidence`   | Screenshots, video, traces                                             |

`environments` holds keys the project chooses, so its contents are not listed here — §4 describes their structure.

Every default in that table is documented, with the reason for it, in
[configuration-defaults.md](configuration-defaults.md). That document is generated from the same catalogue the resolver
reads, and a test compares it against the schema's field list in both directions — so a field added here without a
documented rule, or a rule left behind after a field is removed, fails the build rather than the reader.

## 4. Environment profiles

```json
{
  "version": 1,
  "framework": "cypress",
  "defaultEnvironment": "staging",
  "environments": {
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
  }
}
```

A profile is an object, not a bare map of variables. That is what gives it somewhere to put a target, and what lets a
secret be a different _kind_ of entry rather than a variable whose name happens to start with `SECRET_`.

An environment may carry three things, and every one of them is optional:

| Part      | Field       | Rule                                                                                    |
| --------- | ----------- | --------------------------------------------------------------------------------------- |
| Target    | `baseUrl`   | Absolute `http` or `https`, at most 2048 characters, no username or password in the URL |
| Variables | `variables` | Map of variable name → value, non-sensitive, non-empty when present                     |
| Secrets   | `secrets`   | Map of variable name → reference, non-empty when present. Never a value                 |

A secret reference has two parts, both required:

| Part            | Field  | Rule                                          |
| --------------- | ------ | --------------------------------------------- |
| Source          | `from` | The literal `"environment"`                   |
| Source variable | `name` | The environment variable that holds the value |

Names and values obey the same rules every environment value does:

| Part          | Rule                                                                               |
| ------------- | ---------------------------------------------------------------------------------- |
| Profile name  | Lowercase, hyphenated, at most 32 characters: `^[a-z][a-z0-9-]*$`                  |
| Variable name | Uppercase with digits and underscores, at most 128 characters: `^[A-Z][A-Z0-9_]*$` |
| Value         | At most 4096 characters, one line, no control characters                           |

Five refusals worth knowing, because each one looks like a file somebody wrote on purpose:

- **A profile that declares nothing.** `{}` validates as an object, can be selected as the default, and applies nothing —
  so the first symptom is a run against whatever the previous command left behind. Refused at the profile.
- **A present but empty map.** `"variables": {}` says _these apply_ and applies none of them. Refused at the field.
- **An unknown property.** Profiles are strict, like every other object here. A `timeout` key is a named error rather
  than a field quietly ignored.
- **A secret that carries a value.** A `value` beside `name` is refused as an unknown key. This is a security rule: the
  message names the line the reader typed instead of the file publishing a credential.
- **A credential in a URL.** `https://user:password@host` is a valid URL and a leaked secret, so the target check refuses
  it. Secrets have a field of their own.

A profile is selected by `--environment` or by `defaultEnvironment`. A default that names an undeclared profile is an
error at `defaultEnvironment`, because the alternative is a run that fails where nothing in the file explains it.

`__proto__`, `prototype` and `constructor` are refused as profile names, variable names and secret names: assigning
`__proto__` on an object changes its prototype rather than adding a key, and a configuration file is not an acceptable
place to learn that.

An absent `environments` means the project declares no profiles — a legitimate state, not an unfinished file. Nothing is
derived from an absence: a run that needs a profile and has none says so rather than choosing the first one it finds.

## 5. Paths

Every path — `cypress.configFile`, `output.reports`, `output.evidence` — is **relative to the project root**.

A profile's `baseUrl` is not a path and is not covered here: it is an address a run points at, checked as a URL, and it is
never joined to anything.

What the schema refuses, per field:

| Refused                                                        | Because                                                                                                                              |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| An absolute path: a leading `/`, a drive letter, a UNC prefix  | A path written for one machine is not a path another machine can use, and for an output location it is a _write_ outside the project |
| `.` or `..` segments, a leading, trailing or doubled separator | It normalises to something, and the reader cannot see what                                                                           |
| A backslash                                                    | It is a separator on one platform and a legal filename character on others                                                           |
| Control characters                                             | They corrupt the file, the terminal and the report                                                                                   |
| More than 256 characters                                       | A hand-written field that long is a mistake, and the limit is far above any real one                                                 |

What the resolver refuses as well, when it turns the configured string into an absolute location: a `~` alias, a URL such
as `file://` or `s3://`, a Windows drive-relative path (`C:reports`), and anything over 4096 characters. Those are two
different bounds on purpose — 256 is the schema's judgement about a hand-written field, 4096 is the path layer's guard
against a value that is really something else — and a reader who hits one needs to know which layer spoke. The mapping is
in §10.

**The path is validated, not the thing it names.** A `cypress.configFile` pointing at a file that is not there is a valid
configuration and an invalid project, reported by the command that tries to use it.

**The configured string is kept exactly as written.** Nothing rewrites `output.reports` in the file, and nothing rewrites
it in memory: the absolute location is computed when a command needs it, from the project root. A diagnostic therefore
quotes what the reader typed, which is the only form that lets them find it again.

## 6. Unknown fields

A field the format does not declare is an **error**, reported at the field, with the key named.

A configuration is written by hand, so a misspelled key is the most common defect it can have. Ignoring one produces a run
that behaves as though the reader had not written it, and nothing says anything is wrong. See
[ADR-0022](./adr/0022-reject-unknown-configuration-fields.md).

Strictness applies at every level, so a key inside `output`, `cypress` or a profile is refused too.

## 7. Unsupported versions

`version` is a literal. Any other value fails at `version` with the number that was found, and the message is the loader's
to write because it knows which version it supports.

A file at another version also produces **one** diagnostic, not one per field. Once the version is one this build does not
read, its field errors are speculation: a required field may be missing because that version does not have it, and a key
may be unrecognised because it was added afterwards. Reporting a page of complaints beside "this is not a version I read"
invites the reader to fix the wrong thing.

Adding an optional field does not change the version: an older file remains valid. Changing what a field means, or
removing one, does. The consequence is deliberate — a file written for a newer format is refused by an older build rather
than partly honoured, because a build that silently ignores half a configuration is one whose output cannot be trusted.

## 8. Secrets

**The configuration file is committed, so anything in it is published.** It is in the repository history, in every clone,
in every fork, and in every CI log that prints it. Deleting the line later does not remove it from the history.

Which is why a profile has a `secrets` map. An entry there names the environment variable holding the value; the value
itself never appears:

```text
"secrets": { "API_TOKEN": { "from": "environment", "name": "QAT_STAGING_API_TOKEN" } }
```

That fence is `text` rather than `json` because this is a fragment, and a test parses every `json` block in this document
as a whole configuration. Complete documents elsewhere in the file are fenced `json`; a fragment never is.

`API_TOKEN` is what the framework will receive; `QAT_STAGING_API_TOKEN` is where to read it from. Different profiles
naming different source variables is exactly the case the two fields exist for, and the schema refuses a `value` written
beside them.

So: `environments` holds **targets, defaults and references — not credentials**. A base URL, a retry count, a feature
flag, a region, and a list of names for the secrets a run needs: values that are the same for everybody working on the
branch and are useful in review. A token, a password, a private key, a session cookie — those belong in the environment
the process runs in, which is where a per-machine or per-CI-job value already lives.

Three rules follow:

- **Nothing reads a configuration value into a log line, an error message or a report.** The values are the user's, some of
  them will be sensitive despite this section, and the terminal is not redacted.
- **A URL is described rather than repeated by a diagnostic**, because userinfo is the one place a path-shaped value
  routinely carries a credential. That is a courtesy, not a licence: a credential in a committed file is already
  published.
- **A credential found in a committed file is rotated before the line is removed.** The history keeps it.

There is deliberately no local override file. The trigger to add one is a real need for per-developer settings, and it
would arrive with its own gitignore rule and its own decision record.

## 9. What is not supported

Nothing below is a setting, and a file containing one is refused rather than ignored:

- a framework's own configuration — `specPattern`, `supportFile`, `retries`, `timeout`, `browser`. Those belong in the
  framework's configuration, which QAT does not evaluate. A project that needs one sets it there.
- **a base URL for the project as a whole.** A profile's `baseUrl` selects the target for one run; it does not replace the
  framework's own, and QAT never writes it back. A project that wants a default target sets one where its framework reads
  it.
- a log level, a colour mode, an output format. Those come from a flag or an environment variable; a value with two
  sources needs a precedence rule, not a second file.
- a storage location for the execution database.
- executable code of any kind: no plugins, no hooks, no `beforeRun`.

## 10. Which layer refuses what

A reader who hits a refusal should be able to tell which module produced it, because the remedy differs.

| Refusal                                          | Reported by                   | Reported as                        | Remedy                                         |
| ------------------------------------------------ | ----------------------------- | ---------------------------------- | ---------------------------------------------- |
| The file is not JSON                             | The loader                    | `malformed`, with line and column  | Fix the syntax at the place named              |
| The file is JSON but not an object               | Validation                    | `QAT-C001`                         | Make the document an object                    |
| A field is missing, mistyped or unknown          | Validation                    | `QAT-C003`, `QAT-C004`, `QAT-C007` | Fix the field named                            |
| A value is not one the schema allows             | Validation                    | `QAT-C005`                         | Use one of the values listed                   |
| A profile declares nothing, or an empty map      | Validation                    | `QAT-C006`                         | Add a field, or remove the profile or the map  |
| A secret carries a value                         | Validation                    | `QAT-C007`                         | Remove it; name the variable that holds it     |
| An output path is absolute or leaves the project | Validation                    | `QAT-C006`                         | Write it relative to the project root          |
| The version is not one this build reads          | The loader, before validation | `QAT-C002`                         | Bring the file to the supported version        |
| A path cannot be anchored                        | The resolver                  | `PATH_*`                           | Rewrite the value as a relative, portable path |
| The configuration file cannot be used at all     | `qat init`                    | `QAT-INIT-EXISTING-*`              | Fix or delete the file                         |

Two rows deserve a second look. **A syntax error has no code** — it is a load outcome carrying a position, because a file
that will not parse has no fields for a code to name. And **`QAT-C001` is not the syntax row**: it is what a document that
parses to an array, a number or a string produces, which is why its path is empty.

In practice the last two rows are rare: a document that reaches the resolver has already had its paths judged, and the
resolver's check is a second line of defence. They are listed because a reader who sees one deserves to know it came from
a different layer than the field diagnostics they have been reading.

## 11. Adding a field

1. Add it to the schema, with a constraint built from an existing primitive where one fits.
2. Decide whether it is required. A default is usually the better answer.
3. **If it has a default, add a catalogue row** in `resolver/defaults.ts` with the value and the reason, and regenerate
   the table in [configuration-defaults.md](configuration-defaults.md). If it has none, say so with `rule: "none"` and a
   rationale — the refusal is the reviewed part, and an absent default is not self-explanatory.
4. Decide whether the version changes. An optional field does not; a changed meaning does.
5. Add it to the table in §3, to `examples/configuration/qat.config.json`, and — if it belongs in a template — say why.
6. Run the suite. The field-table check, the defaults-coverage check and the example check will all fail until the
   document, the catalogue and the schema agree, which is the reason they exist.

A field added _inside a profile_ is a different case: it is a property of a value rather than a path through the document,
so it needs no row in §3 and no catalogue entry. It needs a row in §4, a paragraph in
[environment-profiles.md](environment-profiles.md), and — if it can be absent in a way that would let a profile declare
nothing — a moment's thought about whether the profile's "declares nothing" rule still holds.

When you add a **complete document** to this file, fence it `json` so the specification check parses it. When you add a
fragment, fence it `text`: a test parses every `json` block as a whole configuration, and a fragment is not one.
