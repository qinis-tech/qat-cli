# Doctor checks

|               |                                                                                                                                                                                                                      |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**    | Normative                                                                                                                                                                                                            |
| **Contract**  | `src/core/application/checks.ts`                                                                                                                                                                                     |
| **Catalogue** | `src/diagnostics/checks/rules.ts`                                                                                                                                                                                    |
| **Guidance**  | `src/diagnostics/checks/guidance.ts`                                                                                                                                                                                 |
| **Runner**    | `src/diagnostics/checks/run.ts`                                                                                                                                                                                      |
| **Companion** | [diagnostics.md](diagnostics.md), [validation.md](validation.md), [configuration-validation.md](configuration-validation.md), [ADR-0032](./adr/0032-skip-a-check-whose-precondition-failed-rather-than-reporting.md) |

The questions `qat doctor` answers about a project, and the rules its report obeys.

## 1. A check is a question

Every check in this catalogue is a pure function of evidence somebody else gathered — a runtime version, an assessment,
a configuration load result, a writability fact. Nothing in the catalogue reads a file, spawns a process or writes to a
stream.

That constraint is not tidiness. A documented _purpose_ and four documented _outcome conditions_ per check are only
verifiable if the check can be run from a value; a rule that touches a disk can only be checked by building a disk, and
the branches nobody bothers to build a directory for are exactly the ones that go wrong. So the catalogue is a table of
values, and the twenty-odd probes it depends on belong to whoever gathers the facts.

**Six checks judge** something no other layer looks at: the runtime, the package manager, the QAT configuration file,
the selected environment, and the two output directories.

**Six checks forward** a conclusion a lower layer already drew. They find the finding the assessment carries and carry
it onward unchanged — same code, same severity, same remedy. Their value is not the logic; it is that the question a
user asks is answered where the user looks for it, with the words the layer that noticed the condition chose.

## 2. The register

Twelve checks, in the order a report presents them, which is the order a reader fixes things in: causes before
consequences.

| Check                           | Category              | Severity | Mandatory | Precondition                    | Codes it may report                          | Purpose                                                         |
| ------------------------------- | --------------------- | -------- | --------- | ------------------------------- | -------------------------------------------- | --------------------------------------------------------------- |
| `runtime.node-version`          | runtime               | error    | yes       | —                               | `QAT-H001`                                   | The running Node major is one QAT can rely on                   |
| `environment.package-manager`   | package-manager       | warning  | yes       | —                               | `QAT-H002`                                   | A package manager can be named, so a remedy can name one        |
| `project.recognised`            | project-structure     | error    | yes       | —                               | `QAT-D001`, `QAT-D007`                       | The directory is a test project at all                          |
| `project.package-metadata`      | project-structure     | warning  | no        | `project.recognised`            | `QAT-D010`, `QAT-D011`                       | The project name is declared rather than assumed                |
| `cypress.configuration-located` | cypress-configuration | error    | no        | `project.recognised`            | `QAT-D002`–`QAT-D004`                        | There is exactly one configuration, in a format this tool reads |
| `cypress.layout-driveable`      | cypress-configuration | error    | no        | `cypress.configuration-located` | `QAT-V002`                                   | There is a spec location QAT can drive                          |
| `cypress.installed`             | cypress-installation  | error    | no        | `cypress.configuration-located` | `QAT-D005`                                   | The framework is on disk                                        |
| `cypress.version-supported`     | cypress-installation  | error    | no        | `cypress.installed`             | `QAT-D006`, `QAT-V005`, `QAT-V006`           | The installed major is inside the range this tool drives        |
| `qat.configuration-loadable`    | qat-configuration     | error    | yes       | —                               | `QAT-H004`–`QAT-H006`, `QAT-C001`–`QAT-C007` | The configuration file is a document, and a configuration       |
| `qat.environment-resolvable`    | environment-profiles  | error    | no        | `qat.configuration-loadable`    | `QAT-H007`                                   | The environment a command selected exists                       |
| `output.reports-writable`       | output-permissions    | error    | no        | `qat.configuration-loadable`    | `QAT-H003`                                   | A report can be written where the configuration says            |
| `output.evidence-writable`      | output-permissions    | error    | no        | `qat.configuration-loadable`    | `QAT-H003`                                   | Evidence can be written where the configuration says            |

**Mandatory** is derived, not stored: a check with no precondition is always asked. That is four of the twelve, and the
derivation is asserted rather than trusted, so the word cannot drift from the table.

**Ten checks are fatal and two are advisory.** The two advisory ones — the package manager, and the project's own
metadata — share the property that their worst answer is _advice_: a project that names no manager is still runnable,
and a project with no manifest is legal.

### The eight categories

| Category              | Checks |
| --------------------- | ------ |
| runtime               | 1      |
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

**A skipped check never blocks.** That is not an oversight. A check is skipped _because_ another check did not pass, and
that failure is already in the list — counting the consequence as well would report one condition as several, which is
the collapse the whole diagnostics chain exists to prevent.

## 4. Preconditions, and the two ways to skip

A check declares at most one precondition, and a failed or skipped precondition makes the dependant `skipped` rather
than failed.

```
runtime.node-version ──────────────────────────────── mandatory
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

The seven `QAT-H` codes are the conditions nothing else owns:

| Code       | Severity | Condition                                                               |
| ---------- | -------- | ----------------------------------------------------------------------- |
| `QAT-H001` | error    | The runtime major is below the floor, or could not be read as a version |
| `QAT-H002` | warning  | Neither a manifest declaration nor a lockfile names a package manager   |
| `QAT-H003` | error    | An output directory cannot be written; the finding's `path` says which  |
| `QAT-H004` | error    | The configuration file is empty                                         |
| `QAT-H005` | error    | The configuration file is not valid JSON                                |
| `QAT-H006` | error    | The configuration file is larger than QAT will read                     |
| `QAT-H007` | error    | The environment a command selected is not declared                      |

## 6. The evidence a check may read

| Group             | Holds                                                        | Read by                       |
| ----------------- | ------------------------------------------------------------ | ----------------------------- |
| `runtime`         | The running Node version, as the process reports it          | `runtime.node-version`        |
| `package-manager` | The manager that was declared or inferred, if any            | `environment.package-manager` |
| `assessment`      | The structured detection result and its per-operation gates  | Five checks                   |
| `configuration`   | The load outcome                                             | `qat.configuration-loadable`  |
| `environment`     | The selected profile and the declared ones                   | `qat.environment-resolvable`  |
| `output`          | Both resolved output paths, and whether each accepts a write | The two output checks         |

**A group being absent means nobody gathered it**, which is `input-unavailable` — not the same as gathering it and
finding nothing. That distinction is why the package-manager group holds an optional `selected` rather than the group
itself being optional: "no manager could be identified" is a finding, and a check that skipped on it would have nothing
to say about exactly the case it exists for.

A check declares the groups it reads, and the runner skips it when one is missing. A check that reads a group it did not
declare is a defect in this layer, and the loud failure is deliberate in both directions: reporting it as a finding
would put a programmer's mistake into a user's terminal, and passing would let a check claim something it never
examined.

## 7. Traceability

Every check's identifier is its requirement identifier, and every scenario is `<check-id>.<case>`.

| Check                           | Scenarios                                                              |
| ------------------------------- | ---------------------------------------------------------------------- |
| `runtime.node-version`          | `supported`, `below-floor`, `unreadable`                               |
| `environment.package-manager`   | `declared`, `inferred`, `none`                                         |
| `project.recognised`            | `detected`, `nothing-identifying-cypress`, `manifest-unreadable`       |
| `project.package-metadata`      | `present`, `missing`, `incomplete`                                     |
| `cypress.configuration-located` | `located`, `missing`, `ambiguous`, `unusable-format`                   |
| `cypress.layout-driveable`      | `supported`, `no-recognisable-location`, `component-only`              |
| `cypress.installed`             | `installed`, `declared-not-installed`, `not-declared-not-installed`    |
| `cypress.version-supported`     | `in-range`, `below-floor`, `above-known-good`                          |
| `qat.configuration-loadable`    | `absent`, `loaded`, `empty`, `not-json`, `too-large`, `schema-invalid` |
| `qat.environment-resolvable`    | `none-selected`, `declared`, `undeclared`                              |
| `output.reports-writable`       | `writable`, `unwritable`                                               |
| `output.evidence-writable`      | `writable`, `unwritable`, `reports-usable-evidence-not`                |

Thirty-nine scenarios across twelve checks.

The inventory is enforced rather than described: the behaviour suite's fixtures are keyed by these identifiers, and its
first case asserts the two sets are equal in both directions. A scenario declared without a fixture fails, and a fixture
for a scenario nobody declared fails too. That is the traceability claim made mechanical — the register cannot list a
case that does not exist.

**Reachability is the gap the design cannot close.** A code could be a member of the union and be emitted by nothing;
`QAT-H006` would pass every assertion above if the catalogue stopped producing it. The pair of guarantees closest to
reachability is that a scenario is declared per outcome a check distinguishes _and_ that each scenario is driven — which
is why the register withholds a diagnostic code for any condition it cannot name.

## 8. What the catalogue does not do

- **It does not read anything.** Every fact is supplied. Gathering is a separate module, and its probes are the only
  code in this chain that touches a disk.
- **It does not decide the exit status.** `isBlocked(report)` answers whether anything failed. What a command does with
  that — which status, which stream — is the command's decision, and mapping it here would put a second exit-code table
  beside the one in `core/errors`.
- **It does not render.** Findings carry prose; where it is printed, in what order, in what colour, is the output
  layer's business.
- **It does not repair.** Every remedy is a sentence. Nothing here writes, installs or creates a directory.
- **It does not run the framework.** `cypress.installed` reads a finding; nothing invokes Cypress to find out whether it
  works.

## 9. Known limits

| Limit                                                                                               | Why it stands                                                                                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An output directory is probed for writability, which is a side effect that leaves nothing behind    | The alternative — inferring from a mode bit — reports a directory as writable when it is owned by someone else. A probe that creates and removes a temporary file is the honest test, and it belongs to the gatherer rather than to this table |
| `QAT-H003` covers both directories                                                                  | One condition, one code. Two codes for "the same thing happened at a different path" is two permanent identifiers that eventually disagree                                                                                                     |
| The Node floor is restated from `engines.node`                                                      | A module of pure functions cannot open a manifest. A test asserts the two are equal, which is the strongest guard available without I/O                                                                                                        |
| A version that cannot be parsed fails the runtime check                                             | "I cannot tell" is not "supported". Zero is below every floor this tool will set, and treating the absence of a measurement as a pass is how a report blesses what it never measured                                                           |
| `environment.package-manager` is the one identifier whose first segment does not match its category | Its subject segment says `environment` and it is grouped under package-manager availability. Renaming it is a one-line change while no support document quotes it                                                                              |
| Nothing verifies the framework executable                                                           | The check exists in the contract — a verification operation would set `binaryAvailable` — and no producer exists. The catalogue does not pretend otherwise                                                                                     |

## 10. Extending the catalogue

**Adding a check** is six edits, and the compiler and the tests catch five of them:

1. An identifier in `CheckId`. The register test fails until the table has an entry.
2. An entry in `rules.ts`, with a title, a purpose, a procedure, the fact groups it reads, its severity and at least one
   scenario id.
3. An assertion that the entry's `requires` matches what its body reads. Nothing checks this — `present` takes a value,
   not a label — so it is the one step that depends on review.
4. Scenarios in the entry, and one fixture per scenario in the behaviour suite. The inventory case compares the two
   sets.
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
questions.
