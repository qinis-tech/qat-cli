/**
 * Where output goes.
 *
 * An interface rather than direct writes to the process streams, so a test asserts on the text a user
 * would see without spying on a global. Spying on `process.stdout.write` observes the call rather than
 * the result, and it fails the moment two tests run against it at once.
 *
 * The interface is deliberately the smallest thing that works: `write`. Nothing here buffers, encodes,
 * measures or colours.
 */
export interface OutputStreams {
  readonly out: { write(text: string): void };
  readonly err: { write(text: string): void };
}

/** The real streams, named rather than inlined, so the default is one object to replace in a test. */
export const PROCESS_STREAMS: OutputStreams = {
  out: process.stdout,
  err: process.stderr,
};
