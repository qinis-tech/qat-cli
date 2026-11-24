# Configuration loading

|                  |                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Status**       | Normative                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Module**       | `src/config/loader/`                                                                                                                                                                                                                                                                                                                                                                                         |
| **Entry points** | `loadConfiguration(path, options?)`, `parseJsonDocument(text)`                                                                                                                                                                                                                                                                                                                                               |
| **Companion**    | [configuration-discovery.md](configuration-discovery.md), [configuration-validation.md](configuration-validation.md), [configuration-format.md](configuration-format.md), [configuration-schema.md](configuration-schema.md), [ADR-0024](./adr/0024-treat-a-missing-configuration-as-a-result-rather-than-a-fail.md), [ADR-0025](./adr/0025-never-fall-back-to-defaults-for-a-configuration-file-that-ex.md) |

Reading the file discovery found, parsing it, and handing it to the validation service — while keeping apart the six
reasons a configuration can fail to arrive.

## 1. The six outcomes

A path in; one of six answers out. Nothing is thrown for a problem with the file.

| Outcome     | Means                                                                     | What the reader does                                   |
| ----------- | ------------------------------------------------------------------------- | ------------------------------------------------------ |
| `loaded`    | Parsed, validated, defaults applied                                       | Proceeds with the configuration                        |
| `not-found` | Nothing at the path                                                       | Discovers again — the file moved between the two calls |
| `empty`     | Nothing but whitespace                                                    | Writes something, or restores the file                 |
| `malformed` | Not JSON. Carries position, line, column and the line itself              | Fixes the syntax at the place named                    |
| `invalid`   | Valid JSON, not a configuration. Carries one coded diagnostic per problem | Fixes the fields the diagnostics name                  |
| `too-large` | Bigger than any configuration should be                                   | Checks that the path is the file they meant            |

Six sentences rather than one because they send the reader to six places. The collapse available here — _it did not load_ —
is true in all six cases and useful in none.

**`invalid` carries exactly one diagnostic where the file declares a schema version this build does not read.** The fields
are not examined then, because a field complaint at another schema version is a guess about a schema this build has never
seen. See [configuration-validation.md](configuration-validation.md) §3.

Two things throw, and neither is a property of the file:

| Thrown    | When                                                                                                                                                                                                                                           |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `QAT1001` | The path is a directory or another non-file. A caller's mistake: discovery reports a directory occupying the name, and a directory reaching a JSON parser produces a message about a file descriptor rather than about the path a reader typed |
| `QAT5001` | The filesystem could not answer — a permission problem, a failing disk, a symlink loop. Absence is a result; a broken machine is not                                                                                                           |

## 2. Why `not-found` exists although discovery just found the file

Because the loader is reachable directly, and because the two calls are not one call.

Discovery stats the path and reports `found`; the loader stats it again and reads it. Between those two moments something
can remove the file — a formatter rewriting it, a `git checkout`, a cleanup in another process. The read's own `ENOENT` is
reported as `not-found` rather than as a failure, because the answer to the caller in that moment is the same as for a file
that was never there, and calling it a filesystem failure would be a lie about what happened.

## 3. Empty is not malformed

`JSON.parse('')` reports _unexpected end of input at position 0_, which is accurate and tells the reader nothing they can
act on. An empty file has one fix; a missing comma has another. So whitespace-only content is checked **before** parsing and
reported as `empty`.

The check is `^\s*$` rather than `length === 0`, because a file holding a newline is empty to a reader. A file holding only
a byte-order mark is also `empty` — the mark is stripped first, and `\s` matches it anyway.

## 4. A byte-order mark is stripped, and nothing else is

A file saved by an editor that writes a BOM begins with U+FEFF. `JSON.parse` rejects the prefix: the text is not JSON, it is
JSON with an invisible character in front of it.

Every other defect in a configuration belongs to whoever wrote it. This one belongs to their editor, it happens on the
platform most likely to produce it, and refusing the file would report a perfectly good configuration as broken. The mark is
removed once, at the start; a BOM anywhere else is not a BOM, it is invalid JSON, and saying so is correct.

## 5. Validation is the service's job

The loader answers _are these bytes JSON_. The validation service answers _is this a configuration_: it applies the schema,
gives each condition a permanent code, and checks the declared version before anything else. There is one call between them
and no field is judged anywhere else:

```ts
const validation = validateConfiguration(parsed.value);

if (!validation.valid) {
  return {
    kind: ConfigurationLoad.Invalid,
    path,
    diagnostics: validation.diagnostics,
  };
}
```

Three consequences a consumer depends on:

- **Every problem arrives with a code.** `QAT-C003` for a missing field, `QAT-C005` for a value the schema does not allow,
  and so on. A caller branches on the category; a reader quotes the code. The loader adds nothing to that vocabulary.
- **A failure does not quote a configured value.** The service authors its own messages from the path and the rule, because
  the validation library's text for an unrecognised member echoes what it was given — and that value could be a credential.
- **A document that declares a version this build does not read produces one diagnostic, not a page.** The reason is in
  §1 and the detail in [configuration-validation.md](configuration-validation.md).

The load result carries the service's diagnostics directly rather than a projection of its own, so there is no second shape
to keep in step. A root-level problem has an empty path: an unrecognised top-level key has no field to point at, and the key
is named in the message instead.

Reading these two paragraphs together is the useful part: **the loader contributes the path and the bytes, and everything a
reader is told about a field comes from one module.**

## 6. Never repair

A file that exists and cannot be used is a **failure**, not a reason to run with defaults. Only `loaded` carries a `config`;
the other five carry a reason and nothing else, so a caller cannot read a defaulted configuration by accident.

This is not the same as defaults being applied. A file that is valid JSON _and_ valid against the schema gets defaults for
the fields it omits — that is the format working as documented. The rule is about a file that cannot be read at all: it
produces a failure, not a run whose settings nobody chose. See
[ADR-0025](./adr/0025-never-fall-back-to-defaults-for-a-configuration-file-that-ex.md).

## 7. Where a parse error is

Four fields, because they answer different questions:

| Field            | Use                                                                    |
| ---------------- | ---------------------------------------------------------------------- |
| `position`       | Zero-based offset, clamped to the file's length. What a parser reports |
| `line`, `column` | One-based, what an editor's gutter shows and a person counts           |
| `excerpt`        | The line itself, trimmed and truncated to 120 characters               |

The offset comes from the engine's own message, which is the only thing that knows it. Everything else is computed from the
text, so a runtime that adds or drops its own `(line 3 column 5)` suffix — as V8 has done — changes nothing observable.

`reason` carries the engine's sentence verbatim. It is shown to a reader and **never asserted on**, because it is V8's
wording rather than this project's; `location` is the stable part and the part a test should pin.

## 8. The size bound

A megabyte, checked before the file is opened.

It is a **guard against a wrong path**, not a security boundary. The plausible mistake is a `qat.config.json` that resolves
somewhere unexpected — a symlink to a database, a root resolved one directory too high — and the cost of finding out after
`readFile` is an allocation. `stats.size` is a hint: a file that grows between the check and the read exceeds it, and the
bound is not enforced against the bytes actually read.

## 9. Two probes, and why

`stat` before `readFile`, for two reasons that are worth the extra call:

- A directory reaching a read produces an `EISDIR` message that names a file descriptor rather than the path a reader typed.
- The size check has to happen before the allocation rather than after it.

Both probes ask `isMissingPathError` before translating anything. That predicate answers _is there nothing at this path_ —
`ENOENT` or `ENOTDIR` — and everything it declines goes to `translateFilesystemError`, so a failure carries its errno and
the remedy that belongs to it rather than a generic sentence invented here.

## 10. Known limits

| Limit                                                          | Why it is one                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A permission failure has no test                               | Making a file unreadable produces a real test as an ordinary user and a silently passing one as root. The behaviour is implemented and throws `QAT5001`; the test waits for a runner that is not root                                                                                 |
| Invalid UTF-8 becomes _malformed_                              | `readFile` decodes with replacement characters, so a file that is not UTF-8 is reported as a JSON syntax error rather than as an encoding problem. Detecting it properly needs a buffer read and a guess at the intended encoding — and the fix for the reader is the same either way |
| Diagnostics carry paths, not line numbers                      | Mapping a dotted field path back to an offset in the text needs a second parser. The path is what a renderer needs and what a test can assert on                                                                                                                                      |
| An unsupported version reports one diagnostic, not all of them | The fields are not examined once the version is one this build does not read. A reader migrating a file fixes one thing at a time, which is friction accepted in exchange for no complaint being a guess                                                                              |
| A duplicate JSON key is silently the last one                  | `JSON.parse` cannot report it. `{"version": 1, "version": 2}` parses to `2`, and a duplicated field is a defect nothing notices. The trigger to care is a manifest large enough that it happens                                                                                       |
| The excerpt is truncated at 120 characters                     | A very long line loses the end of itself, which may be where the error is. The position and column are still exact                                                                                                                                                                    |
| `maxBytes` is not enforced on the read                         | See §8. It bounds the allocation the check prevents, not the bytes that arrive                                                                                                                                                                                                        |

## 11. Testing

| Scenario                           | Asserted                                                                                                                                                                               |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A minimal file                     | `loads a minimal file and applies the schema defaults` — the defaults are the schema's, applied once                                                                                   |
| A complete file                    | `preserves the values it was given`                                                                                                                                                    |
| A byte-order mark                  | `strips a byte-order mark rather than reporting valid JSON as broken`                                                                                                                  |
| Windows line endings               | `accepts a file with Windows line endings`                                                                                                                                             |
| Nothing at the path                | `reports not-found rather than failing`                                                                                                                                                |
| Empty, and whitespace only         | `reports an %s file as empty rather than as malformed`                                                                                                                                 |
| A trailing comma                   | `reports where the parser stopped` — line 4, excerpt `}`, and a reason that is merely non-empty                                                                                        |
| Four other broken documents        | `reports a location for every malformed case, not only the convenient ones`                                                                                                            |
| A failure carries no configuration | `does not apply defaults to a malformed file` — `'config' in result` is `false`                                                                                                        |
| An unsupported version             | `reports an unsupported version as a single coded diagnostic` — one diagnostic, `QAT-C002`. The case that proves the delegation: a loader calling the schema directly would report two |
| Several field problems             | `reports each field problem when the version is one it reads` — paths collected in one pass, each with a code                                                                          |
| JSON that is not a document        | `rejects %s at the root` over an array, `null`, a string and a number — `QAT-C001`, empty path                                                                                         |
| A directory                        | `rejects a directory` — `QAT1001`, not a load outcome                                                                                                                                  |
| The size bound, both sides         | `loads a file exactly at the size limit`, `refuses a file one byte past the limit without reading it`                                                                                  |
| The parser alone                   | Six cases with no filesystem at all, including a column computed from the last newline                                                                                                 |
| Non-functional                     | No modification, determinism, concurrent independence, working directory unchanged                                                                                                     |

The parser cases need no disk, which is deliberate: error positions are the easiest thing in this module to get subtly wrong
and the slowest to check through a temporary directory.

## 12. Things that will bite

**A valid but incomplete file gets defaults, and that is correct.** It looks like the silent defaulting §6 forbids, and it
is the opposite: the file parsed and validated, and the defaults are documented behaviour. The thing that must never happen
is defaults on a file that did not parse.

**`ENOTDIR` means two different things depending on the operation.** A `stat` on `notes.txt/qat.config.json` has found
nothing, which is an answer; a `writeFile` on the same path has been asked to create a file inside a file, which is a
failure. Only the caller knows which, which is why the predicate is separate from the translator and why the predicate has
to run first.

**A `maxBytes` mistake reads like a policy decision.** It is a guard against a wrong path. Treating it as a limit a
legitimate configuration might hit — and raising it "to be safe" — turns a diagnostic into a setting nobody understands.

**A file with one typo can report a version problem instead.** If somebody edits `version` while fixing something else, every
other field complaint disappears behind a single `QAT-C002` — which is correct and reads like the tool refusing to say what
else is wrong. The version is the first thing to check when a configuration reports only that.

**The six outcomes are a shape chosen before any caller existed.** The first command that reads a configuration may want
fewer, and convert outcomes it does not handle into its own errors. That would make some of this ceremony, and the record
says so rather than defending the six.
