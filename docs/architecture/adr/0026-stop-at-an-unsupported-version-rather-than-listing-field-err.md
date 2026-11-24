# ADR-0027: Stop at an unsupported version rather than listing field errors

Date: 2026-11-25

## Status

Accepted

## Context

A configuration file declares the schema version it was written against, and a build reads exactly one version. When the
two differ, a validator has two things it can do: refuse on the version, or validate the document anyway and report
everything it finds.

Reporting everything feels more helpful, and it is what a validator built to collect failures will do by default. The
collecting behaviour exists for a good reason — a file with three mistakes should produce three messages rather than three
round trips — and the version check sits awkwardly beside it, because it is a check _about_ the schema rather than a rule
_within_ it.

The difficulty is that field errors at an unsupported version are not the same kind of statement as field errors at a
supported one. A version is a claim about a shape, and the shapes differ: a field that is required in the version this
build reads may not have existed when the file was written, and a key the file carries may have been introduced afterwards.
So a document declaring version 2 might produce:

- _`framework` is required_ — when version 2 removed the field entirely
- _`reporting` is not part of the configuration_ — when version 2 added it
- _`output.reports` must be a string_ — when version 2 renamed it

Every one of those is a true statement about the schema this build knows and a misleading statement about the file in front
of the reader. Fixing them would produce a file that is valid at version 1 and not what its author wrote.

Two earlier decisions set the surrounding rules. The version field is required and is a literal — ADR-0023 — so a build
refuses a file it does not understand rather than partly honouring it; the same record made unknown fields an error. And a
file that exists and cannot be used is a failure rather than a reason to fall back to defaults — ADR-0026 — so the
reader is going to be told to fix the file either way. Neither record says anything about how much to say.

There is a real cost on the other side. A reader migrating a file from version 2 to version 1 will hit one problem, fix
it, and discover the next. A full listing would let them do the whole thing in one pass. For a file that is two versions
behind it could be several round trips, and a colleague doing it at the end of a working day will find that tedious.

What makes the decision tractable rather than a matter of taste is a distinction the implementation can actually draw: a
version that is _present and different_ is a file for another schema, while a version that is _absent_ is a file that failed
to declare one. The second is a missing field with a one-line fix, and collapsing it into the first would send a reader
looking for a different build when what they need is to add a line.

The tool is pre-release, one configuration format exists, and nothing consumes it. The ordering is being chosen at the point
where changing it is free.

## Decision

We will check the schema version first, and stop when it is one this build does not read.

If the document declares a version that is present and different from the one supported, validation returns exactly one
diagnostic and does not examine any field. The diagnostic names both numbers and says what to do about them.

A version that is **absent** is not this rule. It is handled by the schema as a missing required field, because adding a
version and replacing a file for a different schema are different jobs.

The declared version is echoed only when it is a number. A string in that position is a defect and could be anything,
including the kind of value that must never be printed, so it is described rather than quoted.

## Consequences

**Easier**

- No field complaint is ever a guess. A message is either about the schema this build knows or about the version, and never
  a speculation about a shape that does not exist here.
- The version message is actionable in one step: it names the version found, the version read, and the two ways out.
- A reader is not sent to correct a key that their schema version does not have. That is the failure mode the alternative
  produces, and it is worse than saying less.
- The rule is one comparison in one place, before the schema runs, so it cannot be forgotten at a call site that validates
  a value.
- A file two versions behind produces a true statement immediately rather than a plausible one.

**Harder**

- **One problem per round trip.** A reader migrating a file fixes the version, runs again, and only then learns about the
  fields. A file with several mismatches takes several passes, and a colleague doing it late in the day will find that
  tedious rather than thorough.
- **A typo in the version reads as a version problem.** `"version": 11` where `1` was meant produces a correct statement
  about what this build reads, and a reader who mistyped a digit gets a lecture about schema versions instead of a
  suggestion. There is no "did you mean", because there is nothing to compare it against.
- **The ordering lives in the validator, not the schema.** The schema cannot know which version it is for, so a second
  caller of the schema's parse — an initialisation workflow validating a file it just wrote, say — bypasses this rule
  entirely. Nothing in the type says so; only review does.
- **A single diagnostic is a weaker machine-readable result.** A tool that wanted to apply fixes mechanically gets one
  problem rather than a plan, and has to re-run after each.
- **The ordering is invisible in the result type.** `{ valid: false, diagnostics }` holds one entry or several, so a
  caller cannot tell "the version was wrong" from "one field was wrong" without inspecting the code.
- **A non-numeric version is described rather than quoted**, which occasionally makes the message harder: somebody who
  wrote `"1"` sees "declares a version that is not 1" and has to notice their own quotation marks.
- **The rule assumes versions are mutually incompatible.** A schema version bumped for an additive change — which ADR-0023
  says does not happen, but which no mechanism prevents — would be refused where it could have been read.

**Neutral**

- No new code is needed beyond the one for an unsupported version. The set does not grow with this decision.
- The exit category is unchanged: a file for another schema is invalid input, as it was before.
- An absent version is unaffected, because the schema still reports it as missing.
- A file that declares the supported version is validated exactly as it was, with every field error collected in one pass.

## Options considered

| Option                                                             | Why not                                                                                                                                                                                                        |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Report every field problem and let the reader sort out which apply | Every complaint is about a schema this build has never seen. A required field may not have existed in the file's version, and a key may have been added after it. The list would be true about the wrong thing |
| Report the version first and then the field problems               | Better ordering, same guessing — and a reader who sees a list will start fixing the entries                                                                                                                    |
| Validate against the nearest known version                         | A version is a claim about a shape, not a distance from one. There is no nearest, and inventing one produces a report about a schema nobody wrote                                                              |
| Treat an unknown version as an unknown field                       | Then a file for a newer schema produces one diagnostic per key that schema added, which is worse than either option above                                                                                      |
| Refuse the version and say nothing else at all                     | Loses the two numbers and the two ways out. The diagnostic has to be actionable, not merely final                                                                                                              |
| Refuse the version and include a migration guide in the message    | A migration guide is a document, not a sentence. The message names both versions and leaves the rest to the format documentation                                                                               |

## References

- `docs/architecture/configuration-validation.md` — the codes, the version rule, and what a diagnostic may not contain
- `src/config/validation/verify.ts` — the comparison, and where it sits relative to the schema
- `src/config/validation/issue.ts` — the version diagnostic, and why a non-numeric version is not quoted
- ADR-0023, which made the version required and a literal, and made an unknown field an error rather than something to honour
- ADR-0026, which made an unusable file a failure rather than a reason to fall back to defaults — this record decides how much of that failure to describe
- ADR-0025, which made absence a result, and is why "no configuration file" never reaches this rule
