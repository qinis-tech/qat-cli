/**
 * The command's result, and its failures.
 *
 * ## Two functions per thing, not one
 *
 * Each output has a renderer that returns a string and a writer that sends it somewhere. The renderer is
 * what tests assert on: no spying, no stream, no timing. The writer is a one-line adapter that the
 * end-to-end suite covers by running the real binary.
 *
 * ## Standard output carries the answer, and nothing else
 *
 * A result goes to standard output — as lines for a person, or as one document under `--json`. Messages,
 * warnings, progress and errors go to standard error. The two never mix, which is what makes
 * `qat doctor --json | jq` work and what makes a redirect of standard output contain the answer rather
 * than the answer plus commentary.
 */
import type { RenderedError } from "../../core/errors/index.js";

import { sanitiseForTerminal } from "./messages.js";
import { PROCESS_STREAMS, type OutputStreams } from "./streams.js";

export interface CommandResult {
  /** Human-readable lines, written to standard output unless `--json` was given. */
  readonly lines: readonly string[];
  /**
   * The machine-readable form.
   *
   * Required, not optional: every command has one, even if it is a summary object. Making it optional is
   * how a command ends up with no `--json` support and nobody noticing until someone pipes it.
   */
  readonly document: unknown;
}

export interface OutputOptions {
  readonly json: boolean;
}

/**
 * The text a result produces.
 *
 * Under `--json` the human lines are not written at all — not filtered, not prefixed, absent. A consumer
 * that receives a document should never have to skip past a line that does not parse.
 */
export function renderResult(
  result: CommandResult,
  options: OutputOptions,
): string {
  if (options.json) {
    return `${JSON.stringify(result.document)}\n`;
  }

  if (result.lines.length === 0) return "";

  return `${result.lines.map((line) => sanitiseForTerminal(line)).join("\n")}\n`;
}

/**
 * The text a failure produces.
 *
 * The code comes first because it is the one thing worth quoting in a bug report. The remediation is
 * separated by a blank line because it is advice, and advice buried in a block of context is advice
 * nobody reads.
 */
export function renderError(
  error: RenderedError,
  options: OutputOptions,
): string {
  if (options.json) {
    return `${JSON.stringify({ error })}\n`;
  }

  const lines = [`error: ${error.code}: ${sanitiseForTerminal(error.message)}`];

  for (const detail of error.details) {
    lines.push(`  ${sanitiseForTerminal(detail)}`);
  }

  if (error.remediation !== undefined) {
    lines.push("", sanitiseForTerminal(error.remediation));
  }

  return `${lines.join("\n")}\n`;
}

export function reportResult(
  result: CommandResult,
  options: OutputOptions,
  streams: OutputStreams = PROCESS_STREAMS,
): void {
  const text = renderResult(result, options);

  // Nothing to write is not a reason to write a blank line.
  if (text.length > 0) streams.out.write(text);
}

export function reportError(
  error: RenderedError,
  options: OutputOptions,
  streams: OutputStreams = PROCESS_STREAMS,
): void {
  streams.err.write(renderError(error, options));
}
