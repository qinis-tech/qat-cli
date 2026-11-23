# Project Discovery

How QAT decides which project a command is working on, and what it then knows about it.

Discovery answers three questions in order: **which directory**, then **what is in it**, then **is that good
enough to run**. The first is resolved in one place before the second begins, and the second is gathered by one
module before the third judges it, so no two commands can disagree about which project they are describing.

## What a project root is

A directory is a project root when it contains **either** a `package.json` **or** a Cypress configuration file.
Nothing else qualifies — not a directory named `cypress`, not a lockfile alone.

The two markers are deliberately loose, because a Cypress project does not require a `package.json` and an npm
workspace does not require a framework configuration. Requiring both would reject valid projects; requiring
neither would accept almost anything.

Existence decides, never content. A `package.json` that fails to parse is still a marker, and reporting it as
"not a project" would send the reader looking for the wrong problem — the parse happens later, where it can
produce a message about JSON.

The marker check is inlined rather than delegated to the detection engine, because it runs once per ancestor level
and must stay a handful of `stat` calls. It checks the same candidate list, so the two cannot disagree about what
counts as a configuration file.

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

The option is a **fallback, not a base**. When an argument is present the option is ignored entirely, including as
a place to resolve a relative argument from — `qat doctor ./x --cwd /repo` resolves `./x` against the process
directory. That follows from one input replacing another rather than the two interacting, and it is recorded
because it is the part most likely to surprise someone.

The resolution lives in `src/project/working-directory.ts` and is reached through
`ProjectDiscovery.resolveWorkingDirectory`, so no command re-implements it. It returns two things:

| Field       | Meaning                                                                       |
| ----------- | ----------------------------------------------------------------------------- |
| `directory` | An absolute, normalised path. Resolved once; nothing downstream re-derives it |
| `source`    | Which of the three inputs won                                                 |

The source is carried because three inputs can produce the same failure and they have three different fixes.
`The directory named by --cwd (/tmp/x) is not a directory.` sends the reader to the right place; `not a directory`
does not.

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
somebody chose, and a layout deeper than it fails in a way that looks like a missing installation — so if that ever
happens, the fix is a better message rather than a larger number.

The same bound is used for the install search, which is a different question with the opposite default. One number
serves both because eight is comfortably above either need, and each caller passes a bound rather than relying on
a default — raising one does not silently widen the other.

## Failures, in the order they are reported

| Order | Situation                                             | Code      | Produced by                                                |
| ----- | ----------------------------------------------------- | --------- | ---------------------------------------------------------- |
| 1     | The named directory does not exist, or is a file      | `QAT1001` | The working-directory resolver, before discovery is called |
| 2     | No project markers at or above the starting directory | `QAT2001` | Discovery, resolving the root                              |
| 3     | A manifest exists and does not parse                  | `QAT5004` | The detection engine, reading the manifest                 |
| 4     | Two supported configurations in one directory         | `QAT2004` | Discovery, from the `ambiguous` verdict                    |
| 5     | A configuration in a format QAT cannot read           | `QAT2003` | Discovery, from the `unsupported` verdict                  |
| 6     | Cypress is evidenced, but no configuration file       | `QAT2002` | Discovery, from the `incomplete` or `absent` verdict       |
| 7     | A framework is configured but not installed           | `QAT4002` | Discovery, after the verdict is accepted                   |

The order is deliberate, and it decides what a directory that is wrong in two ways reports. Rows 4 to 6 are
mutually exclusive verdicts, so their relative order is immaterial; the order relative to everything else is not.

**Resolution first.** An invalid directory never reaches detection, so the failure is a bad-argument message
rather than a misleading "no project found".

**The manifest before the configuration.** A manifest that will not parse makes the project undescribable, and
telling the reader to create a configuration file first would only postpone the real error by one round trip.

**Ambiguity before absence.** A project with two configurations is a different mistake from one with none, and only
the first is about to get worse if it is ignored. There is no defensible ordering between `cypress.config.ts` and
`cypress.config.js` — the presence of both means a migration was left unfinished, and picking one would hide that.

**An unusable format is not an absence.** A directory holding a legacy `cypress.json` is a Cypress project; its
owner needs to upgrade the configuration, not to move. Reporting it as "no configuration found" sends them looking
for the wrong thing, which is worse than saying nothing.

**Rows 6 and 7 are the ones most often conflated.** A framework that is configured but missing has an obvious
remedy; a project that is not what the reader thought has a different one. Conflating them produces the worst
message of the set: telling someone to install something when the real problem is that they are in the wrong
repository.

Row 6 covers two verdicts deliberately. _Absent_ and _incomplete_ are different diagnoses — nothing here versus
Cypress evidenced with something missing — but they lead to the same next step, and the message distinguishes them
rather than the code.

## Detection, then validation

`src/project/cypress-detection/` gathers the evidence and returns a verdict. Discovery decides which verdicts are
permitted and turns the rest into the errors above. See
[cypress-detection.md](cypress-detection.md) and
[ADR-0018](adr/0018-separate-detection-from-validation.md).

| Verdict       | Fatal here?                                | Because                                                              |
| ------------- | ------------------------------------------ | -------------------------------------------------------------------- |
| `detected`    | No — unless the framework is not installed | The project is identifiable; whether it can run is the next question |
| `absent`      | `QAT2002`                                  | Nothing identifying Cypress                                          |
| `incomplete`  | `QAT2002`                                  | Cypress evidenced, configuration missing                             |
| `ambiguous`   | `QAT2004`                                  | Two configurations, no defensible choice                             |
| `unsupported` | `QAT2003`                                  | A configuration in a format QAT cannot read                          |

The split matters because the verdict is a **diagnosis** and the error is a **decision to stop**. A command that
only reports — `qat doctor` today, `qat init` next — wants the evidence and the verdict, including when there is
nothing to find, and cannot get either from a thrown exception.

Detection never throws for an unfavourable verdict. It throws only when input cannot be read, which is why
`QAT5004` appears in the failure table above rather than in the verdict mapping.

## Package metadata

The manifest is read once, by `src/project/package-discovery/`, and never by a consumer. It is untrusted input —
written by hand, edited by tooling, occasionally generated — so every field is narrowed from `unknown` and a field
of the wrong type is treated as absent rather than propagated. A non-string dependency version is dropped, which
reports the package as undeclared; that is what a reader would conclude from a broken entry anyway.

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

**A missing manifest is not an error.** A project of a configuration file and specs, with the framework installed
globally or hoisted from above, is legal; the directory name becomes the project name. `qat doctor` says so
explicitly rather than printing nothing, because a line that disappears makes "no metadata" indistinguishable
from "not reported".

**A manifest that exists and does not parse is an error**, `QAT5004`, and it is reported before the framework
configuration is judged.

**A duplicate declaration is not resolved.** A package appearing in both `dependencies` and `devDependencies` is a
defect in the manifest. The declaration is searched for in a fixed order — runtime, development, optional, peer —
and the runtime one is reported, because it describes how the project uses the package. npm already warns about
the duplicate; adjudicating it here would be a second opinion nobody asked for.

**A declared manager beats a lockfile.** A lockfile left behind after a migration implies a tool the project no
longer uses, and remediation built on it would name the wrong command. The result records which it was, so a
reader can discount an inference.

## Workspaces

Two things are supported and one is refused.

**Supported:** a workspace member is an ordinary project. Its dependency installed at the workspace root is found
and recorded with `source: 'workspace'`. That covers the monorepo case that actually occurs — running a command
inside a package. The install search climbs independently of whether parent traversal was requested, because
hoisting is the ordinary case rather than an anomaly.

**Supported:** a workspace root that also has a framework configuration is treated as a single project, with no
special handling. The common single-package-shaped workspace needs nothing else.

**Refused:** expanding the declared patterns. `workspaces` is read — in both legal shapes, a bare array and an
object with `packages` — and never turned into a list of directories. Expanding it means listing directories and
matching globs, which is the recursive discovery this module avoids: a command run at a workspace root would start
choosing a package on the reader's behalf.

So a workspace root with no configuration is **not** a project. When one is passed, the failure names the declared
patterns and says to run from the package directory, which is a one-line fix rather than a search that guessed
wrong.

The trigger to revisit is a command that legitimately operates on a whole workspace. That needs a documented
selection rule, not a fallback. It is also the one policy in this document with no decision record behind it, and
it should have one before a second command depends on it.

## What discovery does not evaluate

**The framework configuration is not executed or parsed.** A Cypress configuration is code. Running it during
discovery would mean executing the user's program before deciding anything about it, and parsing it would mean
reimplementing the configuration semantics of a tool that already has them. See
[ADR-0008](adr/0008-do-not-evaluate-the-framework-configuration.md).

The manifest, by contrast, **is** read in full. The distinction is not "files versus no files" but **data versus
program**: `package.json` is a document that describes the project, and `cypress.config.ts` is a program that
configures a tool. One can be read, the other can only be run.

A configuration file's _name and format_ are examined — that is what detection is for — but its contents are not.
The unsupported list is finite and explicit for the same reason: finding a file with an unrecognised extension
would mean listing the directory.

Paths are therefore Cypress's conventional defaults, adjusted by which conventional directories exist:

| Path                                      | Source                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------- |
| `configFile`                              | The single supported configuration, from the detection verdict            |
| `specsDirectory`                          | First of `cypress/e2e`, `cypress/integration`, `cypress` that exists      |
| `supportFile`                             | First of `cypress/support/e2e.ts`, `.js`, `cypress/support/index.{ts,js}` |
| `screenshotsDirectory`, `videosDirectory` | Present only when the conventional directory exists                       |
| `sourceDirectory`                         | First of `src`, `lib`, `app` that exists; absent otherwise                |

The Cypress-shaped paths come from the layout evidence, which reports **every** conventional candidate that exists
because it is evidence. Discovery takes the first of each list, and that is the only place the choice is made — so
the answer matches what a first-match scan would produce, and the reason it was chosen is reviewable.

A project that overrides `specPattern` or `supportFile` in its configuration will be described incorrectly. This is
a known limitation, recorded in the decision record, and the trigger to revisit is the adapter needing a path it
cannot derive.

## Determinism

Every lookup checks an ordered list of candidate names against the filesystem. No directory is listed, so the
answer cannot depend on iteration order: configuration filenames, legacy configuration filenames, spec
directories, support files, source roots, lockfiles and `node_modules/<package>/package.json` at each ancestor are
all fixed sequences of `stat` calls.

Detection runs its three readings of the tree concurrently — the manifest and install, the configuration scan, the
layout scan — because none depends on another's answer. That changes how long it takes and not what it returns:
each probe preserves candidate order, and the verdict is computed from the completed evidence.

The manifest's own shape cannot affect the result either. Dependency maps are read into a fixed record of four
sections, so the order the keys happen to appear in the file is irrelevant, and a declaration is found by searching
that record in a fixed order rather than by iterating it.

The context carries no version and no discovery time. It is constructed fresh per invocation and never persisted,
so a version would describe nothing and a timestamp would make identical contexts unequal — turning every assertion
about a context into a test of a clock.

The working directory is resolved once per command, from three inputs that are all explicit, and passed to
discovery as an absolute path. Two commands run from the same place with the same arguments resolve the same
directory, which is what makes the precedence table worth writing down.

## No global state

There is no cached context and no module-level variable, in discovery, in package metadata or in detection. A
caller that needs the project asks for it once and passes the value on. This is what allows two discoveries to run
concurrently without interfering, and what stops a command's behaviour depending on what ran before it in the same
process.

The resolver takes the process directory as a parameter rather than reading it internally, for the same reason: a
test supplies the input it wants to exercise instead of changing the process to arrange it.

## Extending discovery

**Adding a configuration format** means one entry in the shared candidate list and a row in the detection
documentation. The list is shared with the cheap marker check, so a format added in one place cannot be invisible
to the other.

**Adding a recognised-but-unusable format** means one entry in `LEGACY_CONFIG_FILES`, so its owner is told to
upgrade rather than told they are in the wrong directory.

**Adding a layout indicator** means a field on `CypressLayout` and a line in the layout reader — plus a decision
about whether it counts as evidence that the directory is a Cypress project, which is the `evidenced` test in the
engine.

**Adding a verdict** is the only change here that is not additive: the closed set, the exhaustive `switch` in
discovery, and the mapping table above. The compiler enforces the second of those, which is the point.

**Adding a framework** is larger than it looks. It needs its own detection module — `detectCypress` is not
`detectFramework`, and pretending otherwise would put a branch per framework inside one engine — plus a selection
rule in discovery, its configuration filenames beside `CYPRESS_CONFIG_FILES`, and the npm package name to search
for, passed to package discovery explicitly rather than derived from the framework identifier.

**Adding a package manager** means one entry in the `LOCKFILES` table in
`src/project/package-discovery/manifest.ts`, where the manager is typed against `PackageManager` so a wrong entry
is a compile error, plus one member in the domain's `PackageManager` set.

**Adding a dependency section** touches three places, and it is worth knowing that they are three: a member of the
domain's `DependencySection`, a row in the search order in `dependencies.ts`, and a line reading it in
`manifest.ts`. The compiler catches the first two — a `Record` over the section union and an exhaustive read — so
only the search order is a judgement.

**Adding a way to name a directory** — a configuration-file pointer, say — means one more candidate in
`WorkingDirectoryCandidates`, one more member in `WorkingDirectorySource`, and one more row in the precedence
table. It does not touch discovery, which receives a directory and never asks where it came from.

All of these are additive except a new verdict: no existing candidate list changes order, so no existing project is
described differently by the addition.
