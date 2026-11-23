# ADR-0017: Record dependency declaration separately from installation

Date: 2026-11-21

## Status

Accepted

## Context

Before running anything, QAT has to answer "can the framework run here?" Two places hold parts of the answer
and they are maintained by different processes.

`package.json` is written by a person or a package manager and committed. It says what the project intends to
use, and a reviewer sees it change. `node_modules/<package>/package.json` is produced by an install step and
ignored by version control. It says what is actually on the machine.

They disagree routinely, in both directions. A fresh clone has a manifest and no `node_modules`, so every
dependency is declared and none is installed. A workspace hoists its dependencies to a root the member project
does not own, so a package is installed and not declared locally. A package installed globally is present and
appears in no manifest at all. A dependency added and committed before the install was re-run is the first
case, and it is the one that catches people on a Monday morning.

The code being replaced could not tell these apart. It climbed `node_modules`, and when it found nothing it
raised one message: _Cypress is not installed for &lt;root&gt;_. That message is accurate for the hoisted case
and actively misleading for the declared-but-not-installed one, where the reader's next command is an install
they may already have run. The manifest was read, but only for the project name, the version and the package
manager; its dependency maps were never inspected, so the tool had the information and did not use it.

Two earlier decisions constrain how the answer can be obtained. Discovery does not evaluate the framework
configuration — see ADR-0008 — so it cannot ask Cypress about itself. And the project description is a value
handed to every later layer, so anything added to it is inherited by reporting, persistence and the CLI whether
or not they need it.

There is also a direction problem worth stating, because it determines what "installed" means. The install
search climbs to an ancestor, so a package can be installed without the project having installed it. That
provenance is already recorded, and it is not the same question as whether the project asked for the package.

No user has reported either confusion, because nothing has been released. The decision is taken as the code that
answers the question is written, which is the only point at which it costs nothing.

## Decision

We will record the manifest's declaration and the on-disk installation as two separate, optional facts, and
report them separately.

The project description carries a `frameworkDeclaration` — the dependency section and the version range exactly
as written — and continues to carry an `installation` with the version and where it was found. Neither is
derived from the other, and a missing declaration does not mean a missing installation or the reverse.

The declaration is searched for in a fixed order: `dependencies`, `devDependencies`, `optionalDependencies`,
`peerDependencies`. The first section containing the package is reported. Runtime dependencies lead because a
package declared in two sections is a manifest defect, and the runtime one describes how the project actually
uses it; the contradiction is left visible rather than adjudicated.

The range is carried unparsed. Nothing in the domain compares it with the installed version.

An installed package whose manifest declares no usable version is treated as not installed, because every
consumer either displays or compares that string and the type promises one.

The install search stops at the nearest copy it finds, even when that copy is unusable. Climbing past it would
report a version from a directory Node will never load.

Failures distinguish the two cases in their message, and both remain `QAT4002`: a declared but uninstalled
framework names the section it was declared in, and a framework that is neither declared nor installed says so.

## Consequences

**Easier**

- The failure names the actual problem. _Declared in `devDependencies` but not installed_ is one command away;
  _not declared and not installed_ usually means the wrong directory. One message for both helped neither.
- A diagnostic can print the two facts adjacent to each other, which is the only way a reader notices that a
  hoisted install has no declaration of its own.
- A test can construct "declared and not installed" and assert the message without faking a broken install, and
  can construct the reverse without writing a manifest at all.
- The manifest is read once, in one module, so two consumers cannot end up disagreeing about a dependency's
  declared range — the failure mode that made this worth doing rather than leaving each caller to look.
- The workspace case has a name. `source: 'workspace'` is part of the installation record, so "installed from
  somewhere above you" is a fact rather than an inference.

**Harder**

- **The range is carried unparsed, so the two facts can contradict each other and no type prevents it.** A
  project can declare `^13.0.0` and have `14.1.0` installed, and the project description will faithfully report
  both. Answering "is the installed version the one asked for" requires a range implementation, which the domain
  deliberately does not have — so the question is either unanswered or answered by whichever consumer takes the
  dependency first.
- **A broken local copy reports "not installed" while a working copy sits above it.** That mirrors Node, which
  would fail to load the broken one, and it is still going to be reported as a bug by someone who can see the
  working copy.
- Every consumer of the project description now sees an optional field most of them will ignore. The description
  grows with each question someone asks of a project, and there is no counter-pressure on it.
- Reading the manifest means parsing four dependency maps that most consumers never look at, on every
  discovery, for a fact that is consulted on one code path.
- Two message shapes mean anything that matches on message text — a CI script, a troubleshooting document — has
  to handle both. The code stayed the same, so the message carries all the distinguishing information, and the
  code cannot be used to branch on the situation.
- A manifest that exists but declares nothing is indistinguishable, in the result, from a manifest that does not
  exist: `frameworkDeclaration` is absent in both. Only `packageMetadata` separates them, and only because it
  happens to be present in one case.
- Reporting the runtime declaration when a package appears twice is a judgement with nothing behind it. A project
  that genuinely consumes the devDependency gets a declaration section it does not use, and no warning.

**Neutral**

- Exit codes are unchanged. Both cases are environment failures the reader can act on, so the distinction is
  information rather than a different classification — a caller that only reads the exit code sees no change.
- `DependencySection` is now a closed set the domain maintains. Adding a section is a deliberate act, which is
  the point, and it is also an edit in three files.
- The installation record carries an absolute path for diagnostics. It never reaches persistence; the project
  description it feeds contains no path at all.
- Workspace patterns are read for one message and not carried on the description, so nothing downstream can
  expand a glob it was given.

## Options considered

| Option                                                                          | Why not                                                                                                                                                                              |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| One merged availability answer, as before                                       | The simplest shape, and it cannot produce two messages. Every distinct situation collapses into one sentence, and the sentence is wrong for at least one of them                     |
| Two independent facts, reported separately                                      | Chosen. Costs a wider type and a second lookup, and buys a failure message that names the actual problem                                                                             |
| Read the manifest wherever the question is asked instead of carrying the answer | Puts the parse in every consumer, gives two modules the opportunity to disagree about the same file, and repeats the work on each call                                               |
| Ask the framework whether it is installed, by running it                        | Accurate, and it executes the user's program during discovery — the thing ADR-0008 refuses. It also cannot work in the case being reported, where the dependency is not there to run |
| Report every section a package appears in, rather than the first                | More faithful to a defective manifest, and it makes every consumer handle a list to answer a yes-or-no question. npm already warns about the duplicate                               |
| Treat an unusable installed copy as installed, with an unknown version          | Keeps "installed" true and pushes the problem into every consumer, which would each have to decide what to print for a version that is not a version                                 |

## References

- `docs/architecture/project-discovery.md` — the failure sequence, and the package-metadata section
- `src/project/package-discovery/` — the manifest reader, the declaration detector and the install search
- `src/core/domain/project.ts` — `FrameworkDeclaration`, `DependencySection`
- ADR-0008, which forbids evaluating the framework configuration and therefore rules out asking it
- npm documentation on dependency types, and on workspace hoisting
