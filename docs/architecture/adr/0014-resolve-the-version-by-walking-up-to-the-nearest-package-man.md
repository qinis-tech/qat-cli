# ADR-0014: Resolve the version by walking up to the nearest package manifest

Date: 2026-11-21

## Status

Accepted

## Context

The CLI has to report its own version, and that number is not decorative: it appears in bug reports, in
support threads and in decisions about whether an upgrade is needed. A wrong version is worse than a
missing feature, because it makes every other piece of evidence suspect.

The version lives in exactly one place — `package.json`. Lockfiles, changelogs and git tags are derived
from it or describe it; none of them is the source.

The compiled binary runs in four situations that all have to agree: under a TypeScript runner from
`src/cli/index.ts`, from `dist/cli/index.js` after a build, from a linked local install, and from
`node_modules/qat-cli/dist/cli/index.js` once installed as a dependency.

The obvious implementation is a relative URL two levels up from the module. It works, and that is the
problem: it works because `dist/cli` and `src/cli` are both exactly two levels below the directory
holding the manifest. Correctness is a coincidence of depth. Change `outDir`, nest `rootDir`, let a
bundler relocate a chunk, or add a build that emits `dist/src/cli/`, and the path points at a directory
with no manifest in it. None of that is a compile error. The build succeeds, the package publishes, and
the failure arrives the first time a user runs `qat --version` on an installed copy.

The project has already been taught this lesson once. An incremental build record that survived the
clean step meant the compiler emitted nothing and exited zero; fifteen end-to-end tests failed because
the binary could not start. The lesson taken from that was that "it built" is not a claim about the
artefact. This record applies the same reasoning to a runtime path: "the path resolved during
development" is not a claim about the installed package.

Three constraints shaped the answer. The CLI bootstrap may not import the project's implementation
layers, so the existing filesystem module with its JSON reading and error translation is unavailable
here. `package.json` must remain the single source, which rules out anything that keeps a copy. And
resolution has to happen before the program is built, because the version is program metadata.

Nobody has hit a wrong version yet, because nothing has been released. The decision is made at the moment
the file would be written, which is the only point at which it costs nothing.

## Decision

We will resolve the version by walking upward from the module's own directory and taking the first
`package.json` we find, bounded at six levels.

The walk starts at `dirname(fileURLToPath(import.meta.url))` — where the code is, not where the process
was started — so the working directory cannot affect the answer.

The nearest manifest wins, and a damaged one is an error rather than a reason to keep climbing. Climbing
past it would report a parent package's version, which is real, well-formed and about the wrong thing.

The filesystem is read directly with `node:fs/promises` rather than through `core/filesystem`, because
the boundary rules forbid importing an implementation into the CLI and because this code runs before
anything else about the environment is known.

A manifest that is absent, unparseable, or declares no usable version produces `QAT4003` and exit code
`3`. The tool fails rather than reporting a placeholder.

## Consequences

**Easier**

- The resolution is correct at any depth inside the package, so a change to the output layout cannot
  break it. That was the entire point, and it is the one property that survives every packaging scenario
  the project intends to support.
- The manifest remains the single source. There is no generated file to regenerate, no constant to
  remember to bump, and no second value that can disagree with the first.
- All four execution situations work through the same code path, so there is no build-time step whose
  ordering matters — which is a real gain in a project that has already lost a build to exactly that.
- A wrong version becomes impossible rather than merely unlikely, because there is no copy to drift.
- When the metadata cannot be read, the failure is a code, a sentence and a remedy, rather than a
  plausible number.

**Harder**

- **Every invocation pays a filesystem read, including `--help`.** A permission problem or a corrupt file
  at that path stops the CLI before it does anything, so a damaged installation now makes `--help` fail
  as well as `--version`. That is a wider blast radius than a compiled-in constant would have had, and
  it is a deliberate widening.
- **Behaviour now depends on which manifest is nearest.** The same binary copied somewhere without its
  manifest changes from printing a version to failing. That is usually the right answer and it is a
  surprise the first time someone moves `dist/` on its own.
- **Six is a number somebody chose.** A layout deeper than six would fail, and the failure would look
  exactly like a missing installation rather than like a limit being hit.
- **The rule about damaged manifests is a judgement.** Failing is defensible; so is climbing past it to
  find something usable. A reader who expects the second will find the code doing the opposite, and the
  test asserts the first.
- **Reading `node:fs` inside `src/cli` is an exception to a boundary rule.** Exceptions are how boundary
  rules stop being believed, and the next person who wants one will cite this file.
- **The resolver cannot tell "our package" from "whatever package happens to be above us".** It assumes
  the CLI lives inside its own package, which is true for every supported installation and false for any
  bundler that inlines this code into a host project.

**Neutral**

- The version is a runtime string rather than a compile-time constant, so it cannot be inlined. Nothing
  measurable is lost.
- The resolution result carries the manifest path. It is used only in diagnostics, and "which manifest?"
  is the first question anyone asks about a wrong version.
- Whether a missing version should fail or fall back is recorded here as behaviour rather than as its own
  decision. It is arguably separable, and if it is ever disputed it should become a record of its own
  rather than an amendment to this one.

## Options considered

| Option                                                             | Why not                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A relative URL two levels up from the module                       | Correct for the current layout and for nothing else. The link between depth and correctness is invisible at the call site, and the failure appears in an installed package rather than in a test                                                             |
| Generate a version module at build time and commit it              | Removes runtime resolution entirely. Adds a generated file that must exist for type checking on a fresh clone, a build step whose ordering matters, and a copy that drifts unless a test compares it — a second mechanism to do what one source already does |
| Resolve through the module system, using the package's own name    | Genuinely layout-independent. Requires an `exports` map that a CLI does not otherwise need, and it fails in development where the package is not installed under its own name                                                                                |
| Walk upward from the module's directory, bounded                   | Chosen. Layout-independent, single source, no build step, and the failure mode is a message rather than a wrong number                                                                                                                                       |
| Read the version from an environment variable set during the build | Moves the answer to the one place it cannot be verified: a released artefact would depend on how it was built rather than on what it contains                                                                                                                |

## References

- `src/cli/version.ts` — the resolver
- `docs/development/cli-bootstrap.md` §11 — the behaviour, including the unparseable-manifest case that Node intercepts first
- `src/core/errors/codes.ts` — `QAT4003` `installationIncomplete`
- ADR-0011, for why this code lives in the CLI bootstrap rather than in the assembly
