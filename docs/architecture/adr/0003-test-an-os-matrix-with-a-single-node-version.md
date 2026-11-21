# ADR-0003: Test an OS matrix with a single Node version

Date: 2026-11-21

## Status

Accepted

## Context

The project claims support for Linux and Windows, and declares
`engines.node: ">=24.0.0"` — an open-ended range with no upper bound.

The code spawns child processes, resolves filesystem paths, writes files and
parses their output. Those are the operations where operating systems actually
diverge: separator conventions, path casing, executable resolution, line endings,
and the shape of process exit information.

CI runner minutes are finite, and every matrix entry added to a pull request
multiplies the wait before a contributor learns whether their change is
acceptable.

Two axes are therefore available: operating system and Node.js version. They are
not equally likely to hide a defect.

## Decision

CI tests on two operating systems — Ubuntu and Windows — and one Node.js version,
the latest patch of 24.x.

The OS axis is kept because cross-platform behaviour is the plausible failure mode
for a tool that manipulates paths and child processes. The Node axis is dropped
because a compatibility defect specific to a later Node version has not been
observed, has not been reported, and would consume the same runner minutes as the
axis that is actually expected to fail.

Revisit conditions, any one of which justifies adding an entry:

- A consumer reports a failure attributable to a specific Node version.
- The `engines` range gains an upper bound, which makes a second version a claim
  rather than a guess.
- The project adopts a language feature or API with a narrow version window.

Coverage is collected on Linux only. Coverage is a property of the source, not of
the operating system; collecting it twice yields two slightly different numbers
and an artifact nobody opens.

## Consequences

**Easier**

- Path, separator and child-process defects are caught before merge rather than by
  the first Windows user.
- The matrix stays small enough that a pull request finishes quickly, which keeps
  people willing to wait for it rather than merging around it.
- Runner cost scales with one dimension instead of two.
- The revisit conditions are written down, so the decision can be challenged with
  evidence rather than opinion.

**Harder**

- A defect specific to a Node version other than 24.x will not be caught here. The
  `engines` declaration is therefore only partly verified, and that gap is real
  rather than theoretical.
- Windows runners are slower and fail more often for environmental reasons, so
  some red builds will be infrastructure rather than code. Each one spends trust
  in the signal.
- Running the latest 24.x patch rather than 24.0.0 means the literal `engines`
  floor is not tested. A contributor using an API introduced in a 24.x minor would
  break the promise without CI noticing.
- Reconciling coverage with a single-OS authority means a Windows-specific branch
  could reduce real coverage while the Linux number stays unchanged.

**Neutral**

- `fail-fast` is disabled for the matrix, so both platforms always report. This
  costs a small number of runner minutes and buys a complete picture of which
  platforms are affected.
- The matrix is expressed in one place, so adding a version later is a one-line
  change plus a review of this record.

## Options considered

| Option                                              | Why not                                                                                                                                                                                |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Single operating system (Ubuntu)                    | Cheapest. But it hides path, separator and child-process defects, which are precisely the class of bug this project is most likely to produce. The savings would be paid for by users. |
| Two operating systems, two Node versions            | Four jobs per pull request. Most combinations verify nothing distinct, and the quadrupled wait makes merging around CI more likely than reading its output.                            |
| Node version matrix, single operating system        | Inverts the priorities: verifies the axis with no observed defects and ignores the axis where defects are expected.                                                                    |
| Pin Node 24.0.0 to test the literal `engines` floor | Tests a patch release from the floor that almost no user runs. Latest 24.x is the realistic target; the floor gap is recorded as a known cost above.                                   |
| Latest Node only (whatever `lts/*` resolves to)     | Makes the tested version drift with the runner image, so a CI failure could be caused by an image update rather than a code change. A pinned major is reproducible.                    |

## References

- `docs/development/continuous-integration.md`, "Node.js version policy"
- `.github/workflows/ci.yml`
- `package.json`, the `engines` field
