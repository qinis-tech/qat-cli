<!--
GENERATED FILE. Do not edit by hand — `npm run adr:index` overwrites it, and
`npm run verify` fails if it is out of date.

Why an index at all: a directory of numbered files is browsable but not scannable.
The index answers "what has been decided, and is it still in force?" in one screen,
which is the question people actually arrive with.
-->

# Architecture Decision Records

A record of the architecturally significant decisions made on QAT. Each record
states the forces at play, the choice made, and what it cost. Records are
immutable once accepted: a reversal is a new record that supersedes the old one,
so the reasoning behind a change stays visible.

Newest first.

| # | Title | Status | Date |
| --- | --- | --- | --- |
| [ADR-0006](0006-write-files-through-a-temporary-file-and-rename.md) | Write files through a temporary file and rename | Accepted | 2026-11-21 |
| [ADR-0005](0005-separate-diagnostic-logs-from-user-facing-output.md) | Separate diagnostic logs from user-facing output | Accepted | 2026-11-21 |
| [ADR-0004](0004-derive-exit-codes-from-error-category-rather-than-from-the-c.md) | Derive exit codes from error category rather than from the call site | Accepted | 2026-11-21 |
| [ADR-0003](0003-test-an-os-matrix-with-a-single-node-version.md) | Test an OS matrix with a single Node version | Accepted | 2026-11-21 |
| [ADR-0002](0002-verify-every-change-in-continuous-integration.md) | Verify every change in continuous integration | Accepted | 2026-11-21 |
| [ADR-0001](0001-record-architecture-decisions.md) | Record architecture decisions | Accepted | 2026-11-21 |

## Status legend

| Status | Meaning |
| --- | --- |
| **Proposed** | Written, not yet agreed |
| **Accepted** | In force |
| **Deprecated** | No longer relevant; nothing replaced it |
| **Superseded** | Replaced; the replacement is linked from the status cell |

## Creating a record

```bash
npm run adr:new -- "Short noun phrase naming the decision"
```

That allocates the next number, copies `template.md`, and regenerates this index.

## What counts as architecturally significant

A decision qualifies when reversing it later would be expensive, or when it
constrains how everyone else works. In practice, for this project:

- Anything that changes the **exit-code contract** or the **result schema**
- Anything that changes a **command name, flag or configuration key**
- Any new **abstraction or dependency boundary**, including a new adapter contract
- Any **toolchain** choice with an escape cost — language, compiler, test runner,
  package manager, runtime version
- Any **distribution or licensing** decision
- Any decision you have already had to explain twice

If it would take one paragraph to reverse, it is probably not significant, and a
comment in the code is the right place for it.
