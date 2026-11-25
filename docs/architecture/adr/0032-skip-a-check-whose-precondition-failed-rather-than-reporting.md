# ADR-0032: Skip a check whose precondition failed rather than reporting it

Date: 2026-11-24

## Status

Accepted

## Context

`qat doctor` asks twelve questions about a project, grouped into eight categories. They are not independent.

Several are unanswerable in a way that has nothing to do with whether the project is well: you cannot ask where a
project's specs live if it has no Cypress configuration, and you cannot ask whether the installed version is in range
if the framework is not installed. The question is not _is this wrong_ — it is _is this question even about this
project right now_.

Four checks depend on the project being recognisable as a test project at all. Three depend on a configuration file
being readable. One depends on the framework being installed. And when the QAT configuration file cannot be read, the
three checks that consume it — the environment selection and the two output directories — have nothing to consult,
because the paths they would test come from a document that failed to parse.

Nothing about this is hypothetical for the first command that will use the catalogue. A directory with no Cypress
configuration is exactly the directory someone runs a diagnostic command in, so the most common input to the reader is
the one where four questions cannot be answered.

The layers below have already settled what a finding is. A diagnosis is a value with a permanent code per condition, and
a remedy written once beside the code — see the earlier record on catalogues. Validation decides whether those findings
stop a particular operation, and it settled that inspection is never blocked because reporting the blockers is what
inspection is _for_. Severity is a property of the condition, decided by whoever wrote its catalogue entry, and never by
the caller: that is what stops one condition refusing a run today and advising it tomorrow.

Two facts have to be carried somewhere and neither is a finding. A check can be unanswerable because of the _project_ —
the configuration is missing — or because of the _caller_: nobody gathered the runtime version, so nothing about the
machine can be said. Those have different audiences. A user fixes the first by editing their repository. The second is a
defect in the assembly, and the person who needs to know is whoever wired it up.

The catalogue is also the place where a reader looks for a plan. It is ordered by what a reader fixes first: causes
before consequences. That ordering exists whether or not anything acts on it.

Nothing has been released. The catalogue is being written now, which is the moment its reporting rules are cheapest to
decide: every one of them will be copied by the next check, and the twelve that exist are the whole population.

## Decision

We will declare at most one precondition per check, and a precondition that did not pass makes its dependant `skipped`
rather than failed.

A skipped check carries a reason and a sentence. The reason distinguishes a **failed precondition** — a fact about the
project — from **unavailable input** — a fact about the caller. The sentence names what stopped it, so a reader learns
which question went unasked and why.

A skipped check never blocks. It is skipped _because_ another check already failed, and that failure is in the list: the
consequence is not reported as a second problem.

The precondition is declared as data in the catalogue, so the dependency graph is enumerable, and the catalogue's
declaration order guarantees a precondition appears before its dependant — which is what lets the runner resolve skips in
a single pass instead of iterating to a fixed point.

## Consequences

**Easier**

- One condition is reported once. A project with no configuration produces one failure and three silences, and the
  remedy the reader sees is the one the layer that noticed the condition wrote.
- The report reads as a plan. A reader fixing it top to bottom fixes causes before consequences, and the ordering is the
  catalogue's declaration order rather than a sort somebody maintains.
- The dependency graph is a table. It can be counted, asserted acyclic, and checked for a precondition declared after its
  dependant — none of which is possible for a chain of early returns.
- A caller defect and a project problem look different on the page. Without that distinction, a bug in the assembly
  would be reported to the user as a condition of their repository.
- Adding a check that depends on an existing one needs no new reporting rules: it declares a precondition and inherits
  the behaviour.
- The runner is one pass over one list, so a report's cost is linear in the number of checks and independent of how they
  are wired.

**Harder**

- **The report contains more skipped lines than findings, and skipping is quiet.** A reader who counts failures
  under-counts what was checked: four checks that never ran and one that failed is a report that looks like one problem.
  Nothing in the shape makes the unasked questions conspicuous.
- **One root cause can silence four checks, and if the precondition's own message is poor the rest is silence.** The
  guarantee that a skip names its cause only helps a reader who reads the list; there is no summary line saying "three
  questions were not asked".
- **"Everything skipped, nothing failed" is not a pass, and `isBlocked` cannot tell.** A report where no check ran
  returns `false` from the block predicate exactly like a healthy project, so a caller has to read the outcomes to know
  the difference. That is a real trap in the predicate's signature rather than in its implementation.
- **`failed` is reserved for error-severity checks by an invariant, not by a type.** A warning-severity check that
  returned `fail` would be reported as `warned` — the conservative reading, and still an under-claim that only a test
  catches.
- **The two skip reasons force a distinction into the fact types.** "None selected" must be representable inside a group
  that _was_ gathered, or the check skips on exactly the case it exists for. That is why one group holds an optional
  member rather than being optional, and it is a shape a reader has to be told about.
- **A check reading a group it did not declare throws.** It is a programmer's error and it should be loud, but the
  compiler cannot see it: `present` takes a value, not a label, so declaring a group and reading it are connected only by
  review.
- **Declaration order became load-bearing.** A precondition listed after its dependant throws on the first diagnosis
  rather than producing a slightly wrong report, which is the right failure and a new way for an edit to break the
  command.
- **The graph can express only one parent.** "Required only if X", "at least one of these three must pass", and a check
  that depends on two others are all inexpressible. They are inexpressible here rather than supported badly, and the
  first check that genuinely needs a second parent will need this record revisited rather than a table edited.
- **A skipped check carries its declared severity anyway.** It is accurate — that is what a failure _would_ have meant —
  and it invites a reader to add up severities of checks that never ran.

**Neutral**

- Severity stays on the catalogue entry. A skip changes what happened, never what the condition means.
- The verdict the runner consumes is three-valued — pass, warn, fail — and the fourth status exists only on the outcome.
  A check cannot return "skipped": only the runner knows what did not run, which is why it is the runner's decision.
- Exit codes are untouched. `isBlocked` is a predicate over outcomes; what a command does with it is the command's
  decision, and mapping it here would put a second exit-code table beside the one in the error model.
- The report is ordered by the catalogue, so ordering is a consequence of the declaration rather than a rule of the
  runner.

## Options considered

| Option                                                                    | Why not                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run every check and report everything that fails                          | Four findings for one missing configuration, three of them consequences, all with the same remedy in slightly different words. The reader has to work out which one to fix                                              |
| Stop at the first failure                                                 | The cheapest possible implementation, and it loses the rest of the picture. A diagnostic command that stops at its first problem cannot report what is fine, which is half of what it is for                            |
| Throw when a precondition has not passed                                  | Turns a project condition into an exception, in the one command whose whole purpose is to describe project conditions — and the earlier record on per-operation gating already settled that inspection is never blocked |
| One aggregated finding per root cause, naming the dependants in its prose | Keeps the count at one and loses the per-check status a reader scans for. The list of affected checks becomes a sentence rather than data, so nothing can count or test it                                              |
| Report dependants as `warned`                                             | A warning is advice about the project; "not run" is not advice about anything. Collapsing them makes the warning count mean two different things                                                                        |
| Make skip a fourth severity                                               | Severity says what a failure means; skip says what happened. Folding them into one column loses the independence the catalogue decision established                                                                     |
| A general dependency graph with multiple parents                          | More expressive, and it forces every reader — human and machine — to evaluate a graph. One parent covers twelve checks, and a second parent is an extension with a real caller rather than a shape chosen in advance    |
| Leave the ordering to the runner and derive it by iteration               | The skip resolution would need repeated passes to reach a fixed point, and nothing would state the dependency. A declared parent is one field; an inferred order is a theorem                                           |

## References

- `docs/architecture/doctor-checks.md` — the register, the severity policy, the skip reasons and the scenario inventory
- `src/core/application/checks.ts` — `CheckId`, `CheckStatus`, `CheckSkipReason`, `CheckOutcome`, `isBlocked`
- `src/diagnostics/checks/rules.ts` — the twelve entries and their preconditions
- `src/diagnostics/checks/run.ts` — the single pass, and the throw when a precondition was never concluded
- ADR-0019, which put each diagnostic's severity, explanation and remedy in one catalogue and made severity a property of
  the condition rather than of the caller — the decision that lets a skipped check keep its declared severity
- ADR-0020, which made readiness per operation and settled that inspection is never blocked — the precedent for "an
  unfavourable answer is a value, and the caller decides what it stops"
- ADR-0025, which made a missing configuration a result rather than a failure, on the same reasoning one layer down: an
  absence is an answer, and only a broken machine is a fault
