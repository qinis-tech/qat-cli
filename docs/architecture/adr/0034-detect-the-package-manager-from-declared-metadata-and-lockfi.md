# ADR-0034: Detect the package manager from declared metadata and lockfiles, never by executing it

Date: YYYY-MM-DD

## Status

Accepted

## Context

QAT has to name a project's package manager before it can give install advice: "run the install" is not an instruction
when nothing says which tool installs. Three facts about real repositories make that harder than it looks.

**A project can contain evidence of more than one manager.** Repositories are upgraded, forked, or copied from a template
that shipped a different lockfile, and the old file is frequently not deleted. A directory may hold `package-lock.json`
and `pnpm-lock.yaml` at once, and nothing in the tree says which one CI actually runs.

**A project can contain evidence and still be uninstalled.** The most common state of a fresh clone is a lockfile and no
`node_modules` at all. Whatever QAT infers has to be true of a directory nobody has installed yet.

**A project can declare one thing and contain another.** The `packageManager` field (Corepack's convention) is what the
project says; a lockfile is what it did. Both are ordinary, and they are allowed to disagree.

The tempting shortcut is to ask the tool itself: run `pnpm --version`, `npm --version`, `yarn --version`, and see which
one answers. It is three lines, it is what a person would do, and it is wrong here for four reasons that were each
observable while this was built:

- It executes a binary selected by looking at a project the user just checked out. PATH entries can include a
  project-local directory, so "which binary answers" is a question an untrusted repository can influence.
- It answers a different question. A machine can have pnpm installed and a project can still install with npm; the
  binary's presence is a fact about the machine, not about the tree.
- It costs four process spawns, on a command whose budget is measured in tens of milliseconds.
- On Windows, a `.cmd` shim cannot be spawned without `shell: true` since Node's `child_process` shell-injection
  hardening, so a large fraction of the intended answer would come from a code path this tool refuses to take.

Nothing in the existing architecture forces a choice here, which is why the choice is worth recording.

## Decision

We will determine a project's package manager from two sources of evidence only — the `packageManager` field in the
project manifest, and lockfile names at the project root — with a fixed precedence, and we will never execute a package
manager, or anything else, in order to find out which one a project uses.

Specifically:

- Evidence is **presence-based**. A lockfile identifies its manager whether it is empty or not; its contents are never
  parsed to decide identity.
- Precedence is **declaration first, then footprint**, and disagreement between them is **reported, never resolved**.
  Two lockfiles, or a declaration contradicted by the only lockfile, are findings with their own remedies.
- Absence of all evidence is **`undeclared`**, never a default. QAT will not claim a project uses npm because it could
  not tell.
- An unreadable declaration is ignored **for identity** and reported **for itself**, so the same snapshot has one reader
  deciding identity and another describing the author's text.
- Executable location and version probing exist to answer the _other_ question — "is the tool this project declared
  usable here?" — and are performed only after identity is established, from PATH only, without a shell.

## Consequences

**Easier**

- The answer is deterministic. Two machines holding the same files report the same manager, which is what makes the
  finding reproducible in CI and quotable in a bug report.
- The answer is fast and allocation-light: one directory listing, no process, no network, no file read beyond the
  manifest.
- The whole detection matrix — case sensitivity, shrinkwrap-versus-lockfile, three lockfiles, a declaration that
  contradicts the footprint, an unrecognised `deno.lock` — is testable from an immutable snapshot and literals. Those
  cases are almost impossible to arrange on disk and trivial to arrange as a value.
- Running QAT on an untrusted repository does not execute anything from it before the user has asked for a run.
- A conflicting project produces a finding that names both files, which is the only version of that message a reader can
  act on.

**Harder**

- A project with neither a lockfile nor a `packageManager` field cannot be classified. It is reported as `undeclared`, and
  the answer we would like to give requires asking the user to declare something. That is a support cost we accept, but
  it is a cost: some fraction of projects will get advice they must interpret rather than follow.
- Lockfile evidence can be **stale**. A committed `yarn.lock` left behind after a migration to pnpm is reported as a
  conflict, which is correct and also means QAT cannot distinguish "the team switched tools" from "somebody committed the
  wrong file". Both get the same finding, and the message has to be written to fit both.
- A manager that leaves no lockfile cannot be detected at all. npm run with `--no-package-lock`, or an ecosystem whose
  convention omits one, is invisible to this method and lands in the `undeclared` bucket rather than a dedicated one.
- Monorepos are seen only at the root. A member package with its own lockfile is not inspected, so a workspace with
  mixed tooling is reported from the root's perspective. That is a real limit, and closing it means a different
  decision about how far QAT looks, not a change to this one.
- Windows shims cannot be probed, so the version comparison is skipped for `.cmd`/`.bat` — the honest cost of refusing
  to enable a shell.
- The policy is a table that documentation and tests must agree with. Adding a manager is a code change, a fixture, and a
  row in two documents, and a contract test fails if any of the three is missing. That test is the reason the table can
  be trusted, and it is also a tax on every future addition.

**Neutral**

- Identity detection belongs to the project layer; the finding belongs to the health-check catalogue, because the verdict
  needs the machine as well as the tree. That split is deliberate and costs one mapping between them.
- The check's identifier still begins with `environment` while it is grouped under package-manager availability. Renaming
  it is a one-line change while no published document quotes it.
- Two conditions that were once a single "package manager" code are now nine, one per remedy. The catalogue grew; the
  number of checks did not.

## Options considered

| Option                                                                                | Why not                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Execute each candidate manager and see which one answers                              | Runs project-selected binaries to learn a label, is four spawns on a fast command, answers "what is on PATH" rather than "what this project installs with", and cannot be done safely for Windows shims without enabling a shell |
| Infer identity from `node_modules` layout and install markers                         | An install artefact, not a declaration: absent on a fresh clone, stale after a manager switch, and a tree created by a different tool would be read as identity rather than as the mismatch it is                                |
| Default to npm when nothing is found                                                  | A false statement about the user's project, and it suppresses the one condition worth reporting — that the project declares nothing                                                                                              |
| Read lockfile contents to establish identity or version                               | Costs a read of potentially large files, adds a parsing surface, and buys nothing identity needs: presence already identifies the manager                                                                                        |
| Resolve conflicts by a precedence rule (trust the declaration, or trust the lockfile) | A silent winner is how CI installs with the wrong tool and rewrites the lockfile the team meant to keep. The disagreement is the finding                                                                                         |
| Detect with a shell command such as `corepack which` and parse its output             | Same execution objection, plus a dependency on Corepack being present, which is exactly one of the things this check has to be able to report as missing                                                                         |

## References

- [package-managers.md](../package-managers.md) — the policy table this decision is implemented against, and the
  published guarantee list.
- [doctor-checks.md](../doctor-checks.md) §5 — the ladder that turns identity, tooling and installation state into
  `QAT-H` findings.
- [ADR-0007](0007-treat-a-non-zero-exit-code-as-a-result-not-an-error.md) — why a probe's non-zero exit is evidence rather
  than an exception, which is what lets a version probe decline to answer without failing the command.
- [ADR-0032](0032-skip-a-check-whose-precondition-failed-rather-than-reporting.md) — why an unreadable project root skips
  this check rather than being reported as a package-manager problem.
- Node.js `child_process` documentation on spawning `.cmd`/`.bat` files without a shell, and the hardening release note
  that made `shell: true` mandatory for them.
- npm documentation for `package-lock.json` and `npm-shrinkwrap.json`; the Corepack documentation for the
  `packageManager` field, including its requirement that the version be exact.
