# Diagnostics

|               |                                                                                                           |
| ------------- | --------------------------------------------------------------------------------------------------------- |
| **Status**    | Normative                                                                                                 |
| **Contract**  | `src/core/application/diagnostics.ts`                                                                     |
| **Catalogue** | `src/project/diagnostics/catalogue.ts`                                                                    |
| **Companion** | [cypress-detection.md](cypress-detection.md), [ADR-0019](adr/0019-register-diagnostics-in-a-catalogue.md) |

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

## 6. What a diagnosis is not

- **Not a replacement for `discoverProject`.** That function produces a usable project or raises the error that
  stopped it. A diagnosis describes; it does not decide.
- **Not presentation.** No stream, no colour, no column widths. Rendering belongs to the CLI output layer.
- **Not a validation engine.** It compares a version with a format and reports findings. Support policy, dependency
  health and browser availability are not modelled.
