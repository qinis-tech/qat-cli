/**
 * Translation of execa failures into the application error model.
 *
 * Five distinguishable conditions, because they have five different fixes. Collapsing them into one
 * "process failed" error would put the reader back where they started.
 *
 * The original value is preserved as `cause`. For a thrown error it carries the library's own
 * detail; for a resolved timeout or cancellation it is the result object, which carries the
 * captured output — exactly what a maintainer needs and exactly what must not be rendered to a user
 * by default.
 */
import { ErrorCode } from "../errors/codes.js";
import { ProcessExecutionError } from "../errors/errors.js";

import type { ProcessRequest } from "./contracts.js";

/** Structural view of a process failure, so this module does not depend on a library's types. */
export interface ProcessFailure {
  readonly errnoCode: string | undefined;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly signal: string | undefined;
  readonly exitCode: number | undefined;
}

/**
 * An errno, as opposed to any other string a library may put in a `code` field.
 *
 * `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` and its relatives are library codes, not operating-system
 * errors, and treating one as an errno would put a wrong explanation in front of a reader.
 */
const ERRNO_PATTERN = /^E[A-Z0-9]+$/;

/**
 * An errno as it appears in prose: the `ENOENT` inside `Command failed with ENOENT: ci spawn ci`.
 *
 * The boundaries matter. Uppercase-and-digits only, at least three characters, standing alone —
 * which describes every errno and almost nothing else. `Error`, `Execa` and
 * `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` all fail to match.
 */
const ERRNO_IN_TEXT = /\b(E[A-Z0-9]{2,})\b/;

/** How far down a `cause` chain to look. Guards against a self-referential chain. */
const MAX_CAUSE_DEPTH = 4;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Finds an errno, following the `cause` chain and falling back to the message text.
 *
 * Three sources, checked in order of trustworthiness. A declared `code` field is the only one that
 * is not a guess. A wrapper may instead keep the original on `cause`, which is the shape Node's own
 * errors take. Failing both, the errno is often still present in the message, because a library
 * that reports "command failed with ENOENT" has told the reader something it declined to put in a
 * field.
 *
 * Getting this wrong is not cosmetic: a missing executable and an unclassifiable failure produce
 * the same generic message, and the first one has an obvious remedy that the other does not.
 */
function findErrno(value: unknown): string | undefined {
  const visited = new Set<unknown>();
  let current: unknown = value;

  for (
    let depth = 0;
    current !== undefined && depth <= MAX_CAUSE_DEPTH;
    depth += 1
  ) {
    if (visited.has(current)) return undefined;
    visited.add(current);

    const record = asRecord(current);
    if (record === undefined) return undefined;

    const declared = record["code"];
    if (typeof declared === "string" && ERRNO_PATTERN.test(declared))
      return declared;

    for (const key of ["originalMessage", "message"]) {
      const text = record[key];
      if (typeof text !== "string") continue;

      const match = ERRNO_IN_TEXT.exec(text);
      if (match?.[1] !== undefined) return match[1];
    }

    current = record["cause"];
  }

  return undefined;
}

/** Whether any of these keys is literally `true` on the value. */
function isFlagged(
  record: Record<string, unknown> | undefined,
  keys: readonly string[],
): boolean {
  return keys.some((key) => record?.[key] === true);
}

/**
 * Extracts the fields worth distinguishing from an unknown value.
 *
 * Works on a thrown error and on a resolved result alike. That matters because the library resolves
 * rather than rejects for timeouts and cancellations once it has been told not to throw on failure,
 * so the reason has to be readable from either shape. Reading both through one function keeps a
 * single definition of "why did it stop".
 */
export function readProcessFailure(error: unknown): ProcessFailure {
  const record = asRecord(error);

  return {
    errnoCode: findErrno(error),
    timedOut: isFlagged(record, ["timedOut"]),
    cancelled: isFlagged(record, ["isCanceled", "isCancelled", "canceled"]),
    signal:
      typeof record?.["signal"] === "string" ? record["signal"] : undefined,
    exitCode:
      typeof record?.["exitCode"] === "number" ? record["exitCode"] : undefined,
  };
}

/**
 * Builds the error for a process that never produced an exit code.
 *
 * Arguments are **not** included in the message or the context. They may carry credentials — a
 * token passed as a flag is a common pattern — and an error that reaches a log file or a pasted bug
 * report would leak it. The executable and the working directory identify the invocation
 * adequately; the argument count is recorded so a reader knows whether any were passed at all.
 */
export function translateProcessError(
  error: unknown,
  request: ProcessRequest,
  durationMs: number,
): ProcessExecutionError {
  const failure = readProcessFailure(error);

  const base = {
    cause: error,
    context: {
      executable: request.executable,
      ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
      argumentCount: request.args?.length ?? 0,
      durationMs,
      ...(failure.errnoCode === undefined ? {} : { errno: failure.errnoCode }),
      ...(failure.signal === undefined ? {} : { signal: failure.signal }),
    },
  };

  if (failure.cancelled) {
    return new ProcessExecutionError(
      ErrorCode.processCancelled,
      `${request.executable} was cancelled before it finished.`,
      {
        ...base,
        remediation:
          "No action is needed unless the cancellation was unexpected.",
      },
    );
  }

  if (failure.timedOut) {
    const limit =
      request.timeoutMs === undefined
        ? "the configured limit"
        : `${String(request.timeoutMs)} ms`;

    return new ProcessExecutionError(
      ErrorCode.processTimedOut,
      `${request.executable} did not finish within ${limit} and was terminated.`,
      {
        ...base,
        remediation:
          "Raise the timeout, or narrow what the process was asked to do.",
      },
    );
  }

  if (failure.errnoCode === "ENOENT") {
    return new ProcessExecutionError(
      ErrorCode.processExecutableNotFound,
      `${request.executable} was not found.`,
      {
        ...base,
        remediation:
          "Install it, or check the command name and the working directory.",
      },
    );
  }

  if (failure.errnoCode === "EACCES") {
    return new ProcessExecutionError(
      ErrorCode.processFailure,
      `${request.executable} is not executable.`,
      { ...base, remediation: "Check the file permissions." },
    );
  }

  if (failure.signal !== undefined) {
    return new ProcessExecutionError(
      ErrorCode.processFailure,
      `${request.executable} was terminated by ${failure.signal} without reporting an exit code.`,
      {
        ...base,
        remediation:
          "Run it again; if it repeats, check the system log for the cause.",
      },
    );
  }

  // Two whole messages rather than one with an interpolated suffix. A template whose only content
  // is a leading space is invisible in review and has already been stripped once by an editor.
  const message =
    failure.errnoCode === undefined
      ? `${request.executable} could not be run.`
      : `${request.executable} could not be run (${failure.errnoCode}).`;

  return new ProcessExecutionError(ErrorCode.processFailure, message, {
    ...base,
  });
}
