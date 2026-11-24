/**
 * Loading a configuration file.
 *
 * One `stat`, one `readFile`, one parse, one validation, one classification. Every problem with the *file* becomes a
 * result; only the filesystem refusing to answer throws.
 *
 * ## What this does not do
 *
 * It does not look for the file — discovery does that, and its answer is an input here. It does not decide whether the
 * project is usable — the validation service does that, on the value this returns. And it does not repair: when the file
 * exists and cannot be used, the result says so and carries nothing else. A configuration assembled from defaults on top of
 * a broken file is a run nobody can explain afterwards, and it looks exactly like a correct one.
 *
 * ## Why two probes rather than one read
 *
 * `stat` before `readFile` for two reasons that are worth the extra call: a directory reaching a read produces an
 * `EISDIR` message that names nothing useful, and a size check has to happen before the allocation rather than after it.
 * The cost is one filesystem call on a file that is about to be opened anyway.
 *
 * ## Why the boundary between reading and judging matters here
 *
 * Everything above the validation call answers *are these bytes JSON*. Everything from it onwards answers *is this a
 * configuration*. They are different questions asked by different modules, which is what makes a syntax error and a schema
 * error distinguishable by construction rather than by their wording — and what stops this file growing a second opinion
 * about what a valid field is.
 */
import type { Stats } from "node:fs";
import { readFile, stat } from "node:fs/promises";

import { ErrorCode, InvalidArgumentError } from "../../core/errors/index.js";
import {
  isMissingPathError,
  translateFilesystemError,
} from "../../core/filesystem/index.js";
import { validateConfiguration } from "../validation/index.js";

import {
  ConfigurationLoad,
  type ConfigurationLoadResult,
  type LoadOptions,
} from "./contracts.js";
import { parseJsonDocument } from "./json.js";

/**
 * The reading bound.
 *
 * A configuration is a few kilobytes; a megabyte is a hundred times the largest plausible one and far less than reading
 * something else would cost. The bound exists for the case where the path is not what the caller thinks — a configuration
 * symlinked to a database, a root resolved somewhere unexpected — where the alternative is to allocate first and notice
 * afterwards.
 */
const DEFAULT_MAX_BYTES = 1024 * 1024;

/**
 * Loads a configuration file.
 *
 * @param path Absolute path, as produced by configuration discovery.
 * @returns One of six outcomes. Each is a statement about the file, and each has a different remedy.
 * @throws {InvalidArgumentError} `QAT1001` when the path is a directory or another non-file. Discovery already reports a
 *   directory occupying the configuration name; this check stays because the loader is reachable directly, and because a
 *   directory reaching a JSON parser produces a message about a file descriptor rather than about the path a reader typed.
 * @throws {FilesystemError} `QAT5001` when the filesystem could not answer — a permission problem, a failing disk, a
 *   symlink loop. Absence is a result and is returned as one.
 */
export async function loadConfiguration(
  path: string,
  options: LoadOptions = {},
): Promise<ConfigurationLoadResult> {
  const limitBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  const stats = await inspect(path);

  if (stats === undefined) return { kind: ConfigurationLoad.NotFound, path };

  if (!stats.isFile()) {
    throw new InvalidArgumentError(
      ErrorCode.invalidArgument,
      `${path} is not a file.`,
      {
        context: {
          path,
          occupies: stats.isDirectory() ? "directory" : "other",
        },
        remediation:
          "Pass the path configuration discovery returned, or remove whatever occupies that name.",
      },
    );
  }

  // Before reading, so a path that resolved somewhere unexpected cannot cost the allocation of opening it. `stats.size` is
  // what a read would allocate, which is the one reason this check is free enough to be worth having.
  if (stats.size > limitBytes) {
    return {
      kind: ConfigurationLoad.TooLarge,
      path,
      sizeBytes: stats.size,
      limitBytes,
    };
  }

  const text = await read(path);

  // A file removed between the two calls. Reported as absence rather than as a failure, because that is the same answer to
  // the caller and the more honest one: nothing is there now, and the remedy is to discover again.
  if (text === undefined) return { kind: ConfigurationLoad.NotFound, path };

  const parsed = parseJsonDocument(text);

  // One branch per answer rather than a `switch` with a `break`: the narrowing to the parsed variant afterwards is then
  // visible in the shape of the code rather than inferred from fallthrough behaviour.
  if (parsed.kind === "empty") return { kind: ConfigurationLoad.Empty, path };

  if (parsed.kind === "malformed") {
    return {
      kind: ConfigurationLoad.Malformed,
      path,
      reason: parsed.reason,
      location: parsed.location,
    };
  }

  // The one call into the validation service, and the only place a field is judged. It answers with diagnostics that carry
  // permanent codes and never a configured value; this module contributes the path and nothing about fields.
  const validation = validateConfiguration(parsed.value);

  if (!validation.valid) {
    return {
      kind: ConfigurationLoad.Invalid,
      path,
      diagnostics: validation.diagnostics,
    };
  }

  return { kind: ConfigurationLoad.Loaded, path, config: validation.config };
}

/**
 * The file's stats, or `undefined` when there is nothing at the path.
 *
 * `undefined` for absence and a throw for everything else, so the caller's branches are "gone" and "the machine failed"
 * rather than three kinds of `false` — which is exactly the distinction this layer exists to keep.
 *
 * The return type names `Stats` rather than deriving it with `ReturnType<typeof stat>`: `stat` is overloaded, `ReturnType`
 * resolves to the last overload, and that one is the `bigint: true` form — which would make `size` a `number | bigint` for
 * a call that never asked for either.
 *
 * @throws {FilesystemError} `QAT5001` when the filesystem could not answer.
 */
async function inspect(path: string): Promise<Stats | undefined> {
  try {
    return await stat(path);
  } catch (error) {
    // Only "nothing there" is an answer. Everything else goes to the one translator, so the failure carries its errno and
    // the remedy that belongs to it rather than a generic sentence this module invented.
    if (isMissingPathError(error)) return undefined;

    throw translateFilesystemError(error, "inspect", path);
  }
}

/**
 * The file's text, or `undefined` when it is no longer there.
 *
 * Two outcomes rather than an exception for the second: a file removed between the `stat` and this call is a race, and the
 * answer to a caller in that moment is the same as for a file that was never there.
 *
 * @throws {FilesystemError} `QAT5001` when the filesystem could not answer.
 */
async function read(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissingPathError(error)) return undefined;

    throw translateFilesystemError(error, "read", path);
  }
}
