# Configuration diagnostics

How `qat doctor` answers two questions about a project's QAT configuration — _can this file be
obtained?_ and _is it one we can interpret?_ — without ever throwing, writing, or reporting a value
it read.

This document describes the layer as it is. The decisions behind it are recorded in
[ADR-0037](./adr/0037-project-the-configuration-pipeline-into-a-non-throwing-inspe.md);
the stage-level rules it composes are in [configuration-discovery.md](configuration-discovery.md),
[configuration-loading.md](configuration-loading.md),
[configuration-validation.md](configuration-validation.md); the catalogue rows are in
[doctor-checks.md](doctor-checks.md).

## Two questions, four stages, one verdict

The stages already existed and already had their own tests. What did not exist was a single place
that composes them **without throwing**, because every stage is designed to stop: discovery finds
nothing, the loader refuses bytes, the schema gate refuses a version, validation refuses fields,
resolution refuses a path.

A command whose job is to _stop_ wants that. A command whose job is to _describe_ cannot use it: a
diagnostic that throws cannot report. `inspectConfiguration` is the composition, and it returns a
verdict rather than an exception:

```
locate → load → version gate → validate → resolve
   │        │          │           │         │
   └────────┴──────────┴───────────┴─────────┴──▶ one of six states
```

Each stage stops the pipeline on failure, so exactly one state is reported and a reader is never
asked to fix five things at once. The result is frozen, immutable and deterministic.

## The six states

| State                 | Means                                              | What a reader does                                    |
| --------------------- | -------------------------------------------------- | ----------------------------------------------------- |
| `missing`             | no file at the project root                        | nothing, if the defaults suit them                    |
| `inaccessible`        | the file is there and cannot be read               | fix a permission, or whatever occupies the path       |
| `malformed`           | present, readable, not a JSON document             | fix the syntax at the reported line                   |
| `version-unsupported` | declares a schema version this build does not read | upgrade QAT, or bring the file to a supported version |
| `schema-invalid`      | read, and the schema rejected fields               | correct the fields that were named                    |
| `valid`               | parsed, version-checked, valid and resolved        | nothing                                               |

Six states, because six different actions follow. A boolean — `isConfigurationValid` — collapses
them into one, and every consumer given a boolean ends up inventing its own taxonomy to say what
actually happened; the second taxonomy is the one that drifts.

Two distinctions carry most of the value:

- **`missing` is not `inaccessible`.** An uninitialised project is a supported state where documented
  defaults apply. A file that cannot be read is a fault. Collapsing them tells half the readers to
  create a file they already have.
- **`version-unsupported` is not `schema-invalid`.** There is nothing meaningful to say about the
  fields of a document whose version we cannot interpret, and a page of field errors buries the one
  fact the reader can act on. The gate short-circuits for exactly this reason.

`valid` carries the **resolved** configuration, not the document. Inspection ends where a writer can
begin: paths anchored, environment chosen. Anything less would make every caller resolve a second
time, which is how two components come to disagree about where output goes.

## Who owns which condition

Two checks, one per question. Every condition is owned by exactly one of them.

| Condition                            | Observed as                                 | Reported by                  | Code       | Severity    |
| ------------------------------------ | ------------------------------------------- | ---------------------------- | ---------- | ----------- |
| no file, defaults apply              | `missing`                                   | `qat.configuration-loadable` | `QAT-H030` | information |
| no file, command requires one        | `missing`                                   | _operation preflight_        | `QAT-H031` | error       |
| present, unreadable                  | `inaccessible`                              | `qat.configuration-loadable` | `QAT-H032` | error       |
| present, larger than the read budget | `inaccessible` (`TOO_LARGE`)                | `qat.configuration-loadable` | `QAT-H006` | error       |
| present, not JSON                    | `malformed`                                 | `qat.configuration-loadable` | `QAT-H005` | error       |
| empty file                           | `malformed`                                 | `qat.configuration-loadable` | `QAT-H004` | error       |
| unsupported version                  | `version-unsupported`                       | `qat.configuration-valid`    | `QAT-H033` | error       |
| version missing or not a number      | `schema-invalid`, path `schemaVersion`      | `qat.configuration-valid`    | `QAT-H034` | error       |
| framework not one we run             | `schema-invalid`, path `framework`          | `qat.configuration-valid`    | `QAT-H037` | error       |
| output path unusable                 | `schema-invalid`, under a path-bearing root | `qat.configuration-valid`    | `QAT-H036` | error       |
| any other field rejected             | `schema-invalid`                            | `qat.configuration-valid`    | `QAT-H035` | error       |
| all good                             | `valid`                                     | neither — a pass is silence  | —          | —           |

Two rows there are worth their own sentence.

**`QAT-H030` is informational, and the doctor still passes.** Absent configuration is not a problem
the doctor reports as one: the documented defaults are the product's intended behaviour for a project
that never ran `qat init`. Whether a _particular command_ can proceed without a configuration is
that command's preflight, which knows what the user asked for and the doctor does not. Hence
`QAT-H031` living outside the catalogue.

**`QAT-H004` is currently reachable only where the loader distinguishes an empty document from a
malformed one.** Where it does not, an empty file arrives as `malformed` and `QAT-H005` speaks. A
contract test asserts that whichever path is taken, the reader gets one of the two sentences rather
than a silent pass.

## The skip contract

`qat.configuration-valid` declares `precondition: qat.configuration-loadable`. When the discovery
check fails — unreadable, malformed — the runner marks validity **skipped**, with the blocker named.

This is not cosmetic. Reporting "schema invalid" because the file could not be read is a fabricated
finding: it sends someone looking for a malformed field that was never reached. A skipped row is
information about ordering; it never blocks, and it never reads as a pass.

The corollary is visible in the rule: `inaccessible` and `malformed` are unreachable inside
`qat.configuration-valid`'s switch, and the rule **throws** if it is handed one. That is a defect in
the catalogue's `precondition` wiring, not a condition of a project, so it is loud — the same
reasoning `present()` applies to an undeclared fact group.

## Evidence: the address, never the contents

A configuration file is a plausible place for a credential — `environments.staging.secrets`,
`output.reports`, a URL with a token in it. So evidence carries:

- project-relative paths, normalised to forward slashes;
- field paths and issue codes;
- counts and enumerations from closed sets;
- type summaries such as `string`, `object(3 keys)`, `array(2)`.

It never carries a value, a line of the file, a parser message that could quote one, or an absolute
path. `toSafeIssue` and `buildConfigEvidence` are the only functions allowed to decide this, they live
in `src/config/diagnostics/evidence.ts`, and a property-based test injects a secret into a profile
value and asserts it appears in no produced string.

Two details worth stating because they look like fussiness:

- **A malformed file is described by line and column, not by an excerpt.** The parser's message can
  quote the offending fragment, and a fragment of a configuration file is file content.
- **Paths in evidence are relative to the project root.** On a developer machine an absolute path
  routinely contains a username, and a diagnostic is the artefact most likely to be pasted into a
  public issue.

## One read per run

`configuration.inspect(root)` memoises the **promise**, not the result, keyed by project root. Two
callers starting at once share the same in-flight read rather than racing to produce two.

The reason is not speed. A doctor that reads the same file twice can describe two different
filesystems in one report — one row saying the file is fine and another saying it could not be read.
One read is what makes "these two rows are about the same bytes" a fact rather than a hope.

The memo lives in the composition root, which is the only layer that knows a run has a lifetime.
It is cleared on dispose, because holding inspections past the end of a run leaves state describing a
project the application has finished with.

## The seam, and why core does not import this module

`core/application/configuration.ts` declares the inspection in **its own** vocabulary — a closed
access vocabulary (`permission-denied`, `not-a-file`, `link-loop`, `io-error`, `ambiguous`), dotted
field paths, the resolved configuration. The façade speaks a different one: errno codes, structured
path arrays, the resolver's own output.

The two are reconciled in `toPortInspection`, in the composition root, which is the only function
allowed to know both. That is the price of the dependency direction — core may not name the module
that owns files, parsers and schema versions — and it is paid once, in one function, with a comment.

A consequence worth knowing: `TOO_LARGE` and `UNKNOWN` both map to `io-error` above the seam. The
first because "the file is bigger than the reader" is not a permission question, the second because
we genuinely do not know. Inventing a more specific cause would be a worse answer than an honest
general one.

## Two projections, one authority

`ConfigInspection` is the authority. Two projections read it, and neither may re-derive what it
already decided:

| Projection              | Shape                                              | Used where                                                                                                                   |
| ----------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `classifyConfiguration` | `QatConfigReason` + redacted evidence + timestamps | callers that report a configuration finding outside the doctor catalogue — `qat config validate`, stored diagnostic sessions |
| the two checks          | `QAT-H` code + catalogue severity                  | the doctor's report                                                                                                          |

They cannot disagree, because both are total functions of the same value. But they _are_ two, and
that is a cost: a reason and a code describe overlapping conditions in two vocabularies. The rule
that keeps it honest is that neither may inspect the file — if a third is ever needed, it is derived
from these, not written from scratch.

If a future refactor finds that only one of the two has consumers, the other should be deleted rather
than kept "for symmetry". A projection with no reader is a claim about behaviour that no test defends.

## What this layer does not do

- **It does not write.** No file is created, migrated, repaired or rewritten. `qat init` creates, and
  only with declared intent; the doctor never does.
- **It does not validate twice.** The schema rules live in `src/config/schema`. If a rule is wrong,
  it is fixed once, there.
- **It does not check writability.** It validates the _shape and resolution_ of a declared output
  path. Whether the directory accepts a write is the filesystem check's question
  (`output.reports-writable`), because that needs a probe and this needs a policy.
- **It does not read Cypress's configuration.** A different file, a different owner, a different
  check pair (`cypress.configuration-located` / `-validatable`).
- **It does not echo values.** See above; this is the one non-goal that is also a security property.

## Performance and determinism

| Property        | Guarantee                                                                    |
| --------------- | ---------------------------------------------------------------------------- |
| Reads per run   | one per project root                                                         |
| Filesystem work | one stat, one bounded read, no directory walk                                |
| Process spawns  | none                                                                         |
| Network         | none                                                                         |
| Size budget     | 1 MiB (`MAX_CONFIG_BYTES`), enforced by the loader, which answers `TooLarge` |
| Determinism     | identical fixture → byte-identical evidence; issues sorted by path           |
| Cost            | inspection completes in single-digit milliseconds on a warm filesystem       |

## Testing

The state machine is exercised from object literals, not from a disk: `inspectConfiguration` takes
its four collaborators as ports, so all six states and every failure code are table rows.

| Level       | What it covers                                                                                                               |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Unit        | the façade's six states; the classifier's reason selection; evidence redaction (property-based)                              |
| Integration | the real discovery, loader, schema and resolver against the existing `tests/fixtures/config` tree — reused, never duplicated |
| Contract    | every mandatory state has a fixture and a documented reason; `QAT-H004`/`QAT-H005` reachability                              |
| E2E         | `qat doctor` on a malformed fixture: one error, field path shown, no values leaked                                           |

The traceability artefact is the reason vocabulary. `REASON_OWNER`, `DEFAULT_SEVERITY` and
`REASON_PREREQUISITE` are `as const satisfies` tables over the union, so adding a reason is a compile
error until every table covers it — which is the cheapest possible guard against a condition no check
can produce or no test can name.

## Related

- [ADR-0037](./adr/0037-project-the-configuration-pipeline-into-a-non-throwing-inspe.md) —
  why the pipeline is projected rather than re-validated
- [ADR-0026](adr/0026-stop-at-an-unsupported-version-rather-than-listing-field-err.md) — the version
  gate short-circuits
- [ADR-0032](adr/0032-skip-a-check-whose-precondition-failed-rather-than-reporting.md) — the skip
  contract
- [adr-0024](adr/0024-treat-a-missing-configuration-as-a-result-rather-than-a-fail.md) — absence is a
  result
- [diagnostics.md](diagnostics.md) — statuses, severities and the result contract
- [doctor-checks.md](doctor-checks.md) — the catalogue rows
