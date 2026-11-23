# ADR-0019: Register diagnostics in a catalogue

Date: 2026-11-21

## Status

Accepted

## Context

The tool can now report several distinct conditions about a project: no configuration, two configurations, a
configuration in a format it cannot read, a dependency declared but not installed, a version that predates the
configuration format, a manifest that will not parse. Three more are warnings rather than failures.

Each of those needs three things said about it — how serious it is, what happened, and what the reader can do. Until
now all three were written at the place the condition was detected: a `switch` in the validation layer holding string
literals, one branch per verdict, with the wording for the same condition appearing in a second place when the
diagnosis began reporting it.

That arrangement has one property worth keeping and one that has become a problem.

The property is that the prose sits next to the reasoning. Whoever decides that two configurations are a failure is
looking at the condition while writing the sentence about it.

The problem is that "every condition has an understandable explanation" cannot be checked. The conditions are a closed
set of constants; the explanations are string literals at arbitrary call sites. There is no collection to iterate, so
there is nothing a test can assert. A reviewer can only compare a remembered list against a scattered set, and the next
person to add a condition is under no obligation that a compiler or a test would notice.

Severity has the same shape of problem. Each raise site chooses whether a condition is fatal, which means the same
condition can be fatal in one place and advisory in another if two people disagree — and nothing compares them.

Three constraints sit around the answer. The code set is closed and permanent, in the way the error codes are: a code
is quoted in a bug report and its meaning must not change. Several entries cannot be rendered from constants at all,
because a sentence needs the project root, the declared range, or which section a dependency was found in. And the
result has to be readable by something that never imports the tool — a stored diagnosis, a report generator — which
rules out a finding that carries only a code and leaves the reader to look up text elsewhere.

The duplication between the validation layer and the diagnosis is real today and is not resolved by this record. The
record is written as the catalogue lands, because the shape of the catalogue is decided now and everything else can
follow it.

## Decision

We will hold every diagnostic's severity, explanation and remedy in one catalogue, keyed by the closed set of
diagnostic codes.

An entry declares its severity as a literal, and a `describe` function that receives a single facts object and returns
the explanation, an optional remedy, and an optional path relative to the project root.

The catalogue is a `Record` over the code union. A code without an entry does not compile, which is what turns "every
condition has an explanation" from a review obligation into a type.

Severity is a property of the entry, never of the call site. A caller cannot decide that a missing configuration is
advisory.

The rendered text is carried on the finding rather than only the code, so a diagnosis is self-describing and a stored
one still reads correctly after the catalogue's wording has changed.

## Consequences

**Easier**

- "Every defined code has an explanation" is enforced by the compiler. Adding a code and forgetting its entry is a
  build failure rather than something a reviewer might catch.
- Severity is decided once, by whoever writes the entry with the condition in front of them — not by each caller, who
  may know only part of the rule.
- A misleading remedy is one edit, and the correction reaches every consumer at once.
- A test can iterate the union and assert that every entry produces a sentence and that every error offers a remedy.
  That is a property, not a list of remembered assertions.
- Reviewers can read the tool's entire user-facing vocabulary in one file, which is where inconsistent voice and
  duplicated advice become visible rather than staying distributed.
- Because findings carry rendered text, a report generator needs no access to the catalogue, and a stored diagnosis is
  stable.

**Harder**

- **Every entry receives one facts object, so a code needing a new fact widens the shape for all of them.** The object
  will accumulate fields that exactly one entry reads, and nothing marks which those are. Removing a field later means
  checking every entry by reading it.
- **The catalogue is a second source of message text while the validation layer still writes its own.** Two sources of
  the same knowledge drift, and nothing detects the drift. This is the central cost of the decision and the reason it
  is not finished.
- Content goes stale in a way code does not. A remedy naming a configuration filename or an install command is wrong
  everywhere the moment that name changes, and no test asserts that a remedy is still true — only that one exists.
- Carrying rendered text means a diagnosis can disagree with a later catalogue, and a consumer cannot tell whether the
  text it holds is current. That is the price of the result being self-describing.
- The guarantee covers entries, not reachability. The table can hold a condition the engine never produces, and a test
  that iterates the table would pass while doing nothing useful.
- Facts are passed to every entry whether or not it uses them, so a wrong fact changes a sentence silently. A test
  asserting only that the explanation is non-empty would not notice a root that had become `undefined`.
- Debugging a specific condition is now a two-step read: find the code, then the entry, then which facts it consumed.
  Text written at the raise site was faster to find, and that is a real cost for maintainers.

**Neutral**

- The codes carry a `QAT-D` prefix, which separates a finding about a project from an application error that stopped a
  command. Both are strings and both are permanent.
- The catalogue lives in the project implementation layer rather than in the application contract. It is content the
  tool owns, not vocabulary a consumer needs to name.
- Three judgements that were previously implicit are now visibly concentrated in one file: the remedy changes when the
  project declares workspaces, a missing configuration has three different explanations, and a hoisted install is not
  worth warning about. Concentrating them makes each one easier to challenge.

## Options considered

| Option                                                                  | Why not                                                                                                                                                                                       |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Write the prose at each raise site, as before                           | The arrangement that made this a decision. The set of explanations cannot be enumerated, so the "every code explained" property cannot be tested, and severity becomes a per-caller judgement |
| A table of constant fragments that callers assemble sentences from      | Moves the words but not the sentence. A two-part message still gets assembled at each site, so the same condition can be phrased two ways and the assembly is where the drift lives           |
| A catalogue of `describe(facts)` functions keyed by the code union      | Chosen. Exhaustive by type, severity decided once, and the sentence is rendered where the facts are known                                                                                     |
| A data file of templates, loaded and interpolated at runtime            | Separates prose from code, which is a genuine benefit, and adds a loader, a schema, a template syntax and a failure mode when the file is missing — for ten entries                           |
| Codes only, with all prose generated in the presentation layer          | Puts product vocabulary in the layer that should only render, and means a stored diagnosis carries no text at all. A report could then only show codes                                        |
| One generic message per category, with the specifics left to the caller | Fewer entries, and it returns to the original problem: the part that distinguishes one condition from another is exactly the part the caller would write                                      |

## References

- `docs/architecture/diagnostics.md` — the result model, the code table and the severity rules
- `src/project/diagnostics/catalogue.ts` — the catalogue
- `src/core/application/diagnostics.ts` — the code union the catalogue is exhaustive over
- ADR-0004, which made the equivalent decision for exit codes: one table, derived from a closed set, rather than a
  number chosen wherever the failure was raised
- ADR-0018, which made the diagnosis a value so that prose had somewhere other than an exception to live
