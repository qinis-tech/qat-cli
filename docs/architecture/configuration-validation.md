# Configuration validation

|                 |                                                                                                                                                                                                                                                                                                                      |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**      | Normative                                                                                                                                                                                                                                                                                                            |
| **Module**      | `src/config/validation/`                                                                                                                                                                                                                                                                                             |
| **Entry point** | `validateConfiguration(value)`                                                                                                                                                                                                                                                                                       |
| **Companion**   | [configuration-schema.md](configuration-schema.md), [configuration-loading.md](configuration-loading.md), [configuration-format.md](configuration-format.md), [ADR-0022](./adr/0022-reject-unknown-configuration-fields.md), [ADR-0027](adr/0027-stop-at-an-unsupported-version-rather-than-listing-field-errors.md) |

Judging a parsed configuration document, and saying what is wrong with it in terms a caller can branch on.

## 1. What it answers, and what it does not

A parsed JSON value goes in; either a validated configuration or a list of coded diagnostics comes out.

|             |                                                                              |
| ----------- | ---------------------------------------------------------------------------- |
| **In**      | `unknown` — whatever the parser produced, which may be any JSON value at all |
| **Out**     | `{ valid: true, config }` or `{ valid: false, diagnostics }`                 |
| **I/O**     | None. No filesystem, no clock, no cache                                      |
| **Parsing** | None. A syntax error never reaches here                                      |

It takes a _value_ rather than a path, which is what makes every rule below testable as a literal — including the ones about what a message may not contain, which are the hardest to assert through a loader and the ones that matter most.

The result is a union rather than `{ valid: boolean; config?: … }`, so a caller cannot read a configuration that failed. That is the same rule the loader applies one level up, for the same reason.

## 2. The codes

Seven conditions, each with a permanent identifier. A message is prose and changes when somebody improves the wording; a code is what a caller keys on and what a reader quotes in a bug report.

| Code       | Condition                                                                                                           | The reader's next step                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `QAT-C001` | The document is not a JSON object — an array, a string, a number, `null`                                            | Wrap the settings in an object                                          |
| `QAT-C002` | The document declares a schema version this build does not read                                                     | Bring the file to the supported version, or use the build that reads it |
| `QAT-C003` | A required field is absent                                                                                          | Add it                                                                  |
| `QAT-C004` | A field holds the wrong kind of value                                                                               | Replace the value                                                       |
| `QAT-C005` | A field holds a value outside the set the schema allows                                                             | Use one of the listed values                                            |
| `QAT-C006` | A field holds a value the rules refuse — too long, too short, the wrong shape, a path that escapes, a reserved name | Correct the value                                                       |
| `QAT-C007` | A key the schema does not declare                                                                                   | Remove it, or correct its spelling                                      |

The `QAT-C` prefix is the third vocabulary in this codebase and each answers a different question: `QAT-D` is what detection found wrong with a _project_, `QAT-V` is whether that stops an _operation_, and `QAT-C` is what is wrong with a _configuration file_. A reader seeing one in a terminal knows which of the three they are being told about.

**A syntax error has no code at all.** That is the distinction between it and a validation error, stated in the vocabulary rather than in the wording: a code means a rule of this project was broken, and "that is not JSON" is not a rule of this project. The loader reports it with a position instead.

## 3. The version is checked first, and it stops the report

Before the document is validated, its `version` is read and compared with the one this build supports. If it is present and different, exactly one diagnostic comes back and the fields are not examined.

The reasoning is that every field complaint after an unmatched version is a **guess**: a required field may be missing because that schema version does not have it, and an unrecognised key may have been added afterwards. Reporting a page of speculation beside "this file is for a different version" invites the reader to fix the wrong thing.

| In the document  | Result                                                                                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version: 2`     | One `QAT-C002`, and nothing else                                                                                                                          |
| `version: "1"`   | One `QAT-C002` — a string is not the number, and calling it a type error beside field complaints would be neither honest nor actionable                   |
| `version` absent | **Not** the version rule: the schema reports `QAT-C003`, because a file with no version needs one added, which is a different fix from replacing the file |
| `version: 1`     | Everything else is examined, and several diagnostics may come back together                                                                               |

The declared version is echoed only when it is a number. A string in that position is a defect and could be anything — including the kind of value that must never be printed — so it is described rather than quoted. A number is a number.

See [ADR-0027](adr/0027-stop-at-an-unsupported-version-rather-than-listing-field-errors.md).

## 4. What a diagnostic may contain

**A path and a rule. Never a value.**

A configuration field may be `environments.staging.API_TOKEN`, and the value may be the reason it is a secret. A diagnostic is the one thing guaranteed to reach a log line, get pasted into an issue, and appear in a terminal, so the value cannot travel with it.

The mechanism is that **every message is authored here**, from the path and the rule, rather than passed through from the validation library. Two of that library's codes echo the received value — an unrecognised member of a value set, and a failed literal — and both would leak a configured value into a message.

| Source of the sentence | Used for                                                                                                    | Contains a value?         |
| ---------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------- |
| Written in `issue.ts`  | Missing, wrong type, unknown key, size, unsupported value                                                   | No                        |
| The library's text     | Only for messages _this_ project attached to a refinement — a path rule, a name rule, the cross-field check | No, because we wrote them |
| A generic sentence     | A code the mapping does not recognise                                                                       | No, deliberately          |

Three things are echoed and all three are safe:

- **The path**, because it is how the field is found. It names a _variable_, not its value, and a name has to appear for the diagnostic to be actionable at all.
- **The allowed set** for a value-set failure — `framework must be one of: cypress`. Those are our values, not the file's.
- **A size bound**, when the issue carries one, and only when it is a number or a bigint. A stringified `undefined` in a message is the wording defect this avoids.

The one place raw input is touched is the check that distinguishes a missing key from a wrong-typed one, and it is _compared_ against `undefined` and never printed. A comparison is not a disclosure.

## 5. Syntax errors and schema errors

They are distinguishable by construction rather than by their wording, because they are produced at different stages by different modules.

```
bytes ──► loader ──► JSON parser ──► validation ──► schema
           │              │                │
           │              └─ malformed: a position, no code
           │                               └─ invalid: coded diagnostics
           └─ not-found, empty, too-large
```

- **A syntax error** is the loader's `malformed` outcome. It carries a position, a line, a column and the offending line, and no `QAT-C` code.
- **A validation error** is the loader's `invalid` outcome, carrying this service's diagnostics.
- **A document that is valid JSON but not an object** is a _validation_ result — `QAT-C001` — not a parse result. The parser did its job; the value it produced is simply not a configuration.

## 6. What is not checked here

- **Nothing about the filesystem.** A path that passes the rules may point nowhere; that is the command's problem when it tries to use it.
- **Nothing across documents.** A configuration is judged alone.
- **Nothing about the project.** Whether the framework is installed, whether the version is supported by this build of _that_ tool — those belong to project detection, not to a configuration file.
- **No line numbers.** A diagnostic carries a dotted path. Mapping `output.reports` back to an offset in the text needs a second parser over the same document, which is a different piece of work with its own failure modes.

## 7. Known limits

| Limit                                                    | Why it is one                                                                                                                                                                                                                                          |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A code the mapping does not know gets a generic sentence | Deliberate: an unrecognised issue shape is not a reason to print whatever the library decided to put in its message. The cost is that a library upgrade which renames a code degrades the wording silently, since no test asserts the generic sentence |
| `QAT-C006` covers many rules                             | Too long, too short, a path that escapes, a reserved name, the cross-field check. A caller that needs to branch on which rule cannot, and the message is the only distinguishing thing                                                                 |
| The path names a sensitive variable                      | `environments.staging.PROD_DB_PASSWORD` appears in a diagnostic. That is the minimum for the message to be actionable, and it is a name rather than a value — but it is a decision rather than an accident                                             |
| Only one diagnostic for an unsupported version           | A reader migrating a file fixes the version and then discovers what else is wrong. The alternative was a page of guesses                                                                                                                               |
| No diagnostic for a _sensible_ configuration             | There is no "all is well" finding. An empty list is the good outcome, because a positive finding would be noise in every filter and every count                                                                                                        |

## 8. Testing

| Scenario                  | Asserted                                                                                                                                                                               |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A valid document          | Defaults applied; a fully populated document; a partial `output` keeping the default for the field it omits                                                                            |
| Not an object             | Five shapes, each one diagnostic with an empty path                                                                                                                                    |
| Unsupported version       | The short-circuit; a non-numeric version described rather than quoted; `'1'` read as unsupported; an absent version read as _missing_                                                  |
| Missing versus wrong type | Two separate codes for what the library encodes as one issue kind                                                                                                                      |
| Field problems            | Wrong type; an unsupported framework listing the allowed set; an unknown key named; a path that escapes; a refused profile name at the record key; several problems collected together |
| Sensitive values          | Four shapes that fail _and_ carry a secret, plus the library's own quoting behaviour                                                                                                   |
| Boundaries                | A profile name at 32 and 33; a value at 4096 and 4097; the bound printed rather than `undefined`                                                                                       |
| The vocabulary            | Seven distinct codes, each matching `QAT-C###`                                                                                                                                         |
| Non-functional            | Determinism, no mutation, never throws for any JSON value, no filesystem                                                                                                               |

## 9. Things that will bite

**The generic sentence is silent drift.** A library upgrade that renames a code produces a correct path with a vague sentence, and nothing fails. If that matters, the guard is a case asserting a specific message for each code — pinning the sentences rather than the code names.

**`QAT-C006` is a category, not a rule.** Two of its conditions can need opposite next steps, and the message is the only place the difference lives. A caller rendering only codes loses it.

**A migrating reader fixes one thing at a time.** The version rule is right and it is also friction: somebody bringing a file from version 2 sees one problem, fixes it, and then sees what else. Worth knowing before it is reported as a bug.

**`not-an-object` reads as a parse failure and is not one.** A document that is `[]` parsed perfectly. A renderer that says "could not read the file" for it will send the reader to check the JSON syntax.

**The path in a diagnostic is the variable name.** If a reviewer considers variable names sensitive, the fix is to render `environments.staging.<redacted>` — which loses the only useful part of the message. Worth deciding deliberately rather than by omission
