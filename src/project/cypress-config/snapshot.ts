/**
 * Facts about the one Cypress configuration file that detection identified.
 *
 * Division of labour, deliberately narrow: `cypress-detection` decides *what
 * exists* — which configuration file, in what layout, whether the directory is a
 * Cypress project at all. This module answers the follow-up question detection
 * does not: *is the file it found actually openable and readable?*
 *
 * That is why nothing here lists a directory or enumerates candidates. Doing so
 * would be a second opinion about a tree that has already been read, and two
 * probes of the same filesystem can silently disagree.
 *
 * What it does, and all it does:
 *   • `lstat` the entry to learn what it really is, without following links;
 *   • follow a symlink exactly once and enforce the project boundary;
 *   • read a bounded, faithfully-decoded sample of the bytes.
 *
 * It never writes, and it has no write capability on purpose: a diagnostic that
 * can modify the file it is inspecting is not a diagnostic.
 */

import { open, lstat, realpath } from "node:fs/promises";
import path from "node:path";

import type {
  ConfigFileFacts,
  ConfigFileState,
  ConfigTextSample,
} from "./contracts.js";

/**
 * Largest configuration file we are willing to read.
 *
 * Far above any realistic Cypress configuration, small enough that a mistaken or
 * hostile multi-gigabyte file cannot exhaust memory. Exceeding it is not an
 * error: it becomes a "not validated" cause, because a huge file is a fact to
 * report, not a reason to fail the doctor.
 */
export const CONFIG_SIZE_BUDGET_BYTES = 1024 * 1024; // 1 MiB

/**
 * The filesystem operations needed, and nothing more.
 *
 * Injected so every state — unreadable, dangling link, oversize file, a link
 * escaping the project — is testable without temp directories or `chmod`-ing
 * fixtures, and so this module cannot accidentally acquire a write method.
 */
export interface ConfigFileSystem {
  readonly inspect: (target: string) => Promise<{
    readonly isFile: boolean;
    readonly isDirectory: boolean;
    readonly isSymbolicLink: boolean;
    readonly sizeBytes: number;
  }>;
  readonly resolveRealPath: (target: string) => Promise<string>;
  /** Reads at most `maxBytes` from the start of the file. */
  readonly readPrefix: (
    target: string,
    maxBytes: number,
  ) => Promise<Uint8Array>;
}

export interface ConfigFileInspector {
  /**
   * Inspects the configuration file detection reported.
   *
   * `file` is the project-relative name detection used, so the name in evidence
   * is always the name the user sees — even when a symlink is followed.
   * Memoised per file for the lifetime of the inspector (one command run): both
   * configuration checks ask about the same file, and single-flight also stops
   * concurrent callers producing two slightly different answers.
   */
  readonly inspect: (input: {
    readonly projectRoot: string;
    readonly file: string;
  }) => Promise<ConfigFileFacts>;
}

const freeze = <T>(value: T): T => Object.freeze(value);

/** Default implementation over Node's filesystem. */
export function createNodeConfigFileSystem(): ConfigFileSystem {
  return {
    inspect: async (target) => {
      // `lstat`, not `stat`: we must know the entry is a link *before* deciding
      // whether following it is safe.
      const stats = await lstat(target);

      return {
        isFile: stats.isFile(),
        isDirectory: stats.isDirectory(),
        isSymbolicLink: stats.isSymbolicLink(),
        sizeBytes: stats.size,
      };
    },

    resolveRealPath: (target) => realpath(target),

    readPrefix: async (target, maxBytes) => {
      const handle = await open(target, "r");

      try {
        const buffer = Buffer.alloc(maxBytes);
        const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);

        return buffer.subarray(0, bytesRead);
      } finally {
        // Always release the descriptor, even when the read throws: a doctor
        // that leaks handles fails the second time it runs on a large repo.
        await handle.close();
      }
    },
  };
}

/**
 * Containment guard for a symlinked configuration.
 *
 * A configuration that resolves outside the project is not the project's
 * configuration, and reading it would let a repository point QAT at a file the
 * developer never intended to expose to a diagnostic. The boundary is the
 * project root and nothing else — no exception for caches or parent folders.
 */
function isInsideProject(projectRoot: string, target: string): boolean {
  const relative = path.relative(projectRoot, target);

  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === code
  );
}

export function createConfigFileInspector(
  deps: {
    readonly fs?: ConfigFileSystem;
    readonly sizeBudgetBytes?: number;
  } = {},
): ConfigFileInspector {
  const fs = deps.fs ?? createNodeConfigFileSystem();
  const sizeBudget = deps.sizeBudgetBytes ?? CONFIG_SIZE_BUDGET_BYTES;

  // Keyed rather than one shared promise: today only one configuration file can
  // exist, but a cache that returned the wrong file's facts would be a very
  // quiet and very confusing bug if that ever changes.
  const pending = new Map<string, Promise<ConfigFileFacts>>();

  return {
    inspect: ({ projectRoot, file }) => {
      const key = `${projectRoot}\u0000${file}`;

      let capture = pending.get(key);

      if (capture === undefined) {
        capture = inspectOnce(fs, sizeBudget, projectRoot, file);
        pending.set(key, capture);
      }

      return capture;
    },
  };
}

async function inspectOnce(
  fs: ConfigFileSystem,
  sizeBudget: number,
  projectRoot: string,
  file: string,
): Promise<ConfigFileFacts> {
  const absolutePath = path.join(projectRoot, file);

  try {
    const stats = await fs.inspect(absolutePath);

    if (stats.isSymbolicLink) {
      return await inspectSymlink(
        fs,
        sizeBudget,
        projectRoot,
        file,
        absolutePath,
      );
    }

    return await withSample({
      fs,
      sizeBudget,
      projectRoot,
      file,
      absolutePath,
      state: stats.isDirectory ? "directory" : "file",
      sizeBytes: stats.sizeBytes,
    });
  } catch (error) {
    return factsFromError(file, absolutePath, error);
  }
}

/**
 * Resolves a symlinked configuration, then judges what it points at.
 *
 * Resolution happens exactly once and is deliberately not chased further: a
 * configuration reachable only through a chain of links is rare enough that
 * "cannot establish" is a better answer than a clever resolver. The reported
 * file name stays the one the user recognises; only the internal absolute path
 * follows the link.
 */
async function inspectSymlink(
  fs: ConfigFileSystem,
  sizeBudget: number,
  projectRoot: string,
  file: string,
  absolutePath: string,
): Promise<ConfigFileFacts> {
  let resolvedPath: string;

  try {
    resolvedPath = await fs.resolveRealPath(absolutePath);
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) {
      return freeze({ file, absolutePath, state: "dangling-symlink" as const });
    }

    return factsFromError(file, absolutePath, error);
  }

  if (!isInsideProject(projectRoot, resolvedPath)) {
    return freeze({
      file,
      absolutePath: resolvedPath,
      state: "outside-project" as const,
    });
  }

  try {
    const target = await fs.inspect(resolvedPath);

    return await withSample({
      fs,
      sizeBudget,
      projectRoot,
      file,
      absolutePath: resolvedPath,
      state: target.isDirectory ? "directory" : "file",
      sizeBytes: target.sizeBytes,
    });
  } catch (error) {
    return factsFromError(file, absolutePath, error);
  }
}

/**
 * Reads a bounded, decoded sample when the entry is a non-empty regular file.
 *
 * Three deliberate details:
 *   • Empty files are not sampled — there is nothing to decode, and reporting
 *     "empty" belongs to the location verdict, not the validator.
 *   • Over-budget files are not opened at all. We record the size and move on:
 *     reading a gigabyte to learn that it is a gigabyte would be the slowest
 *     thing the doctor could do.
 *   • A failed read downgrades the state to `unreadable`. Permission bits say
 *     what is permitted; an actual read says what is possible. We report the
 *     second, so discovery can say "unreadable" instead of handing the validator
 *     an empty string it might misread as "valid".
 */
async function withSample(input: {
  readonly fs: ConfigFileSystem;
  readonly sizeBudget: number;
  readonly projectRoot: string;
  readonly file: string;
  readonly absolutePath: string;
  readonly state: ConfigFileState;
  readonly sizeBytes: number;
}): Promise<ConfigFileFacts> {
  const { fs, sizeBudget, projectRoot, file, absolutePath, state, sizeBytes } =
    input;

  // `projectRoot` is unused here but kept in the input so every call site passes
  // the same shape; a future relative-path decision has one place to land.
  void projectRoot;

  if (state !== "file" || sizeBytes === 0) {
    return freeze({ file, absolutePath, state, sizeBytes });
  }

  if (sizeBytes > sizeBudget) {
    return freeze({
      file,
      absolutePath,
      state,
      sizeBytes,
      sample: freeze<ConfigTextSample>({
        state: "skipped-too-large",
        text: "",
        bytesRead: 0,
        truncated: true,
        decodable: true,
        containsBinary: false,
      }),
    });
  }

  try {
    // Never allocate more than the file actually holds: a 12-byte configuration
    // should not cost a megabyte of buffer.
    const bytes = await fs.readPrefix(
      absolutePath,
      Math.min(sizeBudget, sizeBytes),
    );

    return freeze({
      file,
      absolutePath,
      state,
      sizeBytes,
      sample: sampleOf(bytes),
    });
  } catch (error) {
    if (
      isErrnoCode(error, "EACCES") ||
      isErrnoCode(error, "EPERM") ||
      isErrnoCode(error, "EISDIR") ||
      isErrnoCode(error, "ENOENT")
    ) {
      return freeze({
        file,
        absolutePath,
        state: "unreadable" as const,
        sizeBytes,
        sample: freeze<ConfigTextSample>({
          state: "unreadable",
          text: "",
          bytesRead: 0,
          truncated: false,
          decodable: true,
          containsBinary: false,
        }),
      });
    }

    throw error;
  }
}

/**
 * Classifies the bytes without pretending a lossy decode succeeded.
 *
 * `fatal: true` is what separates "this is text" from "these are bytes that
 * happen to decode if you ignore the bad parts". A configuration we cannot read
 * faithfully is not one we should be quoting back to anyone, so undecodable
 * content yields no text at all and sets the flag instead.
 */
function sampleOf(bytes: Uint8Array): ConfigTextSample {
  const decodable = isDecodableUtf8(bytes);

  return freeze({
    state: "sampled" as const,
    text: decodable
      ? new TextDecoder("utf-8", { fatal: true })
          .decode(bytes)
          .replace(/^\uFEFF/, "")
      : "",
    bytesRead: bytes.byteLength,
    truncated: false,
    decodable,
    containsBinary: bytes.includes(0),
  });
}

function isDecodableUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);

    return true;
  } catch {
    return false;
  }
}

/**
 * Maps an inspection failure onto data.
 *
 * Absence is not this module's verdict to give: detection already established
 * that the file exists, so a vanished entry is a race or a broken link and is
 * reported as `dangling-symlink` — meaning "this path does not resolve to a
 * file" — rather than thrown. Permission, I/O and link-cycle faults are
 * findings. Anything else is a genuine bug and is allowed to surface; swallowing
 * it here would turn a defect into a misleading "your project is fine".
 */
function factsFromError(
  file: string,
  absolutePath: string,
  error: unknown,
): ConfigFileFacts {
  if (isErrnoCode(error, "ENOENT")) {
    return freeze({ file, absolutePath, state: "dangling-symlink" as const });
  }

  if (
    isErrnoCode(error, "EACCES") ||
    isErrnoCode(error, "EPERM") ||
    isErrnoCode(error, "EIO") ||
    isErrnoCode(error, "ELOOP")
  ) {
    return freeze({ file, absolutePath, state: "unreadable" as const });
  }

  throw error;
}
