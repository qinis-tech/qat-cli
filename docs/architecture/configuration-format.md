# Configuration file format

|               |                                                                                                                                                                                                |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**    | Normative                                                                                                                                                                                      |
| **File**      | `qat.config.json`, at the project root                                                                                                                                                         |
| **Contract**  | [`qatConfigSchema`](../../src/config/schema/config.ts)                                                                                                                                         |
| **Companion** | [configuration-schema.md](configuration-schema.md), [configuration-precedence.md](configuration-precedence.md), [ADR-0023](./adr/0023-read-configuration-from-one-file-at-the-project-root.md) |

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

## 3. Fields

| Field                | Type                                     | Required | Default              | What it is for                                                      |
| -------------------- | ---------------------------------------- | -------- | -------------------- | ------------------------------------------------------------------- |
| `version`            | literal `1`                              | yes      | —                    | Which version of this format the file was written against           |
| `framework`          | `"cypress"`                              | yes      | —                    | The framework to drive                                              |
| `cypress`            | object                                   | no       | —                    | Cypress-specific settings; absent when none are needed              |
| `cypress.configFile` | path                                     | no       | detection            | An explicit configuration file, for a project detection cannot find |
| `defaultEnvironment` | profile name                             | no       | —                    | The profile to use when a command does not name one                 |
| `environments`       | map of profile → map of variable → value | no       | —                    | Named sets of variables                                             |
| `output`             | object                                   | no       | both paths defaulted | Where a run's output goes                                           |
| `output.reports`     | path                                     | no       | `results/reports`    | Rendered reports                                                    |
| `output.evidence`    | path                                     | no       | `results/evidence`   | Screenshots, video, traces                                          |

`environments` holds keys the project chooses, so its contents are not listed here — §4 describes their structure.

## 4. Environment profiles

```json
{
  "version": 1,
  "framework": "cypress",
  "defaultEnvironment": "staging",
  "environments": {
    "staging": { "API_URL": "https://staging.example.test", "RETRIES": "2" }
  }
}
```

| Part          | Rule                                                                               |
| ------------- | ---------------------------------------------------------------------------------- |
| Profile name  | Lowercase, hyphenated, at most 32 characters: `^[a-z][a-z0-9-]*$`                  |
| Variable name | Uppercase with digits and underscores, at most 128 characters: `^[A-Z][A-Z0-9_]*$` |
| Value         | At most 4096 characters, one line, no control characters                           |

A profile selected by `--environment` or by `defaultEnvironment`. A default that names an undeclared profile is an error
at `defaultEnvironment`, because the alternative is a run that fails where nothing in the file explains it.

`__proto__`, `prototype` and `constructor` are refused as profile names and as variable names: assigning `__proto__` on an
object changes its prototype rather than adding a key, and a configuration file is not an acceptable place to learn that.

## 5. Paths

Every path — `cypress.configFile`, `output.reports`, `output.evidence` — is **relative to the project root**, and:

- not absolute: no leading `/`, no `C:`, no `\\`
- forward slashes only, so the same file works on every platform
- no `.` or `..` segments, no leading, trailing or doubled separator
- no control characters
- at most 256 characters

These are rules rather than guidance, because a path that resolves outside the project is a _write_ outside the project —
a different class of accident from a wrong directory. The schema enforces each one; [configuration-schema.md](configuration-schema.md)
records the reasoning.

**The schema validates the path, not the existence of what it names.** A `cypress.configFile` pointing at a file that is
not there is a valid configuration and an invalid project, and that is reported by the command that tries to use it.

## 6. Unknown fields

A field the format does not declare is an **error**, reported at the field, with the key named.

A configuration is written by hand, so a misspelled key is the most common defect it can have. Ignoring one produces a run
that behaves as though the reader had not written it, and nothing says anything is wrong. See
[ADR-0022](./adr/0022-reject-unknown-configuration-fields.md).

Strictness applies at every level, so a key inside `output` or `cypress` is refused too.

## 7. Unsupported versions

`version` is a literal. Any other value fails at `version` with the number that was found, and the message is the
loader's to write because it knows which version it supports.

Adding an optional field does not change the version: an older file remains valid. Changing what a field means, or
removing one, does. The consequence is deliberate — a file written for a newer format is refused by an older build rather
than partly honoured, because a build that silently ignores half a configuration is one whose output cannot be trusted.

## 8. Secrets

**The configuration file is committed, so anything in it is published.** It is in the repository history, in every clone,
in every fork, and in every CI log that prints it. Deleting the line later does not remove it from the history.

So: `environments` holds **defaults, not credentials**. A base URL, a retry count, a feature flag, a region — values that
are the same for everybody working on the branch and are useful in review. A token, a password, a private key, a session
cookie — those belong in the environment the process runs in, which is where a per-machine or per-CI-job value already
lives.

Two rules follow, and both are for code that does not exist yet:

- **Nothing reads a configuration value into a log line, an error message or a report.** The values are the user's, some
  of them will be sensitive despite this section, and the terminal is not redacted.
- **A credential found in a committed file is rotated before the line is removed.** The history keeps it.

There is deliberately no local override file. The trigger to add one is a real need for per-developer settings, and it
would arrive with its own gitignore rule and its own decision record.

## 9. What is not supported

Nothing below is a setting, and a file containing one is refused rather than ignored:

- a framework's own configuration — `baseUrl`, `specPattern`, `supportFile`, `retries`, `timeout`, `browser`. Those belong
  in the framework's configuration, which QAT does not evaluate. A project that needs one sets it there.
- a log level, a colour mode, an output format. Those come from a flag or an environment variable; a value with two
  sources needs a precedence rule, not a second file.
- a storage location for the execution database.
- executable code of any kind: no plugins, no hooks, no `beforeRun`.

## 10. Adding a field

1. Add it to the schema, with a constraint built from an existing primitive where one fits.
2. Decide whether it is required. A default is usually the better answer.
3. Decide whether the version changes. An optional field does not; a changed meaning does.
4. Add it to the table in §3, to `examples/configuration/qat.config.json`, and — if it belongs in a template — say why.
5. Run the suite. The field-table check and the example check will both fail until the document and the example agree with
   the schema, which is the reason they exist.
