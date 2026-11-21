/**
 * Process execution contracts.
 *
 * ## The distinction everything else follows from
 *
 * A **non-zero exit code is a result**. The child ran, decided something, and said so. The caller
 * interprets that number — a test runner exiting 1 means failing tests, not a broken tool.
 *
 * **Failure to run is an error.** The executable is missing, the limit was exceeded, or the caller
 * cancelled. No answer was produced, and there is nothing for a caller to interpret.
 */

/**
 * What to do with one of the child's output streams.
 *
 * `Forward` writes to QAT's **standard error**, never standard output. A child's output is
 * diagnostic input, not the result of the command the user ran; putting it on stdout would break
 * the guarantee that a pipeline parsing QAT's output receives only that output.
 */
export const ProcessOutput = {
  /** Retain in the result. */
  Capture: "capture",
  /** Retain in the result and mirror to QAT's standard error as it arrives. */
  Forward: "forward",
  /** Discard. The corresponding result field is empty. */
  Discard: "discard",
} as const;

export type ProcessOutput = (typeof ProcessOutput)[keyof typeof ProcessOutput];

export interface ProcessOutputPolicy {
  /** Defaults to `capture`. */
  readonly stdout?: ProcessOutput;
  /** Defaults to `capture`. */
  readonly stderr?: ProcessOutput;
  /**
   * Bytes retained per stream before the call fails. Defaults to 10 MiB.
   *
   * A cap rather than no cap: a test runner producing megabytes would otherwise be bounded only
   * by available memory. Exceeding it fails rather than truncating silently, because a truncated
   * result that looks complete is worse than an error.
   */
  readonly maxBufferBytes?: number;
}

export interface ProcessRequest {
  /** Executable name or absolute path. A bare name is resolved against `PATH`. */
  readonly executable: string;

  /**
   * Arguments as separate values. Never a command string.
   *
   * There is no shell, so there is no quoting, no globbing, no variable expansion and no
   * injection: an argument containing `; rm -rf /` arrives as those characters of text.
   */
  readonly args?: readonly string[];

  /** Working directory. Defaults to the current process directory. */
  readonly cwd?: string;

  /**
   * Environment variables to set or override. **Merged** over the inherited environment, not
   * substituted for it — a child almost always needs `PATH`.
   *
   * Never logged, and never included in an error message or context. A caller that passes a
   * credential here expects it to reach the child, not a log file, and this module enforces that
   * by not describing the environment anywhere.
   */
  readonly env?: Readonly<Record<string, string>>;

  /**
   * Wall-clock limit in milliseconds.
   *
   * **No timeout by default.** A test suite may legitimately run for half an hour, and a default
   * chosen here would be either too short to be useful or too long to protect anything. Callers
   * that want protection ask for it.
   */
  readonly timeoutMs?: number;

  /** Cooperative cancellation. Aborting kills the child under the same policy as a timeout. */
  readonly signal?: AbortSignal;

  readonly output?: ProcessOutputPolicy;
}

export interface ProcessResult {
  readonly executable: string;
  /**
   * The exit code. Always defined: a child terminated by a signal is an error rather than a
   * result, so there is no case where a result carries an unknown outcome.
   */
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}
