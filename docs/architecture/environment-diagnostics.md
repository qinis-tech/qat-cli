# Environment diagnostics

What the doctor can say about the environment a run selected, before that run
starts. Two checks, one resolution of one configuration, and one rule that governs
everything below it: **the diagnostic never reads a variable's value.**

Related documents: [`doctor-checks.md`](./doctor-checks.md) for the catalogue rows,
[`environment-profiles.md`](./environment-profiles.md) for the configuration
schema, [`environment-resolution.md`](./environment-resolution.md) for how a
profile's values reach a child process, [`diagnostics.md`](./diagnostics.md) for
the result vocabulary, and
[ADR-0038](./adr/0038-select-one-environment-by-declared-precedence-and-report-why.md)
for why selection works the way it does.

---

## The two checks

| Check                                           | Question                                                    | Reads                  | Severity | Precondition                 |
| ----------------------------------------------- | ----------------------------------------------------------- | ---------------------- | -------- | ---------------------------- |
| `qat.environment-resolvable` (`ENV-002`)        | Does the selected profile exist, and is it one QAT can use? | the decided inspection | `error`  | `qat.configuration-loadable` |
| `qat.environment-variables-present` (`ENV-001`) | Are the variables that profile references usable?           | the same inspection    | `error`  | `qat.environment-resolvable` |

They are two checks rather than one because they carry two remedies. The first
sends a reader to a file they committed; the second sends them to a shell, a CI
secret store or an `.env` they have not exported. A single identifier would have
to name both, and would report a missing variable as a consequence of a profile
the reader had already been told to fix.

The precondition is what keeps the pair honest: references inside a profile that
failed the schema belong to a document nobody parsed, so their presence is not a
fact about the project.

---

## Selection: one environment, one origin

An environment can arrive three ways. The order is fixed, documented, and
implemented in exactly one function (`src/config/environment/select.ts`):

| Precedence | Source                                    | Origin recorded         |
| ---------- | ----------------------------------------- | ----------------------- |
| 1          | `--env <name>` on the command line        | `explicit-cli`          |
| 2          | `QAT_ENV` in the process environment      | `process-environment`   |
| 3          | `defaultEnvironment` in the configuration | `configuration-default` |
| —          | nothing supplied                          | `none`                  |

Three rules follow from it, and each has a failure mode it prevents:

- **The first _supplied_ candidate wins, not the first _usable_ one.** An empty or
  whitespace-only value is returned as an unusable selection with its real origin,
  not as an absence. Falling through to the next candidate would run a different
  environment than the one that was asked for — the worst outcome this code can
  produce.
- **The origin travels with the answer.** Every finding can say _why_ a profile was
  chosen, which is what turns "we ran against staging" into something a reader can
  check.
- **Nothing is merged.** The selected profile replaces the default; it never
  combines with it. Two profiles in one process is state nobody can reproduce.

Names are single tokens: no whitespace, no path separators, no quotes, at most 64
characters. Comparison is exact and case-sensitive — `Staging` and `staging` are
different profiles, and guessing which was meant is worse than saying so.

---

## Inspection: five states

`src/config/environment/inspect.ts` runs the state machine once and returns a
closed union. Each state stops at the first failing precondition, so a reader gets
one problem to fix rather than a cascade.

| State               | Meaning                                | Next step               |
| ------------------- | -------------------------------------- | ----------------------- |
| `not-selected`      | nothing supplied anywhere              | guide                   |
| `selection-invalid` | supplied, and unusable as written      | quote it back           |
| `profile-not-found` | a usable name that no profile declares | list what exists        |
| `profile-invalid`   | declared, and the schema rejected it   | name the fields         |
| `profile-valid`     | usable; here are the reference facts   | ask the second question |

Inspecting never throws for an expected condition. A missing profile, an unreadable
document and an unusable selection are _results_, because a caller whose job is to
describe a broken environment cannot be built on a function that stops.

---

## Classification: reasons to findings

`src/config/environment/diagnostics/classify.ts` turns the inspection into
diagnostics, deciding which of the two checks owns each condition and at what
weight. One reason per condition; one condition per remedy.

| Reason                              | Owned by | Status                   | Severity            | Code                    |
| ----------------------------------- | -------- | ------------------------ | ------------------- | ----------------------- |
| `ENV_NO_SELECTION`                  | ENV-002  | `indeterminate` / `fail` | information / error | `QAT-H038` / `QAT-H039` |
| `ENV_SELECTION_INVALID`             | ENV-002  | `fail`                   | error               | `QAT-H040`              |
| `ENV_PROFILE_NOT_FOUND`             | ENV-002  | `fail`                   | error               | `QAT-H007`              |
| `ENV_REFERENCE_DANGLING`            | ENV-002  | `fail`                   | error               | `QAT-H041`              |
| `ENV_PROFILE_INVALID`               | ENV-002  | `fail`                   | error               | `QAT-H042`              |
| `ENV_SETTING_MISSING`               | ENV-002  | `fail`                   | error               | `QAT-H042`              |
| `ENV_PATH_INVALID`                  | ENV-002  | `fail`                   | error               | `QAT-H043`              |
| `ENV_VARIABLE_MISSING`              | ENV-001  | `fail`                   | error / warning     | `QAT-H044` / `QAT-H045` |
| `ENV_VARIABLE_BLANK`                | ENV-001  | `fail`                   | error / warning     | `QAT-H046` / `QAT-H047` |
| `ENV_REFERENCE_SOURCE_NOT_APPROVED` | ENV-001  | `fail`                   | error               | `QAT-H048`              |
| `ENV_REFERENCE_NAME_INVALID`        | ENV-001  | `fail`                   | error               | `QAT-H049`              |
| `ENV_VARIABLE_UNVERIFIABLE`         | ENV-001  | `indeterminate`          | warning             | `QAT-H050`              |

Two reasons sharing a code is deliberate where the remedy is identical:
`ENV_SETTING_MISSING` is a schema rejection like any other field failure, and the
next action is the same — correct the listed fields.

The one code that predates the group is `QAT-H007`, allocated when `ENV-002` asked
a single question. Codes are appended, never inserted, so it keeps its number even
though its twelve siblings are contiguous.

### Severity follows the declaration, not QAT's opinion

A variable's presence is judged against what the profile said about it:

| Declaration             | Absent         | Why                                                        |
| ----------------------- | -------------- | ---------------------------------------------------------- |
| marked required         | **Error**      | the profile stated the need; not meeting it is a defect    |
| requirement unspecified | **Warning**    | QAT cannot establish the requirement, so it must not block |
| marked optional         | nothing at all | an absent optional value is the documented default         |

"Marked optional and absent" produces no finding. A false Error here teaches people
to ignore the check, and a silent Warning teaches them the same thing more slowly.

Because severity is a property of the code, "missing and blocking" and "missing and
advisory" are two codes rather than one code with a flag. The alternative — a
severity function over facts — would move the same decision into every call site
that remembered to pass the right argument.

---

## The skip contract

`ENV-001` declares `precondition: qat.environment-resolvable`. The **runner** owns
the skip: when the profile check does not pass, the variables check is reported as
`skipped` with the name of the check that must pass first.

The classifier also emits a `skipped` diagnostic for the same situation, because
`qat run`'s preflight consumes the classification directly and has no runner. That
is one fact with two consumers, not two authorities — the rule layer treats a
reason-less diagnostic as a pass, so the report never shows the same condition as
both a skip and a pass.

---

## Nothing here can print a secret

This is the reason the feature is shaped the way it is, so it is worth stating as a
property rather than as a practice.

- The port (`EnvironmentReader` in `core/application/ports.ts`) has **one member
  returning an enum**: `set`, `blank`, `unset`. There is no value accessor on the
  type, so a diagnostic built on it cannot print a credential however it is
  written.
- `Blank` and `Unset` are separate because they are separate facts: `export
API_TOKEN=` is a deliberate act in some pipelines and an inheritance accident in
  others, and telling a reader "it is not set" when they can see it in their shell
  costs the diagnostic its credibility in one sentence.
- The inspection carries **names and presence states**. The evidence carries names,
  counts, field paths and project-relative locations. There is no field anywhere in
  the chain capable of holding a value.
- Redaction is deliberately _not_ applied. Adding it would imply values were
  arriving and merely being hidden — the assumption the port exists to prevent. A
  proposed change that needs a value here does not need a redaction step; it needs
  a different requirement.

`Blank` also counts whitespace-only content as unusable, which is a diagnostic
judgement rather than a value transformation: `core/environment` keeps the literal
value faithful (`VariableState`) and answers the usability question separately
(`VariablePresence`). A caller that needs the value must use the former and accept
the responsibility.

---

## Evidence

A finding carries the profile, the origin of the selection, the configuration path
(project-relative), the names examined or affected, and an issue count. Variable
names are filtered through a portable-name pattern before they reach a sentence,
and paths are relativised so a shared CI log never reveals a home directory.

The persisted model (`src/diagnostics/models/environment.ts`) is versioned,
additive-only, and re-validated on read: evidence comes back from disk, from a
hosted service and from older QAT versions, and none of those can be trusted to be
well formed.

---

## Module map

| Path                                                    | Responsibility                                                        |
| ------------------------------------------------------- | --------------------------------------------------------------------- |
| `src/config/environment/contracts.ts`                   | types only; no imports, no behaviour                                  |
| `src/config/environment/select.ts`                      | precedence, and the reason it chose                                   |
| `src/config/environment/inspect.ts`                     | the five-state machine                                                |
| `src/config/environment/diagnostics/classify.ts`        | state → findings, with severity policy                                |
| `src/config/environment/diagnostics/evidence.ts`        | evidence assembly and the output gate                                 |
| `src/core/environment/variables.ts`                     | `probeVariablePresence` — the only reader of `process.env`            |
| `src/core/application/ports.ts`                         | `EnvironmentReader`, the value-free port                              |
| `src/diagnostics/checks/rules/environment-profile.ts`   | ENV-002: status → verdict, reason → code                              |
| `src/diagnostics/checks/rules/environment-variables.ts` | ENV-001, same shape                                                   |
| `src/diagnostics/checks/contracts.ts`                   | `EnvironmentFacts` — `inspection`, `requiredForOperation`, `declared` |

The configuration module depends on nothing in `src/diagnostics`. The rules depend
on the configuration module and on the shared contracts. The assembly wires the
port over whichever environment source it was given, once.

---

## What is deliberately not checked

| Not checked here                                        | Where it belongs                                    |
| ------------------------------------------------------- | --------------------------------------------------- |
| whether a target URL answers                            | the bounded network checks                          |
| whether a configured directory exists or is writable    | the filesystem checks                               |
| whether a secret has the right _shape_ or _permissions_ | outside the tool                                    |
| profile inheritance or precedence between profiles      | not supported: one selection, one profile           |
| values of any kind                                      | nowhere — no part of QAT holds them for diagnostics |

Path _resolution_ is checked here, because a path is part of the profile's
declaration. Path _availability_ is not, because that is a filesystem question
with two answers already.

---

## Changing the policy

The order of work is enforced by the compiler, and getting it backwards produces
errors in three files that do not name the real cause:

1. Add the reason to `EnvironmentReason` — `classify.ts`'s exhaustive switches now
   fail until it is handled.
2. Teach the classifier which check owns it, and at what weight.
3. Add the `HealthCode` member, appended. `HEALTH_GUIDANCE`'s `Record` now fails
   until it has prose.
4. Add the mapping in the owning rule. A reason attributed to the wrong check
   throws rather than rendering under a neighbouring code.
5. Add the scenario id to the check's `scenarios` list, and a fixture.

A code with prose and no reachable path to the report is a half-finished change,
not a harmless one — see the first item under known debt.

---

## Testing

Scenarios are declared per check and prefixed with the catalogue identifier:

- `qat.environment-resolvable.{none-selected, declared, undeclared, selection-unusable, default-dangling, profile-invalid, paths-unusable}`
- `qat.environment-variables-present.{all-present, none-declared, required-missing, unspecified-missing, blank-required, source-unapproved, name-unusable, unverified}`

Beyond those, four invariants are worth more than scenario coverage because they
can fail silently:

1. **Code weight matches classifier weight.** `toCode` forks on severity so the
   guidance entry agrees with the verdict; nothing in the type system enforces it,
   so a test asserts it for every reason/severity pair.
2. **No value reaches any output.** A property test injects a unique sentinel into a
   fake environment and a configuration fixture, and asserts it appears in no
   finding, JSON, log or persisted record.
3. **`null` reason means pass.** A classifier that started attaching conditions to
   silence would turn "nothing to report" into a finding about nothing.
4. **A verdict always exists.** Both rules throw when the classifier produces no
   entry for them, because a rule that returns nothing disappears from the report
   and a disappeared check looks like a passing one.

Non-functional guarantees: inspection reads no files and spawns no process;
resolution is deterministic across locales and runs; evidence is bounded and
frozen; a thousand repeated classifications of one inspection produce identical
findings.

---

## Known debt

**The pass arm of `CheckVerdict` has no finding slot.** `CheckPassed.finding?`
exists in `core/application/checks.ts` with the invariant "an informational
observation attached to a pass", but `CheckVerdict` cannot produce one. `QAT-H038`
(`EnvironmentNotSelected`) and `QAT-H030` (`ConfigurationMissing`) are therefore
codes with prose and no reachable path to the report. The fix is one line —
`{ readonly verdict: "pass"; readonly finding?: CheckFinding }` — and both rules
already compute the finding they would attach.

**`toProjectRelative` exists twice.** `config/diagnostics/evidence.ts` and
`config/environment/diagnostics/evidence.ts` each implement project-relative path
rendering, with slightly different handling of Windows and UNC paths. The root
barrel publishes only the configuration one, so the ambiguity is resolved at the
boundary rather than by a wildcard silently dropping a name — but two
implementations of one idea is one too many, and the eventual fix is for the
environment evidence builder to reuse the stronger of the two.

**`QAT-H007` sits apart from its siblings.** A consequence of append-only
numbering, recorded here so the next reader does not assume it belongs to an
unrelated group.
