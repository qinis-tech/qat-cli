# ADR-0022: Reject unknown configuration fields

Date: 2026-11-24

## Status

Accepted

## Context

A configuration file is the one input a user writes on purpose. Everything else the tool reads — a manifest, a
framework's configuration, a subprocess's output — was written for another purpose and merely happens to be here. A
configuration file was written to tell this tool what to do, so the most damaging thing it can do is misunderstand it
silently.

The failure mode is specific and it is not hypothetical. A key is misspelled: `reportDir` for `reports`, `enviroments`
for `environments`. The tool reads the file, does not recognise the key, and proceeds. Everything else in the file works,
the run succeeds, and the reports are written to the default directory instead of the one that was asked for. Nothing
says anything is wrong. The reader concludes the setting does not work, or works intermittently, and spends an hour
before opening the file it just wrote.

Two other shapes of the same problem matter. A key may be spelled correctly in a version of the tool that does not exist
yet, and a file written by a newer build is read by an older one. And a key may be deliberately private to a tool that
runs beside this one — an editor's configuration, a wrapper's metadata — in which case a strict reader refuses a file
that is otherwise fine.

There is a second constraint pulling in the same direction. Zaid's law of tools and configuration is that whatever a
program accepts, somebody will write, and whatever it ignores, somebody will believe. A schema that ignores a key
converts a typo into a behaviour difference that no error, log line or exit code reports.

Against that sits the forward-compatibility cost. A strict reader cannot read a file written for a later version, which
means adding a field is a coordinated change across every machine that reads the file. And `package.json` is the
counter-example everybody reaches for: npm ignores unknown top-level keys, which is why a manifest can carry metadata for
a dozen tools at once.

The schema already carries a version field, which changes the shape of the problem. A document that states its version
can be refused on version grounds with a message that names both numbers. That is a legitimate refusal — the reader is
told the file is newer than the tool, which is actionable — whereas a refusal on an unrecognised key alone would be
mysterious without that context.

The tool is pre-release and there is one configuration file format, so nothing depends on the current behaviour. The
decision is being taken while it is free.

## Decision

We will reject a configuration field the schema does not declare.

A configuration object is parsed strictly at every level — the document root, `cypress`, and `output` — so an
unrecognised key fails the parse and is reported at the field it occupies, with the key named in the message.

The cost this creates is paid for by the version field rather than by permissiveness: a file written for a newer schema
fails at `version` with the number that was found, which tells the reader what is actually wrong. Permissiveness is not
used as a substitute for a version, and a version is not used as a substitute for strictness; the two answer different
questions and both are required.

The version itself is a literal rather than a range. This build validates one shape, and accepting a range would be a
promise to validate shapes it has never seen.

Adding an optional field does not change the version, because an older file remains valid and an older build reading a
newer file fails at the unknown key rather than pretending to understand it — which is the honest answer, and the one the
version message makes survivable.

## Consequences

**Easier**

- The most common defect a hand-written configuration can have is reported at the field, in the first second, rather
  than as a run that quietly does something else.
- A file that parses means exactly what it says. There is no subset of it the tool read and no remainder it discarded,
  which is what makes a configuration reviewable at all.
- A misspelling that happens to name another tool's key is refused too. That is the same defect from the reader's point
  of view, and the fix is the same: correct the key or remove it.
- Each new field is a deliberate change with a fixture behind it, because an undeclared field cannot be used at all.
- The strictness is declared once, in the schema, so the loader, the resolver and the initialisation workflow cannot
  disagree about it.

**Harder**

- **A configuration file cannot be shared with a tool that wants its own keys in it.** A wrapper, an editor plugin, a
  repository that keeps one file per tool at the root — each needs a separate file rather than a key in this one. The
  `package.json` precedent does not transfer, because that file's whole purpose is to be extended by tools and this one's
  is not.
- **A file written for a newer build is refused outright rather than partly honoured.** Someone on a branch ahead of
  main, or a colleague on a newer release, produces a file an older binary will not read at all. The version message
  names the problem, and the work still stops.
- **Adding an optional field creates a one-way window.** A newer file is unreadable by an older build, so a team with
  mixed versions cannot share a repository without coordinating. Nothing in the design can fix that; the alternatives are
  worse.
- The version number now carries weight it did not before. It becomes the thing a reader relies on when a field is
  unrecognised, so bumping it too rarely makes a legitimate refusal look like a typo, and bumping it too often makes
  every file version-specific for no reason.
- Strictness at every level means a nested key is refused too, so an extra key inside `output` fails a file whose
  top-level fields are all correct. That is coherent and it is a second place a surprise can come from.
- Every document, example and README snippet in the repository now has to be correct. A worked example with an unknown
  key in it is a worked example that fails, which is good and also means documentation is a test surface.

**Neutral**

- The exit status is unaffected. A configuration that does not parse is invalid input, which is what it was before this
  decision and what it will be after.
- Nothing consumes a configuration yet, so no user-visible behaviour changes. The decision is taken at the point where
  it is cheapest, which is the point the schema is written.
- `zod` becomes a runtime dependency. A hand-written validator would avoid it and would also give up collected,
  path-carrying issues — which is what makes a field-specific message possible at all.

## Options considered

| Option                                                 | Why not                                                                                                                                                                                                                                 |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Strip unknown fields, as most configuration readers do | The behaviour that produces the hour-long debugging session. The tool and the reader disagree about what was asked for, and nothing reports the disagreement                                                                            |
| Pass unknown fields through, as `package.json` does    | Right for a file whose purpose is to be extended by third parties. This file is written for one tool, so a key it does not understand is either a typo or a newer version, and neither is a case where carrying the value forward helps |
| Warn on an unknown field and continue                  | A warning on standard error is not read by the caller that matters — a pipeline. And a run that proceeds with half a configuration is the failure, not the warning                                                                      |
| Strict, with a version range instead of a literal      | A range promises validation of shapes this build has never seen. It would accept a future file and then behave unpredictably on it, which is strictly worse than refusing                                                               |
| Strict, and bump the version for every added field     | Then a file cannot use an optional field without becoming unreadable to builds that predate it, for no benefit — an older build refusing at the unknown key is already the correct, informative outcome                                 |
| Strict only at the root, permissive in nested objects  | A misspelling one level down is the same defect and the same cost. Two policies for one file is also two things to explain                                                                                                              |

## References

- `docs/architecture/configuration-schema.md` — the fields, the path rules, and the version policy
- `src/config/schema/config.ts` — the schema, the defaults and the cross-field rule
- `src/config/schema/constraints.ts` — the primitives every field is built from
- `tests/fixtures/config/invalid/` — one file per refused rule
- ADR-0005, which separated diagnostic logs from user-facing output and is why a warning would not be enough here
- npm's documented behaviour for unknown `package.json` keys, which is the precedent this record deliberately does not
  follow, and the reason it does not
