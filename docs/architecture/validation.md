# Validation

|                    |                                                                                                                                              |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**         | Normative                                                                                                                                    |
| **Contract**       | `src/core/application/validation.ts`                                                                                                         |
| **Implementation** | `src/project/validation/`                                                                                                                    |
| **Companions**     | [cypress-detection.md](cypress-detection.md), [diagnostics.md](diagnostics.md), [ADR-0020](adr/0020-gate-each-operation-on-its-own-rules.md) |

Whether a recognised project may be used for a particular operation.

## 1. Three layers, three questions

| Layer          | Question                          | Answer                           | Can refuse                                |
| -------------- | --------------------------------- | -------------------------------- | ----------------------------------------- |
| Detection      | What is here?                     | A verdict with evidence          | No — an unfavourable verdict is an answer |
| Diagnostics    | What is wrong with it?            | Findings with codes and remedies | No                                        |
| **Validation** | **Does what is wrong stop this?** | **A gate per operation**         | **Yes**                                   |

Validation performs no I/O. Every fact it uses is already on the detection result, which is what makes the
whole rule set testable from a value and stops it becoming a second place that guesses about a project.

## 2. One set of findings, a different verdict per operation

| Operation | Role      | Blocked when                                      |
| --------- | --------- | ------------------------------------------------- |
| `inspect` | Reporting | Never — surfacing the blockers _is_ the operation |
| `execute` | Gating    | Any finding whose severity is `error`             |

**Inspection is never blocked.** That single sentence decides every gate, and it is the reason the operation
set exists rather than one "may I use this project" question. A directory with no configuration is blocked for
execution and perfectly inspectable, and honouring both is what lets `qat doctor` work on exactly the projects
that need diagnosing.

## 3. The classification

| Condition                                | Code       | Severity | Blocks `execute` |
| ---------------------------------------- | ---------- | -------- | ---------------- |
| Nothing identifying Cypress              | `QAT-D001` | error    | yes              |
| Cypress evidenced, no configuration      | `QAT-D002` | error    | yes              |
| More than one configuration              | `QAT-D003` | error    | yes              |
| Configuration in an unreadable format    | `QAT-D004` | error    | yes              |
| Declared or configured, not installed    | `QAT-D005` | error    | yes              |
| Installed major predates the format      | `QAT-D006` | error    | yes              |
| Manifest cannot be read                  | `QAT-D007` | error    | yes              |
| Configuration in the wrong place         | `QAT-V001` | error    | yes              |
| No driveable spec location               | `QAT-V002` | error    | yes              |
| Root is a container as well as a project | `QAT-V003` | warning  | no               |
| Verified: executable unusable            | `QAT-V004` | error    | yes              |
| Major below supported range              | `QAT-V005` | error    | yes              |
| Major above known-good range             | `QAT-V006` | warning  | no               |
| Manifest missing _(legal)_               | `QAT-D010` | warning  | no               |
| Manifest incomplete                      | `QAT-D011` | warning  | no               |
| Installed locally, undeclared            | `QAT-D012` | warning  | no               |

The two prefixes are permanent and distinct: `QAT-D` is a condition detection reports, `QAT-V` is one
validation adds. A reader can tell which layer raised a finding from the code alone.

## 4. The requirements

| Requirement             | What it asserts                                                                   |
| ----------------------- | --------------------------------------------------------------------------------- |
| `project-recognised`    | Every condition detection reported has been considered — forwarded, not re-worded |
| `configuration-located` | The configuration sits where Cypress loads it from                                |
| `layout-supported`      | A spec location exists that this tool can drive                                   |
| `version-supported`     | The installed major is inside the policy range                                    |
| `binary-available`      | No verification has found the executable unusable                                 |
| `root-unambiguous`      | The root is a project, not a container that also happens to be one                |

The first is load-bearing: it carries detection's findings forward unchanged, so **a new detection condition
gates execution without anyone writing a rule for it**. The layer above cannot forget to consult a condition
it has never heard of.

The requirement table is keyed by identifier, so a missing entry does not compile. Every assertion it makes is
reported, including the ones that passed — a list of failures alone cannot distinguish "everything was
checked" from "nothing was checked".

## 5. The supported-layout policy

Two closed classifiers, and each answer maps to at most one code.

**Configuration placement**

| Placement       | Meaning                                             | Code                              |
| --------------- | --------------------------------------------------- | --------------------------------- |
| `at-root`       | A supported configuration where Cypress loads it    | —                                 |
| `misplaced`     | Only inside `cypress/`, where Cypress does not look | `QAT-V001`                        |
| `name-occupied` | A directory sits on a configuration filename        | `QAT-V001`                        |
| `absent`        | Nothing configured, nothing explaining why          | — (detection's `QAT-D001`/`D002`) |

A usable root configuration wins outright. A stray directory on a filename the project does not use is _not_
reported: the job is to gate operations, not to audit repositories, and a finding would block a run that would
succeed.

**Spec location**

| Shape            | Meaning                                               | Code       |
| ---------------- | ----------------------------------------------------- | ---------- |
| `named`          | `cypress/e2e` or `cypress/integration`                | —          |
| `legacy`         | Specs directly under `cypress/`                       | —          |
| `component-only` | `cypress/component` and nothing else                  | `QAT-V002` |
| `unknown`        | Nothing recognisable — usually a custom `specPattern` | `QAT-V002` |

`component-only` and `unknown` share a code because both have the same consequence — no driveable specs —
and different explanations, because the reader with component tests needs a different next step from the
reader with a custom pattern.

**Nothing lists a directory.** Every location comes from a fixed candidate list, so the answer cannot depend
on iteration order. The cost is real and stated: `cypress.config.yaml` is invisible, and so are specs under a
name nobody has used. The misplaced-configuration probe is derived from the root candidate list rather than
written out separately, so a format added in one place is probed in both.

## 6. Version policy

| Boundary                | Value | Effect                                  |
| ----------------------- | ----- | --------------------------------------- |
| `minimumSupportedMajor` | 10    | Below it, `QAT-V005` blocks execution   |
| `knownGoodMaximumMajor` | 13    | Above it, `QAT-V006` warns and proceeds |

`minimumSupportedMajor` equals the configuration-format floor today and is **restated rather than imported**.
One is a fact about a file format; the other is a decision about what this tool supports. They coincide now
and will not stay coincident.

The upper boundary warns rather than refuses. A refusal would turn every new Cypress release into an outage,
and the first person to hit it would be someone whose tests would have passed.

## 7. Execution readiness, and the one place a command is refused

`assertReadyFor(assessment, operation)` throws `QAT2005` when the operation is blocked, carrying the blocking
codes in its context and the first one's remedy. It is the only throw in this layer; everything else is a
value.

For `inspect` it can never throw, because inspection is never blocked. That is not a special case in the
code — it follows from the gate builder, and it is asserted rather than assumed.

## 8. What validation does not do

- **It does not decide what is wrong.** Detection decides; validation decides whether it stops anything.
- **It does not render.** No stream, no colour, no columns. Findings carry text; where it is shown is someone
  else's decision.
- **It does not install, repair or modify anything.** Every fact it uses was read by detection, and every
  remedy is a sentence.
- **It does not verify the binary.** `binaryAvailable` is `undefined` until a separate operation sets it, and
  `undefined` is never treated as `false`.
- **It does not gate on a package manager, a Node version or a browser.** Those are readiness questions for
  later, and each needs its own rule rather than a clause in this one.
