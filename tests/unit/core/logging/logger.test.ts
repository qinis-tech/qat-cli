import type { DestinationStream } from "pino";
import { describe, expect, it } from "vitest";

import {
  createLogger,
  DEFAULT_LOG_LEVEL,
  LogLevel,
  REDACTION_CENSOR,
  resolveLogLevel,
} from "~/core/logging/index.js";

/**
 * Shape of a serialised log entry.
 *
 * The named fields are the ones the logger itself guarantees: pino always emits a level, a
 * message and a timestamp, and the factory may bind a component and a run identifier.
 * Declaring them makes dot access meaningful.
 *
 * The index signature covers call-specific context. Those fields are read with brackets,
 * which is what `noPropertyAccessFromIndexSignature` requires and which reads correctly: a
 * bracket says "this test asserts a field whose presence no type promises".
 */
interface LoggedEntry {
  readonly level?: string;
  readonly message?: string;
  readonly time?: string;
  readonly component?: string;
  readonly runId?: string;
  readonly [key: string]: unknown;
}

/**
 * Captures emitted lines so assertions can be made on the actual serialised output rather
 * than on a mock's call arguments. A mock would pass while the JSON was malformed.
 *
 * `at()` exists because `noUncheckedIndexedAccess` makes every index access nullable. The
 * alternative — a non-null assertion at each call site — would turn a missing entry into a
 * `TypeError` about reading properties of undefined, which says nothing about what the test
 * expected. Failing with the index and the count is worth the ten lines.
 */
interface Capture {
  readonly lines: string[];
  readonly stream: DestinationStream;
  /** Every entry, parsed. */
  entries(): LoggedEntry[];
  /** The entry at `index`, failing loudly when it was not emitted. */
  at(index: number): LoggedEntry;
}

function capture(): Capture {
  const lines: string[] = [];

  const entries = (): LoggedEntry[] =>
    lines.map((line) => JSON.parse(line) as LoggedEntry);

  return {
    lines,
    stream: {
      write(chunk: string): void {
        lines.push(chunk);
      },
    },
    entries,
    at(index: number): LoggedEntry {
      const entry = entries()[index];

      if (entry === undefined) {
        throw new Error(
          `Expected a log entry at index ${index}, but ${lines.length} ${lines.length === 1 ? "entry was" : "entries were"} emitted.`,
        );
      }

      return entry;
    },
  };
}

describe("logger output structure", () => {
  it("emits one JSON object per entry with a level label, an ISO timestamp and a message", () => {
    const sink = capture();
    const logger = createLogger({
      destination: sink.stream,
      level: LogLevel.Info,
    });

    logger.info("resolved configuration");

    expect(sink.lines).toHaveLength(1);

    const entry = sink.at(0);

    expect(entry.level).toBe("info");
    expect(entry.message).toBe("resolved configuration");
    expect(entry.time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("binds component context to every entry", () => {
    const sink = capture();
    const logger = createLogger({ destination: sink.stream }).forComponent(
      "cypress-adapter",
    );

    logger.warn("adapter unavailable");

    expect(sink.at(0).component).toBe("cypress-adapter");
  });

  it("binds a run identifier so entries can be correlated", () => {
    const sink = capture();
    const logger = createLogger({ destination: sink.stream }).forRun("run-42");

    logger.info("suite started");
    logger.info("suite finished");

    expect(sink.entries().map((entry) => entry.runId)).toStrictEqual([
      "run-42",
      "run-42",
    ]);
  });

  it("does not leak child bindings to the parent", () => {
    const sink = capture();
    const parent = createLogger({ destination: sink.stream });
    const child = parent.forComponent("child");

    child.info("from child");
    parent.info("from parent");

    expect(sink.at(0).component).toBe("child");
    expect(sink.at(1).component).toBeUndefined();
  });

  it("merges context into the entry", () => {
    const sink = capture();
    const logger = createLogger({ destination: sink.stream });

    logger.info("spec finished", { specPath: "login.cy.ts", durationMs: 1200 });

    expect(sink.at(0)).toMatchObject({
      specPath: "login.cy.ts",
      durationMs: 1200,
    });
  });

  it("omits pid and hostname", () => {
    const sink = capture();
    const logger = createLogger({ destination: sink.stream });

    logger.info("anything");

    // Neither is useful in a single-process CLI, and hostname is mildly identifying when a
    // log is pasted into an issue.
    expect(sink.at(0)).not.toHaveProperty("pid");
    expect(sink.at(0)).not.toHaveProperty("hostname");
  });
});

describe("level filtering", () => {
  it("suppresses entries below the configured level", () => {
    const sink = capture();
    const logger = createLogger({
      destination: sink.stream,
      level: LogLevel.Warn,
    });

    logger.debug("invisible");
    logger.info("invisible");
    logger.warn("visible");
    logger.error("visible");

    expect(sink.entries().map((entry) => entry.level)).toStrictEqual([
      "warn",
      "error",
    ]);
  });

  it("reports whether a level would be emitted", () => {
    const sink = capture();
    const logger = createLogger({
      destination: sink.stream,
      level: LogLevel.Warn,
    });

    expect(logger.isLevelEnabled(LogLevel.Debug)).toBe(false);
    expect(logger.isLevelEnabled(LogLevel.Warn)).toBe(true);
  });

  it("resolves the level from flag, then environment, then default", () => {
    expect(resolveLogLevel({ flag: "debug", environment: "error" })).toBe(
      "debug",
    );
    expect(resolveLogLevel({ environment: "error" })).toBe("error");
    expect(resolveLogLevel({})).toBe(DEFAULT_LOG_LEVEL);
    // An invalid environment value must not stop a run.
    expect(resolveLogLevel({ environment: "chatty" })).toBe(DEFAULT_LOG_LEVEL);
  });
});

describe("redaction", () => {
  it("redacts a top-level secret", () => {
    const sink = capture();
    const logger = createLogger({ destination: sink.stream });

    logger.info("authenticated", { token: "super-secret-value" });

    expect(sink.lines.join("")).not.toContain("super-secret-value");
    expect(sink.at(0)["token"]).toBe(REDACTION_CENSOR);
  });

  it("redacts a secret one level deep", () => {
    const sink = capture();
    const logger = createLogger({ destination: sink.stream });

    logger.info("configuration loaded", {
      credentials: { password: "hunter2-example" },
    });

    expect(sink.lines.join("")).not.toContain("hunter2-example");
    expect(sink.lines.join("")).toContain(REDACTION_CENSOR);
  });

  it("redacts a request header carrying a bearer token", () => {
    const sink = capture();
    const logger = createLogger({ destination: sink.stream });

    logger.info("calling upstream", {
      headers: { authorization: "Bearer abc123-example" },
    });

    expect(sink.lines.join("")).not.toContain("abc123-example");
  });

  it("leaves non-sensitive fields intact", () => {
    const sink = capture();
    const logger = createLogger({ destination: sink.stream });

    logger.info("spec finished", { specPath: "login.cy.ts", tokenCount: 4 });

    expect(sink.at(0)["specPath"]).toBe("login.cy.ts");
    expect(sink.at(0)["tokenCount"]).toBe(4);
  });
});

describe("resilience", () => {
  it("does not throw when the destination fails, and reports once", () => {
    const reported: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);

    // Capture the guard's one-time complaint without swallowing the real assertion.
    process.stderr.write = (chunk: string) => {
      reported.push(chunk);
      return true;
    };

    try {
      const logger = createLogger({
        destination: {
          write(): void {
            throw new Error("disk full");
          },
        },
      });

      // Neither call may throw. A log statement that throws inside a catch block replaces
      // the application's real failure with a logging failure, which is worse than silence.
      expect(() => {
        logger.info("first");
      }).not.toThrow();

      expect(() => {
        logger.info("second");
      }).not.toThrow();

      expect(reported).toHaveLength(1);
      expect(reported[0]).toContain("disk full");
    } finally {
      process.stderr.write = originalWrite;
    }
  });
});
