/**
 * Everything the CLI writes to the user.
 *
 * Two functions and one rule: results go to standard output, errors go to standard error. A command
 * that succeeded has a result; a command that failed has an explanation, and putting the explanation
 * on the result stream would make a script treat it as data.
 */
import type { RenderedError } from "../../core/errors/index.js";

export interface CommandResult {
  /** Human-readable lines. */
  readonly lines: readonly string[];
  /** The machine-readable form, used when `--json` was given. */
  readonly document: unknown;
}

export function reportResult(
  result: CommandResult,
  options: { readonly json: boolean },
): void {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result.document)}\n`);
    return;
  }

  for (const line of result.lines) {
    process.stdout.write(`${line}\n`);
  }
}

export function reportError(
  error: RenderedError,
  options: { readonly json: boolean },
): void {
  if (options.json) {
    process.stderr.write(`${JSON.stringify({ error })}\n`);
    return;
  }

  process.stderr.write(`error ${error.code}: ${error.message}\n`);

  for (const detail of error.details) {
    process.stderr.write(`  ${detail}\n`);
  }

  if (error.remediation !== undefined) {
    process.stderr.write(`\n${error.remediation}\n`);
  }
}
