# ADR-0037: Project the configuration pipeline into a non-throwing inspection result

Date: 2026-11-27

## Status

Accepted

## Context

<!--
The forces at play, in plain prose. What situation makes a decision necessary?
Constraints, prior decisions, competing goals, what the team knew at the time.

Keep it factual and specific: dates, versions, measured numbers, observed pain.
Leave out the option you intend to choose — this section should read the same
whether or not the reader knows the outcome.
-->

A project's QAT configuration is obtained through five stages, and every one of them is built to stop. Discovery
answers "here or nowhere". The loader returns a six-member outcome — loaded, absent, empty, malformed, oversized,
invalid — and only the `loaded` member carries a document. The version gate refuses a document from a schema this
build does not read. Validation returns `{ valid: true, config }` or `{ valid: false, diagnostics }`. Resolution
returns `{ ok: true, configuration }` or `{ ok: false, issues }`. Each of those contracts is right for a caller that
must not proceed on garbage, and every one of them is wrong for a caller whose job is to explain why the tool will
not start.

The doctor is that second caller. Its two configuration questions — can this file be obtained, and does it conform
to a schema we support — are about one file, read once. Composing them separately means each check performs
locate → load → gate → validate → resolve for itself. Two compositions of one pipeline are two orderings, and the
report has already shown the symptom: a row saying the file is fine beside a row saying it could not be read,
because the two rows were describing two different reads.

Three constraints bound the answer.

The dependency direction is fixed: `src/core` may not import the configuration module. Core's ports carry the
verdict, so the verdict's shape has to exist in core's own vocabulary, and the translation has to happen at the
composition boundary — there is nowhere else it can happen without inverting the direction.

The vocabulary is genuinely plural. Loading speaks `kind`; the schema speaks `QAT-C` codes and structured paths;
core publishes dotted paths on a finding; the catalogue speaks `QAT-H` codes for one `DiagnosticSeverity` scale.
None of those is a mistake, and none of them can be collapsed into another without losing a distinction one of the
layers relies on.

And the resolver is branded: `resolveConfiguration` accepts only a document that loading produced and validation
accepted, and checks a marker at run time to prove it. Any design that erases the document to `unknown` between the
stages must either cast or re-brand — and re-branding would create a second place able to declare a document loaded,
which is the one thing the marker exists to prevent.

Two prior decisions shape what the verdict must be able to say. A missing configuration is a result and not a
failure, because the documented defaults are a supported state. An unsupported schema version short-circuits before
field validation, because field errors against a schema from the future are speculation. A verdict that could not
express those two would force each of its consumers to reconstruct them.

## Decision

<!--
What we are doing, in the active voice: "We will …"

State it once and clearly, then stop. If the reasoning needs more than a
paragraph of justification, the context section is under-developed.
-->

We will compose locate → load → version gate → validate → resolve once, in a single non-throwing entry point, and
return the outcome as one of six discriminated states: absent, unreadable, malformed, unsupported version,
schema-invalid, valid.

We will re-express those six states in core's vocabulary at the composition boundary, so the port can carry the
verdict without core naming the module that produced it, and so the resolved configuration travels with the state
that established it.

We will declare the projection from the loader's output to the document as an explicit dependency of that entry
point, rather than assuming the loader's output is the document the gate and the schema judge.

## Consequences

<!--
What becomes easier and what becomes harder. Both. Always.

Group them as Easier / Harder / Neutral. The Harder list is the one a future
reader needs, and the one that is almost always too short.
-->

**Easier**

- The doctor can report six distinguishable situations instead of one, and a reader gets the action each one implies:
  create a file, fix a permission, fix the syntax, upgrade the tool, correct a field, or nothing.
- Both configuration checks read one value produced by one read, so they cannot describe different bytes. The
  assessment's attach step reads the same value, so the doctor and any later preflight ask one question.
- The whole state machine is exercisable from object literals. Every state and every failure code is reachable in a
  unit test without a disk, which is what makes the boundary cases — an empty file, an oversized one, a document from
  a schema that does not exist — cheap to prove.
- A new consumer of a project's configuration inherits the composition instead of re-deriving it.
- The loader's reason for failing survives the crossing. An oversized file and a permission problem reach the report
  as different conditions, because the failure is translated rather than re-inferred from an error message.

**Harder**

- There are now two projections of one result: a reason-and-evidence vocabulary for callers that report configuration
  findings outside the doctor, and the catalogue's codes for the doctor itself. They read the same value, so they
  cannot disagree about the state, but they can drift about _wording_, and nothing prevents a third appearing.
- The boundary mapping is code whose entire job is translation. When it is wrong it is wrong silently: a schema handed
  the loader's bundle reports every required field as missing, and a version gate handed one finds no version and skips
  itself. Both produce a plausible report, and only an integration test that runs the assembled port catches them.
- The projection is a dependency whose omission is silent in a unit test the fixtures cannot detect. Test doubles
  supply the identity because their loader yields a bare document; production unwraps a bundle. That difference is
  invisible until something exercises both.
- The state union is closed, so a seventh state is a cross-cutting change: every consumer's switch, the catalogue's
  reason tables and the boundary mapping all move together.
- The entry point imports nothing, which is what makes it exercisable from literals, and which also means it restates
  the schema's field name for the version. Renaming that field in the schema is not a compile error here — it is a
  gate that silently stops firing.
- Anything above this layer now depends on a pipeline it does not own. When a stage's contract changes, the lag shows
  up as a report rather than as a failing build.

**Neutral**

- The entry point is asynchronous because loading is; the other four collaborators are synchronous, and that asymmetry
  is deliberate rather than an artefact.
- Six states map one-to-one onto the two checks' prose but not onto the schema's seven `QAT-C` codes. Those remain the
  schema's own vocabulary, and the prose catalogue derives its wording from them rather than adopting them.
- The façade's issue shape is not published from the module's root barrel; a caller that needs it derives it from the
  state that carries it, which is how the composition root already does it.
- Configuration is located by name at the project root, so the locator is a join rather than a search. The port still
  exists, because a scheme with more than one candidate would need exactly one place to say so.

## Options considered

<!--
OPTIONAL — delete this section if there was genuinely one option.

Record each rejected option and the single reason it lost. This is what stops
the same proposal returning every eighteen months with a new name.
-->

| Option                                                                    | Why not                                                                                                                                                                                       |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Let each check compose the stages itself                                  | Two compositions of one pipeline are two orderings, and the report demonstrated the failure: one row saying the file is fine beside another saying it could not be read.                      |
| Have each check catch exceptions from the existing pipeline               | The stages throw for conditions they cannot proceed past, so every rule would need its own error-to-state mapping. Those mappings would diverge, and each would be untested at the boundary.  |
| Return a nullable result, or a boolean "is it valid"                      | Cannot represent six states. Every consumer would re-derive the distinctions, and a boolean cannot tell "cannot be read" from "not there" — which are the two conditions most often confused. |
| Validate twice: leniently for the diagnostic, strictly for the command    | Two validators guarantee eventual disagreement, and the second one becomes the definition nobody tests.                                                                                       |
| Let `src/core` import the configuration module's verdict type             | Inverting the dependency is the reason core stays testable without a filesystem. One module's vocabulary reaching into core would put a module boundary in the type system's hands.           |
| Extend the loader's outcome union until it can answer the schema question | The loader stops at bytes. A loader that judged a schema would be a second validator, and would still not know what resolution applies.                                                       |

## References

<!--
OPTIONAL — links to standards, upstream issues, measurements, or prior art.
-->

- [`configuration-diagnostics.md`](../configuration-diagnostics.md) — the six states, the reason vocabulary and the
  evidence contract as they are implemented.
- [ADR-0023](./0023-read-configuration-from-one-file-at-the-project-root.md) — why the locator is a join and not a search.
- [ADR-0024](./0024-treat-a-missing-configuration-as-a-result-rather-than-a-fail.md) — absence is one of the six states,
  and it is not the failure one.
- [ADR-0026](./0026-stop-at-an-unsupported-version-rather-than-listing-field-err.md) — the version gate the entry point
  delegates to, and the reason a state short-circuits rather than accumulating.
- [ADR-0027](./0027-apply-defaults-only-to-omitted-fields-and-resolve-paths-agai.md) — why the valid state carries a
  resolved configuration rather than a document.
- [ADR-0032](./0032-skip-a-check-whose-precondition-failed-rather-than-reporting.md) — the skip contract that makes the
  six states cheap to report as two rows.
