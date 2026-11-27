/**
 * Reading what is on disk, without writing anything.
 *
 * The implementation behind the `files` port: three questions a health check needs and none it may answer itself. It lives
 * here rather than beside the code that first needed it because it is a machine concern — `stat`, `realpath` and a bounded
 * read — and a second copy in the project layer would be a second set of answers to the same questions.
 *
 * ## It imports the port's types, and that is the correct direction
 *
 * `core/application/ports` declares what the consumer needs; this module supplies it, so the arrow points from
 * implementation to contract. Redeclaring `FileEntryInspection` here would compile just as well and buy nothing: two
 * identical interfaces drift the day one gains a field, and the drift shows up as a cast in the composition root rather
 * than as a compile error.
 *
 * ## No write capability exists, at all
 *
 * No `write`, no `append`, no `unlink`, and no option that would enable one. That is not a policy callers are trusted to
 * respect; it is a property of the object. A diagnostic built on this cannot modify the project it is diagnosing.
 *
 * ## What absence means, and what it does not
 *
 * - **Resolves normally** for a path that exists, whatever it is: file, directory, symlink.
 * - **`inspect` resolves `undefined`** when there is nothing at the path. Absence is an ordinary answer, and the caller has
 *   a sentence for it; throwing here would make "there is no configuration file" look like a defect in QAT.
 * - **Rejects** for everything else: permission denied, an I/O error, a link cycle. Those are distinct from absence because
 *   the caller's sentence is distinct.
 *
 * Two details are easy to get wrong and expensive to debug. `inspect` uses `lstat`, not `stat`: whether an entry *is* a link
 * is a fact a caller needs before deciding whether following it is safe, and following it here would silently answer a
 * different question. And `readPrefix` returns `Uint8Array` rather than `Buffer`, so no runtime-specific type reaches the
 * application layer and a test can produce the bytes from a string literal.
 *
 * Every failure is translated through `./errors.js` rather than thrown raw. A Node error carries an errno the rest of the
 * program has no contract for, and letting one escape would make the error model depend on which runtime produced it.
 */

import { open, lstat, realpath } from "node:fs/promises";

import type { FileInspector } from "../application/ports.js";

import { isMissingPathError, translateFilesystemError } from "./errors.js";

/**
 * Builds the inspector.
 *
 * Called with no arguments, like the other machine factories: it closes over nothing a caller should be able to change, and
 * the per-call seam the health checks need is the *port* the composition root supplies, not an option here. Two seams for
 * one decision is a combination a reviewer then has to reason about.
 */
export function createFileInspector(): FileInspector {
  return {
    async inspect(path) {
      // The two-step the errors module describes, written out. `isMissingPathError` asks whether the failure means "there
      // is nothing there"; everything else is translated. The handler returns for absence and throws for a failure — it
      // never *returns* an error, because a returned one would widen `stats` to `Stats | FilesystemError` and every use
      // below would then be a type error waiting to be papered over with a cast.
      const stats = await lstat(path).catch((error: unknown) => {
        if (isMissingPathError(error)) return undefined;

        throw translateFilesystemError(error, "inspect", path);
      });

      // Absence. The caller turns this into "no configuration file", which is a sentence about their project rather than
      // about the filesystem.
      if (stats === undefined) return undefined;

      return {
        isFile: stats.isFile(),
        isDirectory: stats.isDirectory(),
        isSymbolicLink: stats.isSymbolicLink(),
        // Only for a regular file. Reporting a directory's size invites a caller to reason about it, and the number means
        // nothing portable.
        ...(stats.isFile() ? { sizeBytes: stats.size } : {}),
      };
    },

    async resolveRealPath(path) {
      return realpath(path).catch((error: unknown) => {
        // Deliberately *not* treated as absence: this function's whole job is to produce a destination, and "the
        // destination does not exist" is not a destination. A link that leads nowhere therefore rejects with a translated
        // ENOENT, which the caller maps to "a symlink with no target" — the accurate fact, rather than a path that looks
        // resolved and is not.
        throw translateFilesystemError(error, "resolve", path);
      });
    },

    async readPrefix(path, maxBytes) {
      // Guarded rather than trusted: a caller computing the bound can produce zero or a negative number, and
      // `Buffer.alloc` would then throw a `RangeError` that reads like a mistake in this module rather than in the caller.
      if (!Number.isFinite(maxBytes) || maxBytes <= 0) return new Uint8Array(0);

      const handle = await open(path, "r").catch((error: unknown) => {
        throw translateFilesystemError(error, "read", path);
      });

      try {
        const buffer = Buffer.alloc(maxBytes);

        const { bytesRead } = await handle
          .read(buffer, 0, maxBytes, 0)
          .catch((error: unknown) => {
            // Also not treated as absence: the caller has already established that this file exists, so an `ENOENT` here
            // means it vanished mid-read — a race worth reporting, not an absence to swallow.
            throw translateFilesystemError(error, "read", path);
          });

        // A view, not the whole buffer: the caller asked for at most `maxBytes`, and `subarray` reports exactly how many
        // bytes were actually there.
        return buffer.subarray(0, bytesRead);
      } finally {
        // Closed even when the read throws. A health check that leaked a descriptor per project would fail the second time
        // it ran, and the report would blame the project.
        await handle.close();
      }
    },
  };
}
