/**
 * Messages about a command, as distinct from its result.
 *
 * ## Every message goes to standard error
 *
 * Standard output carries what the command was asked to produce; standard error carries everything
 * about producing it. A success message is commentary on the work, not the work — so it goes to the
 * second stream, and a pipeline redirecting the first sees only the answer.
 *
 * ## No colour, no symbols, no box drawing
 *
 * A tick character is mojibake in a Windows console using a legacy code page, and colour needs
 * detection, a `--no-color` flag and an environment-variable convention before it can be trusted.
 * Neither is worth the machinery for output a person reads once.
 */
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
 * Progress is unprefixed because a progress line is usually already a sentence about the work, and a
 * label in front of every one of them is noise.
 */
const LABEL: Readonly<Record<MessageKind, string | undefined>> = {
  [MessageKind.Success]: "success",
  [MessageKind.Note]: "note",
  [MessageKind.Warning]: "warning",
  [MessageKind.Progress]: undefined,
};

// Deliberately matching control characters, in order to remove them. A message that carries a terminal
// escape sequence can move the cursor, clear the screen or forge output that a user believes came from
// this tool — and the text usually arrives from a subprocess or a file rather than from a person.
// eslint-disable-next-line no-control-regex -- matching control characters to strip them
const ANSI_ESCAPE = /\u001B\[[0-9;?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex -- matching control characters to strip them
const OTHER_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/**
 * Removes anything that could act on a terminal rather than appear in it.
 *
 * Newlines and tabs survive: they are how a multi-line message is written. Everything else in the
 * control range is removed, which also protects a log file being read in a terminal later.
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
 * Always to standard error. Nothing in this module writes to standard output, which is the property that
 * keeps a machine-readable result free of commentary.
 */
export function writeMessage(
  kind: MessageKind,
  text: string,
  streams: OutputStreams = PROCESS_STREAMS,
): void {
  streams.err.write(`${renderMessage(kind, text)}\n`);
}
