# ADR-0001: Record architecture decisions

Date: 2026-11-21

## Status

Accepted

## Context

QAT is a CLI-first platform whose value depends on people trusting its output. Its
architectural decisions are currently spread across code comments, commit messages,
pull request descriptions and conversations. None of those survive well.

Code comments explain _how_. Commit messages explain _what changed_. Neither explains
_why this and not the alternative_, and neither survives a file being renamed. When the
reasoning behind a choice is lost, the choice is re-litigated from scratch — usually by
someone rediscovering the same constraints a year later, and often with less patience.

The project also needs new contributors to understand the architecture without having
been present for the discussions that produced it.

## Decision

We will keep a collection of Architecture Decision Records in
`docs/architecture/adr/`, one file per decision, following Michael Nygard's format:

- a numbered title naming the decision
- the date
- a status: Proposed, Accepted, Deprecated or Superseded
- **Context** — the forces at play
- **Decision** — what we will do
- **Consequences** — what becomes easier and, explicitly, what becomes harder

Additional rules:

1. **One decision per record.** A title containing "and" is two records.
2. **Records are immutable once accepted.** A reversal is a new record whose status
   names the record it supersedes. The superseded record is never edited: editing would
   erase the reasoning that made the original choice reasonable at the time, which is
   precisely what a later reader needs.
3. **Records live in the repository**, versioned with the code they describe and
   reviewed in the same pull request as the change they justify. A decision record kept
   somewhere else is discovered by nobody.
4. **Records are proposed before implementation** for any change that alters an exit
   code, the result schema, a command surface, an adapter contract or a toolchain.
5. **No planning identifiers.** Not the work item, not the sprint, not the phase. A
   record must still make sense after the plan that commissioned it is gone.
6. **The index is generated, not maintained by hand.** A hand-maintained index goes
   stale silently, and a stale index is worse than none because it is trusted.

## Consequences

**Easier**

- The reasoning behind a decision survives the people who made it.
- Reviewing a change becomes reviewing a decision, rather than reverse-engineering one.
- Rejected options stay on record, so the same proposal does not return every eighteen
  months under a new name.
- New contributors have a single chronological source for why the architecture is the
  way it is.
- Writing the record before implementing routinely exposes a weak decision while it is
  still cheap to change.

**Harder**

- Writing a record costs time, and the cost lands before any of the value is visible.
- The format invites padding. A four-page record nobody reads is worse than a
  paragraph, and resisting that is a discipline rather than a rule.
- Accepted records must be honoured. A record the code contradicts is actively
  misleading, and detecting that drift requires ongoing attention.
- Immutability means a mistaken record cannot be quietly corrected — it must be
  superseded in public. That is the intent, and it remains uncomfortable.
- The rule that records are proposed _before_ implementation adds a step to the front
  of work that already feels urgent.

**Neutral**

- The collection grows monotonically. By design, nothing is deleted.
- The tooling is roughly two hundred lines of Node with no dependencies, so the cost of
  the process is the writing, not the machinery.
- Records are plain Markdown. They render on the hosting provider, in an editor, and in
  a terminal, which is the whole of the interoperability requirement.

## Options considered

| Option                                                      | Why not                                                                                                                                                       |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No formal record; rely on commit messages and pull requests | Survives only as long as the repository history is read, and explains what changed rather than why. Reasoning behind a rejected option is lost entirely.      |
| A wiki or external document store                           | Separated from the code, so it drifts out of date without anything failing. Also bypasses the review path that would catch a thin record.                     |
| Long-form design documents                                  | The cost of writing one discourages writing any, and they are rarely updated when the decision is refined. Most decisions need a page, not ten.               |
| Nygard-format records in the repository, one per decision   | Chosen. Small enough to actually get written, versioned with the code, reviewed alongside the change, and immutable so the history of reasoning stays intact. |

## References

- Michael Nygard, "Documenting Architecture Decisions" (2011)
- `docs/architecture/adr/template.md`
- `docs/architecture/adr/adr-index.md`
