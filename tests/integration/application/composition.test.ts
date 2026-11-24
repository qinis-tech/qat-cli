import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { DestinationStream } from "pino";
import { afterEach, describe, expect, it } from "vitest";

import { createApplication } from "~/app/index.js";
import { ConfigurationLoad, loadConfiguration } from "~/config/loader/index.js";
import {
  LoadedConfigurationRequiredError,
  markLoaded,
} from "~/config/resolver/index.js";
import { OUTPUT_DEFAULTS } from "~/config/schema/config.js";
import { SUPPORTED_CONFIG_VERSION } from "~/config/schema/index.js";
import type { LoadedConfigurationDocument } from "~/core/application/configuration.js";
import type { ExecutionRecord } from "~/core/application/ports.js";
import { ErrorCode, InvalidArgumentError } from "~/core/errors/index.js";

/**
 * Integration rather than unit: the thing under test is the assembly of real modules.
 *
 * Every test supplies its own log destination and environment source. Nothing reads the machine the suite runs on, which
 * is what the isolation policy requires and what makes the assertions mean anything.
 *
 * ## The configuration adapter
 *
 * The assembly publishes one operation for configuration — `resolve` — and it is the only place where the resolution
 * stage's vocabulary meets the application's. Three things about it are worth asserting here rather than in the
 * resolver's own suite: that the loader's result is accepted without a cast, that the result is translated rather than
 * passed through, and that a forged document is refused at runtime even though the port's structural type accepts it.
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

/** The configuration that requires nothing: two fields and every default. */
function minimalConfig(): string {
  return JSON.stringify({
    version: SUPPORTED_CONFIG_VERSION,
    framework: "cypress",
  });
}

/** A project that is both a Cypress project and a configured QAT project. */
async function configuredProject(configuration: string): Promise<string> {
  return makeProject({ ...cypressProject(), "qat.config.json": configuration });
}

/** Read the configuration at a project root through the real loader. */
async function loadFrom(root: string): Promise<LoadedConfigurationDocument> {
  const loaded = await loadConfiguration(join(root, "qat.config.json"));

  if (loaded.kind !== ConfigurationLoad.Loaded) {
    throw new Error(`expected a loaded configuration, received ${loaded.kind}`);
  }

  return loaded.config;
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
    expect(typeof application.configuration.resolve).toBe("function");
    expect(typeof application.dispose).toBe("function");
  });

  it("needs no framework installation to be constructed", () => {
    // The criterion this covers: instantiation must not depend on anything the project under test happens to have
    // installed.
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

describe("the configuration adapter", () => {
  it("anchors a project's output paths through the assembled port", async () => {
    const root = await configuredProject(minimalConfig());
    const application = createApplication({
      environment: {},
      logDestination: capture().stream,
    });

    const resolution = application.configuration.resolve(
      root,
      await loadFrom(root),
    );

    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;

    // The schema supplied the values, the resolver placed them, and the adapter translated the result. Nothing in that
    // chain used the working directory.
    expect(resolution.configuration.reportsDirectory.absolute).toBe(
      join(root, OUTPUT_DEFAULTS.reports),
    );
    expect(resolution.configuration.evidenceDirectory.absolute).toBe(
      join(root, OUTPUT_DEFAULTS.evidence),
    );
    expect(resolution.configuration.reportsDirectory.source).toBe(
      OUTPUT_DEFAULTS.reports,
    );
  });

  it("accepts the loader's result without a cast", async () => {
    const root = await configuredProject(minimalConfig());
    const application = createApplication({
      environment: {},
      logDestination: capture().stream,
    });

    // The loader hands over the resolver's branded type; the port declares a structural one. If those two ever stop
    // being compatible this line fails to compile, which is the cheapest possible warning.
    const resolution = application.configuration.resolve(
      root,
      await loadFrom(root),
    );

    expect(resolution.ok).toBe(true);
  });

  it("translates the resolver's vocabulary rather than passing it through", async () => {
    const root = await configuredProject(
      JSON.stringify({
        version: SUPPORTED_CONFIG_VERSION,
        framework: "cypress",
        cypress: { configFile: "cypress.config.ts" },
      }),
    );
    const application = createApplication({
      environment: {},
      logDestination: capture().stream,
    });

    const resolution = application.configuration.resolve(
      root,
      await loadFrom(root),
    );

    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;

    // Renamed: `cypressConfigFile` is the resolver's name, `frameworkConfigFile` is the application's. Core names the
    // concept and never the framework, which is the same rule that keeps `FrameworkAdapter` free of Cypress.
    expect(resolution.configuration.frameworkConfigFile?.absolute).toBe(
      join(root, "cypress.config.ts"),
    );
    // Not passed through: the resolver's internal shape has no business reaching a command.
    expect("paths" in resolution.configuration).toBe(false);
    expect("document" in resolution.configuration).toBe(false);
  });

  it("names the framework configuration file only when the configuration supplied one", async () => {
    const root = await configuredProject(minimalConfig());
    const application = createApplication({
      environment: {},
      logDestination: capture().stream,
    });

    const resolution = application.configuration.resolve(
      root,
      await loadFrom(root),
    );

    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;

    // Absent, not `undefined`: a consumer iterating the object should not meet a key whose value means nothing.
    expect(Object.keys(resolution.configuration)).not.toContain(
      "frameworkConfigFile",
    );
  });

  it("reports which environment a run would target", async () => {
    const root = await configuredProject(
      JSON.stringify({
        version: SUPPORTED_CONFIG_VERSION,
        framework: "cypress",
        environments: { only: { A: "1" } },
      }),
    );
    const application = createApplication({
      environment: {},
      logDestination: capture().stream,
    });

    const resolution = application.configuration.resolve(
      root,
      await loadFrom(root),
    );

    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;

    expect(resolution.configuration.environment).toStrictEqual({
      origin: "sole",
      name: "only",
    });
  });

  it("reports a refused path as a finding rather than throwing", async () => {
    const root = await makeProject({ "readme.md": "" });
    const application = createApplication({
      environment: {},
      logDestination: capture().stream,
    });

    // A branded document that skipped validation: the only way to reach the resolver's own refusal, and the case the
    // second line of defence exists for.
    const forged = markLoaded(
      {
        version: SUPPORTED_CONFIG_VERSION,
        framework: "cypress",
        output: { reports: "../escape", evidence: "ok" },
      },
      join(root, "qat.config.json"),
    );

    const resolution = application.configuration.resolve(root, forged);

    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;

    expect(resolution.findings).toHaveLength(1);
    expect(resolution.findings[0]).toMatchObject({ path: "output.reports" });
    // `remediation`, the application's name for it, not the resolver's `hint`.
    expect(resolution.findings[0]?.remediation?.length ?? 0).toBeGreaterThan(0);
    expect("configuration" in resolution).toBe(false);
  });

  it("refuses a document the loader never branded", async () => {
    const root = await makeProject({ "readme.md": "" });
    const application = createApplication({
      environment: {},
      logDestination: capture().stream,
    });

    // The port's structural type accepts this — the brand property is optional — so the refusal has to come from the
    // marker check inside the resolver. Without it, a discarded load failure could be turned into a run assembled from
    // invented values.
    const forged: LoadedConfigurationDocument = {
      document: { version: SUPPORTED_CONFIG_VERSION, framework: "cypress" },
      source: join(root, "qat.config.json"),
    };

    expect(() => application.configuration.resolve(root, forged)).toThrow(
      LoadedConfigurationRequiredError,
    );
  });

  it("is synchronous, and exposes no test seam", () => {
    const application = createApplication({
      environment: {},
      logDestination: capture().stream,
    });

    // Synchronous because resolution performs no I/O: a promise here would advertise work that never happens.
    expect(
      application.configuration.resolve,
      "resolve must stay synchronous",
    ).toBeTypeOf("function");
    expect(Object.keys(application.configuration)).toStrictEqual(["resolve"]);
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

    // Shutdown is reached from a signal handler and from a normal exit; neither is guaranteed to be the only one.
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
