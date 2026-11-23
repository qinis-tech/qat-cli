/**
 * Narrowing helpers for untrusted JSON.
 *
 * A manifest is written by hand, edited by tooling and occasionally generated, so every field starts as
 * `unknown` and has to be narrowed. One helper rather than a cast at each site: a cast inside a parser is
 * how a malformed manifest becomes a runtime failure three modules away, with a message about the module
 * that broke rather than the file that caused it.
 */

/** @returns The value as a plain object, or `undefined` for anything else — including `null` and arrays. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  // Arrays are objects, and treating one as a record would make `section['0']` a dependency name.
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
