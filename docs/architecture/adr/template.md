<!--
ADR TEMPLATE — do not add a number to this file, and do not treat it as an ADR.
It is scaffolding copy, and the index generator skips it by name.

Create a record with:   npm run adr:new -- "Your decision in a few words"
Regenerate the index:   npm run adr:index

Rules that make this format work, in order of how often they are broken:

  1. ONE DECISION PER RECORD. If the title contains "and", you have two records.
  2. RECORDS ARE IMMUTABLE ONCE ACCEPTED. Do not edit an accepted ADR to reflect
     a change of mind. Write a new one and mark the old one superseded. The
     history of a decision is as useful as the decision, and editing destroys it.
  3. WRITE IT WHEN YOU DECIDE, NOT AFTERWARDS. An ADR written at the end of a
     project is a rationalisation, and reads like one.
  4. THE CONSEQUENCES SECTION IS THE POINT. An ADR with no honest cost is
     advocacy, not a record. If nothing got harder, you have not looked.
  5. NO PLANNING IDENTIFIERS. Not the work item, not the sprint, not the phase.
     A record must still make sense after the plan that commissioned it is gone.

Leave the HTML comments in place while drafting — they are invisible when
rendered and they stop the next reader from misreading a thin section as a
considered one. Delete them before the record is accepted.
-->

# ADR-NNNN: Short noun phrase naming the decision

Date: YYYY-MM-DD

## Status

<!--
One of: Proposed · Accepted · Deprecated · Superseded by ADR-NNNN

Proposed    — written, not yet agreed. The record exists so the argument has a home.
Accepted    — in force. Superseding it requires a new record, not an edit here.
Deprecated  — no longer relevant; nothing replaced it.
Superseded  — replaced. Name the replacement, and link it.
-->

Proposed

## Context

<!--
The forces at play, in plain prose. What situation makes a decision necessary?
Constraints, prior decisions, competing goals, what the team knew at the time.

Keep it factual and specific: dates, versions, measured numbers, observed pain.
Leave out the option you intend to choose — this section should read the same
whether or not the reader knows the outcome.
-->

## Decision

<!--
What we are doing, in the active voice: "We will …"

State it once and clearly, then stop. If the reasoning needs more than a
paragraph of justification, the context section is under-developed.
-->

## Consequences

<!--
What becomes easier and what becomes harder. Both. Always.

Group them as Easier / Harder / Neutral. The Harder list is the one a future
reader needs, and the one that is almost always too short.
-->

**Easier**

-

**Harder**

-

**Neutral**

-

## Options considered

<!--
OPTIONAL — delete this section if there was genuinely one option.

Record each rejected option and the single reason it lost. This is what stops
the same proposal returning every eighteen months with a new name.
-->

| Option | Why not |
| ------ | ------- |
|        |         |

## References

<!--
OPTIONAL — links to standards, upstream issues, measurements, or prior art.
-->

-
