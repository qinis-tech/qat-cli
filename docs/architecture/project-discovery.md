# Project Discovery

How QAT decides which project a command is working on, and what it then knows about it.

Discovery answers two questions in order: **which directory**, and then **what is in it**. The first is
resolved in one place before the second begins, so that every command asks about the same directory and no two
commands can disagree about which project they are describing.

## What a project root is

A directory is a project root when it contains **either** a `package.json` **or** a Cypress configuration file.
Nothing else qualifies — not a directory named `cypress`, not a lockfile alone.

The two markers are deliberately loose, because a Cypress project does not require a `package.json` and an npm
workspace does not require a framework configuration. Requiring both would reject valid projects; requiring
neither would accept almost anything.

Existence decides, never content. A `package.json` that fails to parse is still a marker, and reporting it as
"not a project" would send the reader looking for the wrong problem — the parse happens later, where it can
produce a message about JSON.

## Resolving the working directory

Three inputs can name the directory, in this order:

| Order | Source                                   | Behaviour                                                                         |
| ----- | ---------------------------------------- | --------------------------------------------------------------------------------- |
| 1     | Directory named as a positional argument | `qat doctor ./packages/api`. Resolved against the process directory when relative |
| 2     | Working-directory option                 | `--cwd ./packages/api`. Used when no argument was given                           |
| 3     | Process working directory                | Used when neither was given                                                       |
| 4     | Parent traversal                         | **Off by default**, and performed only by discovery — never by the resolver       |

**An argument beats the option.** `--cwd` means "behave as though started here", and a directory named for a
specific command is the more specific instruction. The consequence is that `qat doctor ./a --cwd ./b` describes
`./a`. See
[ADR-0016](adr/0016-prefer-the-positional-directory-over-the-working-directory-option.md).

The option is a **fallback, not a base**. When an argument is present the option is ignored entirely, including
as a place to resolve a relative argument from — `qat doctor ./x --cwd /repo` resolves `./x` against the process
directory. That follows from one input replacing another rather than the two interacting, and it is recorded
because it is the part most likely to surprise someone.

The resolution lives in `src/project/working-directory.ts` and is reached through
`ProjectDiscovery.resolveWorkingDirectory`, so no command re-implements it. It returns two things:

| Field       | Meaning                                                                       |
| ----------- | ----------------------------------------------------------------------------- |
| `directory` | An absolute, normalised path. Resolved once; nothing downstream re-derives it |
| `source`    | Which of the three inputs won                                                 |

The source is carried because three inputs can produce the same failure and they have three different fixes.
`The directory named by --cwd (/tmp/x) is not a directory.` sends the reader to the right place; `not a
directory` does not.

Validation happens **before** discovery is called:

- The directory must exist and be a directory, or the command fails with `QAT1001`.
- An empty or whitespace-only value is rejected rather than treated as absent. An explicit empty value is a
  mistake, not an instruction to use the default.
- A value containing a null byte is rejected.

`.` and `..` resolve against the process directory, like any other relative value. Discovery keeps its own
existence check as well, because it is a public function and defence in depth costs one comparison.

## Parent traversal

With traversal off, the starting directory must itself be a project root. It is not walked up to "find something
useful": a command run in the wrong place should say so rather than silently report a project three levels above.

When requested, it ascends up to `maxParentDepth` (8) and stops at the first directory containing a project
marker, or at the filesystem root.

The bound exists because a mistaken start directory should not wander into an unrelated project. It is a number
somebody chose, and a layout deeper than it fails in a way that looks like a missing installation — so if that
ever happens, the fix is a better message rather than a larger number.

## Failures, in the order they are reported

| Order | Situation                                             | Code      | Produced by                                                |
| ----- | ----------------------------------------------------- | --------- | ---------------------------------------------------------- |
| 1     | The named directory does not exist, or is a file      | `QAT1001` | The working-directory resolver, before discovery is called |
| 2     | No project markers at or above the starting directory | `QAT2001` | Discovery, first check                                     |
| 3     | A manifest exists and does not parse                  | `QAT5004` | The manifest read, immediately after the root is found     |
| 4     | Two framework configurations in one directory         | `QAT2004` | Discovery, before absence                                  |
| 5     | No framework configuration at the root                | `QAT2002` | Discovery                                                  |
| 6     | A framework is configured but not installed           | `QAT4002` | Discovery, after the manifest and the install search       |

The order is deliberate, and it decides what a directory that is wrong in two ways reports.

**Resolution first.** An invalid directory never reaches detection, so the failure is a bad-argument message
rather than a misleading "no project found".

**The manifest before the configuration.** A manifest that will not parse makes the project undescribable, and
telling the reader to create a configuration file first would only postpone the real error by one round trip.

**Ambiguity before absence.** A project with two configurations is a different mistake from one with none, and
only the first is about to get worse if it is ignored. There is no defensible ordering between
`cypress.config.ts` and `cypress.config.js` — the presence of both means a migration was left unfinished, and
picking one would hide that.

**The last row is the one most often conflated with absence.** A framework that is configured but missing has an
obvious remedy; a project that is not what the reader thought has a different one. Conflating them produces the
worst message of the set: telling someone to install something when the real problem is that they are in the
wrong repository.

## Package metadata

The manifest is read once, by `src/project/package-discovery/`, and never by a consumer. It is untrusted input
— written by hand, edited by tooling, occasionally generated — so every field is narrowed from `unknown` and a
field of the wrong type is treated as absent rather than propagated. A non-string dependency version is dropped,
which reports the package as undeclared; that is what a reader would conclude from a broken entry anyway.

Two lookups happen there, and **they are independent**:

| Fact         | Where it comes from                                              | Absent means                                    |
| ------------ | ---------------------------------------------------------------- | ----------------------------------------------- |
| Declaration  | The manifest's dependency maps                                   | The project does not claim to use the framework |
| Installation | `node_modules/<package>/package.json`, at the root then above it | The package is not on disk                      |

Neither implies the other. A package can be declared and uninstalled, installed and undeclared — hoisted from a
workspace, or installed globally — or both absent. The three produce different messages because they have
different fixes: _declared in `devDependencies` but not installed_ is one command, while _not declared and not
installed_ usually means the wrong directory. Both are recorded on the project description separately, so a
diagnostic can show them next to each other. See
[ADR-0017](adr/0017-record-dependency-declaration-separately-from-installation.md).

**A missing manifest is not an error.** A project of a configuration file and specs, with the framework
installed globally or hoisted from above, is legal; the directory name becomes the project name. `qat doctor`
says so explicitly rather than printing nothing, because a line that disappears makes "no metadata"
indistinguishable from "not reported".

**A manifest that exists and does not parse is an error**, `QAT5004`, and it is reported before the framework
configuration is looked for.

**A duplicate declaration is not resolved.** A package appearing in both `dependencies` and `devDependencies` is
a defect in the manifest. The declaration is searched for in a fixed order — runtime, development, optional,
peer — and the runtime one is reported, because it describes how the project uses the package. npm already warns
about the duplicate; adjudicating it here would be a second opinion nobody asked for.

**A declared manager beats a lockfile.** A lockfile left behind after a migration implies a tool the project no
longer uses, and remediation built on it would name the wrong command. The result records which it was, so a
reader can discount an inference.

## Workspaces

Two things are supported and one is refused.

**Supported:** a workspace member is an ordinary project. Its dependency installed at the workspace root is
found and recorded with `source: 'workspace'`. That covers the monorepo case that actually occurs — running a
command inside a package. The install search climbs independently of whether parent traversal was requested,
because hoisting is the ordinary case rather than an anomaly.

**Supported:** a workspace root that also has a framework configuration is treated as a single project, with no
special handling. The common single-package-shaped workspace needs nothing else.

**Refused:** expanding the declared patterns. `workspaces` is read — in both legal shapes, a bare array and an
object with `packages` — and never turned into a list of directories. Expanding it means listing directories and
matching globs, which is the recursive discovery this module avoids: a command run at a workspace root would
start choosing a package on the reader's behalf.

So a workspace root with no configuration is **not** a project. When one is passed, the failure names the
declared patterns and says to run from the package directory, which is a one-line fix rather than a search that
guessed wrong.

The trigger to revisit is a command that legitimately operates on a whole workspace. That needs a documented
selection rule, not a fallback.

## What discovery does not evaluate

**The framework configuration is not executed or parsed.** A Cypress configuration is code. Running it during
discovery would mean executing the user's program before deciding anything about it, and parsing it would mean
reimplementing the configuration semantics of a tool that already has them. See
[ADR-0008](adr/0008-do-not-evaluate-the-framework-configuration.md).

The manifest, by contrast, **is** read in full. The distinction is not "files versus no files" but **data versus
program**: `package.json` is a document that describes the project, and `cypress.config.ts` is a program that
configures a tool. One can be read, the other can only be run.

Paths are therefore Cypress's conventional defaults, adjusted by which conventional directories exist:

| Path                                      | Source                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------- |
| `configFile`                              | The configuration file that was found                                     |
| `specsDirectory`                          | First of `cypress/e2e`, `cypress/integration`, `cypress` that exists      |
| `supportFile`                             | First of `cypress/support/e2e.ts`, `.js`, `cypress/support/index.{ts,js}` |
| `screenshotsDirectory`, `videosDirectory` | Present only when the conventional directory exists                       |
| `sourceDirectory`                         | First of `src`, `lib`, `app` that exists; absent otherwise                |

A project that overrides `specPattern` or `supportFile` in its configuration will be described incorrectly.
This is a known limitation, recorded in the decision record, and the trigger to revisit is the adapter needing a
path it cannot derive.

## Determinism

Every lookup checks an ordered list of candidate names against the filesystem. No directory is listed, so the
answer cannot depend on iteration order: configuration filenames, spec directories, support files, source roots,
lockfiles and `node_modules/<package>/package.json` at each ancestor are all fixed sequences of `isFile` calls.

The manifest's own shape cannot affect the result either. Dependency maps are read into a fixed record of four
sections, so the order the keys happen to appear in the file is irrelevant, and a declaration is found by
searching that record in a fixed order rather than by iterating it.

The context carries no version and no discovery time. It is constructed fresh per invocation and never persisted,
so a version would describe nothing and a timestamp would make identical contexts unequal — turning every
assertion about a context into a test of a clock.

The working directory is resolved once per command, from three inputs that are all explicit, and passed to
discovery as an absolute path. Two commands run from the same place with the same arguments resolve the same
directory, which is what makes the precedence table worth writing down.

## No global state

There is no cached context and no module-level variable, in discovery or in package metadata. A caller that needs
the project asks for it once and passes the value on. This is what allows two discoveries to run concurrently
without interfering, and what stops a command's behaviour depending on what ran before it in the same process.

The resolver takes the process directory as a parameter rather than reading it internally, for the same reason: a
test supplies the input it wants to exercise instead of changing the process to arrange it.

## Extending discovery

**Adding a framework** means its configuration filenames beside `CYPRESS_CONFIG_FILES`, a branch in the
framework check, a row in the ambiguity rule, and the npm package name to search for — passed to package
discovery explicitly rather than derived from the framework identifier, because the two only coincide today.

**Adding a package manager** means one entry in the `LOCKFILES` table in `src/project/package-discovery/manifest.ts`,
where the manager is typed against `PackageManager` so a wrong entry is a compile error, plus one member in the
domain's `PackageManager` set.

**Adding a dependency section** touches three places, and it is worth knowing that they are three: a member of
the domain's `DependencySection`, a row in the search order in `dependencies.ts`, and a line reading it in
`manifest.ts`. The compiler catches the first two — a `Record` over the section union and an exhaustive read —
so only the search order is a judgement.

**Adding a way to name a directory** — a configuration-file pointer, say — means one more candidate in
`WorkingDirectoryCandidates`, one more member in `WorkingDirectorySource`, and one more row in the precedence
table. It does not touch discovery, which receives a directory and never asks where it came from.

All of these are additive: no existing candidate list changes order, so no existing project is described
differently by the addition.
