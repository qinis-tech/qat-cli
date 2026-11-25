# ADR-0031: Resolve one approved override instead of merging configuration

Date: 2026-11-24

## Status

Proposed

## Context

A project declares named environments, and each one is a typed profile: a target address, a set of non-sensitive
variables, and a set of secret references that name environment variables rather than holding values. A run selects one
environment and turns it into the values a framework adapter needs.

Three forces met when deciding how a value could arrive from somewhere other than the committed file.

**Running the same suite against a different deployment is the ordinary case.** The reason to have named environments at
all is that a suite is pointed at one address on a laptop and another in CI. If the committed file is the only source,
then changing the target means editing, committing and reviewing a file — which is not an override, it is a release.

**The configuration file exists so that what a run uses is reviewable.** Its value over a shell export is that it is
visible in a diff, and that a reviewer sees the variables and the secret _names_ a run depends on. Anything that arrives
from outside the file is invisible to that review, and the more of it that can arrive, the less the file means.

**Secrets must not be re-pointable out of band.** The file names the variable that holds a credential. If an outside
source could supply a _different name_, a run would authenticate as something nobody reviewed, and the file would still
describe the old one.

Prior decisions constrain the answer. Environment variables outrank the file, so any override must sit above the profile
and below the flag. The schema rejects unknown fields, so a configuration cannot smuggle a setting in. The precedence
chain is documented and tested for settings that arrive from all four sources.

Recent work in this repository had already produced two examples of the failure this decision is about: the same default
restated in two modules, and a resolver anchoring a field path that the schema had since renamed. Both were silent, and
both were found by a type error rather than by a test. A general merge is that failure mode with the volume turned up —
the set of things it merges is decided per run, by whoever types a key.

## Decision

We will resolve exactly one property from approved override sources — the selected environment's target address — and
refuse every other override rather than merging configuration.

The order is: the flag, then the one approved environment variable, then the selected profile. The override surface is a
type with a single field, so an override for anything else cannot be expressed, and no code path iterates over keys. An
override is validated with the same constraint the profile's own field uses, and an unusable one is refused rather than
ignored, on both sources.

## Consequences

**Easier**

- A pipeline can point a run at a preview deployment without touching the committed file, and the flag appears in the job
  definition where a reviewer of the pipeline can see it.
- Every other property has exactly one source. "Why is it using this value?" has one answer, and the resolved value
  records which level supplied the target so the answer survives the run.
- Adding a property that may be overridden is a reviewed change to one type, not a change to a merge path whose behaviour
  is decided at call sites.
- A variable's value and a secret's name cannot be changed out of band, so the identities a run uses are the ones the file
  describes.
- An unusable override fails the command instead of falling back. An operator who exported a target and got a different
  one would have produced a run whose results look entirely ordinary and are about the wrong system.

**Harder**

- Teams that want to vary a _variable_ per pipeline cannot. The workaround is a second profile, which is more
  configuration than an environment variable would have been, and the pressure to add one will be constant.
- The refusal deviates from the rule documented for the settings that go through the shared precedence resolver, where an
  unusable environment variable is skipped in favour of the next rung. Two policies now exist for the same kind of input,
  and the difference is justified only by what a target means — so it has to be explained at both sites, or a future
  reader will "fix" one of them.
- The order for this property is written out in the environment stage rather than delegated to the shared helper, because
  that helper reads the ambient environment itself instead of accepting one. This is duplication that looks removable, and
  someone will try; removing it requires giving the helper an injectable source first.
- `baseUrlSource` stops being decorative. Once two sources can legitimately supply the target, a support question cannot
  be answered without it, so it becomes part of the contract rather than a nicety.
- Adding a second overridable property means touching the type, the stage, two documentation tables and the tests, and no
  compiler error will mention the documentation.
- The override surface will read as unfinished. The next person will reasonably ask why variables are not overridable, and
  the answer lives in this record rather than beside the type — which is exactly where a record like this earns its keep,
  and exactly where it will be missed by somebody who does not look.

**Neutral**

- Nothing about the configuration file changes. A project that overrides nothing behaves as it did before.
- The resolved value is still frozen and still carries its secrets in a self-redacting container; this decision does not
  touch how values are protected, only how they are selected.
- An empty override is treated as absent, consistent with how the variable utilities read an inherited blank.
- The property has no default at any level, so there is nothing at the bottom of the chain for an override to outrank.

## Options considered

| Option                                                       | Why not                                                                                                                                                                                                 |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Merge the file, the environment and the flags generically    | The merge itself becomes the decision, taken per run and reviewed by nobody. It also makes every key overridable the day somebody types it, which is the failure the file exists to prevent             |
| A naming scheme, `QAT_<PROPERTY>`, for every setting         | A convention that reads as an open surface. By the third property it is "everything, if you guess the name", and nothing records which names were agreed                                                |
| Allow variables to be overridden while keeping secrets fixed | Half the guarantee. A variable map is precisely where a credential gets written by mistake, and an out-of-band variable makes the file a lie about what ran                                             |
| Skip an unusable override and fall back to the profile       | A run pointed somewhere other than where the operator asked. Defensible for a log level, where the difference is cosmetic; not for a target, where it produces plausible results about the wrong system |
| No override at all                                           | Then running against a preview deployment means editing a committed file, which is a release rather than an override                                                                                    |

## References

- ADR-0009 — prefer environment variables over configuration file values: the order this decision sits inside
- `docs/architecture/environment-profiles.md` — the profile model, and why secrets are references
- `docs/architecture/environment-resolution.md` — selection, the resolved value, and the secret container
- `docs/architecture/configuration-precedence.md` — the full chain, and the rung this property occupies
- `profileBaseUrl` in `src/config/schema/constraints.ts` — the one constraint applied to the file and to every override
