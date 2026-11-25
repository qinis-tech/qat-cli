# ADR-0029: Require declared intent for a destructive configuration write

Date: 2026-11-24

## Status

Proposed

## Context

The tool writes files. `qat.config.json` holds a project's settings and is edited by hand. Reports and result documents are
written by the tool itself, into directories the tool owns. These two kinds of file have opposite relationships with their
previous contents: a report is _always_ replaced, and a configuration must almost never be.

Both were going through one function. Its shape — write a temporary file, flush it, rename it over the target — is correct
and hard to improve for a replacement, and it is what
[ADR-0006](0006-write-files-through-a-temporary-file-and-rename.md) records. The trouble is that `rename` **replaces
silently**: it does not refuse, it does not warn, and it reports success. Pointed at a file somebody edited by hand, it
destroys that file and returns normally.

Two things made that a live risk rather than a theoretical one.

**Creation and replacement look identical at the call site.** Both take a path and contents; both return a promise. A
caller implementing "create a configuration if there isn't one" reaches for the existing function because it is there, and
the resulting defect appears only when two things happen at once — a second process, a checkout, a colleague — which is
precisely the condition that is never present in a test.

**A replacement of a configuration has no recovery.** A report can be regenerated. A configuration cannot: it is the thing
that describes how to regenerate everything else. Losing it means reconstructing decisions from memory, and the loss is
invisible until the next run reads the wrong settings.

Prior decisions constrain the answer.
[ADR-0028](./0028-create-a-new-configuration-exclusively-rather-than-by-renami.md) established that creating a
configuration uses a hard link rather than a rename, so a create cannot overwrite. That answers creation. It says nothing
about a caller who genuinely does intend to replace an existing configuration — a case the product does not have today but
which is the obvious next request once a reader has a stale file and is told to delete it by hand.

`node:fs` offers exactly two primitives that matter here, and they are not interchangeable. `link` fails if the destination
exists, performing the test and the effect in one operation. `rename` replaces, performing them in one operation as well —
in the other direction.

## Decision

We will require a caller to declare which of the two things it is doing, and we will make the destructive one carry proof.

`writeNewFile` creates and cannot replace: it reports `"exists"` rather than overwriting, and the underlying `link` makes
that decision atomic. `writeFileAtomic` replaces and is for files the caller owns. `replaceFileWithBackup` replaces a file
it did not write, and will do so only given a `expectedSha256` matching the content the caller read — a compare-and-swap,
not a checksum — and only after it has written the previous bytes to a sibling backup and read that backup back to prove it.

No command exposes the third operation. `qat init` is bound to the create-only form, and the type of that dependency is
what prevents the replacing form from being bound to it: different result union, different required argument. Enabling
replacement later is therefore a visible change with a place in a diff, not an implementation decision taken quietly
inside a workflow.

## Consequences

**Easier**

- Creating a configuration has no data-loss failure mode, so the one command that writes a file into somebody's repository
  cannot damage what is there.
- A refused create is a value, not an exception. It renders as a message with a remedy rather than as a stack trace, and a
  caller cannot swallow it by forgetting a `catch`.
- The undo for an approved replacement is one line — `mv qat.config.json.backup qat.config.json` — short enough to put in
  the message that reports the replacement.
- Every document the tool writes goes through one module, so the temporary-file lifecycle, the flush ordering and the
  same-directory rule exist once rather than once per caller.
- Awaiting a replacement feature, the argument for it has somewhere to live: the backup path, the failure behaviour, the
  prompt-free requirement and the recovery line are decided here rather than in a design meeting.

**Harder**

- About a hundred and twenty lines of tested code have no caller. Unused code rots, and this is the honest cost of deciding
  the mechanism before the feature: the tests are the specification, and a test suite nobody runs against production code
  is a claim rather than a guarantee. The mitigation is that the create path exercises half the module today, and the
  replacing half is where the flag will attach.
- `expectedSha256` has no default, so every future caller must read the file and hold its bytes before replacing. A caller
  that merely wants to overwrite its own output must still do the read, or use `writeFileAtomic` and accept that it is
  declaring ownership it may not have.
- A replacement leaves `qat.config.json.backup` in the working tree. It is repository noise unless ignored, the name is not
  configurable, and there is exactly one generation of it — a second replacement destroys the first copy.
- Two primitives to understand instead of one. A reviewer now has to know which operation a call site uses and why, and a
  call site that picks the wrong one compiles and passes its tests.
- Hard links are not universal. Some network mounts and FAT volumes refuse `link` with `EPERM`, so creation is unavailable
  there — reported clearly, but unavailable, where a plain write would have worked.
- `--force` is foreclosed as a cheap later addition. Whatever replacement feature is eventually approved has to answer the
  questions this record leaves open, and cannot be a flag that skips them.

**Neutral**

- No command signature, exit code or result-schema field changes. The user-visible surface is identical to before.
- The backup path is derived from the target rather than configured, so nothing has to discover it and nothing can disagree
  about where it is.
- Durability semantics are unchanged: contents are flushed, the parent directory is not, and that trade was already
  recorded for every other write in the product.

## Options considered

| Option                                             | Why not                                                                                                                                                                                                                                    |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Use the existing replace function for creation     | It replaces silently, so a file that appeared between the caller's check and the call is destroyed and the caller is told the write succeeded                                                                                              |
| One function with an `overwrite?: boolean`         | A boolean is a value somebody passes along, defaults, inverts or forgets. It cannot make a caller state which of two opposite operations they meant, which is the only thing that matters here                                             |
| Open with `O_EXCL` and write directly              | Gains exclusivity and loses atomicity: a crash leaves a partially written file under the final name, which is the failure the temporary file exists to prevent                                                                             |
| Timestamped backups beside the target              | A directory of dated copies nobody prunes. History belongs in version control, and one generation is enough for "put back what I had"                                                                                                      |
| Ship `--force` with a warning in the documentation | A flag whose purpose is to destroy will be used by whoever hits the obstacle, in a script, unattended. The alternative — delete the file and run again — is one deliberate action and cannot be pasted into CI without somebody meaning it |
| Report a refused create as a thrown error          | Callers convert it straight back into a value, with an error path in between that can be logged, rendered or swallowed by accident. It is also wrong about the nature of the condition: an occupied path is an ordinary answer             |

## References

- [ADR-0006](0006-write-files-through-a-temporary-file-and-rename.md) — write files through a temporary file and rename
- [ADR-0028](./0028-create-a-new-configuration-exclusively-rather-than-by-renami.md) — create a new configuration exclusively
- [safe-writes.md](../safe-writes.md) — the operations, the guarantees and the recovery procedure
- [initialisation.md](../initialisation.md) — the one command that creates a configuration, and why it cannot replace one
- Node.js `fs` documentation: `link`, `rename`, `open` with the `wx` flag
