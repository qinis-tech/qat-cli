/**
 * Finding the project's configuration file.
 *
 * ## What this does not do
 *
 * It does not read the file, parse it, validate it, or look for one anywhere except the given root. Locating and
 * understanding are separate failures with separate messages, and a service that did both would have to choose which one
 * to report when a file exists and is broken.
 *
 * It does not ascend. A configuration at a parent directory is not this project's configuration, and reading one would
 * mean a command run in the wrong place silently using somebody else's settings — the same reason project root resolution
 * does not ascend unless asked.
 *
 * ## Why it reaches for `stat` rather than `isFile`
 *
 * `isFile` answers a yes-or-no question, and this module has to answer a question with four answers. A permission failure
 * and an absent file are both `false` to it, and reporting a permission problem as "there is no configuration" is how a
 * reader ends up checking a file that exists.
 *
 * The distinction is kept by asking `isMissingPathError` *before* translating anything: that helper answers "is there
 * nothing at this path", and everything it declines is passed to the shared translator, so a permission problem arrives
 * with its errno, a remedy and the same wording every other filesystem failure in this codebase carries.
 */
import { stat } from "node:fs/promises";
import { join } from "node:path";

import { ErrorCode, InvalidArgumentError } from "../../core/errors/index.js";
import {
  isMissingPathError,
  translateFilesystemError,
} from "../../core/filesystem/index.js";
import { CONFIG_FILE_NAME } from "../contracts.js";

import {
  ConfigurationLocation,
  type ConfigurationDiscovery,
} from "./contracts.js";

/**
 * The name has no separator, so joining it to a root cannot escape that root.
 *
 * Asserted once at load rather than trusted, because the day this constant becomes configurable is the day the guarantee
 * ends — and a failure at import is a better warning than a path traversal discovered later. The absence of a
 * caller-supplied path parameter is the other half of the same guarantee: there is no way to ask this module to look
 * somewhere else.
 */
if (CONFIG_FILE_NAME.includes("/") || CONFIG_FILE_NAME.includes("\\")) {
  throw new Error(
    `CONFIG_FILE_NAME must be a bare filename; it is "${CONFIG_FILE_NAME}".`,
  );
}

/** Four answers, because "not a file" is three different situations and one of them is the filesystem failing. */
type Inspection =
  | { readonly kind: "file" }
  | { readonly kind: "absent" }
  | { readonly kind: "directory" }
  | { readonly kind: "other" };

/**
 * What is at a path.
 *
 * @throws {FilesystemError} `QAT5001` when the filesystem could not answer — a permission problem, a failing disk, a
 *   symlink loop. Absence is an answer and is returned as one.
 */
async function inspect(path: string): Promise<Inspection> {
  try {
    const stats = await stat(path);

    if (stats.isFile()) return { kind: "file" };
    if (stats.isDirectory()) return { kind: "directory" };

    return { kind: "other" };
  } catch (error) {
    // `ENOTDIR` as well as `ENOENT`: a path whose parent is a file does not contain a configuration either, and it is the
    // same absence from the reader's point of view. The predicate decides that; this module does not keep its own opinion
    // about which errno means "nothing there".
    if (isMissingPathError(error)) return { kind: "absent" };

    // Everything else is passed to the one translator, so this failure carries the errno in its context and the remedy
    // that belongs to it — a permission problem and a symlink loop need different sentences, and neither is `EACCES`.
    throw translateFilesystemError(error, "inspect", path);
  }
}

/**
 * Locates the project's configuration file.
 *
 * @param root Absolute project root, as resolved by the working-directory resolver and confirmed by project discovery.
 * @returns One of three answers. Absence is a result, not a failure.
 * @throws {InvalidArgumentError} `QAT1001` when the root is not a directory — ordinarily the caller has already
 *   established this, and the check stays because this service is reachable directly and costs one `stat`.
 * @throws {FilesystemError} `QAT5001` when the filesystem could not answer.
 */
export async function locateConfiguration(
  root: string,
): Promise<ConfigurationDiscovery> {
  const rootInspection = await inspect(root);

  if (rootInspection.kind !== "directory") {
    throw new InvalidArgumentError(
      ErrorCode.invalidArgument,
      rootInspection.kind === "absent"
        ? `${root} does not exist.`
        : `${root} is not a directory.`,
      {
        context: { root },
        remediation:
          "Pass the resolved project root, or run the command inside a project.",
      },
    );
  }

  const path = join(root, CONFIG_FILE_NAME);
  const inspection = await inspect(path);

  switch (inspection.kind) {
    case "file":
      return { kind: ConfigurationLocation.Found, path };

    case "absent":
      return { kind: ConfigurationLocation.Absent, root };

    case "directory":
    case "other":
      return {
        kind: ConfigurationLocation.NotAFile,
        path,
        occupiedBy: inspection.kind === "directory" ? "directory" : "other",
      };
  }
}
