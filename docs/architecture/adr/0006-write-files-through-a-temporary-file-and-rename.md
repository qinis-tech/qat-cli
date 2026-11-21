# ADR-0006: Write files through a temporary file and rename

Date: 2026-11-21

## Status

Accepted

## Context

QAT produces artefacts that outlive the process that wrote them: execution results, HTML and
JUnit reports, configuration files it rewrites, evidence manifests. Something else reads each of
them afterwards — a report generator, a downstream CI job, the next `qat history` invocation, or
a person opening a file.

A process can stop at any moment. A CI job can be cancelled at a timeout boundary. A user can
press Ctrl-C during a long run. A container can be evicted. The window in which a write is in
progress is milliseconds, so this is not a frequent event — but the consequences are not
proportional to the frequency.

The naive approach, opening the target and writing into it, means the target is truncated the
moment the file is opened and remains partially written until the last chunk lands. If the
process stops in between, a file exists with the correct name, the correct location, and wrong
contents. For JSON, that is usually a loud failure: the next reader cannot parse it and says so.
For a line-oriented format it can be worse — a truncated JUnit document or a half-written log is
still valid-looking data, so a reader accepts it and reports something quietly untrue.

A schema version does not help. It lets a reader reject a shape it does not recognise, but a
truncated file is not an unrecognised shape; it is an unparseable one, or a short one that parses
perfectly.

Node's `rename` within a single directory is atomic: on POSIX it is a `rename(2)` that either
happens or does not, and on Windows it maps to `MoveFileEx` with replace semantics. That primitive
is the basis of what follows.

No incident has been observed. The argument rests on the shape of the failure rather than on a
measurement, and that is stated plainly because it is the weakest part of the case.

## Decision

We will write every durable artefact to a uniquely named temporary file in the same directory as
its target, flush it to disk, and then rename it over the target. The rename is the commit point.

Specifically:

- The temporary file is a **sibling of the target**, named `.{basename}.{pid}.{uuid}.tmp`. Same
  directory, because a rename across filesystems is not atomic and fails outright with `EXDEV`.
- It is created with the **`wx`** flag, so a path that already exists — including a symlink placed
  by another user in a shared directory — causes a failure rather than redirecting the write.
- The file handle is **flushed before the rename**. The rename promises the name; the flush
  promises the contents. Reversing them allows a correctly named file containing nothing.
- The temporary file is removed in a `finally` block that runs on both the success and failure
  paths, and a failure to remove it is swallowed rather than allowed to replace the real error.
- The **parent directory is not created**. A missing parent is an error naming the missing
  directory, not the internal temporary path.
- Callers may opt out with `atomic: false` for writes where partial content is meaningless.
- The **directory** is not flushed after the rename. That is a POSIX-specific step, it costs a
  system call per write, and for report files the trade is not worth it.

## Consequences

**Easier**

- A reader never observes a partially written artefact. It sees the previous version or the new
  one, and the tool never produces a file that looks like data and is not.
- A crash during a write leaves the target untouched, so an interrupted run cannot destroy the
  previous successful run's results.
- Concurrent writers cannot corrupt each other, because each writes its own temporary file. The
  last rename wins, which is a defined outcome rather than an interleaving.
- Writing over an existing file becomes safe to retry: a failed attempt leaves the previous
  version intact, so a retry is a genuine second attempt rather than a recovery.
- The failure mode has a name. A leftover `.tmp` file is evidence that a write was interrupted,
  which is more than a truncated target would tell anyone.

**Harder**

- Every write creates and removes an extra file. On Windows and on network filesystems that is
  measurable, and it is paid on every artefact even though the interruption it protects against
  happens rarely.
- The flush is the slow part. On filesystems where `fsync` dominates small writes, writing ten
  small reports costs noticeably more than writing them directly.
- A killed process leaves a `.tmp` file that the user did not create and cannot account for.
  Nothing cleans these up. They accumulate in an output directory until somebody notices and
  deletes them by hand, and until then the directory listing lies about what a run produced.
- The exclusive-create flag turns a stale temporary file with a colliding name into a failure
  rather than an overwrite. Unique names make that unlikely, and the resulting error is confusing
  precisely because the name in it is one nobody typed.
- The existing file's **mode is not preserved**. Rewriting a file that was deliberately made
  executable, or deliberately restricted, silently replaces its permissions with the process
  default. Nothing needs that today; it is recorded because the day something does, the failure
  will be a permissions problem attributed to the wrong cause.
- Crash safety is argued from the mechanism, not demonstrated. A unit test can assert that no
  temporary file survives and that the target is old-or-new; it cannot force an interruption
  between the flush and the rename. Anyone reviewing this should treat the guarantee as a
  property of the strategy rather than as a tested behaviour.

**Neutral**

- Disk usage briefly doubles for the file being written. For a report of a few hundred kilobytes
  that is irrelevant; for a large evidence archive it is worth knowing.
- Only whole-file replacement is protected. Append-style writes are untouched and remain
  non-atomic, because appending cannot be made atomic by renaming.
- The temporary file is visible in a directory listing while a write is in progress, which is
  noticeable when a user watches a long run.

## Options considered

| Option                                                             | Why not                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Write directly to the target                                       | Simplest, and leaves a truncated file behind whenever a process stops mid-write. The failure is silent for any format where partial content still parses, which includes most line-oriented ones.                                                                    |
| Write to the system temporary directory, then rename               | Works on every developer machine and fails on a CI runner that mounts its temporary volume separately, because rename across filesystems is not atomic and errors with `EXDEV`. The defect would appear only in the environment where diagnosing it is hardest.      |
| Keep a backup copy, write the target, delete the backup on success | Restores the previous version after a crash, but only if something knows to look. The target is still partial during the write and remains partial after a crash until a recovery step runs, so the problem is moved rather than removed.                            |
| Write to a temporary sibling, flush, then rename                   | Chosen. One filesystem operation becomes the commit point, and the failure mode degrades to a leftover file rather than a corrupt one.                                                                                                                               |
| Use a library that already does this                               | Adds a dependency for roughly forty lines, and the details that matter — same-directory temporary file, exclusive creation, flush before rename, cleanup on both paths — are exactly the details worth having in the codebase where they can be reviewed and tested. |

## References

- `src/core/filesystem/atomic-write.ts` — the implementation
- `docs/architecture/module-boundaries.md` — why the filesystem module imports only `node:` and `core/errors`
- `docs/architecture/error-model.md` — `FilesystemError` and the codes this path can produce
- POSIX `rename(2)` atomicity guarantees within a filesystem
- Windows `MoveFileEx` with `MOVEFILE_REPLACE_EXISTING`, which is what Node's `rename` maps to
