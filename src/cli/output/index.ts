/**
 * Everything the CLI writes to the user.
 *
 * One direction only, and one stream: standard error. stdout is the command's result, and a command
 * that failed has no result — putting the explanation there would make it look like one.
 *
 * Nothing here knows about colour, width or the terminal. That is a rendering decision for later,
 * and getting it wrong now would bake an escape code into a `--json` consumer's input.
 */
import type { RenderedError } from "../../core/errors/index.js";

export function reportError(
  error: RenderedError,
  options: { readonly json: boolean },
): void {
  if (options.json) {
    // One document, so a machine can read the failure without parsing prose.
    process.stderr.write(`${JSON.stringify({ error })}\n`);
    return;
  }

  process.stderr.write(`error ${error.code}: ${error.message}\n`);

  for (const detail of error.details) {
    process.stderr.write(`  ${detail}\n`);
  }

  if (error.remediation !== undefined) {
    // A blank line, because the remediation is advice and advice buried in a block of context is
    // advice nobody reads.
    process.stderr.write(`\n${error.remediation}\n`);
  }
}
