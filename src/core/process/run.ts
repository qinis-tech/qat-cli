/**
 * Running an external command under a defined lifecycle.
 *
 * ## Lifecycle policy
 *
 * - **The executable is resolved before it is spawned.** The failure a spawn reports for a missing
 *   command carries an errno that varies by environment — this machine answers `EACCES` where
 *   `ENOENT` is expected — so the question is answered here instead of inferred afterwards.
 * - **No shell, ever.** Arguments are an array and there is no option to change that. A toggle that
 *   enables shell interpolation is a toggle that eventually gets enabled for a reason that sounded
 *   good at the time.
 * - **Standard input is closed.** A child that decides to prompt cannot block a run waiting for an
 *   answer that will never come.
 * - **Timeout and cancellation send the termination signal, then force-kill.** A polite signal and
 *   hope is not a lifecycle. The child gets five seconds, then it is killed.
 * - **The environment is inherited and merged**, never replaced, and never described anywhere.
 * - **A non-zero exit is returned**, not thrown.
 */
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";

import { execa } from "execa";

import { isApplicationError } from "../errors/application-error.js";
import { ErrorCode } from "../errors/codes.js";
import { ProcessExecutionError } from "../errors/errors.js";

import {
  ProcessOutput,
  type ProcessRequest,
  type ProcessResult,
} from "./contracts.js";
import { readProcessFailure, translateProcessError } from "./errors.js";

/** Bytes retained per stream before the call fails. */
const DEFAULT_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

/**
 * How long a child has to exit after the termination signal before it is killed outright.
 *
 * Without this, a child that ignores `SIGTERM` — or a shell wrapper that never forwards it — leaves
 * the call waiting indefinitely, which is the exact failure a timeout exists to prevent.
 */
const FORCE_KILL_AFTER_MS = 5_000;

/**
 * Extensions Windows appends when resolving a bare command name.
 *
 * Without them, a bare `cypress` is reported missing on Windows even though `cypress.cmd` is
 * present — the single most likely way this check could produce a false negative.
 */
function windowsExtensions(): readonly string[] {
  if (process.platform !== "win32") return [""];

  const pathext = process.env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD";

  return [
    "",
    ...pathext.split(";").filter((extension) => extension.length > 0),
  ];
}

/**
 * Determines whether an executable can be run, before trying to run it.
 *
 * The alternative — spawning and classifying the failure afterwards — depends on an errno that
 * differs by environment. This machine reports `EACCES` for a command that does not exist, where
 * `ENOENT` is the documented answer, which makes "not installed" and "not permitted"
 * indistinguishable at exactly the point where the distinction decides what the reader does next.
 *
 * Resolving first also separates the three outcomes the spawn error collapses together: found and
 * runnable, found and not runnable, and not found at all.
 *
 * Known limit: if a `PATH` directory cannot be searched, every candidate inside it looks absent and
 * the answer is "not found" rather than an environment error. Reporting that accurately would mean
 * walking `PATH` with per-entry error reporting, which is more machinery than the case justifies.
 */
async function assertExecutable(
  executable: string,
  cwd: string | undefined,
): Promise<void> {
  const isPath = executable.includes("/") || executable.includes("\\");

  const directories = (process.env["PATH"] ?? "")
    .split(delimiter)
    .filter((entry) => entry.length > 0);

  const candidates = isPath
    ? [resolve(cwd ?? process.cwd(), executable)]
    : windowsExtensions().flatMap((extension) =>
        directories.map((directory) =>
          join(directory, `${executable}${extension}`),
        ),
      );

  let foundButNotExecutable: string | undefined;

  for (const candidate of candidates) {
    const exists = await access(candidate, constants.F_OK).then(
      () => true,
      () => false,
    );

    if (!exists) continue;

    const runnable = await access(candidate, constants.X_OK).then(
      () => true,
      () => false,
    );

    if (runnable) return;

    foundButNotExecutable ??= candidate;
  }

  const context = { executable, ...(cwd === undefined ? {} : { cwd }) };

  if (foundButNotExecutable !== undefined) {
    throw new ProcessExecutionError(
      ErrorCode.processFailure,
      `${executable} is not executable.`,
      {
        context: { ...context, path: foundButNotExecutable },
        remediation: "Check the file permissions.",
      },
    );
  }

  throw new ProcessExecutionError(
    ErrorCode.processExecutableNotFound,
    `${executable} was not found.`,
    {
      context,
      remediation:
        "Install it, or check the command name and the working directory.",
    },
  );
}

/**
 * Runs a command to completion.
 *
 * @throws {ProcessExecutionError} when the executable cannot be run, exceeded its timeout, was
 *   cancelled, or was terminated by a signal. Never for a non-zero exit code.
 */
export async function runProcess(
  request: ProcessRequest,
): Promise<ProcessResult> {
  const args = [...(request.args ?? [])];
  const policy = request.output ?? {};
  const stdoutMode = policy.stdout ?? ProcessOutput.Capture;
  const stderrMode = policy.stderr ?? ProcessOutput.Capture;

  const startedAt = performance.now();

  // Answered here rather than inferred from a spawn failure afterwards, because the failure's errno
  // varies by environment and "not installed" is the case where a wrong answer costs the most.
  await assertExecutable(request.executable, request.cwd);

  const subprocess = execa(request.executable, args, {
    // execa merges `env` over `process.env`, which is the contract: a child needs `PATH` and
    // inherits everything else, and only the named keys are overridden.
    ...(request.env === undefined ? {} : { env: request.env }),
    ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
    ...(request.timeoutMs === undefined ? {} : { timeout: request.timeoutMs }),
    ...(request.signal === undefined ? {} : { cancelSignal: request.signal }),

    stdin: "ignore",
    stdout: stdoutMode === ProcessOutput.Discard ? "ignore" : "pipe",
    stderr: stderrMode === ProcessOutput.Discard ? "ignore" : "pipe",

    maxBuffer: policy.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES,

    killSignal: "SIGTERM",
    forceKillAfterDelay: FORCE_KILL_AFTER_MS,

    // A non-zero exit is data; only the absence of an exit code is an error. Note that this option
    // also makes a timeout and a cancellation resolve rather than reject, which is why the reason
    // is read from the result below rather than caught from above.
    reject: false,

    // Preserve output byte-for-byte: trimming a trailing newline changes what a parser sees.
    stripFinalNewline: false,
  });

  // Forwarded output goes to standard error. A child's output is diagnostic input, not the result
  // of the command the user ran.
  if (stdoutMode === ProcessOutput.Forward) {
    subprocess.stdout?.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
    });
  }

  if (stderrMode === ProcessOutput.Forward) {
    subprocess.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
    });
  }

  try {
    const completed = await subprocess;
    const durationMs = performance.now() - startedAt;

    // With `reject: false`, a timeout and a cancellation resolve rather than reject, so the reason
    // has to be read from the result instead of inferred from a missing exit code. Reading it
    // through the same structural helper used for thrown errors keeps one definition of "why did it
    // stop" — otherwise a resolved timeout is indistinguishable from a child killed by an outside
    // signal, and both report the same generic code.
    const outcome = readProcessFailure(completed);
    const exitCode = outcome.exitCode;

    if (
      outcome.timedOut ||
      outcome.cancelled ||
      outcome.signal !== undefined ||
      exitCode === undefined
    ) {
      // The whole result is passed on, not a trimmed `{ signal, exitCode }`: it carries the flags
      // that say why the process stopped, and discarding them is what made every one of these cases
      // collapse into the same fallback error.
      throw translateProcessError(completed, request, durationMs);
    }

    return {
      executable: request.executable,
      exitCode,
      stdout: typeof completed.stdout === "string" ? completed.stdout : "",
      stderr: typeof completed.stderr === "string" ? completed.stderr : "",
      durationMs,
    };
  } catch (error) {
    // Rethrown unchanged, so an error that already carries a specific code is not wrapped a second
    // time and reduced to the generic one.
    if (isApplicationError(error)) throw error;

    throw translateProcessError(error, request, performance.now() - startedAt);
  }
}
