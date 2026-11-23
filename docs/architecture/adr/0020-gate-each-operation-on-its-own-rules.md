# ADR-0020: Gate each operation on its own rules

Date: 2026-11-22

## Status

Accepted

## Context

Two layers now describe a project and neither of them decides anything about it. Detection returns a verdict with
evidence, and it returns the same five verdicts for a directory whoever is asking. Diagnostics turn that evidence into
findings that carry a severity, an explanation and a remedy. Both answer for _the project_, and both were shaped by a
single question: what is true about this directory.

That is not the question a command has. A command has already decided what it intends to do, and it needs to know
whether what is true permits that. The two are not the same, and the gap has already produced two concrete problems.

**A report cannot be produced for the projects that need one.** `qat doctor` exists to tell a user what QAT can see,
including — especially — that a directory is not a usable Cypress project. It obtains that by calling the function that
produces a project description, which throws for exactly those cases. So the command that should describe a broken
project is the command that refuses to run on one, and the evidence behind the refusal is discarded on the way to
raising it. Catching the exception recovers a code and a message and nothing else: not whether the dependency was
declared, not whether a `cypress/` directory exists, not which file was ambiguous.

**Severity was decided without knowing the operation.** A finding's severity is a property of the condition — how
serious it is — and the existing predicate treats any error as fatal to whatever the caller was doing. That reads
correctly until there are two callers. "This project has no Cypress configuration" is an error by any measure, and it
is simultaneously not a reason to refuse to _report_ it. One severity cannot serve both readers, and the fix cannot be
to soften the severity: a missing configuration must still stop a run, which is the whole point of having it.

The conditions themselves are known and bounded. A project can be recognisable and unsupported for ten distinct
reasons: nothing identifying the framework, a missing configuration, an unsupported version, invalid package metadata,
a configuration in the wrong place, an ambiguous root, a layout that cannot be driven, an unavailable executable, a
missing dependency, or two competing configurations. Each needs a specific diagnosis, and some need a remedy the reader
can act on. Several are already reported by detection. Several cannot be: a configuration inside `cypress/` is invisible
to a probe that only looks at the root, and a directory squatting on `cypress.config.ts` is invisible to a probe that
only looks at files.

Four constraints bound the answer. Discovery may not evaluate the framework configuration, so no condition can be
established by asking Cypress about itself. No module may list a directory, so every condition has to be reachable from
an ordered list of candidate names. Error codes are permanent and are quoted in bug reports, so a second permanent
identifier for a condition that already has one is a lasting cost. And the CLI may not import the project layer, so
whatever a command relies on has to be reachable through the application contract or it does not exist as far as a
command is concerned.

## Decision

We will gate operations rather than projects.

Readiness is computed per operation from the same findings, and the findings are shared. Two operations exist:
`inspect`, which reads a project and reports what was found, and `execute`, which drives the framework. `inspect` is
never blocked — surfacing the blockers is what it is for. `execute` is blocked by any finding whose severity is
`error`. There is no single "is this project valid" verdict, because the honest answer differs by operation and a
single value would have to choose.

Validation performs no I/O. It is a pure function of the detection result, so every rule is a function from a value to
a set of codes, and the same evidence always produces the same assessment.

The rules are a table, keyed by identifier so a missing entry does not compile. The first entry carries detection's
findings forward **unchanged** — never re-derived and never re-worded — so a new detection condition gates execution
without anyone writing a rule for it. The remaining entries add conditions detection cannot see: where the
configuration sits, whether a spec location is driveable, whether the installed major is inside the policy range, and
whether a verification has found the executable unusable.

Severity stays where it already was, on the catalogue entry, and there is no second list of fatal codes. What this
decision adds is the sentence that reads it: _any error blocks execution, and nothing blocks inspection._

The layout policy is two closed classifiers — configuration placement and spec shape — each mapping to at most one
code, computed from evidence the detection engine gathers through the same fixed candidate lists as everything else.
A usable root configuration wins outright, because a project that works is not blocked over a stray directory.

The version policy has two boundaries. Below the supported floor, execution is refused. Above the newest major the
tool has been written against, it warns and proceeds.

Conditions that block are reported through one gate, which raises the existing invalid-project error code with the
blocking codes in its context. No new code is introduced per condition: the findings already identify each one
permanently, and two permanent identifiers for one condition is one that eventually disagrees with the other.

## Consequences

**Easier**

- A command can report what it found without an exception, which is the requirement `qat doctor` has and could not meet.
- Identification and readiness are separable, so a fresh clone is representable: a Cypress project whose dependency is
  not installed yet, rather than a failure indistinguishable from being in the wrong directory.
- One condition produces one sentence. Detection decides what is wrong; validation decides whether it stops anything;
  a condition reported by both is forwarded rather than described twice.
- A new detection condition gates execution for free. The forwarding requirement means the layer above cannot forget
  to consult a condition it has never heard of, which is the failure mode a rule table written by hand would have.
- The layout and version policies are pure functions of evidence, so every rule about a supported project is testable
  without a filesystem, and the fixtures for them are values rather than trees.
- The one place a command is refused is a function with a name, rather than four `throw` statements inside a
  ninety-line discovery routine.
- Ten previously indistinguishable situations now produce eight distinct diagnoses with remedies, because the
  evidence that separates them is gathered whether or not the project is usable.

**Harder**

- **`inspect` never being blocked means the gate cannot refuse anything except a run.** A command that reads a project
  gets an assessment whatever state the project is in, so it must decide its own exit code from the findings. That is
  the correct behaviour and it moves a decision into every reporting command, where it will be made slightly
  differently at least once.
- **The two gates carry the same lists.** `readiness` is the only field that differs between them, and a reader who
  compares `gates.inspect.blocking` with `gates.execute.blocking` will find them identical and may conclude the
  operations are the same. The judgement lives in one enum member and nothing about the shape emphasises it.
- **One condition, one code was not free.** The version policy's floor currently equals the configuration-format
  floor, so a version below it is already reported by detection. The requirement therefore defers when detection has
  said the same thing, and that guard is a subtle two-line branch. Remove it and every affected project carries two
  codes for one fact.
- **The legacy spec fallback is a guess, and the classifier has to prefer better evidence.** `cypress/` exists in a
  component-only project as well as in a pre-10 one, so the engine cannot distinguish them by directory names alone.
  The classifier trusts the component directory first, which means a pre-10 project that also holds components is
  classified as component-only and refused. That combination is rare, and the alternative error — treating every
  component-testing project as driveable — produces a run that starts and collects the wrong files.
- Reading the version out of a string needed a reader of its own, with no semver implementation behind it. It reads a
  prefix and does not validate: `13..0` reads as 13. That is documented rather than fixed, and any consumer that later
  wants real precedence will need the dependency this decision avoided.
- The evidence the policies read costs three more existence probes on every detection. Cheap on a local disk, less so
  on a network filesystem, and the fix if it ever matters is a directory listing the determinism rule forbids.
- A recognised-but-unusable configuration is only found in the one place it is probed for. A configuration at
  `cypress/nested/cypress.config.ts` is invisible, so "no configuration found" remains the answer for a small number of
  projects that have one.
- The requirement table can hold a requirement no fixture reaches. The table proves each entry exists, not that
  anything can arrive at it, and the same gap the diagnostic codes have applies here.
- One rule is reachable only from constructed evidence: an executable that a verification has found unusable. Nothing
  in passive detection sets that field, so the rule and its test describe a state the current program cannot produce.
- Refusing a project and explaining it are now two places. A caller reading only the exit code learns that the project
  is unusable and not which condition, so anything that needs both must read the assessment rather than the failure.
- The gate function lives beside the rules it applies, in the project layer, which `src/cli` may not import. It is
  reachable from the composition root and from tests, and not from a command — so the first command that gates has to
  move it, and moving it is the moment its message becomes part of the CLI's vocabulary.

**Neutral**

- Exit codes are unchanged. A blocked execution is an invalid-input failure, because the project is the problem
  rather than the machine; a missing install is still an environment failure, raised where it is detected.
- The assessment embeds the diagnosis rather than summarising it, so there is no second copy of "was it detected" to
  drift. The cost is that `diagnose` and `assess` read the tree independently, and a command needing both should call
  the second.
- One predicate is defined twice in shape: `hasBlockingErrors` answers for a diagnosis, and the gate builder answers
  per operation. They agree today because the forwarding requirement makes them, and they are not the same function
  because they are not the same question.
- The probe tables are derived from the root candidate list rather than written out, so a configuration format added in
  one place is probed in both.
- Discovery still raises its own errors with its own wording, so the same condition can be described in two vocabularies
  until a command adopts the assessment. This is the second record in which that duplication is recorded as a cost
  rather than resolved, and the trigger to finish it has not moved.

## Options considered

| Option                                                                 | Why not                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One project-level status: valid, valid-with-warnings, invalid          | The shape everyone reaches for first. It cannot distinguish "this is not a Cypress project" from "this project cannot run on this machine", which is the distinction the whole chain of layers exists to keep. It also duplicates the gate, and the two would be compared |
| Gate on the diagnosis alone: any error finding blocks the caller       | Simplest possible rule, and it blocks reporting on exactly the projects a report is most needed for. Softening the severities to compensate would stop a missing configuration from blocking a run                                                                        |
| A single "may I run" question with no operation set                    | Answers the gating question and leaves the reporting one unanswered, so the first command that reads a project needs a second path. The asymmetry is the design, not a detail of it                                                                                       |
| Validation re-reads the tree independently of detection                | Two readings of one tree can disagree, and the disagreement surfaces as a report and a verdict describing different projects. It also doubles the determinism burden: every probe would need its own no-listing guarantee                                                 |
| A new error code per blocking condition                                | Two permanent identifiers for one condition. A bug report quotes the finding code and a terminal prints the error code, and the day one of them changes meaning the pairing is lost                                                                                       |
| A separate table of fatal codes, alongside the severity on each entry  | Two lists of the same thing. They agree at first and then one of them is edited                                                                                                                                                                                           |
| Derive readiness from finding severity for both operations             | Produces a gate that refuses to report, which is self-defeating for the operation whose purpose is to report                                                                                                                                                              |
| Refuse any version above the newest major written against              | Turns every Cypress release into an outage, and the first person to hit it is someone whose tests would have passed                                                                                                                                                       |
| Put the operation set in the domain, beside the execution result types | Readiness is a decision about a command, not a fact about a run. The domain carries what happened; this is about whether something may happen                                                                                                                             |

## References

- `docs/architecture/validation.md` — the operations, the requirement table, both policies and the classification
- `docs/architecture/project-discovery.md` — the failure sequence and the verdict-to-error mapping
- `src/core/application/validation.ts` — the contract
- `src/project/validation/` — the rules, the policies, the catalogue and the gate
- ADR-0008, which forbids evaluating the framework configuration and rules out asking Cypress for a verdict
- ADR-0017, which separated dependency declaration from installation and is what makes "identifiable but not
  installed" representable
- ADR-0018, which separated detection from validation and produced the verdict this layer reads
- ADR-0019, which put diagnostic prose in a catalogue and left the operation-dependent decision to whoever reads it
