/**
 * The filesystem operations QAT is allowed to perform.
 *
 * Every function here is a thin, predictable wrapper over `node:fs/promises` with one property
 * that the raw API does not have: a failure arrives as a `FilesystemError` with a code and,
 * usually, something to do about it.
 *
 * Absent from this module on purpose: no implicit directory creation on write, no recursive
 * delete, and no glob. Each is a capability with a blast radius, and none is needed yet.
 */
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";

import { ErrorCode } from "../errors/codes.js";
import { FilesystemError } from "../errors/errors.js";

import { writeFileAtomic } from "./atomic-write.js";
import { hasErrorCode, translateFilesystemError } from "./errors.js";

export interface EnsureDirectoryOptions {
  /** Mode for directories created by this call. Defaults to the process umask applied to `0o777`. */
  readonly mode?: number;
}

/**
 * Creates a directory and any missing parents. Idempotent for an existing directory.
 *
 * @returns The path, so calls can be chained.
 * @throws {FilesystemError} when the path exists and is not a directory, which is a different
 *   condition from a permission failure and deserves a different message.
 */
export async function ensureDirectory(
  path: string,
  options: EnsureDirectoryOptions = {},
): Promise<string> {
  try {
    await mkdir(path, {
      recursive: true,
      ...(options.mode === undefined ? {} : { mode: options.mode }),
    });

    return path;
  } catch (error) {
    if (hasErrorCode(error) && error.code === "EEXIST") {
      throw new FilesystemError(
        ErrorCode.filesystemFailure,
        `${path} exists and is not a directory.`,
        {
          cause: error,
          context: { path },
          remediation: "Remove the file, or choose a different directory.",
        },
      );
    }

    throw translateFilesystemError(error, "create directory", path);
  }
}

/**
 * Whether anything exists at `path`.
 *
 * @throws {FilesystemError} for a permission failure, rather than returning `false`. "It does
 *   not exist" is an answer; "I was not allowed to look" is not, and a caller that treats the
 *   second as the first will make a decision on a false premise.
 */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (
      hasErrorCode(error) &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      return false;
    }

    throw translateFilesystemError(error, "inspect", path);
  }
}

/** Whether `path` exists and is a directory. Permission failures throw, as above. */
export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (
      hasErrorCode(error) &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      return false;
    }

    throw translateFilesystemError(error, "inspect", path);
  }
}

/** Whether `path` exists and is a regular file. Permission failures throw, as above. */
export async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (
      hasErrorCode(error) &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      return false;
    }

    throw translateFilesystemError(error, "inspect", path);
  }
}

/**
 * Names of the entries in a directory, sorted.
 *
 * Sorted by code unit rather than `localeCompare`: directory order varies by filesystem, and a
 * locale-sensitive sort varies by machine. Both make a test or a generated report differ between
 * runs for no reason a reader could see.
 */
export async function listDirectory(path: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.map((entry) => entry.name).sort();
  } catch (error) {
    throw translateFilesystemError(error, "list directory", path);
  }
}

export interface WriteTextOptions {
  /**
   * Write through a temporary file and rename. Defaults to `true`.
   *
   * A partially written report or result file is worse than a slow write: it is a file that
   * looks like data and is not. Opt out only for high-frequency or append-style writes where
   * partial content is meaningless anyway.
   */
  readonly atomic?: boolean;
  readonly mode?: number;
}

/** Reads a file as UTF-8 text. */
export async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    throw translateFilesystemError(error, "read", path);
  }
}

/**
 * Writes UTF-8 text.
 *
 * Replaces the file's contents entirely. Does not create parent directories.
 */
export async function writeText(
  path: string,
  contents: string,
  options: WriteTextOptions = {},
): Promise<void> {
  const mode = options.mode === undefined ? {} : { mode: options.mode };

  if (options.atomic ?? true) {
    await writeFileAtomic(path, contents, mode);
    return;
  }

  try {
    await writeFile(path, contents, { encoding: "utf8", ...mode });
  } catch (error) {
    throw translateFilesystemError(error, "write", path);
  }
}
