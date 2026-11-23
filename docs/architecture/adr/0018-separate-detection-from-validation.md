# ADR-0018: Separate detection from validation

Date: 2026-11-21

## Status

Accepted

## Context

Deciding what a directory is and deciding whether it can be used are two questions, and until now one function
answered both. `discoverProject` read the manifest, scanned for configuration filenames, checked for an installed
package, and threw on the first thing that was wrong. Its result was all-or-nothing: a project description, or an
exception.

That shape works for one caller. It stops working at the second.

`qat doctor` reports what it finds, which means it must be able to say _this directory has Cypress installed and no
configuration file_ — a sentence built from two facts, one favourable and one not, neither of which is an error. It
currently obtains those facts by letting discovery succeed and reading the project description, which means a
directory with no configuration produces an exception instead of a report. Catching it would give the caller the
code and nothing else: not whether the dependency was declared, not whether the package was installed, not whether
a `cypress/` directory existed. The evidence was gathered and then discarded on the way to the error.

`qat init` makes the problem sharper. Its whole purpose is to run in a directory that is not yet a Cypress project
and to make it one. Every case detection reports as a failure is a case `init` must succeed at, and it has to
distinguish them: given a directory with Cypress installed and no configuration, the right behaviour is to offer to
create one; given a directory with nothing Cypress-shaped at all, the right behaviour is to ask whether this is
really where the user meant to be. Both are answers, and neither can be obtained from an exception.

There is a second distinction tangled up in the first. _This is a Cypress project_ and _Cypress can run here_ are
routinely different. A fresh clone has a configuration file and no `node_modules`; a workspace member has an
installed package and no configuration of its own. The existing function reports both as one thing — a failure —
because it has one mechanism for unfavourable news.

Constraints from earlier decisions shape what is possible. The framework configuration may not be evaluated, so a
verdict cannot be obtained by asking Cypress about itself. Errors are the mechanism by which a command stops, and
the top-level handler turns any of them into an exit code, so anything thrown is fatal to the command that threw
it. The exit-code contract has one home, and moving a decision out of the error model would put a second mapping
somewhere else.

Nothing has been released. The engine is being written now, which is when the shape of it is cheapest to get
right.

## Decision

We will split the question in two.

`src/project/cypress-detection/` gathers evidence and returns a verdict. It answers _is this a Cypress project QAT
can drive_, it returns one of five verdicts with the evidence attached, and it does not throw for an unfavourable
answer. Absence, ambiguity and an unusable configuration format are diagnoses.

`discoverProject` validates. It decides which verdicts are permitted for the command about to run, turns the rest
into errors with remedies, checks that a detected project actually has the framework installed, and assembles the
project description from the evidence.

Two corollaries carry the weight:

- **`detected` means identifiable, not runnable.** A project with a supported configuration and no installed
  package is detected. The missing dependency is a separate failure with a separate code, raised by validation.
- **The engine throws only when input cannot be read.** A manifest that does not parse is an error, not a verdict.
  _There is nothing here_ and _there is something here and it will not open_ are different problems and only the
  second is a fault.

The verdict set is closed, and the mapping from verdict to error in validation is an exhaustive `switch`, so a
sixth verdict is a compile error rather than an unhandled case.

## Consequences

**Easier**

- A command can report what it found without an exception, including that there is nothing to find. That is the
  requirement `qat init` has and `qat doctor` already half-has.
- The evidence is available on every path. Three situations that previously produced one message now produce
  three — an installed package with no configuration, a declared dependency with no configuration, and a bare
  `cypress/` directory — because each verdict arrives with the facts that distinguish it.
- Identification and runnability are separable, so a fresh clone is representable: a Cypress project whose
  dependency is not installed yet.
- A verdict is a value, so a test asserts it directly and can also assert the evidence that produced it. Asserting
  which exception a call throws is a coarser instrument, and it cannot see the evidence at all.
- The engine is testable without the error model and the error model without the engine. Neither needs the other's
  fixtures.
- The one place that decides fatal-from-not is a function a reader can find. Before, that decision was spread
  across four `throw` statements inside a ninety-line function.

**Harder**

- **`detected` will be mistaken for "ready to run".** The type says a configuration exists; it says nothing about
  whether Cypress is installed, and a consumer that reads `detected` and proceeds will fail later with a less
  useful error than the one validation would have produced. Nothing in the type prevents it, and the field that
  would — the installation — is on the evidence rather than in the verdict.
- **Two vocabularies must be held together.** Five verdicts, seven error codes, and two verdicts sharing one code.
  A reader moving between the two modules carries a mapping in their head that neither type states.
- **Ordering is now split across the seam.** The engine decides that ambiguity precedes absence; validation decides
  that an unreadable manifest precedes both. Neither module can see the whole sequence, and the sequence is only
  written down in prose.
- Failure news arrives in two shapes — a verdict value and an exception — so every caller handles both, and a
  caller that handles only the exception treats `absent` as success.
- The engine pays for evidence whether or not it is wanted. The layout scan runs three directory probes and four
  file probes on every call, including calls that only need to know whether a configuration exists.
- A new _rule_ inside an existing verdict is unconstrained. Adding a verdict breaks the switch and gets reviewed;
  reclassifying what counts as `incomplete` changes behaviour with nothing to catch it.
- `detectCypress` is Cypress-specific by name and by content. A second framework needs its own engine and a
  selection rule in validation, which is honest and is also more work than adding a branch would have been.

**Neutral**

- Exit codes are unchanged, and the mapping from verdict to code lives in validation, so the contract still has one
  home. A caller that reads only the exit code sees no difference.
- The verdicts are not domain vocabulary. They live in the implementation layer until a command needs to report
  one, at which point they move — and moving them early would put a discovery concept into a type every layer
  consumes.
- The layout evidence is a superset of what a project description needs: it reports every conventional candidate
  that exists, and validation takes the first of each list. The choice is therefore in one place, which was not
  true before.
- The engine's cost is the same work the single function did, minus the duplicated spec-directory and support-file
  lookups that validation used to re-derive, plus one directory probe. It is not measurably different.

## Options considered

| Option                                                                                               | Why not                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One function that throws, as before                                                                  | The shape that made this a decision. It cannot report without an exception, and it discards the evidence on the way to raising one, so the second caller cannot exist                                                                                                                           |
| One function that never throws, returning a result for every outcome including unreadable input      | Removes the exception entirely, which sounds tidier and moves a real fault into a result variant. Every caller would have to handle "the manifest is broken" as a case in a switch it can do nothing about, while the one call site that can — the top-level catch — already handles exceptions |
| Detection returns a verdict; validation throws                                                       | Chosen. The diagnosis is a value, the decision is an exception, and each has exactly one home                                                                                                                                                                                                   |
| Detection returns a boolean plus an error union                                                      | Loses the ability to distinguish ambiguity from an unusable format without a parallel evidence object, and a boolean named `isCypress` invites exactly the "detected means runnable" mistake the split exists to prevent                                                                        |
| Two entry points, one asking "is this Cypress" and one asking "can it run", each doing its own reads | Doubles the filesystem work and lets the two answers disagree, which is the failure mode a single evidence-gathering pass exists to prevent                                                                                                                                                     |
| Return the evidence only, and let each caller decide what it means                                   | Pushes the classification into every consumer. Two commands would classify the same directory differently, and the difference would be invisible until someone compared their output                                                                                                            |

## References

- `docs/architecture/cypress-detection.md` — the five verdicts, the rules behind each, and what the engine does not do
- `docs/architecture/project-discovery.md` — the failure sequence and the verdict-to-error mapping
- `src/project/cypress-detection/` — the engine
- `src/project/discovery.ts` — the validation layer
- ADR-0008, which forbids evaluating the framework configuration and therefore rules out asking Cypress for its own verdict
- ADR-0017, which separated dependency declaration from installation and is what makes an "identifiable but not runnable" project representable at all
