# ADR-0033: Derive the supported Node.js range from the package engine declaration

Date: 2026-11-25

## Status

Accepted

## Context

QAT refuses to run on a Node.js version it has not been tested against. Until this record, the floor that refusal was
based on was a constant in the health-check guidance — `MINIMUM_NODE_MAJOR` — restated from the `engines.node` field of
the package manifest, because a module of pure functions cannot open a file. A unit test compared the two.

Three problems were observed with that arrangement.

It compared **majors**. `majorOf("20.11")` and `majorOf("20.11.0")` produced the same answer, and so did `21.0.0` and
`21.0.0-rc.1`. A policy that names a range admits 20.11.0 and refuses 20.10.9; a policy that names a major admits both,
and cannot express an excluded ceiling at all.

The message quoted a **number**, not a requirement. A reader told "QAT requires Node 24 or later" could not tell whether
that came from QAT, from their own manifest, or from a dependency's documentation — and could not check it against
anything they could open.

Every support change was a **two-place edit**: the manifest and the constant. The test that compared them could only
report that they agreed on the day it ran. It could not report that the sentence a user saw last week was now wrong.

Relevant constraints at the time of the decision:

- A check is a pure function of the evidence it is handed. Nothing in the catalogue reads a file, spawns a process or
  consults the clock; that is what makes every branch of a check reachable from a literal in a test.
- `engines.node` is already enforced by the package manager on install, and it travels with the published artefact.
  Whatever QAT declares there is what its users' package managers already believe.
- A project's framework may declare a Node.js requirement of its own, read from a third-party manifest written in npm's
  grammar, which is wider than any grammar QAT has implemented.
- A diagnostic that cannot measure something must not report it as either supported or unsupported. Both answers are
  inventions.

## Decision

We will derive the supported Node.js range from this package's own `engines.node` declaration. It is read once at the
composition boundary and passed to the check as evidence; nothing else in the program reads it, restates it, narrows it
or defaults it.

Because a range has to be parsed before it can be compared, that parsing is part of the decision: the comparison is a
pure function in `core/compatibility` that answers `satisfied`, `unsatisfied` or `indeterminate`, and a version or a
range that cannot be read is `indeterminate` — reported as a warning, never as a pass.

## Consequences

**Easier**

- Changing a supported runtime is one edit, in one file, with no second place to forget.
- A message can quote the declared range and say where it came from, so a reader can open the file that would have to
  change.
- The check is a pure function of evidence, so every boundary — inclusive floor, exclusive ceiling, a gap between
  alternatives, a pre-release, an unreadable version, an unreadable range — is reachable from a literal in a unit test.
- The range grammar can express an excluded ceiling, which a major comparison could not. The floor/ceiling pair is now
  testable at both edges rather than at one.
- A second consumer of the policy — a future preflight, a CI matrix check, a documentation generator — calls the same
  resolver instead of writing its own.

**Harder**

- The declaration must now be a complete `MAJOR.MINOR.PATCH` tuple on every bound. `>=20.11.0 <21` is a valid npm range
  and is refused here, because the ceiling's patch level would have to be invented. A manifest written that way produces
  "could not check" on every run instead of a verdict — a warning that is survivable and therefore easy to ignore.
- Nothing prevents a malformed declaration at build time. The guards are a contract test and the package verification
  script, which means somebody has to keep those wired, and a broken installation fails as advice rather than as an
  error.
- Reading the manifest from the module's own location depends on the build layout preserving `shared/utils/` — a
  flattening build resolves one level too high, and only the contract test would notice.
- The verdict vocabulary grew from two values to three. Every consumer must handle `indeterminate`, and a consumer that
  treats "not a failure" as success silently reintroduces the bug this record exists to prevent.
- A pre-release that used to pass — because its major matched the floor — now warns, because no comparator names it.
  That is the intended behaviour and it is still new noise for anyone developing on an RC.
- Contributors must distinguish a policy constant, which must be deleted, from a format fact such as
  `MINIMUM_CYPRESS_MAJOR`, which must be kept because nothing else declares it. The two look identical at a glance, and
  the wrong generalisation from this record deletes the second.

**Neutral**

- The requirement is now carried in the evidence group the checks read, so the check layer gained a fact it previously
  did not consume.
- A project-declared framework requirement is reported as a separate advisory check with its own identifier. Nothing
  gathers that fact yet, so the advisory passes by absence; it will start appearing when a gatherer reads the
  declaration.
- The shipped range is no longer visible in the source. It is visible in the manifest, which is a more public place.

## Options considered

| Option                                                                               | Why not                                                                                                                                                                      |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keep the constant, restated from the manifest, and keep the test that compares them  | Every support change stays a two-place edit, and the test can only prove the two numbers agreed on the day it ran — it cannot prove the sentence a user was shown is current |
| Generate the constant at build time from the manifest                                | An extra build step that can drift from the published artefact, and the generated value is fixed to the build rather than to the manifest that was installed                 |
| Add a `semver` dependency and call `satisfies`                                       | An unreadable range would throw inside a dependency rather than being reported as a finding, and the accepted grammar would be invisible to every reader of the code         |
| Allow an environment variable to override the declared range or the detected version | It would let CI assert compatibility it does not have, turning a safety check into a checkbox                                                                                |
| Report the framework's declared requirement inside the same finding as QAT's         | The two requirements have different owners and different remedies; a merged sentence names a problem without naming whose it is                                              |
| Keep comparing majors, but fix the message                                           | The comparison itself was the defect — it accepts an untested patch level and an untested pre-release, and cannot express a ceiling                                          |

## References

- [ADR-0014](0014-resolve-the-version-by-walking-up-to-the-nearest-package-man.md) — resolving the nearest package
  manifest, which this record depends on and extends from a version string to the engine policy
- [ADR-0019](0019-register-diagnostics-in-a-catalogue.md) — the catalogue pattern the range's findings are registered in
- [ADR-0032](0032-skip-a-check-whose-precondition-failed-rather-than-reporting.md) — why an unanswerable question is
  reported rather than counted as a pass
- [runtime-compatibility.md](../runtime-compatibility.md) — the normative description of the grammar, the three outcomes
  and the reporting rules
- [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html) — precedence, pre-release ordering and the meaning of
  a version tuple
- `package.json` → `engines.node`, the declaration this record makes authoritative
