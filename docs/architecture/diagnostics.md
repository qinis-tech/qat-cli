# Diagnostics

|               |                                                                                                                                                                                                       |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**    | Normative                                                                                                                                                                                             |
| **Contract**  | `src/core/application/diagnostics.ts`                                                                                                                                                                 |
| **Catalogue** | `src/project/diagnostics/catalogue.ts`                                                                                                                                                                |
| **Companion** | [cypress-detection.md](cypress-detection.md), [doctor-checks.md](doctor-checks.md), [runtime-compatibility.md](runtime-compatibility.md), [ADR-0019](adr/0019-register-diagnostics-in-a-catalogue.md) |

What QAT reports about a project, as a value rather than as prose emitted at the point of failure.

## 1. The shape

```
ProjectDiagnosis
├── identity      root, name, packageMetadata status
├── framework     declaration, installation, configuration, candidates, binaryAvailable
├── detection     detected | not-detected | ambiguous | invalid
├── compatibility consistent | incompatible | undetermined
└── findings      array of DiagnosticFinding
```

An empty `findings` array is the good outcome. There is no "all is well" finding, because one would be noise in
every filter and would have to be excluded from every count.

## 2. Two statuses, never one

`detection` and `compatibility` answer different questions, and a project can fail either while passing the other.

|                | Meaning                                                                   |
| -------------- | ------------------------------------------------------------------------- |
| `detected`     | A supported configuration file was found                                  |
| `not-detected` | Nothing identifying Cypress, or Cypress evidenced without a configuration |
| `ambiguous`    | More than one supported configuration                                     |
| `invalid`      | A configuration in an unused format, or metadata that cannot be read      |

|                | Meaning                                                               |
| -------------- | --------------------------------------------------------------------- |
| `consistent`   | Whatever is installed is not contradicted by the configuration format |
| `incompatible` | The installed major predates the format in use                        |
| `undetermined` | Nothing to compare: no installation, or no configuration              |

`consistent` is deliberately not called `supported`. The only comparison available without a version policy is a
fact about the format — `cypress.config.*` arrived in Cypress 10 — so the field claims exactly that much and no more.

It is also not the _runtime_ verdict. Whether the running Node.js version is one this build supports is a different
question with a different vocabulary and a different owner; §6 says why, and where it is answered.

## 3. Findings, severity and order

Two severities. A finding either stops the command or does not; nothing acts on a third.

Findings are ordered: **blocking findings first, then warnings.** A caller taking the first error therefore gets the
most fundamental problem, and a caller printing the list reads the reason before the remarks about it.

| Code       | Severity | Condition                                           |
| ---------- | -------- | --------------------------------------------------- |
| `QAT-D001` | error    | Nothing identifying Cypress                         |
| `QAT-D002` | error    | Cypress evidenced, no configuration file            |
| `QAT-D003` | error    | More than one supported configuration               |
| `QAT-D004` | error    | A configuration in an unused format                 |
| `QAT-D005` | error    | A configuration exists, no installed package        |
| `QAT-D006` | error    | Installed major predates the configuration format   |
| `QAT-D007` | error    | A manifest exists and cannot be read                |
| `QAT-D010` | warning  | No manifest — legal                                 |
| `QAT-D011` | warning  | A manifest without a name or a version              |
| `QAT-D012` | warning  | Installed in the project itself, not declared by it |

`QAT-D012` fires only for a project-local install. A hoisted workspace install is the normal shape for a monorepo
member and is already described by `installation.source === 'workspace'`; warning about it would make the noisiest
case the most common one.

Every code in this table describes **the project tree**. Conditions about the machine or the run — the Node.js version
this build supports, a configuration file that is not a document, an output directory that cannot be written — carry
`QAT-H` and live in [doctor-checks.md](doctor-checks.md). A `QAT-D` code must not be invented for a runtime condition,
and a runtime condition must not be smuggled into one of the rows above: the prefix is how a reader tells which layer
spoke, and the first misuse makes it meaningless.

## 4. Where the prose lives

Every explanation and every remedy is in the catalogue, one entry per code, and the table is a `Record` over the code
union — a code without an entry does not compile.

The finding carries the rendered text rather than the code alone, so a diagnosis is self-describing: a report
generator needs no catalogue, and a stored diagnosis still reads correctly after the wording has changed.

Paths on findings are relative to `identity.root`, consistent with every other stored path in the project.

## 5. The two tri-states

`binaryAvailable` is `boolean | undefined`, and `undefined` means **nobody looked**. Passive detection never runs the
framework, so it is `undefined` throughout the current implementation. A separate verification operation can set it
without changing a shape consumers already read.

`compatibility` has an `undetermined` member for the same reason: the honest answer when there is nothing to compare
is not the same as a negative verdict.

## 6. What a diagnosis says about the runtime: nothing

The Node.js a project is run on is not a property of the project. It is a property of the machine executing the
command, and it belongs to a different vocabulary for exactly that reason:

| Question                                                | Answered by                    | Prefix  |
| ------------------------------------------------------- | ------------------------------ | ------- |
| Is this directory a project QAT can drive?              | `ProjectDiagnosis` — this file | `QAT-D` |
| Does that project stop an operation?                    | the validation layer's gate    | `QAT-V` |
| Is the configuration document readable?                 | the configuration loader       | `QAT-C` |
| Is the running Node.js version one this build supports? | the health-check catalogue     | `QAT-H` |

A `ProjectDiagnosis` is gathered from one tree, by a function that takes a root. The runtime is gathered from the
process, by a port that takes nothing. Merging them would mean a diagnosis could not describe a project without also
describing whichever machine happened to read it — so a stored diagnosis would be wrong the moment it was read
somewhere else.

The two meet in `qat doctor`, and they meet as **separate findings**, never as one:

- `runtime.node-version` reports what QAT itself requires, and can block.
- `cypress.runtime-supported` reports what the project's framework release declares, and only ever advises.

They are separate because their owners are different — one is fixed by moving QAT, the other by moving the project —
and because a merged sentence would name a problem without naming whose it is. The declared range, the accepted
grammar and the three outcomes are specified in [runtime-compatibility.md](runtime-compatibility.md).

`compatibility` is emphatically not the place for this. It compares an installed Cypress major with a configuration
_format_, which is a fact about the tree; a runtime verdict is a fact about the process. Two facts, two fields, two
vocabularies — and a field that answered both would be wrong half the time it was read.

## 7. What a diagnosis is not

- **Not a replacement for `discoverProject`.** That function produces a usable project or raises the error that
  stopped it. A diagnosis describes; it does not decide.
- **Not presentation.** No stream, no colour, no column widths. Rendering belongs to the CLI output layer.
- **Not a validation engine.** It compares a version with a format and reports findings. Support policy, dependency
  health and browser availability are not modelled _here_ — the Node.js support policy exists and is normative, but it
  lives in [runtime-compatibility.md](runtime-compatibility.md) and reaches a report as `QAT-H` findings, never as a
  `ProjectDiagnosis` field.
