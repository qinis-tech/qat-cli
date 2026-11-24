/**
 * Turning configuration text into a value, and failing in a way a reader can act on.
 *
 * Pure: no filesystem, no clock, no schema. That is what makes the three answers testable as literals — including the
 * malformed one, whose whole value is the position it reports. A parser whose tests need a temporary directory is a
 * parser whose error positions are checked once and understood never.
 *
 * ## What it does not do
 *
 * It does not validate. `{"version": 2}` is parsed and returned, because "is this JSON" and "is this a configuration"
 * are different questions asked by different layers. It does not refuse dangerous-looking keys either: the schema does
 * that, and a second place that knew which names are forbidden would be a second place to keep in step with the first.
 * The document comes back exactly as written.
 */
import type { JsonLocation } from "./contracts.js";

/**
 * The byte-order mark.
 *
 * A file saved by an editor that writes one starts with U+FEFF, and `JSON.parse` rejects the prefix — the text is not
 * JSON, the text is JSON with an invisible character in front of it. Every other defect in a configuration belongs to
 * whoever wrote it; this one belongs to their editor, it happens on the platform most likely to produce it, and refusing
 * the file would report a perfectly good configuration as broken.
 *
 * Only the leading mark, and only once. A BOM in the middle of a document is not a BOM, it is invalid JSON, and saying so
 * is correct.
 */
const BOM = "\uFEFF";

/**
 * Whitespace only, which is what an "empty" file contains.
 *
 * Not `length === 0`: a file holding a newline is empty to a reader, and telling them it is malformed because
 * `JSON.parse('\n')` says "unexpected end of input at position 1" would be pedantry.
 */
const BLANK = /^\s*$/;

/** Long enough to show a reader where they are, short enough to sit beside a label on one terminal line. */
const EXCERPT_LENGTH = 120;

/**
 * The parser's answer.
 *
 * Three variants rather than two, because an empty file and a broken one have different fixes — write something, versus
 * correct a comma — and `JSON.parse` cannot tell them apart in a way a reader would recognise.
 */
export type JsonParse =
  | { readonly kind: "parsed"; readonly value: unknown }
  | { readonly kind: "empty" }
  | {
      readonly kind: "malformed";
      readonly reason: string;
      readonly location: JsonLocation;
    };

/**
 * Parses a JSON document.
 *
 * @param text The file's contents, as read.
 * @returns One of three answers. A syntax error is returned rather than thrown, because it is a statement about the file
 *   rather than a failure of this function.
 * @throws {Error} only when the runtime throws something that is not a `SyntaxError` — which would be a defect in the
 *   runtime rather than a problem with the document. Rethrown unchanged, so it is never reported as the author's mistake.
 */
export function parseJsonDocument(text: string): JsonParse {
  const body = text.startsWith(BOM) ? text.slice(BOM.length) : text;

  // Before parsing, because `JSON.parse('')` reports "unexpected end of input at position 0" — accurate, and it tells the
  // reader nothing they can act on.
  if (BLANK.test(body)) return { kind: "empty" };

  try {
    return { kind: "parsed", value: JSON.parse(body) as unknown };
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;

    return {
      kind: "malformed",
      reason: error.message,
      location: locate(body, error.message),
    };
  }
}

/**
 * Where the parser stopped, in the three forms a reader needs.
 *
 * The offset is taken from the engine's own message, because only the engine knows it. Line, column and excerpt are
 * computed from the text, so a runtime that adds or drops its own "(line 3 column 5)" suffix — as V8 has done — changes
 * nothing observable here.
 *
 * A message with no offset in it falls back to position zero rather than failing. That would be a runtime that reports an
 * unlocatable syntax error, and a slightly wrong location is more useful than no answer at all.
 */
function locate(text: string, message: string): JsonLocation {
  const reported = /position (\d+)/.exec(message);
  const position = Math.min(
    reported?.[1] === undefined ? 0 : Number.parseInt(reported[1], 10),
    text.length,
  );

  const before = text.slice(0, position);

  // One-based, and counting from the last newline rather than the file start: `lastIndexOf` returns -1 when there is no
  // newline, so the `+ 1` falls out of the subtraction rather than needing a branch.
  const line = before.split("\n").length;
  const column = position - before.lastIndexOf("\n");

  return { position, line, column, excerpt: excerptAt(text, line) };
}

/**
 * The line the parser stopped on, trimmed and bounded.
 *
 * Trimmed because the reader needs the content rather than the indentation, and bounded because the message it lands in
 * sits beside a label on one line. The ellipsis is three dots rather than a character: this text reaches a terminal, and a
 * console on a legacy code page renders anything else as mojibake.
 *
 * Control characters are left alone here. A stray escape sequence in a configuration line is the author's, and the output
 * layer already filters everything it writes — filtering twice would mean two places deciding what is safe to print.
 */
function excerptAt(text: string, line: number): string {
  const content = text.split("\n")[line - 1]?.trim() ?? "";

  return content.length <= EXCERPT_LENGTH
    ? content
    : `${content.slice(0, EXCERPT_LENGTH)}...`;
}
