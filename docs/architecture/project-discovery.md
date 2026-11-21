# Project Discovery

How QAT decides which project a command is working on, and what it then knows about it.

## What a project root is

A directory is a project root when it contains **either** a `package.json` **or** a Cypress
configuration file. Nothing else qualifies — not a directory named `cypress`, not a lockfile alone.

The two markers are deliberately loose, because a Cypress project does not require a `package.json`
and a npm workspace does not require a framework configuration. Requiring both would reject valid
projects; requiring neither would accept almost anything.

## Precedence

| Order | Source             | Behaviour                                                                                                                                               |
| ----- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Explicit directory | Used as the starting point. A relative value resolves against the working directory. Must exist and be a directory, or the command fails with `QAT1001` |
| 2     | Working directory  | Used when nothing explicit was given                                                                                                                    |
| 3     | Parent traversal   | **Off by default.** Ascends up to `maxParentDepth` (8) only when explicitly requested                                                                   |

With parent traversal off, the starting directory must itself be a project root. It is not walked up
to "find something useful": a command run in the wrong place should say so rather than silently
report a project three levels above.

## Ambiguity

More than one Cypress configuration in one directory is reported as `QAT2004`, not resolved by
precedence. There is no defensible ordering between `cypress.config.ts` and `cypress.config.js` —
the presence of both means a migration was left unfinished, and picking one would hide that.

Ambiguity is checked before absence, because a project with two configurations is a different
mistake from one with none.

## Missing pieces

| Situation                                   | Code      | Why it is a distinct failure                                       |
| ------------------------------------------- | --------- | ------------------------------------------------------------------ |
| Directory does not exist                    | `QAT1001` | A bad argument, known before anything about projects is considered |
| No project markers anywhere searched        | `QAT2001` | The command is in the wrong place                                  |
| Markers present, no framework configuration | `QAT2002` | This is a project, but not a test project QAT can run              |
| Two configurations                          | `QAT2004` | Unfinished migration                                               |
| Configured but not installed                | `QAT4002` | One install command away; the reader can fix it                    |

The last two of those are the ones most often conflated, and conflating them produces the worst
message: telling someone to install something when the real problem is that they deleted the wrong
file, or the reverse.

## Monorepos

An installation is looked for at the project root first, then **up the tree**, independently of
whether parent search was requested. A workspace that hoists dependencies to its root is the normal
case, and refusing to look would report a present dependency as missing.

The result records where it was found — `project` or `workspace` — because a run against a hoisted
install is pinned by a lockfile the project does not own, and that is worth knowing when a version
surprises someone.

Neither package discovery nor per-package configuration is modelled. A monorepo root often has
neither a framework configuration nor a single test suite; discovery is expected to be run from the
package directory.

## What discovery does not read

**The framework configuration is not executed or parsed.** A Cypress configuration is code. Running
it during discovery would mean executing the user's program before deciding anything about it, and
parsing it would mean reimplementing the configuration semantics of a tool that already has them.

Paths are therefore Cypress's conventional defaults, adjusted by which conventional directories
exist:

| Path                                      | Source                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------- |
| `configFile`                              | The configuration file that was found                                     |
| `specsDirectory`                          | First of `cypress/e2e`, `cypress/integration`, `cypress` that exists      |
| `supportFile`                             | First of `cypress/support/e2e.ts`, `.js`, `cypress/support/index.{ts,js}` |
| `screenshotsDirectory`, `videosDirectory` | Present only when the conventional directory exists                       |
| `sourceDirectory`                         | First of `src`, `lib`, `app` that exists; absent otherwise                |

A project that overrides `specPattern` or `supportFile` in its configuration will be described
incorrectly. This is a known limitation, recorded in the decision record, and the trigger to revisit
is the adapter needing a path it cannot derive.

## Determinism

Every lookup checks an ordered list of candidate names against the filesystem. No directory is
listed, so the answer cannot depend on iteration order; no timestamp is recorded, so two discoveries
of the same tree produce deeply equal values.

The context carries no version and no discovery time. It is constructed fresh per invocation and
never persisted, so a version would describe nothing and a timestamp would make identical contexts
unequal — turning every assertion about a context into a test of a clock.

## No global state

There is no cached context and no module-level variable. A caller that needs the project asks for it
once and passes the value on. This is what allows two discoveries to run concurrently without
interfering, and what stops a command's behaviour depending on what ran before it in the same
process.

## Extending discovery

Adding a framework means adding its configuration filenames to `CYPRESS_CONFIG_FILES`' sibling, a
branch in the framework check, and a row in the ambiguity rule. Adding a package manager means one
entry in `LOCKFILES` and one member in the domain's `PackageManager` set.

Both are additive: no existing candidate list changes order, so no existing project is described
differently by the addition.
