/**
 * Existence probes over ordered candidate lists.
 *
 * Every probe returns *all* the candidates that exist, in candidate order, rather than the first. That is the
 * difference between gathering evidence and making a choice: detection reports what is there, and a caller that
 * needs one answer takes the first element of a list it can see.
 *
 * No directory is listed anywhere in this module. Directory iteration order is filesystem-dependent, so a
 * listing-based search can return a different answer on two machines holding identical files.
 */
import { join } from "node:path";

import { isDirectory, isFile } from "../../core/filesystem/index.js";

export async function existingFiles(
  root: string,
  candidates: readonly string[],
): Promise<readonly string[]> {
  const checks = await Promise.all(
    candidates.map(async (file) =>
      (await isFile(join(root, file))) ? file : undefined,
    ),
  );

  // `Promise.all` preserves input order, so the result is the candidate order rather than the completion order.
  return checks.filter((file): file is string => file !== undefined);
}

export async function existingDirectories(
  root: string,
  candidates: readonly string[],
): Promise<readonly string[]> {
  const checks = await Promise.all(
    candidates.map(async (directory) =>
      (await isDirectory(join(root, directory))) ? directory : undefined,
    ),
  );

  return checks.filter(
    (directory): directory is string => directory !== undefined,
  );
}
