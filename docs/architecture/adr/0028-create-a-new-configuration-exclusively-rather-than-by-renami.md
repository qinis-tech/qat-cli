# ADR-0028: Create a new configuration exclusively rather than by renaming over the target

Date: 2026-11-24

## Status

Proposed

## Context

QAT can now initialise a project: it writes `qat.config.json` at the project root, and it is the first thing the tool
ever writes into somebody's repository. The file is committed, hand-edited, and shared with everyone working on that
branch.

The product's existing answer for writing a file is recorded: write the whole contents to a uniquely named temporary file
in the same directory, flush it, and rename it over the target. That makes a reader see either the old contents or the
new, never a mixture, and it is correct for its stated purpose — an edit of a file the caller has already read.

That purpose is not this one. Rename is atomic and it also **replaces** the destination without a word. For an edit that
is the point. For a create it means the operation succeeds and something is gone.

Three situations produce this need, and none of them is hypothetical:

- **Two runs at once.** A provisioning script retried, two terminals, a `git checkout` landing between the check and the
  write, a colleague doing the same thing on the same clone.
- **A file with hand edits.** Initialisation is expected to be run more than once — on a fresh clone, after pulling,
  after deleting the file to start again — and the file may by then contain settings nobody wants to reconstruct.
- **A retry inside one process.** A caller that cannot tell whether the write happened has to guess, and guessing twice
  is how a first-run file becomes a second-run casualty.

A check for the file before writing is available and is not sufficient. The check and the write are two moments, and
between them the filesystem is free to change. A check is advice about the past; only the operation that commits the
effect can refuse.

The constraint on the other side is that the write must still be atomic in the sense the existing rule means: a reader
must never observe a half-written configuration, because a truncated file is a state the next command reports as
malformed and the user did not create.

## Decision

We will create a new configuration with an **exclusive create**. The contents are written to a uniquely named temporary
file in the same directory and flushed; the temporary file is then **hard-linked** to the final name, which fails if the
name is already taken; the temporary name is removed either way.

"The name is taken" is an **outcome, not a failure**: the writer reports whether it created the file, and the caller turns
that answer into whatever it would have said had it seen the file a moment earlier. Replacement keeps the existing rule
unchanged — `rename`, unchanged, for every caller that has read the file it is replacing.

## Consequences

**Easier**

- A race cannot destroy a file. The refusal comes from the same operation that would have committed the effect, performed
  by the filesystem, at the moment it matters.
- "This project is already initialised" becomes a first-class answer, because the writer can say whether it created the
  file. A retry is safe by construction rather than by the caller remembering to check.
- The guarantee is testable in one assertion: run the create twice against the same path and compare the bytes. Nothing
  about ordering, timing or schedulation enters the test.
- A future command that scaffolds a file — a config for a second framework, a CI template — inherits the property by
  using the same writer, rather than by re-reading this record and re-deriving the argument.
- The distinction between "create" and "replace" is now in the type system: the two writers have different names and one
  of them returns an outcome the caller cannot ignore.

**Harder**

- There are now two write primitives, and choosing between them is a judgement rather than a lookup. Picking the
  renaming one for a create compiles, passes every test that does not run two writers concurrently, and loses the
  guarantee silently. The two call sites are a reviewer's responsibility.
- Filesystems without hard links — some network mounts, FAT volumes — refuse the operation with `EPERM` or `ENOSYS`.
  Initialisation then fails with a message naming the capability. That is worse than working, and better than silently
  degrading to a direct write: degrading would trade crash atomicity for portability without telling the caller.
- The outcome forces a second read on the one path where it fires. When the link reports that the name is taken, the
  caller re-reads the path to report what is actually there, which means a third possible shape — "appeared and vanished"
  — needs its own sentence and its own remedy.
- A crash between the write and the link leaves a stray `.qat.config.json.<pid>.<uuid>.tmp` beside the target. It is named
  so it is attributable and it is never read, but nothing sweeps it.
- The writer's signature returns an outcome rather than `void`, so it is not a drop-in replacement for the neighbouring
  helper. Two functions that look alike now behave differently at the call site, and the difference is the whole point —
  which means it cannot be hidden behind a flag.

**Neutral**

- The temporary-file-and-flush discipline is unchanged: the durability argument, the same-directory requirement and the
  refusal to create parent directories are all inherited rather than re-decided.
- What the file contains, where it lives and what it is called are unaffected. This record is about how the bytes arrive,
  not about what they say.
- The message a user sees on a second run is unchanged in wording: the outcome was already "already initialised"; only
  the mechanism that guarantees it moved.
- Performance is indistinguishable: one extra filesystem call against one that was already happening.

## Options considered

| Option                                                                 | Why not                                                                                                                                                                           |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reuse the existing temporary-file-and-rename writer                    | Rename replaces the destination silently. A file created between the caller's check and the write is destroyed and the caller is told the write succeeded                         |
| Open the final path directly with the exclusive flag and write into it | Exclusive, and a crash mid-write leaves a truncated file at the final name — the one state worse than no file, because it looks like a configuration and is reported as malformed |
| Check for the file, then use the existing writer                       | Two moments. The check describes the past; only the committing operation can refuse. This is the option that looks correct in review and fails once a year                        |
| Take a lock file, then check and write                                 | The lock is new state that can go stale, in a directory the tool does not own, and it makes the failure mode "a lock nobody removed" instead of "a file somebody wrote"           |
| Copy the temporary file with an exclusive-creation flag                | A copy is not atomic, costs a full read and write of the contents, and the final step is a rename again — so the replacement returns through the back door                        |

## References

- ADR-0006 — write files through a temporary file and rename. The rule this record departs from, for one operation, with
  the departure reasoned rather than assumed
- ADR-0025 — do not fall back to defaults for a configuration file that exists. The same principle from the other
  direction: a file that exists is the user's, and the tool's job is to read it, not to improve it
- POSIX `link(2)`, which fails with `EEXIST` when the new path names an existing file, and `rename(2)`, which replaces
  the destination atomically — the two behaviours this record chooses between
- `src/core/filesystem/atomic-write.ts` — both writers, with the reasoning at the point of use
- `docs/architecture/initialisation.md` — the workflow, the four outcomes, and the branch that handles a file appearing
  between the check and the write
