# Doctor checks

|               |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**    | Normative                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Contract**  | `src/core/application/checks.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Catalogue** | `src/diagnostics/checks/rules.ts`, with the branch-heavy checks in `rules/node-runtime.ts`, `rules/package-manager.ts`, `rules/cypress-config-discovery.ts`, `rules/cypress-config-validity.ts`, `rules/qat-config-discovery.ts`, `rules/qat-config-schema.ts`, `rules/environment-profile.ts` and `rules/environment-variables.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Guidance**  | `src/diagnostics/checks/guidance.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Runner**    | `src/diagnostics/checks/run.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Companion** | [diagnostics.md](diagnostics.md), [validation.md](validation.md), [configuration-validation.md](configuration-validation.md), [configuration-diagnostics.md](configuration-diagnostics.md), [environment-diagnostics.md](environment-diagnostics.md), [runtime-compatibility.md](runtime-compatibility.md), [package-managers.md](package-managers.md), [cypress-configuration-checks.md](cypress-configuration-checks.md), [ADR-0032](./adr/0032-skip-a-check-whose-precondition-failed-rather-than-reporting.md), [ADR-0034](./adr/0034-detect-the-package-manager-from-declared-metadata-and-lockfi.md), [ADR-0036](./adr/0036-inspect-the-cypress-configuration-as-data-and-never-import-i.md), [ADR-0037](./adr/0037-project-the-configuration-pipeline-into-a-non-throwing-inspe.md), [ADR-0038](./adr/0038-select-one-environment-by-declared-precedence-and-report-why.md) |

The questions `qat doctor` answers about a project, and the rules its report obeys.

## 1. A check is a question

Every check in this catalogue is a pure function of evidence somebody else gathered — a runtime version, an assessment, a
composed configuration verdict, an environment inspection, a writability fact. Nothing in the catalogue reads a file, spawns
a process or writes to a stream.

That constraint is not tidiness. A documented _purpose_ and four documented _outcome conditions_ per check are only
verifiable if the check can be run from a value; a rule that touches a disk can only be checked by building a disk, and the
branches nobody bothers to build a directory for are exactly the ones that go wrong. So the catalogue is a table of values,
and the twenty-odd probes it depends on belong to whoever gathers the facts.

**Eleven checks judge** something no other layer looks at: the runtime QAT itself requires, the runtime a project's framework
requires, the project's package-manager environment, where the Cypress configuration is and whether anything can establish
that it is valid, whether QAT's own configuration document can be obtained and whether it is one this release can interpret,
the selected environment profile and the variables it references, and the two output directories.

**Five checks forward** a conclusion a lower layer already drew. They find the finding the assessment carries and carry it
onward unchanged — same code, same severity, same remedy. Their value is not the logic; it is that the question a user asks
is answered where the user looks for it, with the words the layer that noticed the condition chose.

Nine judging checks have real branches — a floor, a ceiling, gap alternatives, pre-release admission, seven package-manager
conditions, thirteen Cypress configuration-location reasons, six validation gaps, the six configuration states behind two
more, and an environment selection with three possible origins plus a profile that can fail in five ways and references that
can fail in four more — and those live in `rules/*.ts` rather than inside the map literal, so each branch can be tested on
its own. The catalogue's job is to say which questions exist, in what order, under which identifier.

The runtime pair is the one place where "judging" needed an authority it does not own. Neither question can be answered by
restating a conclusion — QAT's own range and a project's framework range are separate declarations — and both delegate to
the single compatibility engine in `core/compatibility`. The detail is in
[runtime-compatibility.md](runtime-compatibility.md); the catalogue's part is only to say which question comes first. The
package-manager check delegates in the same way: the version the project expects arrives as evidence and is compared by that
same engine, so there is one notion of "satisfies" in the product.

## 2. The register

Sixteen checks, in the order a report presents them, which is the order a reader fixes things in: causes before
consequences.

| Check                               | Category              | Severity | Mandatory | Precondition                    | Codes it may report                | Purpose                                                                       |
| ----------------------------------- | --------------------- | -------- | --------- | ------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------- |
| `runtime.node-version`              | runtime               | error    | yes       | —                               | `QAT-H001`, `QAT-H008`             | The running Node version is inside the range QAT declares                     |
| `cypress.runtime-supported`         | runtime               | warning  | yes       | —                               | `QAT-H009`                         | The running Node version is inside the range the project's framework needs    |
| `environment.package-manager`       | package-manager       | warning  | yes       | —                               | `QAT-H002`, `QAT-H010`–`QAT-H017`  | The package-manager environment is consistent with the project and the policy |
| `project.recognised`                | project-structure     | error    | yes       | —                               | `QAT-D001`, `QAT-D007`             | The directory is a test project at all                                        |
| `project.package-metadata`          | project-structure     | warning  | no        | `project.recognised`            | `QAT-D010`, `QAT-D011`             | The project name is declared rather than assumed                              |
| `cypress.configuration-located`     | cypress-configuration | error    | no        | `project.recognised`            | `QAT-H018`–`QAT-H027`              | There is exactly one configuration, and it is usable as a file                |
| `cypress.configuration-validatable` | cypress-configuration | error    | no        | `cypress.configuration-located` | `QAT-H028`, `QAT-H029`             | Something was entitled to establish that it is valid, and did                 |
| `cypress.layout-driveable`          | cypress-configuration | error    | no        | `cypress.configuration-located` | `QAT-V002`                         | There is a spec location QAT can drive                                        |
| `cypress.installed`                 | cypress-installation  | error    | no        | `cypress.configuration-located` | `QAT-D005`                         | The framework is on disk                                                      |
| `cypress.version-supported`         | cypress-installation  | error    | no        | `cypress.installed`             | `QAT-D006`, `QAT-V005`, `QAT-V006` | The installed major is inside the range this tool drives                      |
| `qat.configuration-loadable`        | qat-configuration     | error    | yes       | —                               | `QAT-H004`–`QAT-H006`, `QAT-H032`  | QAT's configuration file is a document that can be obtained                   |
| `qat.configuration-valid`           | qat-configuration     | error    | no        | `qat.configuration-loadable`    | `QAT-H033`–`QAT-H037`              | That document conforms to a schema this release supports                      |
| `qat.environment-resolvable`        | environment-profiles  | error    | no        | `qat.configuration-loadable`    | `QAT-H007`, `QAT-H039`–`QAT-H043`  | The selected environment is a profile this configuration declares             |
| `qat.environment-variables-present` | environment-profiles  | error    | no        | `qat.environment-resolvable`    | `QAT-H044`–`QAT-H050`              | The variables that profile references are usable                              |
| `output.reports-writable`           | output-permissions    | error    | no        | `qat.configuration-loadable`    | `QAT-H003`                         | A report can be written where the configuration says                          |
| `output.evidence-writable`          | output-permissions    | error    | no        | `qat.configuration-loadable`    | `QAT-H003`                         | Evidence can be written where the configuration says                          |

**Mandatory** is derived, not stored: a check with no precondition is always asked. That is five of the sixteen, and the
derivation is asserted rather than trusted, so the word cannot drift from the table.

**Thirteen checks are fatal and three are advisory.** The advisory ones — the package manager, the project's own metadata,
and the project's framework runtime bound — share the property that their worst answer is _advice_: a project that names no
manager is still runnable, a project with no manifest is legal, and a framework's declared bound is metadata QAT neither
controls nor verifies. Both Cypress configuration checks declare `error`, and three of the conditions they report still
conclude as warnings — a legacy format, a stale copy in the wrong place, a file nothing inspected — because one declared
severity and a status decided by the condition is what §3 is for. QAT's configuration pair declares `error` throughout and
never warns: every condition it reports is either a document nobody can obtain or a field the schema refused, and there is
no middle case worth softening. The environment pair joins the Cypress configuration checks in that arrangement: both
declare `error`, and three of the conditions they report — a variable whose requirement the profile never stated, and a
presence question nothing could answer — conclude as warnings.

The two runtime checks are the clearest illustration of why mandatory-ness and blocking are different questions. Both are
always asked, because a runtime question has an answer on every machine; only one can refuse a run, because only one of the
two requirements is QAT's to enforce. Making the advisory blocking would let a dependency's `engines` field veto work over a
bound nobody checked. The package-manager check sits in the same position: always asked, never blocking, because a mismatched
installer predicts a confusing `install` later rather than preventing a run now.

### The eight categories

| Category              | Checks |
| --------------------- | ------ |
| runtime               | 2      |
| package-manager       | 1      |
| project-structure     | 2      |
| cypress-configuration | 3      |
| cypress-installation  | 2      |
| qat-configuration     | 2      |
| environment-profiles  | 2      |
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

The last row is unreachable by design, and the report takes the conservative reading rather than trusting the invariant at
every call site: a report that under-claims a failure is recoverable, and one that refuses a run it should have allowed is
not. A test holds every advisory check to never returning `fail`, driven from the same fixtures the scenario inventory uses.

`warn` also carries a condition that is neither a pass nor a failure: **the check could not establish the answer**. An
unreadable runtime version, a declared range the parser cannot interpret, a package-manager version that was expected and
never obtained, a configuration no mechanism was entitled to validate, or a presence question the host would not answer are
all reported as warnings rather than as failures — and never as passes. An unanswered question must not block work we can
still perform, and it must not read as consent either.

There is one further outcome worth naming here because the package-manager check makes it visible: **nobody asked**. A
manager whose version was never declared is not compared, and a platform whose shims cannot be spawned without a shell is not
probed. That produces no finding at all — reporting "unverified" for a question we chose not to ask would teach readers to
ignore the code that means something. The environment check applies the same rule to a variable the profile marks
_optional_: absent is the documented default, so it is a pass with no finding rather than advice nobody can act on.

**A skipped check never blocks.** That is not an oversight. A check is skipped _because_ another check did not pass, and
that failure is already in the list — counting the consequence as well would report one condition as several, which is the
collapse the whole diagnostics chain exists to prevent.

## 4. Preconditions, and the two ways to skip

A check declares at most one precondition, and a failed or skipped precondition makes the dependant `skipped` rather than
failed.

```
runtime.node-version ──────────────────────────────── mandatory
cypress.runtime-supported ─────────────────────────── mandatory
environment.package-manager ───────────────────────── mandatory
project.recognised ────────────────────────────────── mandatory
├── project.package-metadata
└── cypress.configuration-located
    ├── cypress.configuration-validatable
    ├── cypress.layout-driveable
    └── cypress.installed
        └── cypress.version-supported
qat.configuration-loadable ────────────────────────── mandatory
├── qat.configuration-valid
├── qat.environment-resolvable
│   └── qat.environment-variables-present
├── output.reports-writable
└── output.evidence-writable
```

A directory with no Cypress configuration produces **one failure and four silences**: `cypress.configuration-located` fails
with `QAT-H018`, and the four checks below it — validity, layout, installation and the version that depends on installation —
are skipped with a sentence naming the check that stopped them. Reporting all five would give a reader a list of five
problems to fix where there is one.

`cypress.configuration-validatable` is the only member of that subtree with a precondition on a _question_ rather than on a
fact: nothing can be validated until something has been located, and "the file was never found" is a far more useful sentence
than "the file could not be validated".

`qat.configuration-valid` carries the same kind of precondition for the same reason, one level up the tree. A configuration
file that cannot be read has nothing to validate, so the runner skips the validity check with a named cause rather than
letting it invent a schema verdict about bytes nobody parsed. That is the whole reason QAT's configuration is two
identifiers and not one with an arm for every state: no verdict is possible, so none is claimed.

`qat.environment-variables-present` is the third of that shape, and the deepest link in the tree. References inside a profile
that failed the schema belong to a document nobody parsed, so their presence is not a fact about the project; the second
environment question is skipped with `qat.environment-resolvable` named as the check that stopped it. Without that link the
report would show a missing variable against a profile the reader had already been told to correct — two problems where
there is one, and the second impossible to act on.

Neither runtime check carries a precondition, and that is deliberate rather than an omission. A precondition exists so a
_consequence_ is not reported as a second, separate problem; a framework bound is not a consequence of QAT's own range. The
two can be violated independently — a framework bound is violable on a runtime QAT supports perfectly well — and suppressing
the advisory whenever the blocking check fails would hide the only finding that explains why the project's tests will still
fail on a runtime QAT is happy with. Declaration order puts the blocking question first, which is the part a reader needs.

`environment.package-manager` has no precondition either, for a narrower reason: nothing above it can make its question
unanswerable. A project can be un-runnable on this interpreter and still have a perfectly reportable package-manager problem,
and the reader may be able to fix the second on a machine that has no supported runtime at all.

Two skip reasons, and the difference is the difference between a user's problem and ours:

| Reason                | Means                                                                                | Who acts                  |
| --------------------- | ------------------------------------------------------------------------------------ | ------------------------- |
| `precondition-failed` | A fact about the project. The question is unanswerable until something else is fixed | The user                  |
| `input-unavailable`   | A fact about the caller. Nobody gathered the evidence                                | Whoever assembled the run |

Both produce a sentence naming the subject, because _skipped_ alone is the least useful word in a report — and it says "not
run" rather than "could not be verified", which read as two different levels of doubt.

## 5. Four code vocabularies, one finding shape

| Prefix  | Answers                                     | Declared in                         |
| ------- | ------------------------------------------- | ----------------------------------- |
| `QAT-D` | What detection found wrong with a project   | `core/application/diagnostics.ts`   |
| `QAT-V` | Whether that stops an operation             | `core/application/validation.ts`    |
| `QAT-C` | What is wrong with a configuration document | `core/application/configuration.ts` |
| `QAT-H` | What is wrong with this machine or this run | `core/application/checks.ts`        |

A reader can tell which layer raised a finding from the code alone. `DiagnosticFinding<Code>` is generic over the set, so a
check that forwards a narrower vocabulary is assignable to the report's wider one with no cast.

**The forwarding checks invent no codes.** `cypress.installed` carries `QAT-D005` rather than a `QAT-H` code of its own, and
`cypress.version-supported` carries whichever of `QAT-D006`, `QAT-V005` and `QAT-V006` the policy produced. One condition, one
code, one sentence — and the doctor is the worst possible home for a support decision, because the moment a comparison lives
in a report the report becomes the definition.

`runtime.node-version` compares a version, and it is not an exception to that rule. It compares by delegating to the one
compatibility engine, using the range the manifest declares, both supplied as evidence. The distinction is between _using_ an
authority and _being_ one: the check contributes no floor, no operator and no tolerance of its own. Delete it and the policy
is unchanged; delete the engine and nothing compiles. The environment pair follows the same discipline one level further: it
maps a reason the classifier already decided onto the code that owns its prose, and re-derives neither the reason nor its
weight.

### Why the configuration location check stopped forwarding

`cypress.configuration-located` used to forward the three detection codes — missing, ambiguous, unusable format — and could
report nothing else, because those are the only configuration conditions the detection engine looks for. It probes _names_
at the project root and deliberately never reads a file.

The rest are file-level facts it cannot see: a directory sitting on the configuration path, a file the user may not read, an
empty file, a symlink that escapes the project, a legacy format, a stale copy in the wrong place. Reporting those needs
bytes, and bytes are exactly what the detection layer refuses to touch — so a doctor forwarding only the detection codes
would call a project configured while its configuration was unreadable, which is the condition its owner most needs to hear
about.

Both halves of the pair therefore consume one decided verdict, taken from one capture of one file, and author their own
codes. The detection findings those three conditions produced remain in the diagnosis for every other consumer; only the
doctor's reporting of them moved vocabulary. The alternative — keeping the three forwarded codes _and_ adding H codes for
the other seven — would report one condition under two identifiers depending on which layer noticed it first.

QAT's own configuration pair is the same shape with a different subject. `qat.configuration-loadable` began by reading the
loader's outcome directly — loaded, not found, empty, malformed, too large, schema-invalid — and could not answer the second
question at all. It now consumes the composed six-state inspection, so both checks project from one read and neither can
describe different bytes. The states that followed are in §5 below; the reasoning is in
[configuration-diagnostics.md](configuration-diagnostics.md).

The environment pair is a third instance of the same shape, and the one with the most states behind it. One resolution of one
configuration produces an inspection with five outcomes — nothing selected, an unusable selection, an undeclared profile, an
invalid profile, a usable profile with its reference facts — and two checks project from it: the profile question and the
references question. Neither resolves anything itself, so the two cannot disagree about which profile applied. The detail is
in [environment-diagnostics.md](environment-diagnostics.md).

The fifty `QAT-H` codes are the conditions nothing else owns:

| Code       | Severity    | Condition                                                                   |
| ---------- | ----------- | --------------------------------------------------------------------------- |
| `QAT-H001` | error       | The running Node version was read and is outside the range QAT declares     |
| `QAT-H002` | warning     | Neither a manifest declaration nor a lockfile names a package manager       |
| `QAT-H003` | error       | An output directory cannot be written; the finding's `path` says which      |
| `QAT-H004` | error       | The configuration file is empty                                             |
| `QAT-H005` | error       | The configuration file is not valid JSON                                    |
| `QAT-H006` | error       | The configuration file is larger than QAT will read                         |
| `QAT-H007` | error       | The environment a command selected is not declared                          |
| `QAT-H008` | warning     | The running Node version could not be compared with the declared range      |
| `QAT-H009` | warning     | The project's framework declares a runtime range the running version misses |
| `QAT-H010` | warning     | The `packageManager` field is present and cannot be used as written         |
| `QAT-H011` | warning     | The project installs with a manager outside the supported policy            |
| `QAT-H012` | warning     | Two lockfiles, or a declaration and a lockfile, name different managers     |
| `QAT-H013` | warning     | The manager is supported and its executable is not on `PATH`                |
| `QAT-H014` | warning     | The executable's version is outside what the project declared               |
| `QAT-H015` | warning     | A package-manager version was expected and none could be read               |
| `QAT-H016` | warning     | The manager and its tooling are fine; dependencies are not installed        |
| `QAT-H017` | warning     | `node_modules` exists and a different manager created it                    |
| `QAT-H018` | error       | No Cypress configuration file was found                                     |
| `QAT-H019` | error       | More than one Cypress configuration file is present                         |
| `QAT-H020` | error       | A configuration-looking file exists in a form Cypress does not load         |
| `QAT-H021` | warning     | A configuration exists where Cypress never reads one                        |
| `QAT-H022` | error       | A configuration path is not a regular file                                  |
| `QAT-H023` | error       | The configuration is a symlink that resolves outside the project            |
| `QAT-H024` | error       | The configuration exists and cannot be read                                 |
| `QAT-H025` | error       | The configuration exists and is empty                                       |
| `QAT-H026` | warning     | The configuration is readable and in the pre-v10 format                     |
| `QAT-H027` | warning     | The configuration was located and never inspected                           |
| `QAT-H028` | error       | A supported mechanism established that the configuration is invalid         |
| `QAT-H029` | warning     | No mechanism was entitled to a verdict about the configuration              |
| `QAT-H030` | information | No QAT configuration file exists, and the documented defaults apply         |
| `QAT-H031` | error       | No QAT configuration file exists, and this command requires one             |
| `QAT-H032` | error       | The QAT configuration file exists and cannot be read                        |
| `QAT-H033` | error       | The declared schema version is outside the set this release reads           |
| `QAT-H034` | error       | The schema version field is absent or is not a number                       |
| `QAT-H035` | error       | The document parsed and the schema rejected one or more fields              |
| `QAT-H036` | error       | An output path is absolute, escapes the project, or is not portable         |
| `QAT-H037` | error       | The framework identifier is not an adapter this release can run             |
| `QAT-H038` | information | No environment was selected, and this command does not need one             |
| `QAT-H039` | error       | No environment was selected, and this command requires one                  |
| `QAT-H040` | error       | The supplied environment selection is empty or unusable                     |
| `QAT-H041` | error       | The configuration's `defaultEnvironment` names an undeclared profile        |
| `QAT-H042` | error       | The selected profile exists and the schema rejected it                      |
| `QAT-H043` | error       | The profile is valid and a path it declares is not usable                   |
| `QAT-H044` | error       | A variable the profile marks required is not set                            |
| `QAT-H045` | warning     | A referenced variable is not set, and its requirement is unstated           |
| `QAT-H046` | error       | A variable the profile marks required is set to nothing                     |
| `QAT-H047` | warning     | A referenced variable is set to nothing, and its requirement is unstated    |
| `QAT-H048` | error       | A reference reads from a source QAT does not approve                        |
| `QAT-H049` | error       | A declared variable name cannot be passed to a child process faithfully     |
| `QAT-H050` | warning     | Whether a referenced variable is set could not be established               |

`QAT-H001` and `QAT-H008` are two codes and not one, because they are two different reader actions: a mismatch that was
_measured_ blocks and is fixed by moving the runtime, while an answer that could not be _obtained_ warns and is fixed by
getting a readable interpreter — or by reinstalling QAT, if the declared range itself is what cannot be read. `QAT-H009` is
separate again because its owner is the project, not the tool.

The package-manager family multiplied for the same reason, one code per _fix_: "nothing identifies your tool", "your field
cannot be used", "the tool is not supported", "two lockfiles disagree", "the tool is not installed", "the version
disagrees", "the version could not be read", "the dependencies are not installed" and "someone else installed them" send a
reader to nine different places. A shared code could describe one of them and would be wrong for the other eight. All nine
are advisory, so the severity column is uniform — which is exactly why the distinction has to be carried by the code rather
than by the weight.

The Cypress configuration family follows the same rule with one merge: ten location conditions, ten codes, except that a
directory on the path and an entry that is not a regular file share `QAT-H022`, because both end in the same instruction —
put a regular file there. The validity question adds two: one for "a mechanism said no", one for "no mechanism was entitled
to speak". The six ways the second can happen share a code because they share a remedy: get a mechanism, then ask again.

QAT's configuration family grew from three codes to eleven when the check moved from the loader's outcome to the composed
verdict. `QAT-H004`–`QAT-H006` remain the loader's own: empty, not JSON, too large. `QAT-H032` is the fourth access
condition — present and unreadable — which the loader never sees, because it is the filesystem that says so. `QAT-H033`–
`QAT-H037` are the validity family, one per fix: an unsupported schema version, a version field that cannot be used, a
rejected field, an output path, a framework identifier. `QAT-H030` and `QAT-H031` are the one pair the doctor does not emit —
absence is a pass here, and whether a _command_ may proceed without a configuration is that command's preflight — and they
are listed anyway because the vocabulary is one set and the preflight shares it.

The environment family is thirteen codes for one profile and its references, and three splits inside it are worth defending
because each looks like over-elaboration until the failure mode is stated. **"Not selected" is two codes**
(`QAT-H038`, `QAT-H039`) rather than one with a conditional severity, because severity is a property of the code — a
selection that is a non-event for `doctor` and a blocker for a command about to execute tests is not two weights of one
outcome, it is a pass and a failure. **"Missing" and "empty" are four codes**, because a deployment that sets `API_TOKEN=` is
not one that forgot it, and telling a reader "it is not set" when they can see it in their shell costs the diagnostic its
credibility in one sentence. **The profile check and the reference check keep separate codes even where the profile is the
cause**, because a reference inside a profile that could not be parsed is not a fact about the variable. The one merge is
`ENV_SETTING_MISSING` into `QAT-H042`: a required setting that is absent is a schema rejection like any other, and the remedy
— correct the listed fields — is identical.

## 6. The evidence a check may read

| Group                   | Holds                                                                                                                                                                                                                                                                | Read by                              |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `runtime`               | The running Node version, the range this build declares, and any range the project's framework declares                                                                                                                                                              | The two runtime checks               |
| `package-manager`       | How identity was established, the lockfiles seen, the executable evidence, the manager version the project expects, how far an install got, and who created the tree if not this manager                                                                             | `environment.package-manager`        |
| `assessment`            | The structured detection result and its per-operation gates                                                                                                                                                                                                          | Four checks                          |
| `cypress-configuration` | The located verdict and the validation verdict, decided from one capture of one file                                                                                                                                                                                 | The two Cypress configuration checks |
| `configuration`         | The composed verdict — one of six states, from absent through unreadable, malformed, unsupported version and schema-invalid to a resolved configuration                                                                                                              | The two QAT configuration checks     |
| `environment`           | The decided inspection of the selected profile — its state, the origin of the selection, per-reference presence verdicts and per-path resolution verdicts — whether the invoking operation requires an environment, and the profile names the configuration declares | The two environment checks           |
| `output`                | Both resolved output paths, and whether each accepts a write                                                                                                                                                                                                         | The two output checks                |

**A group being absent means nobody gathered it**, which is `input-unavailable` — not the same as gathering it and finding
nothing. That distinction is why the package-manager group's identity member is a discriminated union with an `undeclared`
variant rather than an optional field: "no manager could be identified" is a finding, and a check that skipped on it would
have nothing to say about exactly the case it exists for.

The same reasoning explains why `runtime.nodeVersion` is optional and `runtime.frameworkRequired` is optional, while
`runtime.required` is not. A host that reports no version is an answer worth reporting; a project that declares no framework
bound offers nothing to violate; but QAT always has an authority, even when that authority declared nothing — which arrives
as an empty range and is reported as unreadable policy rather than skipped.

`configuration` is the third case and the easiest to get wrong. The group being absent means nobody inspected the project.
An inspection whose state is `missing` means we looked, found nothing, and have something to say about it — a pass, because
the documented defaults are a supported state. A check that skipped because the _group_ was absent would be silent on
precisely the condition `qat.configuration-loadable` exists to report.

`environment` is the fourth, and it fails in the more expensive direction. A configuration that exists but selects no profile
is a _result_: most projects have no environment-specific settings, and the documented behaviour for a run with no selection
is to use the defaults. Skipping because the group was absent and skipping because nothing was selected would look identical
in a report while meaning opposite things — one is a bug in QAT, the other is a bug in the project. The group therefore
carries the inspection, which has a `not-selected` state of its own, rather than an optional selection field.

The environment group also carries the one fact the inspection cannot know: `requiredForOperation`. Whether a command needs an
environment is a property of the command, not of the project, and it changes a finding's weight without changing a single
fact about the files. Recording it as evidence is what lets the finding explain its own severity instead of applying one
silently.

The package-manager group follows the same rule at a finer grain. `selection` is required and always says one of four things;
`executable` becomes required once a manager is identified, because a gatherer that named a manager and never looked for its
binary has left a hole; `required` is absent when the project declared no version, which is different from a declaration
that could not be read; and `installState` distinguishes "installed", "absent", "someone else's tree" and "we could not
attribute it" — the last of which produces no finding, because a gap in the evidence must not be rendered as a fault.

`cypress-configuration` carries both of its members as required, and that is the opposite decision for a good reason: the two
verdicts were decided from one capture of one file, so a facts object holding one without the other could report a validity
verdict about a file it never located. Neither member is derivable from the other — a located file may be unvalidatable, and
a validation can only exist because something was located first.

A check declares the groups it reads, and the runner skips it when one is missing. A check that reads a group it did not
declare is a defect in this layer, and the loud failure is deliberate in both directions: reporting it as a finding would put
a programmer's mistake into a user's terminal, and passing would let a check claim something it never examined. A required
field _inside_ a group is guarded the same way — `present` for the group, `requireFact` for the field — because a hand-built
facts object can satisfy a type without ever having gone through it.

## 7. Traceability

Every check's identifier is its requirement identifier, and every scenario is `<check-id>.<case>`. The separator is a dot,
and that is a contract rather than a style: the behaviour suite keys its fixtures by these exact strings, so a different
separator makes a rule and its verification disagree while both read correctly in isolation.

| Check                               | Scenarios                                                                                                                                                                                                                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `runtime.node-version`              | `supported`, `below-floor`, `above-ceiling`, `between-lines`, `pre-release`, `version-unreadable`, `policy-unreadable`                                                                                                                                                         |
| `cypress.runtime-supported`         | `satisfied`, `unsatisfied`, `not-declared`, `version-unreadable`                                                                                                                                                                                                               |
| `environment.package-manager`       | `declared`, `inferred`, `none`, `declaration-invalid`, `unsupported`, `conflicting`, `executable-missing`, `version-mismatch`, `version-unverified`, `not-installed`, `foreign-install`                                                                                        |
| `project.recognised`                | `detected`, `nothing-identifying-cypress`, `manifest-unreadable`                                                                                                                                                                                                               |
| `project.package-metadata`          | `present`, `missing`, `incomplete`                                                                                                                                                                                                                                             |
| `cypress.configuration-located`     | `found`, `missing`, `ambiguous`, `unsupported-name`, `misplaced`, `path-occupied`, `not-a-file`, `outside-project`, `unreadable`, `empty`, `legacy-format`, `not-inspected`, `not-applicable`                                                                                  |
| `cypress.configuration-validatable` | `validated-json`, `validated-loader`, `invalid-syntax`, `invalid-shape`, `invalid-load`, `not-validated-deep-disabled`, `not-validated-deep-unavailable`, `not-validated-probe-timeout`, `not-validated-undecodable`, `not-validated-size-budget`, `not-validated-text-sanity` |
| `cypress.layout-driveable`          | `supported`, `no-recognisable-location`, `component-only`                                                                                                                                                                                                                      |
| `cypress.installed`                 | `installed`, `declared-not-installed`, `not-declared-not-installed`                                                                                                                                                                                                            |
| `cypress.version-supported`         | `in-range`, `below-floor`, `above-known-good`                                                                                                                                                                                                                                  |
| `qat.configuration-loadable`        | `absent`, `loaded`, `unreadable`, `not-json`, `too-large`, `schema-invalid-is-still-readable`, `version-unsupported-is-still-readable`                                                                                                                                         |
| `qat.configuration-valid`           | `valid`, `absent-nothing-to-validate`, `version-unsupported`, `version-invalid`, `field-rejected`, `output-path-rejected`, `framework-rejected`, `skipped-when-unreadable`                                                                                                     |
| `qat.environment-resolvable`        | `none-selected`, `declared`, `undeclared`, `selection-unusable`, `default-dangling`, `profile-invalid`, `paths-unusable`                                                                                                                                                       |
| `qat.environment-variables-present` | `all-present`, `none-declared`, `required-missing`, `unspecified-missing`, `blank-required`, `source-unapproved`, `name-unusable`, `unverified`                                                                                                                                |
| `output.reports-writable`           | `writable`, `unwritable`                                                                                                                                                                                                                                                       |
| `output.evidence-writable`          | `writable`, `unwritable`, `reports-usable-evidence-not`                                                                                                                                                                                                                        |

Ninety-six scenarios across sixteen checks.

The inventory is enforced rather than described: the behaviour suite's fixtures are keyed by these identifiers, and its first
case asserts the two sets are equal in both directions. A scenario declared without a fixture fails, and a fixture for a
scenario nobody declared fails too. That is the traceability claim made mechanical — the register cannot list a case that
does not exist.

The runtime floor and ceiling are the reason part of that list is longer than it looks. Against `>=20.11.0 <21` the four
adjacent cells are `20.10.9` (below-floor), `20.11.0` (supported, and the inclusive edge), `20.999.999` (supported, and the
upper neighbour) and `21.0.0` (above-ceiling, and the exclusive edge): testing only `supported` and `below-floor` would leave
an inclusive floor indistinguishable from an exclusive one. `between-lines` needs a different policy to be reachable at all —
a gapped alternative such as `<19 || >=22` evaluated at `20.0.0` — which is why it is a scenario of its own rather than
another row of the same table: its remedy is neither "upgrade" nor "go back", it is "move onto one of the supported lines".

The package-manager list reads as its ladder does: two ways to pass, then the conditions in the order a reader fixes them.
That order is not cosmetic. Each rung is only reachable when the ones above it passed — nothing identifies the tool, so there
is no version to compare; the binary is absent, so no version could be read — and a scenario numbered out of order would
make the fixture list describe a search path the check does not follow.

The Cypress configuration pair is counted for the same reason, in the other direction. Thirteen location scenarios are what
a thirteen-reason union costs, and each is a different remedy rather than a different wording. The eleven validation
scenarios are one per terminal outcome plus one per gap cause, because "not validated" is a legitimate result and would
otherwise be the branch nobody proves. `not-applicable` is declared and currently unreachable from the projection — the
precondition means the runner skips a non-Cypress project first — and it stays to cover the case where a runner cannot skip.

QAT's configuration pair is seven and eight rather than six, and the arithmetic is the same split. The two
`…-is-still-readable` scenarios are the boundary the readability check exists to respect — a document that was read is
readable, whatever the schema thinks of it — and both are asserted rather than trusted, because "the file was obtained" and
"the file is good" are the two claims most likely to collapse into each other during a refactor. On the validity side,
`version-invalid` is separate from `version-unsupported` because a string where a number belongs is a one-character fix
while a version from the future means the reader is on the wrong release of QAT, and `output-path-rejected` is separate from
the general field report because its fix is a shape rather than a value. `skipped-when-unreadable` is the whole reason the
pair has two identifiers.

The environment pair is seven and eight, and the split between them is the split the checks make. Four of the seven profile
scenarios reach different codes because they end in four different actions — select something, correct an empty flag, declare
a profile, correct a committed default — and the remaining three are the two ways a usable profile can still be wrong plus the
one way it can be right. Every one of the eight reference scenarios uses a _usable_ profile, deliberately: a failing profile
makes the runner skip the second check, so a fixture built on one would assert a skip instead of the presence verdict it is
named for. Two of the eight are passes — one variable present, none declared — and they are the cases that prove a healthy
project is silent rather than merely non-blocking.

**Reachability is the gap the design cannot close.** A code could be a member of the union and be emitted by nothing. The
pair of guarantees closest to reachability is that a scenario is declared per outcome a check distinguishes _and_ that each
scenario is driven — which is why the register withholds a diagnostic code for any condition it cannot name, and why the
package-manager check's code-to-scenario map is itself asserted: every code it can emit names a scenario the catalogue
declares, and no declared scenario is without one. The same map exists for both configuration pairs and for both environment
rules, in the rule modules themselves: a reason without a code does not compile, and a reason attributed to the wrong check
throws rather than rendering under a neighbouring code.

## 8. What the catalogue does not do

- **It does not read anything.** Every fact is supplied. Gathering is a separate module, and its probes are the only code in
  this chain that touches a disk.
- **It does not read a variable's value.** The environment port answers `set`, `blank` or `unset` and has no accessor that
  could return a value, so a finding cannot print a credential however it is written. A proposed entry that needs a value
  does not need a redaction step; it needs a different requirement.
- **It does not decide the exit status.** `isBlocked(report)` answers whether anything failed. What a command does with
  that — which status, which stream — is the command's decision, and mapping it here would put a second exit-code table
  beside the one in `core/errors`.
- **It does not render.** Findings carry prose; where it is printed, in what order, in what colour, is the output layer's
  business.
- **It does not repair.** Every remedy is a sentence. Nothing here writes, installs, creates a directory or rewrites a
  lockfile.
- **It does not run the framework.** `cypress.installed` reads a finding; nothing invokes Cypress to find out whether it
  works.
- **It does not detect the runtime.** `process.versions.node` is read behind a port; the catalogue receives the string and
  never reaches for it.
- **It does not read the process environment.** Presence arrives through a port the assembly binds to one source, once. A
  probe that shelled out to `printenv` would be a hidden second execution inside a read-only diagnostic, and a `.env` reader
  would make the answer depend on a file the project can change while the run that follows uses only the process
  environment.
- **It does not execute a package manager to identify it.** Identity comes from declared metadata and root lockfiles. A
  binary is located and asked for its version only once a manager has been named by evidence, and never from a project-local
  binary directory.
- **It does not import either configuration.** Both files are inspected as data — name, type, size, permissions, a bounded
  text sample — and the executable one is evaluated only by the project's own loader, on request, with a declared timeout.
  No finding ever carries a line of either.

## 9. Known limits

| Limit                                                                                               | Why it stands                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An output directory is probed for writability, which is a side effect that leaves nothing behind    | The alternative — inferring from a mode bit — reports a directory as writable when it is owned by someone else. A probe that creates and removes a temporary file is the honest test, and it belongs to the gatherer rather than to this table                                                                                                        |
| `QAT-H003` covers both directories                                                                  | One condition, one code. Two codes for "the same thing happened at a different path" is two permanent identifiers that eventually disagree                                                                                                                                                                                                            |
| The supported Node range is read from `engines.node`, not held as a constant                        | Pure functions cannot open a manifest, so the range arrives as evidence from composition. A constant here would have been a second copy of a policy, and the two would diverge on the first release that changed one of them                                                                                                                          |
| A version that cannot be parsed warns rather than failing                                           | "I cannot tell" is neither "supported" nor "unsupported". It is reported, it does not block, and it never counts as clean — the alternative, treating an unmeasured runtime as a pass, is how a report blesses what it never checked                                                                                                                  |
| Only a subset of range syntax is accepted                                                           | Floors, ceilings, `^`, `~` and `\|\|` alternatives. Wildcards, hyphen ranges and partial versions are refused rather than guessed at, because each would require inventing a component. A refused range is reported, never assumed                                                                                                                    |
| Nothing gathers the project's framework runtime bound yet                                           | `cypress.runtime-supported` is implemented and covered, and its fact is optional, so it passes by absence on every project today. The advisory appears when a gatherer reads a declaration; until then the report is silent rather than wrong                                                                                                         |
| Installation state is `unknown` whenever `node_modules` exists and no marker was inspected          | Attributing a tree means reading inside `node_modules`, which the root snapshot deliberately does not do. The check therefore reports nothing rather than guessing, and `QAT-H016` / `QAT-H017` are reachable but not observed in the doctor until a gatherer attributes the tree                                                                     |
| A package-manager version is compared only when the project declares one                            | Comparing against a bound QAT invented would be a support policy this tool does not have. No declaration means no comparison, and `QAT-H015` reports the case where one was declared and could not be read                                                                                                                                            |
| `environment.package-manager` is the one identifier whose first segment does not match its category | Its subject segment says `environment` and it is grouped under package-manager availability. Renaming it is a one-line change while no support document quotes it                                                                                                                                                                                     |
| Nothing verifies the framework executable                                                           | The check exists in the contract — a verification operation would set `binaryAvailable` — and no producer exists. The catalogue does not pretend otherwise                                                                                                                                                                                            |
| Deep validation of an executable configuration is opt-in                                            | Loading a configuration runs project code. `QAT-H029` reports `deep-validation-disabled` as a warning on every TypeScript project, which is the honest middle: a green check would claim a verification that never ran                                                                                                                                |
| Configuration filenames are matched case-sensitively                                                | `Cypress.Config.ts` is not a configuration file, because Cypress does not read it either. A case-insensitive match would report a file the framework ignores                                                                                                                                                                                          |
| A configuration symlink is resolved exactly once                                                    | A file reachable only through a chain of links is reported as not-a-file rather than chased. A chain that long is rare enough that "cannot establish" is a better answer than a clever resolver                                                                                                                                                       |
| A configuration in an unrecognised format is invisible to detection                                 | `cypress.config.yaml` is not in the candidate list, so it is indistinguishable from no configuration at all. Detection probes fixed names rather than listing the directory, and that determinism is worth more than the coverage                                                                                                                     |
| `QAT-H004` is emitted only where the loader distinguishes an empty document from a malformed one    | Today an empty file arrives as `QAT-H005`, and that is the honest report: an empty file is not a JSON document. A seventh state for "zero bytes" would put a distinction in the state machine that only one release of one loader could observe                                                                                                       |
| `QAT-H030`, `QAT-H031` and `QAT-H038` are declared and never emitted by this catalogue              | Absence is a pass here, because the documented defaults are a supported state; whether a _command_ may proceed without a configuration or an environment is that command's preflight, which knows what the user asked for and the doctor does not. They are declared so the vocabulary is one set                                                     |
| The configuration state machine has no `empty` state                                                | Six states are six reader actions. "Empty" and "not JSON" end in the same instruction — put a document there — and the code that distinguishes them already exists for the day a loader can tell them apart                                                                                                                                           |
| `ENV_SETTING_MISSING` reports under `QAT-H042`                                                      | A required setting that is absent is a schema rejection like any other, and the remedy is the same sentence: correct the listed fields. A separate code would be a second identifier for one instruction, and the two would eventually word it differently                                                                                            |
| An environment name is matched exactly and case-sensitively                                         | `Staging` and `staging` are different profiles, because the configuration schema defines them that way. A selector that folded case would agree with a matcher that does not exist and hide a typo the reader can see                                                                                                                                 |
| The environment check reports names and presence states, never values                               | Deliberate and structural rather than a policy: the port has no value accessor, so nothing downstream could print one. Redacting at the finding layer would imply values were arriving and merely being hidden — the assumption the port exists to prevent                                                                                            |
| An informational pass cannot carry its observation                                                  | `CheckPassed.finding` is declared with the invariant "an informational observation attached to a pass", but `CheckVerdict` has no slot for it, so `QAT-H030` and `QAT-H038` are computed and dropped. The fix is one line on the verdict union; until then both rules return a bare pass                                                              |
| `toProjectRelative` exists twice                                                                    | `config/diagnostics/evidence.ts` and `config/environment/diagnostics/evidence.ts` both render project-relative paths, with slightly different handling of Windows and UNC paths. The root barrel publishes only the first, so the ambiguity is resolved at a boundary rather than by a wildcard — but two implementations of one idea is one too many |

## 10. Extending the catalogue

**Adding a check** is six edits, and the compiler and the tests catch five of them:

1. An identifier in `CheckId`. The register test fails until the table has an entry.
2. An entry in `rules.ts`, with a title, a purpose, a procedure, the fact groups it reads, its severity and at least one
   scenario id.
3. An assertion that the entry's `requires` matches what its body reads. Nothing checks this — `present` and `requireFact`
   take a value, not a label — so it is the one step that depends on review.
4. Scenarios in the entry, and one fixture per scenario in the behaviour suite. The inventory case compares the two sets, in
   both directions.
5. A row in §2 and a row in §7 of this document. A test asserts every identifier appears here.
6. A `QAT-H` code and its guidance entry, if the check notices a condition no other layer owns. If it restates one, it
   carries that code and authors nothing.

**Adding a category** is a decision about how the report groups, not a label a check may choose. `CheckCategory` is closed
and the register asserts all eight are covered.

**Adding a fact group** means a new property on `CheckFacts`, a row in `FACT_KEYS`, and a row in §6. The map is what lets the
label a report prints differ from the property a type declares, and it is the reason a group can be added without renaming
anything a message quotes.

**Adding a reason to a judged verdict** — the pattern both configuration pairs and both environment rules follow — is three
edits that must agree: a member in the verdict union, an entry in the rule's reason-to-code map, and a guidance entry for
that code. The first makes the second a compile error if forgotten; the second makes the third a compile error; and the
scenario list then needs one fixture per new reason. That ordering is deliberate: work from the union outward, so the
compiler tells you what is missing rather than a reader discovering a reason with no sentence. Two rules reading one verdict
add a fourth obligation — the reason must be attributed to exactly one of them, and the rule that receives a reason it does
not own throws rather than rendering it under a neighbouring code.

**Adding a code to an existing check's list** is a change to what that check answers. Before doing it, ask whether the
condition deserves its own check: a check is a question, and two conditions a reader fixes differently are two questions.
The package-manager family is the worked example of the opposite decision — one question, nine codes — which was right there
because the conditions are mutually exclusive rungs of one ladder rather than nine independent questions. The configuration
pairs are the counter-example: two questions with a precondition between them, because "where is it / can it be obtained"
and "can anything vouch for it" have different answers and different evidence. The environment pair is the counter-example
twice over: the profile and the references inside it are fixed by two different people — one edits a committed file, the
other exports a value on the machine — and the second question is unanswerable until the first is.

**Adding a supported version** is not an edit to this document at all. It is an edit to `package.json#engines.node`, the CI
matrix that must cover it, and the release notes — see
[runtime-compatibility.md](runtime-compatibility.md#7-changing-the-supported-range). A check that needed a code change to gain
a supported version would be a check that had restated the policy.

**Adding a package manager** is not an edit here either: it is a row in the policy table, a fixture proving detection, and
the matching row in [package-managers.md](package-managers.md) that a contract test compares against the code.

**Adding a supported Cypress configuration filename** is one edit in the detection registry, plus a fixture. Nothing in this
layer enumerates filenames: the location check maps _reasons_, not names, which is what keeps the two from drifting.

**Adding a supported QAT configuration schema version** is one edit in the schema module. The façade receives the supported
set as a value and the validity check reports what the gate refused, so neither restates it — and a version joining the set
is a change to one array's contents, not to a signature.

**Adding a supported environment name rule** is one edit in `config/environment/select.ts`, plus a fixture. Nothing here
enumerates the character class: the profile check maps _states_, and the shape of a name is decided where names are
selected.
