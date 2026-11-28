# ADR-0038: Select one environment by declared precedence and report why

Date: 2026-11-28

## Status

Accepted

## Context

A run can be told which environment profile to use in three ways, and they can all be present at once:

- `--env <name>` on the command line;
- `QAT_ENV` in the process environment, which is how CI supplies it;
- `defaultEnvironment` in `qat.config.json`, committed with the project.

Before this decision the selector treated those three as a pool of candidates and resolved them by falling through: an unusable value was skipped and the next candidate won, an absent selection acquired a well-known name, and a selected profile was allowed to combine with the default. Three consequences were observed:

- A flag present but empty — the ordinary result of an unset shell variable in an invocation like `qat run --env "$TARGET"` — ran against the committed default. Nothing in the output said the requested value had been ignored, so the run appeared to confirm a target it never used.
- Two profiles could contribute values to one run. When a variable resolved to something unexpected there was no way to tell which profile had won without attaching a debugger.
- Support conversations could not be reproduced, because "which environment was that?" was not recorded anywhere. A reader with a saved report could not answer it.

The constraints that shaped the decision:

- The profile schema models environments as typed profiles whose secrets are _references_ to environment variables, never values. The diagnostic layer verifies that a reference exists and that its source is approved; it never reads a value. Any design that surfaced resolved values to answer "which environment applied?" would break that.
- `qat run`'s preflight and `qat doctor` must reach the same conclusion. Two resolution paths would be two chances to disagree about the target of a run.
- Configuration is read from one file at the project root, and profiles are declared in it. There is no profile inheritance in the schema, and nothing merges profiles.

## Decision

We will resolve exactly one environment selection by a fixed precedence — explicit command-line selection, then the process environment, then the configuration default, then no selection — and return the selected name together with the origin that chose it.

Three rules are part of the decision rather than implementation detail:

- **The first supplied candidate wins, not the first usable one.** A value that is present but unusable is an invalid selection with its own finding; it never falls through. Empty and whitespace-only input counts as present.
- **Profiles are never merged.** The selected profile replaces the default; no run sees values contributed by two profiles.
- **Names are matched exactly and case-sensitively.** `Staging` and `staging` are different profiles.

Selection is a pure function of its three inputs, expressed in one module, with the precedence order exported as a value so the documented table and the code can be compared by a test.

## Consequences

**Easier**

- Every finding names the profile a run used and the source that chose it, so "which environment was that?" is answerable from a saved report.
- Because both the doctor and the preflight call one function, they cannot disagree about the selected environment.
- "Which value won?" is answerable without a debugger, because only one profile contributes.
- The precedence order exists in one place: changing it is one edit, and the documentation is asserted against the exported table rather than restated.
- The diagnostic can promise never to print a credential, because it never needs a resolved value to answer the question it asks.

**Harder**

- A stale or misspelled `QAT_ENV` in CI now fails where it was previously ignored and the default was silently used. Teams relying on that accident must correct the variable before upgrading, and the failure appears as a blocked run rather than a wrong one — which is the point, but it is still a migration.
- Empty-string invocations must be fixed at the call site. There is no configuration that makes `--env ""` mean "use the default", because allowing one would restore the failure mode.
- The origin has to be threaded through inspection, classification, evidence and guidance. That is more surface than a `selected?: string` field, and it is the cost of every message being able to say who chose.
- Projects that were accidentally depending on the default providing a variable now have to consolidate their profiles. Where the two happened to agree, nothing breaks; where they did not, the breakage is real and appears at run time.
- Case-sensitive matching surprises people arriving from tools that fold case. The error message names the problem, but the surprise is not eliminated.

**Neutral**

- The process-environment variable is still called `QAT_ENV`; no new variable is introduced.
- The profile schema is unchanged. Selection is a step before resolution, so existing configurations remain valid.
- A project with no environment profiles and no selection is unchanged in practice: it passes, because the documented defaults apply. Nothing needs to be configured in order to keep working.
- Names remain single tokens with a bounded character set. That was already true of profile names; it is now enforced at the point a selection enters the system.

## Options considered

| Option                                                                      | Why not                                                                                                                                                                                             |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fall through to the next candidate when a value is unusable                 | Hides a typo and changes the test target without saying so. A run against a different environment than the one requested is the worst outcome available here.                                       |
| Merge the selected profile with the default                                 | Produces state that cannot be reconstructed from the configuration, makes a failure dependent on two files, and reduces "which value won?" to a debugging exercise.                                 |
| Infer the environment from `NODE_ENV`                                       | A Node convention for build mode, not a stated deployment target. Frequently unset, often set to something like `production` inside CI regardless of which environment the tests target.            |
| Default to a well-known name such as `development` when nothing is selected | Asserts a fact about the project that nobody declared. A run that asks is better than a run that guesses wrong.                                                                                     |
| Return only the selected name, without its origin                           | Every downstream message loses the one detail that makes a report reproducible, and the origin cannot be recovered later without re-running the selection against a possibly different environment. |
| Expose the selection as a map of resolved values                            | Puts credentials in the diagnostic layer to answer a question about identity. The presence-only contract is what makes non-disclosure structural rather than a discipline.                          |

## References

- ADR-0030 — model an environment as a typed profile rather than a map of values: the reason secrets are references.
- ADR-0031 — resolve one approved override instead of merging configuration: the prior decision this extends from configuration to environment selection.
- ADR-0032 — skip a check whose precondition failed rather than reporting a misleading result: why the references check is skipped when the profile is unusable.
- ADR-0009 — prefer environment variables over configuration file values: why `QAT_ENV` outranks the committed default.
- `src/config/environment/select.ts` — the precedence table and the name rules.
- `docs/architecture/environment-diagnostics.md` — the precedence table, the inspection states and the no-values contract.
- POSIX environment variable naming rules, for the character set a name must satisfy to be passed to a child process faithfully.
