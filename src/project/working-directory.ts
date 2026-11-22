/**
 * Which directory a command is working on, and why.
 *
 * Three possible answers to one question: a directory named as an argument, a directory named by the
 * global option, or the directory the process happens to be in. Resolving that in one place is what
 * stops two commands disagreeing about which project they are describing.
 *
 * ## Not recursive
 *
 * This resolves one directory, checks it, and stops. Looking upwards is discovery's decision, and it
 * only does so when asked — an unbounded search from a command started in the wrong place is how a tool
 * ends up reporting on a project nobody knew it was inside.
 */
import {
  WorkingDirectorySource,
  type ResolvedWorkingDirectory,
  type WorkingDirectoryCandidates,
} from "../core/application/ports.js";
import { ErrorCode, InvalidArgumentError } from "../core/errors/index.js";
import {
  isDirectory,
  normalizeAbsolutePath,
  resolveAgainst,
} from "../core/filesystem/index.js";

/**
 * @param candidates The two values a command may have been given.
 * @param processDirectory Where relative paths resolve from, and the answer when neither value was
 *   supplied. Defaults to the process working directory; passed explicitly in tests so that a test never
 *   has to change the process to arrange its own input.
 */
export async function resolveWorkingDirectory(
  candidates: WorkingDirectoryCandidates = {},
  processDirectory: string = process.cwd(),
): Promise<ResolvedWorkingDirectory> {
  const base = normalizeAbsolutePath(processDirectory);
  const chosen = pickCandidate(candidates);

  const directory =
    chosen === undefined
      ? base
      : resolveAgainst(base, assertUsable(chosen.value, chosen.source));

  if (!(await isDirectory(directory))) {
    const source = chosen?.source ?? WorkingDirectorySource.Process;
    const supplied = chosen?.value ?? base;

    throw new InvalidArgumentError(
      ErrorCode.invalidArgument,
      `${describeOrigin(source)} (${supplied}) is not a directory.`,
      {
        context: { source, supplied, resolved: directory },
        remediation: remediationFor(source),
      },
    );
  }

  return {
    directory,
    source: chosen?.source ?? WorkingDirectorySource.Process,
  };
}

/** Precedence: an argument, then the option, then the process. */
function pickCandidate(
  candidates: WorkingDirectoryCandidates,
):
  | { readonly value: string; readonly source: WorkingDirectorySource }
  | undefined {
  if (candidates.argument !== undefined) {
    return {
      value: candidates.argument,
      source: WorkingDirectorySource.Argument,
    };
  }

  if (candidates.option !== undefined) {
    return { value: candidates.option, source: WorkingDirectorySource.Option };
  }

  return undefined;
}

/**
 * Rejects a value that could never name a directory.
 *
 * Checked here rather than inside path resolution because the message should say which input was wrong —
 * "the directory named by --cwd is empty" is actionable, and "path is empty" is not.
 */
function assertUsable(value: string, source: WorkingDirectorySource): string {
  if (value.includes("\0")) {
    throw new InvalidArgumentError(
      ErrorCode.invalidArgument,
      `${describeOrigin(source)} contains a null byte.`,
      {
        context: { source },
        remediation: "Remove the null byte from the value.",
      },
    );
  }

  if (value.trim().length === 0) {
    throw new InvalidArgumentError(
      ErrorCode.invalidArgument,
      `${describeOrigin(source)} is empty.`,
      {
        context: { source },
        remediation:
          "Pass a directory, or omit the value entirely to use the working directory.",
      },
    );
  }

  return value;
}

function describeOrigin(source: WorkingDirectorySource): string {
  switch (source) {
    case WorkingDirectorySource.Argument:
      return "The directory named as an argument";
    case WorkingDirectorySource.Option:
      return "The directory named by --cwd";
    case WorkingDirectorySource.Process:
      return "The working directory";
  }
}

function remediationFor(source: WorkingDirectorySource): string {
  return source === WorkingDirectorySource.Process
    ? "Run the command from a directory that exists, or pass --cwd with one."
    : "Pass a directory that exists, or omit it to use the working directory.";
}
