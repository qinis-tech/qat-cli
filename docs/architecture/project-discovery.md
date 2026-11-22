# Project Discovery

How QAT decides which project a command is working on, and what it then knows about it.

Discovery answers two questions in order: **which directory**, and then **what is in it**. The first is
resolved in one place before the second begins, so that every command asks about the same directory.

## What a project root is

A directory is a project root when it contains **either** a `package.json` **or** a Cypress configuration
file. Nothing else qualifies — not a directory named `cypress`, not a lockfile alone.

The two markers are deliberately loose, because a Cypress project does not require a `package.json` and a
npm workspace does not require a framework configuration. Requiring both would reject valid projects;
requiring neither would accept almost anything.

## Resolving the working directory

Three inputs can name the directory, in this order:

| Order | Source                                   | Behaviour                                                                         |
| ----- | ---------------------------------------- | --------------------------------------------------------------------------------- |
| 1     | Directory named as a positional argument | `qat doctor ./packages/api`. Resolved against the process directory when relative |
| 2     | Working-directory option                 | `--cwd ./packages/api`. Used when no argument was given                           |
| 3     | Process working directory                | Used when neither was given                                                       |
| 4     | Parent traversal                         | **Off by default**, and performed only by discovery — never by the resolver       |

**An argument beats the option.** `--cwd` means "behave as though started here", and a directory named for
a specific command is the more specific instruction. The consequence is that `qat doctor ./a --cwd ./b`
describes `./a`. See
[ADR-0016](../architecture/adr/0016-prefer-the-positional-directory-over-the-working-directory-option.md).

The resolution lives in `src/project/working-directory.ts` and is reached through
`ProjectDiscovery.resolveWorkingDirectory`, so no command re-implements it. It returns two things:

| Field       | Meaning                                                                       |
| ----------- | ----------------------------------------------------------------------------- |
| `directory` | An absolute, normalised path. Resolved once; nothing downstream re-derives it |
| `source`    | Which of the three inputs won                                                 |

The source is carried because three inputs can produce the same failure and they have three different
fixes. `The directory named by --cwd (/tmp/x) is not a directory.` sends the reader to the right place;
`not a directory` does not.

Validation happens **before** discovery is called:

- The directory must exist and be a directory, or the command fails with `QAT1001`.
- An empty or whitespace-only value is rejected rather than treated as absent. An explicit empty value is
  a mistake, not an instruction to use the default.
- A value containing a null byte is rejected.

`.` and `..` resolve against the process directory, like any other relative value. Discovery keeps its
own existence check as well, because it is a public function and defence in depth costs one comparison.

## Parent traversal

With traversal off, the starting directory must itself be a project root. It is not walked up to "find
something useful": a command run in the wrong place should say so rather than silently report a project
three levels above.

When requested, it ascends up to `maxParentDepth` (8) and stops at the first directory containing a
project marker, or at the filesystem root.

The bound exists because a mistaken start directory should not wander into an unrelated project. It is a
number somebody chose, and a layout deeper than it fails in a way that looks like a missing installation —
so if that ever happens, the fix is a better message rather than a larger number.

## Ambiguity

More than one Cypress configuration in one directory is reported as `QAT2004`, not resolved by precedence.
There is no defensible ordering between `cypress.config.ts` and `cypress.config.js` — the presence of both
means a migration was left unfinished, and picking one would hide that.

Ambiguity is checked before absence, because a project with two configurations is a different mistake from
one with none.

## Missing pieces

| Situation                                   | Code      | Produced by                    | Why it is a distinct failure                                    |
| ------------------------------------------- | --------- | ------------------------------ | --------------------------------------------------------------- |
| Directory does not exist, or is a file      | `QAT1001` | The working-directory resolver | A bad input, known before anything about projects is considered |
| No project markers anywhere searched        | `QAT2001` | Discovery                      | The command is in the wrong place                               |
| Markers present, no framework configuration | `QAT2002` | Discovery                      | This is a project, but not a test project QAT can run           |
| Two configurations                          | `QAT2004` | Discovery                      | Unfinished migration                                            |
| Configured but not installed                | `QAT4002` | Discovery                      | One install command away; the reader can fix it                 |

The first row is the reason resolution happens first: an invalid directory never reaches detection, so the
failure is a bad-argument message rather than a misleading "no project found".

The last two are the ones most often conflated, and conflating them produces the worst message: telling
someone to install something when the real problem is that they deleted the wrong file, or the reverse.

## Monorepos

An installation is looked for at the project root first, then **up the tree**, independently of whether
parent search was requested. A workspace that hoists dependencies to its root is the normal case, and
refusing to look would report a present dependency as missing.

The result records where it was found — `project` or `workspace` — because a run against a hoisted install
is pinned by a lockfile the project does not own, and that is worth knowing when a version surprises
someone.

Neither package discovery nor per-package configuration is modelled. A monorepo root often has neither a
framework configuration nor a single test suite; discovery is expected to be run from the package
directory.

## What discovery does not read

**The framework configuration is not executed or parsed.** A Cypress configuration is code. Running it
during discovery would mean executing the user's program before deciding anything about it, and parsing it
would mean reimplementing the configuration semantics of a tool that already has them.

Paths are therefore Cypress's conventional defaults, adjusted by which conventional directories exist:

| Path                                      | Source                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------- |
| `configFile`                              | The configuration file that was found                                     |
| `specsDirectory`                          | First of `cypress/e2e`, `cypress/integration`, `cypress` that exists      |
| `supportFile`                             | First of `cypress/support/e2e.ts`, `.js`, `cypress/support/index.{ts,js}` |
| `screenshotsDirectory`, `videosDirectory` | Present only when the conventional directory exists                       |
| `sourceDirectory`                         | First of `src`, `lib`, `app` that exists; absent otherwise                |

A project that overrides `specPattern` or `supportFile` in its configuration will be described
incorrectly. This is a known limitation, recorded in the decision record, and the trigger to revisit is the
adapter needing a path it cannot derive.

## Determinism

Every lookup checks an ordered list of candidate names against the filesystem. No directory is listed, so
the answer cannot depend on iteration order; no timestamp is recorded, so two discoveries of the same tree
produce deeply equal values.

The context carries no version and no discovery time. It is constructed fresh per invocation and never
persisted, so a version would describe nothing and a timestamp would make identical contexts unequal —
turning every assertion about a context into a test of a clock.

The working directory is resolved once per command, from three inputs that are all explicit, and passed to
discovery as an absolute path. Two commands run from the same place with the same arguments resolve the
same directory, which is what makes the precedence table worth writing down.

## No global state

There is no cached context and no module-level variable. A caller that needs the project asks for it once
and passes the value on. This is what allows two discoveries to run concurrently without interfering, and
what stops a command's behaviour depending on what ran before it in the same process.

The resolver takes the process directory as a parameter rather than reading it internally, for the same
reason: a test supplies the input it wants to exercise instead of changing the process to arrange it.

## Extending discovery

Adding a framework means adding its configuration filenames to `CYPRESS_CONFIG_FILES`' sibling, a branch in
the framework check, and a row in the ambiguity rule. Adding a package manager means one entry in
`LOCKFILES` and one member in the domain's `PackageManager` set.

Adding a way to _name_ a directory — a configuration-file pointer, say — means one more candidate in
`WorkingDirectoryCandidates`, one more member in `WorkingDirectorySource`, and one more row in the
precedence table. It does not touch discovery, which receives a directory and never asks where it came from.

All of these are additive: no existing candidate list changes order, so no existing project is described
differently by the addition.
