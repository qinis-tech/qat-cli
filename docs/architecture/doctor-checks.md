# Doctor checks

|               |                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**    | Normative                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Contract**  | `src/core/application/checks.ts`                                                                                                                                                                                                                                                                                                                                                                               |
| **Catalogue** | `src/diagnostics/checks/rules.ts`, with the branch-heavy checks in `rules/node-runtime.ts` and `rules/package-manager.ts`                                                                                                                                                                                                                                                                                      |
| **Guidance**  | `src/diagnostics/checks/guidance.ts`                                                                                                                                                                                                                                                                                                                                                                           |
| **Runner**    | `src/diagnostics/checks/run.ts`                                                                                                                                                                                                                                                                                                                                                                                |
| **Companion** | [diagnostics.md](diagnostics.md), [validation.md](validation.md), [configuration-validation.md](configuration-validation.md), [runtime-compatibility.md](runtime-compatibility.md), [package-managers.md](package-managers.md), [ADR-0032](./adr/0032-skip-a-check-whose-precondition-failed-rather-than-reporting.md), [ADR-0034](./adr/0034-detect-the-package-manager-from-declared-metadata-and-lockfi.md) |

The questions `qat doctor` answers about a project, and the rules its report obeys.

## 1. A check is a question

Every check in this catalogue is a pure function of evidence somebody else gathered — a runtime version, an assessment,
a configuration load result, a writability fact. Nothing in the catalogue reads a file, spawns a process or writes to a
stream.

That constraint is not tidiness. A documented _purpose_ and four documented _outcome conditions_ per check are only
verifiable if the check can be run from a value; a rule that touches a disk can only be checked by building a disk, and
the branches nobody bothers to build a directory for are exactly the ones that go wrong. So the catalogue is a table of
values, and the twenty-odd probes it depends on belong to whoever gathers the facts.

**Seven checks judge** something no other layer looks at: the runtime QAT itself requires, the runtime a project's
framework requires, the project's package-manager environment, the QAT configuration file, the selected environment, and
the two output directories.

**Six checks forward** a conclusion a lower layer already drew. They find the finding the assessment carries and carry
it onward unchanged — same code, same severity, same remedy. Their value is not the logic; it is that the question a
user asks is answered where the user looks for it, with the words the layer that noticed the condition chose.

Three judging checks have real branches — a floor, a ceiling, gap alternatives, pre-release admission, seven
package-manager conditions — and those live in `rules/*.ts` rather than inside the map literal, so each branch can be
tested on its own. The catalogue's job is to say which questions exist, in what order, under which identifier.

The runtime pair is the one place where "judging" needed an authority it does not own. Neither question can be answered
by restating a conclusion — QAT's own range and a project's framework range are separate declarations — and both
delegate to the single compatibility engine in `core/compatibility`. The detail is in
[runtime-compatibility.md](runtime-compatibility.md); the catalogue's part is only to say which question comes first. The
package-manager check delegates in the same way: the version the project expects arrives as evidence and is compared by
that same engine, so there is one notion of "satisfies" in the product.

## 2. The register

Thirteen checks, in the order a report presents them, which is the order a reader fixes things in: causes before
consequences.

| Check                           | Category              | Severity | Mandatory | Precondition                    | Codes it may report                          | Purpose                                                                       |
| ------------------------------- | --------------------- | -------- | --------- | ------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------- |
| `runtime.node-version`          | runtime               | error    | yes       | —                               | `QAT-H001`, `QAT-H008`                       | The running Node version is inside the range QAT declares                     |
| `cypress.runtime-supported`     | runtime               | warning  | yes       | —                               | `QAT-H009`                                   | The running Node version is inside the range the project's framework needs    |
| `environment.package-manager`   | package-manager       | warning  | yes       | —                               | `QAT-H002`, `QAT-H010`–`QAT-H017`            | The package-manager environment is consistent with the project and the policy |
| `project.recognised`            | project-structure     | error    | yes       | —                               | `QAT-D001`, `QAT-D007`                       | The directory is a test project at all                                        |
| `project.package-metadata`      | project-structure     | warning  | no        | `project.recognised`            | `QAT-D010`, `QAT-D011`                       | The project name is declared rather than assumed                              |
| `cypress.configuration-located` | cypress-configuration | error    | no        | `project.recognised`            | `QAT-D002`, `QAT-D004`                       | There is exactly one configuration, in a format this tool reads               |
| `cypress.layout-driveable`      | cypress-configuration | error    | no        | `cypress.configuration-located` | `QAT-V002`                                   | There is a spec location QAT can drive                                        |
| `cypress.installed`             | cypress-installation  | error    | no        | `cypress.configuration-located` | `QAT-D005`                                   | The framework is on disk                                                      |
| `cypress.version-supported`     | cypress-installation  | error    | no        | `cypress.installed`             | `QAT-D006`, `QAT-V005`, `QAT-V006`           | The installed major is inside the range this tool drives                      |
| `qat.configuration-loadable`    | qat-configuration     | error    | yes       | —                               | `QAT-H004`–`QAT-H006`, `QAT-C001`–`QAT-C007` | The configuration file is a document, and a configuration                     |
| `qat.environment-resolvable`    | environment-profiles  | error    | no        | `qat.configuration-loadable`    | `QAT-H007`                                   | The environment a command selected exists                                     |
| `output.reports-writable`       | output-permissions    | error    | no        | `qat.configuration-loadable`    | `QAT-H003`                                   | A report can be written where the configuration says                          |
| `output.evidence-writable`      | output-permissions    | error    | no        | `qat.configuration-loadable`    | `QAT-H003`                                   | Evidence can be written where the configuration says                          |

**Mandatory** is derived, not stored: a check with no precondition is always asked. That is five of the thirteen, and
the derivation is asserted rather than trusted, so the word cannot drift from the table.

**Ten checks are fatal and three are advisory.** The advisory ones — the package manager, the project's own metadata,
and the project's framework runtime bound — share the property that their worst answer is _advice_: a project that
names no manager is still runnable, a project with no manifest is legal, and a framework's declared bound is metadata
QAT neither controls nor verifies.

The two runtime checks are the clearest illustration of why mandatory-ness and blocking are different questions. Both
are always asked, because a runtime question has an answer on every machine; only one can refuse a run, because only
one of the two requirements is QAT's to enforce. Making the advisory blocking would let a dependency's `engines` field
veto work over a bound nobody checked. The package-manager check sits in the same position: always asked, never blocking,
because a mismatched installer predicts a confusing `install` later rather than preventing a run now.

### The eight categories

| Category              | Checks |
| --------------------- | ------ |
| runtime               | 2      |
| package-manager       | 1      |
| project-structure     | 2      |
| cypress-configuration | 2      |
| cypress-installation  | 2      |
| qat-configuration     | 1      |
| environment-profiles  | 1      |
| output-permissions    | 2      |

Each has at least one check, and the set is closed: a category with no check is a heading a reader expects and does not
find.

## 3. Severity, status and blocking are three separate facts

| Fact         | Where it comes from           | Changes between runs?                                                                    |
| ------------ | ----------------------------- | ---------------------------------------------------------------------------------------- |
| **Severity** | The catalogue entry           | No. It says what an unfavourable answer _means_, decided once by whoever wrote the entry |
| **Status**   | The verdict this run produced | Yes. It says what actually happened                                                      |
| **Blocking** | `status === failed`           | Derived. Nothing else decides it                                                         |

| Check returned | Entry severity | Reported status |
| -------------- | -------------- | --------------- |
| pass           | any            | `passed`        |
| warn           | any            | `warned`        |
| fail           | error          | `failed`        |
| fail           | warning        | `warned`        |

The last row is unreachable by design, and the report takes the conservative reading rather than trusting the
invariant at every call site: a report that under-claims a failure is recoverable, and one that refuses a run it should
have allowed is not. A test holds every advisory check to never returning `fail`, driven from the same fixtures the
scenario inventory uses.

`warn` also carries a condition that is neither a pass nor a failure: **the check could not establish the answer**. An
unreadable runtime version, a declared range the parser cannot interpret, or a package-manager version that was expected
and never obtained are all reported as warnings rather than as failures — and never as passes. An unanswered question
must not block work we can still perform, and it must not read as consent either.

There is one further outcome worth naming here because the package-manager check makes it visible: **nobody asked**. A
manager whose version was never declared is not compared, and a platform whose shims cannot be spawned without a shell is
not probed. That produces no finding at all — reporting "unverified" for a question we chose not to ask would teach
readers to ignore the code that means something.

**A skipped check never blocks.** That is not an oversight. A check is skipped _because_ another check did not pass, and
that failure is already in the list — counting the consequence as well would report one condition as several, which is
the collapse the whole diagnostics chain exists to prevent.

## 4. Preconditions, and the two ways to skip

A check declares at most one precondition, and a failed or skipped precondition makes the dependant `skipped` rather
than failed.

```
runtime.node-version ──────────────────────────────── mandatory
cypress.runtime-supported ─────────────────────────── mandatory
environment.package-manager ───────────────────────── mandatory
project.recognised ────────────────────────────────── mandatory
├── project.package-metadata
└── cypress.configuration-located
    ├── cypress.layout-driveable
    └── cypress.installed
        └── cypress.version-supported
qat.configuration-loadable ────────────────────────── mandatory
├── qat.environment-resolvable
├── output.reports-writable
└── output.evidence-writable
```

A directory with no Cypress configuration produces **one failure and three silences**: `cypress.configuration-located`
fails with `QAT-D002`, and the three checks below it are skipped with a sentence naming the check that stopped them.
Reporting all four would give a reader a list of four problems to fix where there is one.

Neither runtime check carries a precondition, and that is deliberate rather than an omission. A precondition exists so a
_consequence_ is not reported as a second, separate problem; a framework bound is not a consequence of QAT's own range.
The two can be violated independently — a framework bound is violable on a runtime QAT supports perfectly well — and
suppressing the advisory whenever the blocking check fails would hide the only finding that explains why the project's
tests will still fail on a runtime QAT is happy with. Declaration order puts the blocking question first, which is the
part a reader needs.

`environment.package-manager` has no precondition either, for a narrower reason: nothing above it can make its question
unanswerable. A project can be un-runnable on this interpreter and still have a perfectly reportable package-manager
problem, and the reader may be able to fix the second on a machine that has no supported runtime at all.

Two skip reasons, and the difference is the difference between a user's problem and ours:

| Reason                | Means                                                                                | Who acts                  |
| --------------------- | ------------------------------------------------------------------------------------ | ------------------------- |
| `precondition-failed` | A fact about the project. The question is unanswerable until something else is fixed | The user                  |
| `input-unavailable`   | A fact about the caller. Nobody gathered the evidence                                | Whoever assembled the run |

Both produce a sentence naming the subject, because _skipped_ alone is the least useful word in a report — and it says
"not run" rather than "could not be verified", which read as two different levels of doubt.

## 5. Four code vocabularies, one finding shape

| Prefix  | Answers                                     | Declared in                         |
| ------- | ------------------------------------------- | ----------------------------------- |
| `QAT-D` | What detection found wrong with a project   | `core/application/diagnostics.ts`   |
| `QAT-V` | Whether that stops an operation             | `core/application/validation.ts`    |
| `QAT-C` | What is wrong with a configuration document | `core/application/configuration.ts` |
| `QAT-H` | What is wrong with this machine or this run | `core/application/checks.ts`        |

A reader can tell which layer raised a finding from the code alone. `DiagnosticFinding<Code>` is generic over the set,
so a check that forwards a narrower vocabulary is assignable to the report's wider one with no cast.

**The forwarding checks invent no codes.** `cypress.installed` carries `QAT-D005` rather than a `QAT-H` code of its own,
and `cypress.version-supported` carries whichever of `QAT-D006`, `QAT-V005` and `QAT-V006` the policy produced. One
condition, one code, one sentence — and the doctor is the worst possible home for a support decision, because the moment
a comparison lives in a report the report becomes the definition.

`runtime.node-version` compares a version, and it is not an exception to that rule. It compares by delegating to the one
compatibility engine, using the range the manifest declares, both supplied as evidence. The distinction is between
_using_ an authority and _being_ one: the check contributes no floor, no operator and no tolerance of its own. Delete it
and the policy is unchanged; delete the engine and nothing compiles.

The seventeen `QAT-H` codes are the conditions nothing else owns:

| Code       | Severity | Condition                                                                   |
| ---------- | -------- | --------------------------------------------------------------------------- |
| `QAT-H001` | error    | The running Node version was read and is outside the range QAT declares     |
| `QAT-H002` | warning  | Neither a manifest declaration nor a lockfile names a package manager       |
| `QAT-H003` | error    | An output directory cannot be written; the finding's `path` says which      |
| `QAT-H004` | error    | The configuration file is empty                                             |
| `QAT-H005` | error    | The configuration file is not valid JSON                                    |
| `QAT-H006` | error    | The configuration file is larger than QAT will read                         |
| `QAT-H007` | error    | The environment a command selected is not declared                          |
| `QAT-H008` | warning  | The running Node version could not be compared with the declared range      |
| `QAT-H009` | warning  | The project's framework declares a runtime range the running version misses |
| `QAT-H010` | warning  | The `packageManager` field is present and cannot be used as written         |
| `QAT-H011` | warning  | The project installs with a manager outside the supported policy            |
| `QAT-H012` | warning  | Two lockfiles, or a declaration and a lockfile, name different managers     |
| `QAT-H013` | warning  | The manager is supported and its executable is not on `PATH`                |
| `QAT-H014` | warning  | The executable's version is outside what the project declared               |
| `QAT-H015` | warning  | A package-manager version was expected and none could be read               |
| `QAT-H016` | warning  | The manager and its tooling are fine; dependencies are not installed        |
| `QAT-H017` | warning  | `node_modules` exists and a different manager created it                    |

`QAT-H001` and `QAT-H008` are two codes and not one, because they are two different reader actions: a mismatch that was
_measured_ blocks and is fixed by moving the runtime, while an answer that could not be _obtained_ warns and is fixed by
getting a readable interpreter — or by reinstalling QAT, if the declared range itself is what cannot be read.
`QAT-H009` is separate again because its owner is the project, not the tool.

The package-manager family multiplied for the same reason, one code per _fix_: "nothing identifies your tool", "your
field cannot be used", "the tool is not supported", "two lockfiles disagree", "the tool is not installed", "the version
disagrees", "the version could not be read", "the dependencies are not installed" and "someone else installed them" send
a reader to nine different places. A shared code could describe one of them and would be wrong for the other eight. All
nine are advisory, so the severity column is uniform — which is exactly why the distinction has to be carried by the code
rather than by the weight.

## 6. The evidence a check may read

| Group             | Holds                                                                                                                                                                                    | Read by                       |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `runtime`         | The running Node version, the range this build declares, and any range the project's framework declares                                                                                  | The two runtime checks        |
| `package-manager` | How identity was established, the lockfiles seen, the executable evidence, the manager version the project expects, how far an install got, and who created the tree if not this manager | `environment.package-manager` |
| `assessment`      | The structured detection result and its per-operation gates                                                                                                                              | Five checks                   |
| `configuration`   | The load outcome                                                                                                                                                                         | `qat.configuration-loadable`  |
| `environment`     | The selected profile and the declared ones                                                                                                                                               | `qat.environment-resolvable`  |
| `output`          | Both resolved output paths, and whether each accepts a write                                                                                                                             | The two output checks         |

**A group being absent means nobody gathered it**, which is `input-unavailable` — not the same as gathering it and
finding nothing. That distinction is why the package-manager group's identity member is a discriminated union with an
`undeclared` variant rather than an optional field: "no manager could be identified" is a finding, and a check that
skipped on it would have nothing to say about exactly the case it exists for.

The same reasoning explains why `runtime.nodeVersion` is optional and `runtime.frameworkRequired` is optional, while
`runtime.required` is not. A host that reports no version is an answer worth reporting; a project that declares no
framework bound offers nothing to violate; but QAT always has an authority, even when that authority declared nothing —
which arrives as an empty range and is reported as unreadable policy rather than skipped.

The package-manager group follows the same rule at a finer grain. `selection` is required and always says one of four
things; `executable` becomes required once a manager is identified, because a gatherer that named a manager and never
looked for its binary has left a hole; `required` is absent when the project declared no version, which is different from
a declaration that could not be read; and `installState` distinguishes "installed", "absent", "someone else's tree" and
"we could not attribute it" — the last of which produces no finding, because a gap in the evidence must not be rendered
as a fault.

A check declares the groups it reads, and the runner skips it when one is missing. A check that reads a group it did not
declare is a defect in this layer, and the loud failure is deliberate in both directions: reporting it as a finding
would put a programmer's mistake into a user's terminal, and passing would let a check claim something it never
examined. A required field _inside_ a group is guarded the same way — `present` for the group, `requireFact` for the
field — because a hand-built facts object can satisfy a type without ever having gone through it.

## 7. Traceability

Every check's identifier is its requirement identifier, and every scenario is `<check-id>.<case>`. The separator is a
dot, and that is a contract rather than a style: the behaviour suite keys its fixtures by these exact strings, so a
different separator makes a rule and its verification disagree while both read correctly in isolation.

| Check                           | Scenarios                                                                                                                                                                               |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runtime.node-version`          | `supported`, `below-floor`, `above-ceiling`, `between-lines`, `pre-release`, `version-unreadable`, `policy-unreadable`                                                                  |
| `cypress.runtime-supported`     | `satisfied`, `unsatisfied`, `not-declared`, `version-unreadable`                                                                                                                        |
| `environment.package-manager`   | `declared`, `inferred`, `none`, `declaration-invalid`, `unsupported`, `conflicting`, `executable-missing`, `version-mismatch`, `version-unverified`, `not-installed`, `foreign-install` |
| `project.recognised`            | `detected`, `nothing-identifying-cypress`, `manifest-unreadable`                                                                                                                        |
| `project.package-metadata`      | `present`, `missing`, `incomplete`                                                                                                                                                      |
| `cypress.configuration-located` | `located`, `missing`, `ambiguous`, `unusable-format`                                                                                                                                    |
| `cypress.layout-driveable`      | `supported`, `no-recognisable-location`, `component-only`                                                                                                                               |
| `cypress.installed`             | `installed`, `declared-not-installed`, `not-declared-not-installed`                                                                                                                     |
| `cypress.version-supported`     | `in-range`, `below-floor`, `above-known-good`                                                                                                                                           |
| `qat.configuration-loadable`    | `absent`, `loaded`, `empty`, `not-json`, `too-large`, `schema-invalid`                                                                                                                  |
| `qat.environment-resolvable`    | `none-selected`, `declared`, `undeclared`                                                                                                                                               |
| `output.reports-writable`       | `writable`, `unwritable`                                                                                                                                                                |
| `output.evidence-writable`      | `writable`, `unwritable`, `reports-usable-evidence-not`                                                                                                                                 |

Fifty-five scenarios across thirteen checks.

The inventory is enforced rather than described: the behaviour suite's fixtures are keyed by these identifiers, and its
first case asserts the two sets are equal in both directions. A scenario declared without a fixture fails, and a fixture
for a scenario nobody declared fails too. That is the traceability claim made mechanical — the register cannot list a
case that does not exist.

The runtime floor and ceiling are the reason the list is longer than it looks. `supported`, `below-floor`, `above-ceiling`
and `between-lines` are four cells of one table — 20.10.9, 20.11.0, 20.999.999 and 21.0.0 against `>=20.11.0 <21` — and
testing only `supported` and `below-floor` would leave an inclusive floor indistinguishable from an exclusive one, and a
gapped policy indistinguishable from a contiguous one.

The package-manager list reads as its ladder does: two ways to pass, then the conditions in the order a reader fixes
them. That order is not cosmetic. Each rung is only reachable when the ones above it passed — nothing identifies the
tool, so there is no version to compare; the binary is absent, so no version could be read — and a scenario numbered out
of order would make the fixture list describe a search path the check does not follow.

**Reachability is the gap the design cannot close.** A code could be a member of the union and be emitted by nothing. The
pair of guarantees closest to reachability is that a scenario is declared per outcome a check distinguishes _and_ that
each scenario is driven — which is why the register withholds a diagnostic code for any condition it cannot name, and why
the package-manager check's code-to-scenario map is itself asserted: every code it can emit names a scenario the
catalogue declares, and no declared scenario is without one.

## 8. What the catalogue does not do

- **It does not read anything.** Every fact is supplied. Gathering is a separate module, and its probes are the only
  code in this chain that touches a disk.
- **It does not decide the exit status.** `isBlocked(report)` answers whether anything failed. What a command does with
  that — which status, which stream — is the command's decision, and mapping it here would put a second exit-code table
  beside the one in `core/errors`.
- **It does not render.** Findings carry prose; where it is printed, in what order, in what colour, is the output
  layer's business.
- **It does not repair.** Every remedy is a sentence. Nothing here writes, installs, creates a directory or rewrites a
  lockfile.
- **It does not run the framework.** `cypress.installed` reads a finding; nothing invokes Cypress to find out whether it
  works.
- **It does not detect the runtime.** `process.versions.node` is read behind a port; the catalogue receives the string
  and never reaches for it.
- **It does not execute a package manager to identify it.** Identity comes from declared metadata and root lockfiles. A
  binary is located and asked for its version only once a manager has been named by evidence, and never from a
  project-local binary directory.

## 9. Known limits

| Limit                                                                                               | Why it stands                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An output directory is probed for writability, which is a side effect that leaves nothing behind    | The alternative — inferring from a mode bit — reports a directory as writable when it is owned by someone else. A probe that creates and removes a temporary file is the honest test, and it belongs to the gatherer rather than to this table                                    |
| `QAT-H003` covers both directories                                                                  | One condition, one code. Two codes for "the same thing happened at a different path" is two permanent identifiers that eventually disagree                                                                                                                                        |
| The supported Node range is read from `engines.node`, not held as a constant                        | Pure functions cannot open a manifest, so the range arrives as evidence from composition. A constant here would have been a second copy of a policy, and the two would diverge on the first release that changed one of them                                                      |
| A version that cannot be parsed warns rather than failing                                           | "I cannot tell" is neither "supported" nor "unsupported". It is reported, it does not block, and it never counts as clean — the alternative, treating an unmeasured runtime as a pass, is how a report blesses what it never checked                                              |
| Only a subset of range syntax is accepted                                                           | Floors, ceilings, `^`, `~` and `\|\|` alternatives. Wildcards, hyphen ranges and partial versions are refused rather than guessed at, because each would require inventing a component. A refused range is reported, never assumed                                                |
| Nothing gathers the project's framework runtime bound yet                                           | `cypress.runtime-supported` is implemented and covered, and its fact is optional, so it passes by absence on every project today. The advisory appears when a gatherer reads a declaration; until then the report is silent rather than wrong                                     |
| Installation state is `unknown` whenever `node_modules` exists and no marker was inspected          | Attributing a tree means reading inside `node_modules`, which the root snapshot deliberately does not do. The check therefore reports nothing rather than guessing, and `QAT-H016` / `QAT-H017` are reachable but not observed in the doctor until a gatherer attributes the tree |
| A package-manager version is compared only when the project declares one                            | Comparing against a bound QAT invented would be a support policy this tool does not have. No declaration means no comparison, and `QAT-H015` reports the case where one was declared and could not be read                                                                        |
| `environment.package-manager` is the one identifier whose first segment does not match its category | Its subject segment says `environment` and it is grouped under package-manager availability. Renaming it is a one-line change while no support document quotes it                                                                                                                 |
| Nothing verifies the framework executable                                                           | The check exists in the contract — a verification operation would set `binaryAvailable` — and no producer exists. The catalogue does not pretend otherwise                                                                                                                        |

## 10. Extending the catalogue

**Adding a check** is six edits, and the compiler and the tests catch five of them:

1. An identifier in `CheckId`. The register test fails until the table has an entry.
2. An entry in `rules.ts`, with a title, a purpose, a procedure, the fact groups it reads, its severity and at least one
   scenario id.
3. An assertion that the entry's `requires` matches what its body reads. Nothing checks this — `present` and
   `requireFact` take a value, not a label — so it is the one step that depends on review.
4. Scenarios in the entry, and one fixture per scenario in the behaviour suite. The inventory case compares the two
   sets, in both directions.
5. A row in §2 and a row in §7 of this document. A test asserts every identifier appears here.
6. A `QAT-H` code and its guidance entry, if the check notices a condition no other layer owns. If it restates one, it
   carries that code and authors nothing.

**Adding a category** is a decision about how the report groups, not a label a check may choose. `CheckCategory` is
closed and the register asserts all eight are covered.

**Adding a fact group** means a new property on `CheckFacts`, a row in `FACT_KEYS`, and a row in §6. The map is what
lets the label a report prints differ from the property a type declares, and it is the reason a group can be added
without renaming anything a message quotes.

**Adding a code to an existing check's list** is a change to what that check answers. Before doing it, ask whether the
condition deserves its own check: a check is a question, and two conditions a reader fixes differently are two
questions. The package-manager family is the worked example of the opposite decision — one question, nine codes — which
was right there because the conditions are mutually exclusive rungs of one ladder rather than nine independent
questions.

**Adding a supported version** is not an edit to this document at all. It is an edit to `package.json#engines.node`, the
CI matrix that must cover it, and the release notes — see
[runtime-compatibility.md](runtime-compatibility.md#7-changing-the-supported-range). A check that needed a code change
to gain a supported version would be a check that had restated the policy.

**Adding a package manager** is not an edit here either: it is a row in the policy table, a fixture proving detection,
and the matching row in [package-managers.md](package-managers.md) that a contract test compares against the code.
