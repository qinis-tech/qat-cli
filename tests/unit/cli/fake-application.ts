/**
 * A fake application, for tests that exercise the program rather than a command.
 *
 * Not a test file: the unit suite's include pattern is `**\/*.test.ts`, so this module is imported and never
 * collected.
 *
 * ## Why it is a factory rather than a constant
 *
 * The program disposes the application after a command runs, and a test that checks the lifecycle has to observe
 * that. An optional callback records it without a spy, which keeps the fake free of a mocking framework and usable
 * from a test that does not care.
 *
 * ## Why it lives here rather than in `tests/helpers/`
 *
 * Two files in this directory use it and nothing else does. Promoting it to `tests/helpers/` when a second suite
 * needs it is a file move, not a rewrite; importing a CLI-specific fake from a shared directory before then would
 * make it look like a general facility.
 *
 * ## Every member refuses to do anything useful
 *
 * `discovery` and `repository` reject rather than resolve. A test that accidentally calls one should fail with a
 * message naming the call, not silently succeed against a stub that returned nothing.
 */
import type { Application } from "~/core/application/ports.js";

export interface FakeApplicationOptions {
  /** Called when the handler disposes the application. Records the lifecycle without a spy. */
  readonly onDispose?: () => void;
}

export function fakeApplication(
  options: FakeApplicationOptions = {},
): Application {
  return {
    logger: {
      trace: () => undefined,
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      fatal: () => undefined,
    },

    repository: {
      create: () => Promise.resolve(),
      complete: () => Promise.resolve(),
      findById: () => Promise.resolve(undefined),
      list: () => Promise.resolve([]),
      close: () => Promise.resolve(),
    },

    discovery: {
      resolveWorkingDirectory: () =>
        Promise.reject(new Error("discovery is unused in this test")),
      diagnose: () =>
        Promise.reject(new Error("discovery is unused in this test")),
      discover: () =>
        Promise.reject(new Error("discovery is unused in this test")),
    },

    dispose: () => {
      options.onDispose?.();
      return Promise.resolve();
    },
  };
}
