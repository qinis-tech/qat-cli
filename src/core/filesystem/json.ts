/**
 * JSON files, with the failure modes made explicit.
 *
 * Reading JSON is where a tool most often meets input it did not produce: a configuration file
 * someone edited by hand, a report from another tool, a file an editor left empty. Each of those
 * has a different fix, so each gets a different message.
 */
import { ErrorCode } from "../errors/codes.js";
import { FilesystemError } from "../errors/errors.js";

import { readText, writeText } from "./file-system.js";

/**
 * Reads and parses a JSON file.
 *
 * @throws {FilesystemError} `QAT5004` when the file is empty or does not parse, and `QAT5001`
 *   when it cannot be read at all. The parse position from the underlying error is preserved as
 *   the cause, so a maintainer can see exactly where the document broke.
 *
 * The result is asserted rather than validated. Validating arbitrary JSON against a schema is
 * the job of `zod` at the point where the shape matters; guessing here would produce a second,
 * weaker validator that drifts from the real one.
 */
export async function readJson<T>(path: string): Promise<T> {
  const contents = await readText(path);

  // Distinguished from invalid JSON because the fixes differ: an empty file usually means a
  // write was interrupted or an editor truncated it, not that someone typed bad syntax.
  if (contents.trim().length === 0) {
    throw new FilesystemError(
      ErrorCode.filesystemInvalidJson,
      `${path} is empty.`,
      {
        context: { path },
        remediation:
          "Write valid JSON, or delete the file if it should not exist.",
      },
    );
  }

  try {
    return JSON.parse(contents) as T;
  } catch (error) {
    throw new FilesystemError(
      ErrorCode.filesystemInvalidJson,
      `${path} does not contain valid JSON.`,
      {
        cause: error,
        context: {
          path,
          detail: error instanceof Error ? error.message : String(error),
        },
        remediation:
          "Check the file for a trailing comma, a missing quote, or an unquoted key.",
      },
    );
  }
}

/**
 * Serialises a value and writes it as formatted JSON, through a temporary file.
 *
 * Two spaces and a trailing newline: the file is meant to be read and diffed by people, and a
 * one-line JSON document shows up in review as a single unreadable line.
 *
 * @throws {TypeError} when the value cannot be serialised — a circular reference, a `BigInt`, or
 *   `undefined`. Deliberately not a `FilesystemError`: the file was never touched, and the fault
 *   is in the value the caller built, which is a defect rather than a filesystem condition.
 */
export async function writeJson(
  path: string,
  value: unknown,
  options: { readonly mode?: number } = {},
): Promise<void> {
  const serialised = JSON.stringify(value, null, 2);

  // `JSON.stringify(undefined)` returns `undefined` rather than throwing, which would otherwise
  // be written as the literal text "undefined" and produce a file that is neither valid JSON nor
  // obviously broken.
  if (serialised === undefined) {
    throw new TypeError(
      `Cannot write ${path}: the value is not representable as JSON.`,
    );
  }

  await writeText(path, `${serialised}\n`, { atomic: true, ...options });
}
