/**
 * Resolved secret values, in a container that refuses to be read incidentally.
 *
 * ## Why a class and not a record
 *
 * A `Record<string, string>` of secrets is a value that travels: it gets logged with the object it sits in, spread into a
 * debug line, serialised into a `--json` document, and printed by a test that failed. Every one of those is a leak that
 * nobody did on purpose.
 *
 * This container serialises to `[redacted]`, prints as `[redacted]`, and has no enumerable own properties, so every one
 * of those accidents produces a line that is obviously stripped rather than a credential that is obviously in it.
 *
 * ## The one accessor that returns the values
 *
 * `entriesForFramework` exists because the adapter must eventually put these into a child process environment. It is
 * named for its single caller on purpose: a reviewer who sees it anywhere else has found a leak.
 */
export class ResolvedSecrets {
  readonly #values: ReadonlyMap<string, string>;

  private constructor(values: ReadonlyMap<string, string>) {
    this.#values = values;
    Object.freeze(this);
  }

  static empty(): ResolvedSecrets {
    return new ResolvedSecrets(new Map());
  }

  /** Built from resolved entries; later keys win, which is the only sensible reading of a duplicate. */
  static from(entries: Iterable<readonly [string, string]>): ResolvedSecrets {
    return new ResolvedSecrets(new Map(entries));
  }

  get size(): number {
    return this.#values.size;
  }

  has(name: string): boolean {
    return this.#values.has(name);
  }

  /** The names only. Safe to log, and the part a diagnostic is allowed to mention. */
  names(): readonly string[] {
    return [...this.#values.keys()];
  }

  /** The values, for the framework adapter and nothing else. */
  entriesForFramework(): readonly (readonly [string, string])[] {
    return [...this.#values.entries()];
  }

  /** Serialisation is where a leak usually happens: JSON.stringify on the enclosing object. */
  toJSON(): Readonly<Record<string, string>> {
    return Object.fromEntries(this.names().map((name) => [name, REDACTED]));
  }

  toString(): string {
    return `ResolvedSecrets(${String(this.#values.size)} redacted)`;
  }
}

/** One spelling, so a test can assert the exact thing that appears instead of a value. */
export const REDACTED = "[redacted]";
