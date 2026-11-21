# ADR-0008: Do not evaluate the framework configuration during discovery

Date: 2026-11-21

## Status

Accepted

## Context

Discovery has to describe a project before anything runs in it: the root, the name, the framework,
the installation, and the paths a later command will read from and write to. Some of those answers
live inside `cypress.config.ts` or `cypress.config.js` — the spec pattern, the support file, the
screenshots and videos directories, the base URL, the environment variables.

That file is not data. It is a module Cypress imports and calls. It may be TypeScript, it may import
other files, it may read the environment, it may compute a spec pattern conditionally, and it may do
anything else a program does. The only way to learn what it resolves to is to run it — either
directly, or by asking Cypress, which already knows how.

Running a user's configuration during discovery has consequences that are easy to miss when the
config in front of you is three lines returning an empty object. It could start a server, open a
database connection, write files, or fail because an import is missing. In a directory that was
cloned from a remote repository and has not been reviewed, executing its code before deciding
whether it is a test project at all is a category of risk that a project whose purpose is trustworthy
automation should not take casually.

Parsing instead is not a way out. The resolution involves defaults merged with user values,
`defineConfig` semantics, conditional expressions and imported constants. Reimplementing that would
produce a second resolver that drifts from the real one, and whose failures are indistinguishable
from the tool's own.

There is a further constraint that settles it for this stage: discovery's job includes reporting that
the framework is _not installed_. That is precisely the situation in which a configuration cannot be
executed, because its dependencies are the thing that is missing. A design that requires running the
config cannot describe the project it most needs to describe.

Nothing consumes these paths in earnest yet. The first consumers will write reports and evidence into
the directories discovery reports, so the cost of an inaccurate path today is a file in the wrong
place rather than a corrupted one.

## Decision

We will not execute or parse the framework configuration during discovery.

Discovery uses the configuration file's **existence** — to identify the project root, to detect the
framework, and to detect ambiguity between two configuration files. It uses the file's **contents**
in no way at all.

Paths are reported from Cypress's documented conventional defaults, adjusted by which conventional
directories exist on disk: the first of `cypress/e2e`, `cypress/integration`, `cypress` that exists
becomes the spec directory; the first of the conventional support files that exists becomes the
support file; screenshots and videos directories are reported only when present.

When a consumer eventually needs a path it cannot derive — because the project customises its
configuration — the resolution is for that consumer to ask the framework for its resolved
configuration, through the adapter. Discovery does not grow the ability to evaluate files in order
to answer a question the framework can answer itself.

## Consequences

**Easier**

- Discovery is safe to run against any directory. It cannot execute code, start a process, open a
  connection, or fail because a configuration imports something that is not there.
- It works on a project whose dependencies are not installed, which is the case it most needs to
  report accurately.
- The result is deterministic in a strong sense: file presence only, with no dependence on an
  execution environment, an environment variable, or a module resolution outcome.
- It is fast. A handful of existence checks, with no TypeScript compilation and no process spawn.
- There is one configuration resolver in the project, and it is Cypress's, which is the only one
  that will stay correct as Cypress changes.
- Errors stay attributable. A broken configuration produces this tool's own actionable error rather
  than a stack trace from the user's file appearing before any of our logic has run.

**Harder**

- **A project that customises its configuration is described incorrectly.** A `specPattern` of
  `tests/**/*.cy.ts`, or a support file in a non-standard location, produces a context that names
  the wrong directory. Nothing in the type marks a path as approximate, so a reader — human or
  machine — will believe it.
- Every consumer has to tolerate being wrong about a path. Reporting writes to the conventional
  directory; for a customised project that is the wrong place, and the symptom is a report nobody
  finds rather than an error anybody sees.
- Two sources of path information will exist once the adapter can ask Cypress, and reconciling them
  is deferred work with no owner yet. Until then, a project's real paths are knowable but the context
  does not contain them.
- Anything derived from the configuration rather than from directory layout — the base URL, the
  environment variables, per-spec overrides — cannot be reported at all. A consumer needing those
  must go elsewhere.
- The candidate lists encode Cypress's own history: `cypress/e2e` is the modern convention and
  `cypress/integration` is the old one. Adding a second framework means adding another ordered list,
  and the ordering is a judgement rather than a rule.
- A project whose configuration lives somewhere other than its root is not discovered at all. That
  is a direct consequence of using existence for root detection, and it is a real limitation rather
  than a theoretical one.

**Neutral**

- The context is best-effort, and the only place that says so is documentation and this record. The
  type does not distinguish a path that is certainly right from one that is probably right, which is
  the sharpest criticism available of this decision.
- Ambiguity between two configuration files is detectable without reading either, so the case that
  most needs a clear answer gets one.
- The conventional default for the spec directory is reported even when no spec directory exists,
  because a project with an empty suite is still a project.

## Options considered

| Option                                                            | Why not                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Execute the configuration during discovery                        | Runs the user's code before deciding anything about it, including in directories that have not been reviewed. Inherits every failure mode of that code, and cannot work at all on the project whose dependencies are missing — which is the case discovery exists to report |
| Parse the configuration statically                                | Means reimplementing Cypress's resolution: defaults, `defineConfig`, imports, conditional patterns. A second implementation that drifts, and whose failures look like ours rather than like a configuration problem                                                         |
| Ask Cypress for its resolved configuration during discovery       | The correct eventual answer, and unavailable now: it requires a working installation, which is precisely what discovery is still trying to establish                                                                                                                        |
| Report conventional defaults, adjusted by which directories exist | Chosen. Gives up accuracy for customised projects and buys safety, determinism, and the ability to describe a project that cannot yet run                                                                                                                                   |
| Report no paths at all until the adapter can supply true ones     | Honest, and it pushes the same problem to every consumer, each of which would invent its own default. Several disagreeing defaults are worse than one that is documented as approximate                                                                                     |

## References

- `src/project/discovery.ts` — where the configuration's existence is read and its contents are not
- `docs/architecture/project-discovery.md` — the behaviour specification and the known limitation
- ADR-0006 — atomic writes, which turns a wrong output directory into a misplaced file rather than a corrupted one
- Cypress configuration documentation, for the defaults of `specPattern`, `supportFile`, `screenshotsFolder` and `videosFolder`
