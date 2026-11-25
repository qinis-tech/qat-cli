# Safe writes

|                  |                                                                                                                                                                                                                                                                                                                |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**       | Normative                                                                                                                                                                                                                                                                                                      |
| **Module**       | `src/core/filesystem/atomic-write.ts`                                                                                                                                                                                                                                                                          |
| **Entry points** | `writeNewFile(path, contents, options?)`, `writeFileAtomic(path, contents, options?)`, `replaceFileWithBackup(path, contents, options)`, `backupPathFor(path)`, `hashContents(contents)`                                                                                                                       |
| **Companion**    | [initialisation.md](initialisation.md), [configuration-loading.md](configuration-loading.md), [cli-output.md](../development/cli-output.md), [ADR-0006](./adr/0006-write-files-through-a-temporary-file-and-rename.md), [ADR-0029](./adr/0029-require-declared-intent-for-a-destructive-configuration-writ.md) |

Writing a file so that a reader sees either the old bytes or the new ones, and so that a file which is already there is
not lost by accident.

## 1. Three jobs, three primitives

| Job                                    | Entry point             | Primitive       | Guarantee                                                                                  |
| -------------------------------------- | ----------------------- | --------------- | ------------------------------------------------------------------------------------------ |
| Create a file that must not exist      | `writeNewFile`          | `link`          | A file that appeared a moment ago is not overwritten — the call reports `"exists"` instead |
| Replace a file the caller has read     | `writeFileAtomic`       | `rename`        | A reader sees the old file or the new one, never a mixture                                 |
| Replace a file, keeping what was there | `replaceFileWithBackup` | `rename`, twice | The previous bytes are preserved and verified before the target changes                    |

The primitives are not interchangeable, and the difference is the whole subject of this document. `rename` is atomic and
**replaces silently** — for an edit that is exactly the contract; for a create it is data loss with a successful return
code. `link` creates a second name for a file and **fails if that name is taken**, which is the only primitive that
tests and effects in one operation.

This narrows [ADR-0006](./adr/0006-write-files-through-a-temporary-file-and-rename.md), which says every write goes
through a temporary file and a rename. That is still true for replacements. It cannot be true for creations, and
[ADR-0029](./adr/0029-require-declared-intent-for-a-destructive-configuration-writ.md) records why the create path needs
a different primitive rather than a flag on the old one.

## 2. The temporary file

Three properties, each of which has a portability bug behind it.

**In the same directory as the target.** `rename` and `link` both fail with `EXDEV` across filesystems, so a temporary in
the system temp directory works on a developer laptop with one disk and fails on a CI runner whose `/tmp` is a separate
volume. The worst kind of portability bug: it appears only where the failure is least convenient.

**Flushed before the commit.** `sync` runs before the `rename` or the `link`, never after. The rename promises the _name_;
the flush promises the _contents_. Without it, an abrupt termination can leave a correctly named file containing nothing.

**Named so nothing can mistake it for the file it will become.** `.<basename>.<pid>.<uuid>.tmp` — unique per call, so two
concurrent writers cannot collide; attributed by pid, so a leftover is traceable; dot-prefixed and `.tmp`-suffixed, so
nothing that reads a file by exact name will ever open one. A configuration is read by exact name, which is what makes a
crash-surviving temporary inert rather than dangerous.

The parent directory is **not** created implicitly. A typo in an output path should produce an error naming the directory,
not a tree in an unexpected place — and it does, because the parent is checked before the temporary is even named.

## 3. Creating: the answer, not the exception

```ts
const outcome = await writeNewFile(path, contents);
// "created" | "exists"
```

"There is already a file here" is an ordinary answer to an ordinary question. A caller that had to catch it would convert
it straight back into a value, with an error path in between that can be logged, rendered or swallowed by accident. The
neighbouring rules in this codebase make the same call for a missing path, and for the same reason: an expected state is
not a failure.

It is also what makes the operation safe under a race. A caller has almost certainly checked the path already — that check
was advice, taken at an earlier moment. This call is the one that decides, because the kernel performs the test and the
effect together. Two concurrent `qat init` runs therefore produce exactly one `"created"` and one `"exists"`, and the
loser's temporary is removed.

The temporary is opened with `wx`, which fails if the name exists. That is not about the temporary — the name is a fresh
UUID — but about a pre-created symlink in a directory another user can write to: without the flag, the open would follow
the link and the write would land somewhere unintended.

## 4. Replacing atomically

```ts
await writeFileAtomic(path, contents);
```

Write the temporary, flush it, rename it over the target. Whatever was there is gone in one atomic step, and a reader
running at the same instant sees either version in full.

This is the operation for a file whose previous contents the caller has read and intends to change — a report, a result
document. It is **not** the operation for a file the caller did not write, which is what §5 exists for.

## 5. Replacing with a verified backup

```ts
const outcome = await replaceFileWithBackup(path, contents, { expectedSha256 });
// "replaced" | "changed" | "missing"
```

Four steps, and the order is the guarantee:

| #   | Step                                                                             | What it refuses                                                     |
| --- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 1   | Read the current bytes and compare `expectedSha256`                              | A file edited between the caller's read and this call → `"changed"` |
| 2   | Write those bytes to the sibling backup, then read that file back and compare it | A copy that cannot be read is not a copy → throws, target untouched |
| 3   | Rename the new contents over the target                                          | —                                                                   |
| 4   | Report `"replaced"`                                                              | —                                                                   |

**The hash is a compare-and-swap, not a checksum.** The filesystem already guarantees the bytes it returns are the bytes it
stored. What `expectedSha256` adds is _authorisation for a specific content_: a caller cannot say "replace the configuration"
without saying "the configuration I read", so a file that changed while the caller was deciding is refused rather than
clobbered. It has no default, and that is deliberate — a default would turn the strongest guarantee here into a comment.

**The read-back is the part worth defending.** A backup whose creation was reported as successful, but which cannot be read,
is worse than no backup: it is a false assurance that turns "I can put it back" into a discovery made after the original is
gone. Verification costs one read of a file measured in kilobytes and happens before the one destructive step.

**Nothing calls this.** No command exposes a replacement, so the function is reachable only from a caller that constructs
an intent, reads the file and holds its hash. `qat init` cannot: its dependency is typed for creation, and this function's
result type and required hash do not fit it. That is the point of §8.

## 6. What a caller may assume

- The target holds the old bytes, the new bytes, or nothing. Never a mixture, never truncated.
- Nothing was written to the target unless the result says `"created"` or `"replaced"`.
- A `"exists"`, `"changed"` or `"missing"` result leaves the filesystem exactly as it was found, temporary files included.
- A rejected promise means the _machine_ failed — a full disk, a permission, a filesystem without hard links — not a
  decision about the content. Those arrive as `FilesystemError` carrying the errno and a remedy.

The split is this codebase's error contract: conditions about content are values a caller renders, failures of the
machine are exceptions a caller reports.

## 7. Recovery after an interrupted write

| Interruption                                           | What is on disk                                   | What a reader sees                                    |
| ------------------------------------------------------ | ------------------------------------------------- | ----------------------------------------------------- |
| Before the rename or link                              | Target as it was, one `.tmp` file                 | The old file. The temporary is inert and identifiable |
| During the rename or link                              | One of the two states — the operation is atomic   | The old file, or the new one                          |
| After a replacement's backup, before the target rename | Target as it was, `.backup` present               | The old file, plus a recoverable copy of itself       |
| After a successful replacement                         | New target, `.backup` holds the previous contents | The new file, and a one-line undo                     |

Restoring is a rename, deliberately small enough to say in a message:

```bash
mv qat.config.json.backup qat.config.json
```

Temporary files that survive a crash are **never swept automatically**. Removing another process's in-flight temporary is
worse than the litter it cleans up, and a crash can leave one behind with no way to tell whether it is abandoned. The name
is chosen so that nothing which reads configurations will mistake one for one — that is the recovery behaviour, and a
`sweep` would be an optimisation a future diagnostic can offer when it knows what it is looking at.

## 8. Who may call what

| Caller                    | Uses                    | Because                                                                  |
| ------------------------- | ----------------------- | ------------------------------------------------------------------------ |
| `qat init`                | `writeNewFile`          | A configuration is created or reported, never replaced                   |
| Report and result writers | `writeFileAtomic`       | They own the file and intend to overwrite their own output               |
| Nothing, today            | `replaceFileWithBackup` | Replacement has no approved user intent, so there is no flag to reach it |

The distinction is enforced by types rather than by discipline. An initialisation dependency is typed
`(path, contents) => Promise<NewFileWriteOutcome>`; `replaceFileWithBackup` returns a different union _and_ demands a hash,
so it cannot be bound to that dependency at all. Widening that dependency is the change that would need review, and it is a
visible one.

## 9. What this module does not do

| Not done                   | Because                                                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create parent directories  | A typo in a path should be an error, not a tree                                                                                                   |
| Follow or verify symlinks  | Resolving real paths is I/O layered on I/O; the caller passed a path it means                                                                     |
| Lock files                 | Advisory locking is not portable, and the compare-and-swap in §5 covers the case a lock would serve                                               |
| Flush the parent directory | POSIX-specific, one syscall per write, and it buys durability of the rename rather than of the contents. Stated here rather than discovered later |
| Sweep stale temporaries    | See §7                                                                                                                                            |
| Know what it is writing    | It handles bytes. Nothing here knows what a configuration is, which is what lets one writer serve every document the tool produces                |

## 10. Known limits

| Limit                                          | Why it is one                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A filesystem without hard links                | `link` may refuse with `EPERM` or `ENOSYS` — some network mounts, some FAT volumes, a Windows volume without the capability. Reported as its own error with its own remedy rather than silently degrading to a direct write, because degrading trades crash atomicity for portability without telling anybody |
| `EPERM` is ambiguous                           | A refused link and a refused permission share the code. The message names the capability rather than the permission, and it is produced where the operation is known                                                                                                                                          |
| The backup is one generation                   | A second replacement replaces the first backup. A history belongs in version control, not in a directory of dated copies nobody prunes                                                                                                                                                                        |
| No durability of the rename against power loss | See §9. The contents are flushed; the directory entry may not be                                                                                                                                                                                                                                              |
| A crash can leave a temporary behind           | See §7                                                                                                                                                                                                                                                                                                        |
| Windows rename semantics                       | Replacing an open file fails. The failure is translated and the target is untouched; retrying after the handle closes is the caller's remedy                                                                                                                                                                  |

## 11. Testing

`tests/unit/core/filesystem/atomic-write.test.ts` — real temporary directories for anything whose meaning is a filesystem
behaviour, and three mocked primitives (`open`, `link`, `rename`) for the failures a real disk will not produce on demand.
Every override is queued as `*Once` and consumed by the call it was written for; an override installed with
`mockImplementation` would outlive its test, because clearing mocks resets history rather than implementations.

| Scenario                                | Asserted                                                                             |
| --------------------------------------- | ------------------------------------------------------------------------------------ |
| Create into a free path                 | `"created"`, exact contents, no temporary left                                       |
| Create onto an occupied path            | `"exists"`, target byte-identical, no temporary left                                 |
| Two creates racing                      | Exactly one `"created"`, one `"exists"` — the reason `link` is used at all           |
| Write or flush fails                    | Rejection, target absent, half-written temporary removed                             |
| Hard links unavailable                  | Rejection naming the capability, not the permission                                  |
| Replace, rename fails                   | Rejection, target still holds the old bytes                                          |
| Replace with backup                     | `"replaced"`, backup byte-identical to the previous contents                         |
| Replace with a stale hash               | `"changed"`, and no backup taken                                                     |
| Backup cannot be read back              | Rejection, **target untouched** — the acceptance criterion as an assertion           |
| Backup path occupied by a directory     | Rejection, target untouched                                                          |
| Replacement fails after a proven backup | Rejection, target untouched, backup present — a failed replacement is not a lost one |
| Restore from the backup                 | The previous contents, byte for byte                                                 |
| Empty content, and a 1 MiB document     | Boundary cases for both operations                                                   |
| Repeated replacements                   | One target, one backup, no history                                                   |
| After every refusal                     | The directory contains exactly what it contained before                              |

## 12. Things that will bite

**`writeFileAtomic` will look like the right call for creating a file.** It is atomic, it exists, and its signature is
identical. It also replaces silently, so the failover is invisible until somebody loses a file. Reach for
`writeNewFile` whenever the answer to "may I write here?" is not yours to give.

**A passing create test does not prove the exclusive behaviour.** A test that only ever targets a free path passes for a
rise-based implementation too. The two that matter are the occupied-path case and the concurrent case, and a change that
removes the second is a change that removes the guarantee.

**Hashes are of bytes.** `hashContents` accepts a string or a `Uint8Array`; a string is hashed as UTF-8. A caller that
decoded with a different encoding gets a mismatch and a refusal — which is the safe direction, but it looks like a
concurrent edit if nobody knows why.

**A leftover `.backup` is a file in the repository.** It is not a configuration, it is not read by anything, and it should
be ignored by version control. If it is not, the next review includes somebody's previous settings.

**Clearing mocks is not resetting them.** `vi.clearAllMocks()` empties call history; `resetAllMocks` would also strip the
real implementations the mock factory installed, and every later test would call `undefined`. That is a five-minute debug,
which is cheaper to prevent with a comment than to diagnose from a confusing failure.
