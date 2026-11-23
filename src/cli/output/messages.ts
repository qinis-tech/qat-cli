/**
 * Messages about a command, as distinct from its result.
 *
 * ## Every message goes to standard error
 *
 * Standard output carries what the command was asked to produce; standard error carries everything about producing
 * it. A success message is commentary on the work, not the work — so it goes to the second stream, and a pipeline
 * redirecting the first sees only the answer.
 *
 * ## No colour, no symbols, no box drawing
 *
 * A tick character is mojibake in a Windows console using a legacy code page, and colour needs detection, a
 * `--no-color` flag and an environment-variable convention before it can be trusted. Neither is worth the machinery
 * for output a person reads once.
 *
 * ## The failure message lives here too
 *
 * `reportError` is the one message with a code and a second form: prose for a person, a document for a machine. It
 * belongs in this file rather than beside the result writer because it is commentary about a run that failed, and it
 * shares the properties above — standard error, no decoration, and the same filter applied to its text.
 */
import type { RenderedError } from "../../core/errors/index.js";

import { PROCESS_STREAMS, type OutputStreams } from "./streams.js";

export const MessageKind = {
  /** The command did what was asked. */
  Success: "success",
  /** Something worth knowing that is not a problem. */
  Note: "note",
  /** Something unexpected that did not stop the command. */
  Warning: "warning",
  /** A line describing what is happening now. */
  Progress: "progress",
} as const;

export type MessageKind = (typeof MessageKind)[keyof typeof MessageKind];

/**
 * The prefix for each kind. `undefined` means the line stands on its own.
 *
 * Progress is unprefixed because a progress line is usually already a sentence about the work, and a label in front of
 * every one of them is noise.
 */
const LABEL: Readonly<Record<MessageKind, string | undefined>> = {
  [MessageKind.Success]: "success",
  [MessageKind.Note]: "note",
  [MessageKind.Warning]: "warning",
  [MessageKind.Progress]: undefined,
};

// Deliberately matching control characters, in order to remove them. A message that carries a terminal escape sequence
// can move the cursor, clear the screen or forge output that a user believes came from this tool — and the text usually
// arrives from a subprocess or a file rather than from a person.
// eslint-disable-next-line no-control-regex -- matching control characters to strip them
const ANSI_ESCAPE = /\u001B\[[0-9;?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex -- matching control characters to strip them
const OTHER_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/**
 * Removes anything that could act on a terminal rather than appear in it.
 *
 * Newlines and tabs survive: they are how a multi-line message is written. Everything else in the control range is
 * removed, which also protects a log file being read in a terminal later.
 *
 * Applied to every string this module writes, including an error's message, its details and its remediation. Those are
 * the *most* likely to carry foreign output — a detail is often a line from a child process's standard error, and a
 * message names a path a user supplied. Filtering only the friendly messages would be filtering the wrong end.
 */
export function sanitiseForTerminal(text: string): string {
  return text.replace(ANSI_ESCAPE, "").replace(OTHER_CONTROL, "");
}

/** The line a message would produce, without its trailing newline. */
export function renderMessage(kind: MessageKind, text: string): string {
  const body = sanitiseForTerminal(text);
  const label = LABEL[kind];

  return label === undefined ? body : `${label}: ${body}`;
}

/**
 * Writes one message.
 *
 * Always to standard error. Nothing in this module writes to standard output, which is the property that keeps a
 * machine-readable result free of commentary.
 */
export function writeMessage(
  kind: MessageKind,
  text: string,
  streams: OutputStreams = PROCESS_STREAMS,
): void {
  streams.err.write(`${renderMessage(kind, text)}\n`);
}

/**
 * Writes a failure.
 *
 * Standard error in both modes, because a failure has no result: putting it on standard output would make a consumer
 * reading results treat an explanation as one.
 *
 * ## The document form
 *
 * `--json` emits one document rather than a sentence, so a machine can read the failure without parsing prose. Its
 * fields are filtered the same way the prose is, and for a slightly different reason: a document is parsed and then
 * *printed* — by `jq`, by a log viewer, by somebody pasting it into a comment — so the escape sequence that
 * `JSON.stringify` turns into harmless `\u001b` text becomes live again the moment it is rendered. Filtering at the
 * source is the only place that covers every later reader.
 *
 * The cost, stated plainly: a consumer that genuinely needed the original bytes of a message cannot get them. Nothing
 * in this project does, and a control character in an error message is almost always an injection attempt or a
 * subprocess artefact rather than information.
 */
export function reportError(
  error: RenderedError,
  options: { readonly json: boolean },
  streams: OutputStreams = PROCESS_STREAMS,
): void {
  if (options.json) {
    streams.err.write(
      `${JSON.stringify({
        error: {
          ...error,
          message: sanitiseForTerminal(error.message),
          details: error.details.map(sanitiseForTerminal),
          ...(error.remediation === undefined
            ? {}
            : { remediation: sanitiseForTerminal(error.remediation) }),
        },
      })}\n`,
    );
    return;
  }

  // The code comes before the message, on the same line, because it is the part a reader greps for and the part
  // they quote in a bug report.
  streams.err.write(
    `error ${error.code}: ${sanitiseForTerminal(error.message)}\n`,
  );

  for (const detail of error.details) {
    // Indented, because a detail belongs to the line above it rather than standing on its own.
    streams.err.write(`  ${sanitiseForTerminal(detail)}\n`);
  }

  if (error.remediation !== undefined) {
    // A blank line, because the remediation is advice and advice buried in a block of context is advice nobody reads.
    streams.err.write(`\n${sanitiseForTerminal(error.remediation)}\n`);
  }
}
