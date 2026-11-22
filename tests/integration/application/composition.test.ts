import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { DestinationStream } from "pino";
import { afterEach, describe, expect, it } from "vitest";

import { createApplication } from "~/app/index.js";
import type { ExecutionRecord } from "~/core/application/ports.js";
import { ErrorCode, InvalidArgumentError } from "~/core/errors/index.js";

/**
 * Integration rather than unit: the thing under test is the assembly of real modules.
 *
 * Every test supplies its own log destination and environment source. Nothing reads the machine the
 * suite runs on, which is what the isolation policy requires and what makes the assertions mean
 * anything.
 */
const created: string[] = [];

function capture(): {
  readonly lines: string[];
  readonly stream: DestinationStream;
} {
  const lines: string[] = [];

  return {
    lines,
    stream: { write: (chunk: string): void => void lines.push(chunk) },
  };
}

async function makeProject(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "qat-app-"));
  created.push(root);

  for (const [path, contents] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  }

  return root;
}

function cypressProject(): Record<string, string> {
  return {
    "package.json": JSON.stringify({ name: "demo", version: "1.0.0" }),
    "cypress.config.ts": "export default {};",
    "node_modules/cypress/package.json": JSON.stringify({
      name: "cypress",
      version: "13.15.0",
    }),
  };
}

function record(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    executionId: "run-1",
    projectRoot: "/project",
    environment: "staging",
    framework: "cypress",
    frameworkVersion: "13.15.0",
    status: "running",
    startedAt: "2026-01-01T10:00:00.000Z",
    evidenceCount: 0,
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(
    created.map((path) => rm(path, { recursive: true, force: true })),
  );
  created.length = 0;
});

describe("assembling an application", () => {
  it("produces the dependencies a command handler needs", () => {
    const application = createApplication({
      environment: {},
      logDestination: capture().stream,
    });

    expect(typeof application.discovery.discover).toBe("function");
    expect(typeof application.repository.create).toBe("function");
    expect(typeof application.logger.info).toBe("function");
    expect(typeof application.dispose).toBe("function");
  });

  it("needs no framework installation to be constructed", () => {
    // The criterion this covers: instantiation must not depend on anything the project under test
    // happens to have installed.
    expect(() =>
      createApplication({ environment: {}, logDestination: capture().stream }),
    ).not.toThrow();
  });

  it("binds every log entry to the application component", () => {
    const sink = capture();
    const application = createApplication({
      environment: {},
      logDestination: sink.stream,
    });

    application.logger.info("assembled");

    expect(JSON.parse(sink.lines[0] ?? "{}")).toMatchObject({
      component: "qat",
      message: "assembled",
    });
  });
});

describe("the wired dependencies work", () => {
  it("discovers a real project through the assembled port", async () => {
    const root = await makeProject(cypressProject());
    const application = createApplication({
      environment: {},
      logDestination: capture().stream,
    });

    await expect(application.discovery.discover(root)).resolves.toMatchObject({
      root,
      name: "demo",
      framework: "cypress",
    });
  });

  it("stores and reads a record through the assembled repository", async () => {
    const application = createApplication({
      environment: {},
      logDestination: capture().stream,
    });

    await application.repository.create(record());

    await expect(
      application.repository.findById("run-1"),
    ).resolves.toMatchObject({
      status: "running",
    });
  });

  it("surfaces a discovery failure as a structured error rather than a crash", async () => {
    const empty = await makeProject({ "readme.md": "" });
    const application = createApplication({
      environment: {},
      logDestination: capture().stream,
    });

    await expect(application.discovery.discover(empty)).rejects.toMatchObject({
      code: ErrorCode.projectNotFound,
    });
  });
});

describe("startup failures", () => {
  it("rejects an unknown log level rather than falling back", () => {
    const attempt = (): unknown => {
      try {
        createApplication({
          logLevel: "chatty",
          environment: {},
          logDestination: capture().stream,
        });
        return undefined;
      } catch (caught: unknown) {
        return caught;
      }
    };

    expect(attempt()).toBeInstanceOf(InvalidArgumentError);
    expect(attempt()).toMatchObject({ code: ErrorCode.invalidArgument });
  });

  it("accepts every level the resolver knows", () => {
    for (const level of ["trace", "debug", "info", "warn", "error", "fatal"]) {
      expect(() =>
        createApplication({
          logLevel: level,
          environment: {},
          logDestination: capture().stream,
        }),
      ).not.toThrow();
    }
  });
});

describe("isolation and lifecycle", () => {
  it("does not read the real process environment when a source is supplied", () => {
    const before = process.env["QAT_LOG_LEVEL"];
    const sink = capture();

    const application = createApplication({
      environment: { QAT_LOG_LEVEL: "error" },
      logDestination: sink.stream,
    });

    application.logger.info("suppressed");
    application.logger.error("kept");

    expect(sink.lines).toHaveLength(1);
    expect(process.env["QAT_LOG_LEVEL"]).toBe(before);
  });

  it("keeps two applications independent", async () => {
    const first = createApplication({
      environment: {},
      logDestination: capture().stream,
    });
    const second = createApplication({
      environment: {},
      logDestination: capture().stream,
    });

    await first.repository.create(record({ executionId: "only-in-first" }));

    await expect(
      second.repository.findById("only-in-first"),
    ).resolves.toBeUndefined();
  });

  it("flushes the logger on dispose", async () => {
    const sink = capture();
    const application = createApplication({
      environment: {},
      logDestination: sink.stream,
    });

    application.logger.info("before shutdown");
    await application.dispose();

    expect(sink.lines).toHaveLength(1);
  });

  it("tolerates dispose being called twice", async () => {
    const application = createApplication({
      environment: {},
      logDestination: capture().stream,
    });

    await application.dispose();

    // Shutdown is reached from a signal handler and from a normal exit; neither is guaranteed to be
    // the only one.
    await expect(application.dispose()).resolves.toBeUndefined();
  });

  it("accepts an injected repository, which is how a --no-history flag would work", async () => {
    const injected = createApplication({
      environment: {},
      logDestination: capture().stream,
    }).repository;

    const application = createApplication({
      environment: {},
      logDestination: capture().stream,
      repository: injected,
    });

    await application.repository.create(record());

    await expect(injected.findById("run-1")).resolves.toBeDefined();
  });
});
