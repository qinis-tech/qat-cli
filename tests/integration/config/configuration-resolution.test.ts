/**
 * Loading and resolving a configuration, against a real filesystem.
 *
 * The unit suites cover each stage against literals. This one covers the seam between them: a file on disk becomes a
 * document, the document becomes anchored paths, and the three things that only appear when both stages are real are
 * asserted here —
 *
 * - a configured path that the schema refuses **never reaches resolution**, and a path the schema accepts is anchored
 *   without being second-guessed;
 * - a profile reaches resolution exactly as the reader wrote it, because this stage carries environments and does not
 *   interpret them; and
 * - nothing is created on disk by loading or resolving, which is the policy that keeps `qat init` from leaving empty
 *   output directories behind.
 *
 * The documents are written as JSON and read back through `loadConfiguration`, never constructed in memory: a test that
 * built a document directly would prove the resolver works and would not prove that a reader's file reaches it.
 */
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ConfigurationLoad, loadConfiguration } from "~/config/loader/index.js";
import {
  LoadedConfigurationRequiredError,
  markLoaded,
  type ConfigurationResolution,
  type LoadedConfigurationDocument,
  type ResolvedConfiguration,
} from "~/config/resolver/contracts.js";
import {
  outputDirectories,
  resolveConfiguration,
} from "~/config/resolver/index.js";
import {
  OUTPUT_DEFAULTS,
  SUPPORTED_CONFIG_VERSION,
  SecretSource,
} from "~/config/schema/index.js";
import { ConfigurationDiagnosticCode } from "~/config/validation/index.js";

/* -------------------------------------------------------------------------- */
/* A project on disk                                                          */
/* -------------------------------------------------------------------------- */

let created: string[] = [];

/** Write a project and return its root. Empty directories are not created: only files matter here. */
async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "qat-resolve-"));
  created.push(root);

  for (const [name, contents] of Object.entries(files)) {
    const path = join(root, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
  }

  return root;
}

/** The two required fields, at the version this build reads. */
function minimal(): string {
  return JSON.stringify({
    version: SUPPORTED_CONFIG_VERSION,
    framework: "cypress",
  });
}

function withOutput(output: Record<string, unknown>): string {
  return JSON.stringify({
    version: SUPPORTED_CONFIG_VERSION,
    framework: "cypress",
    output,
  });
}

function withEnvironments(
  environments: Record<string, unknown>,
  defaultEnvironment?: string,
): string {
  return JSON.stringify({
    version: SUPPORTED_CONFIG_VERSION,
    framework: "cypress",
    ...(defaultEnvironment === undefined ? {} : { defaultEnvironment }),
    environments,
  });
}

/** A profile with every approved field, as a reader would write it. */
const STAGING_PROFILE = {
  baseUrl: "https://staging.example.test",
  variables: {
    API_URL: "https://staging.example.test/api",
    RETRIES: "2",
  },
  secrets: {
    API_TOKEN: {
      from: SecretSource.Environment,
      name: "QAT_STAGING_API_TOKEN",
    },
  },
};

/**
 * Load the configuration at the project root and resolve it.
 *
 * Both stages are the production ones, with nothing substituted: the point of an integration test here is that a real
 * file produces real anchored paths.
 */
async function resolveIn(root: string): Promise<ConfigurationResolution> {
  const loaded = await loadConfiguration(join(root, "qat.config.json"));

  if (loaded.kind !== ConfigurationLoad.Loaded) {
    throw new Error(`expected a loaded configuration, received ${loaded.kind}`);
  }

  return resolveConfiguration({ loaded: loaded.config, projectRoot: root });
}

/** The resolved half of a successful resolution, or a failure naming what was reported instead. */
function resolvedOrFail(
  resolution: ConfigurationResolution,
): ResolvedConfiguration {
  if (!resolution.ok) {
    throw new Error(
      `expected a resolution, received ${resolution.issues.map((issue) => issue.code).join(", ")}`,
    );
  }
  return resolution.resolved;
}

afterEach(async () => {
  await Promise.all(
    created.map((path) => rm(path, { recursive: true, force: true })),
  );
  created = [];
});

/* -------------------------------------------------------------------------- */
/* Defaults, end to end                                                       */
/* -------------------------------------------------------------------------- */

describe("a project with a minimal configuration", () => {
  it("anchors the schema's default output paths against the project root", async () => {
    const root = await project({ "qat.config.json": minimal() });

    const resolved = resolvedOrFail(await resolveIn(root));

    // The schema supplied the values; the resolver placed them. Neither stage guessed, and the anchor is the root rather
    // than the working directory.
    expect(resolved.paths.reportsDirectory.source).toBe(
      OUTPUT_DEFAULTS.reports,
    );
    expect(resolved.paths.reportsDirectory.absolute).toBe(
      join(root, OUTPUT_DEFAULTS.reports),
    );
    expect(resolved.paths.evidenceDirectory.absolute).toBe(
      join(root, OUTPUT_DEFAULTS.evidence),
    );
    expect(resolved.paths.reportsDirectory.withinProjectRoot).toBe(true);
  });

  it("keeps a path the reader chose, and fills only the other one", async () => {
    const root = await project({
      "qat.config.json": withOutput({ reports: "artifacts/runs" }),
    });

    const resolved = resolvedOrFail(await resolveIn(root));

    // A supplied group is filled, never replaced: losing `evidence` here would surface much later as a report written to
    // `undefined`.
    expect(resolved.paths.reportsDirectory.absolute).toBe(
      join(root, "artifacts/runs"),
    );
    expect(resolved.paths.evidenceDirectory.absolute).toBe(
      join(root, OUTPUT_DEFAULTS.evidence),
    );
  });

  it("carries the configured form beside the anchored one", async () => {
    const root = await project({
      "qat.config.json": withOutput({
        reports: "artifacts/runs",
        evidence: "artifacts/proof",
      }),
    });

    const resolved = resolvedOrFail(await resolveIn(root));

    // Diagnostics quote `source`; writers use `absolute`. A resolved path that had lost its source form could not explain
    // which line of the reader's file produced it.
    expect(resolved.paths.reportsDirectory.source).toBe("artifacts/runs");
    expect(resolved.paths.reportsDirectory.form).toBe("relative");
  });
});

/* -------------------------------------------------------------------------- */
/* Anchoring                                                                  */
/* -------------------------------------------------------------------------- */

describe("anchoring", () => {
  it("does not depend on the working directory", async () => {
    const root = await project({ "qat.config.json": minimal() });
    const before = process.cwd();

    try {
      process.chdir(tmpdir());
      const resolved = resolvedOrFail(await resolveIn(root));

      // The defect this whole stage exists to remove: resolving from a different directory would put output beside the
      // process rather than beside the project.
      expect(resolved.paths.reportsDirectory.absolute.startsWith(root)).toBe(
        true,
      );
    } finally {
      process.chdir(before);
    }
  });

  it("produces the same paths for a root spelled with a trailing separator", async () => {
    const root = await project({ "qat.config.json": minimal() });

    const plain = resolvedOrFail(await resolveIn(root));
    const withSeparator = resolvedOrFail(
      resolveConfiguration({
        loaded: markLoaded(
          {
            version: SUPPORTED_CONFIG_VERSION,
            framework: "cypress",
            output: OUTPUT_DEFAULTS,
          },
          join(root, "qat.config.json"),
        ),
        projectRoot: `${root}${sep}`,
      }),
    );

    // One location, one canonical form: otherwise two configurations that differ only in spelling produce two values that
    // compare unequal and print differently.
    expect(withSeparator.paths.reportsDirectory.absolute).toBe(
      plain.paths.reportsDirectory.absolute,
    );
  });

  it("anchors a framework configuration file the configuration names", async () => {
    const root = await project({
      "qat.config.json": JSON.stringify({
        version: SUPPORTED_CONFIG_VERSION,
        framework: "cypress",
        cypress: { configFile: "cypress.config.ts" },
      }),
      "cypress.config.ts": "export default {};\n",
    });

    const resolved = resolvedOrFail(await resolveIn(root));

    // The schema types this field as a relative project path, so the value that reaches resolution is relative and is
    // anchored here. An absolute spelling is refused during validation, which is why acceptance of absolute input paths
    // is covered in `paths.test.ts` rather than through a file.
    expect(resolved.paths.cypressConfigFile?.absolute).toBe(
      join(root, "cypress.config.ts"),
    );
    expect(resolved.paths.cypressConfigFile?.form).toBe("relative");
    expect(resolved.paths.cypressConfigFile?.withinProjectRoot).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Refused paths                                                              */
/* -------------------------------------------------------------------------- */

describe("a path that must be refused", () => {
  it("is refused by the schema before resolution sees it", async () => {
    const root = await project({
      "qat.config.json": withOutput({ evidence: "../outside" }),
    });

    const loaded = await loadConfiguration(join(root, "qat.config.json"));

    // The schema owns admissibility: whether a path is relative and inside the project is decided while the document is
    // being read, with a diagnostic that names the field. Resolution never runs, which is why the field name in the
    // message matches the one in the file.
    expect(loaded.kind).toBe(ConfigurationLoad.Invalid);
    if (loaded.kind !== ConfigurationLoad.Invalid) return;

    expect(loaded.diagnostics.map((diagnostic) => diagnostic.path)).toContain(
      "output.evidence",
    );
    expect(loaded.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      ConfigurationDiagnosticCode.RefusedValue,
    );
  });

  it("is refused by the schema when it is absolute", async () => {
    const root = await project({
      "qat.config.json": withOutput({ reports: "/var/reports" }),
    });

    const loaded = await loadConfiguration(join(root, "qat.config.json"));

    expect(loaded.kind).toBe(ConfigurationLoad.Invalid);
    if (loaded.kind !== ConfigurationLoad.Invalid) return;

    expect(loaded.diagnostics.map((diagnostic) => diagnostic.path)).toContain(
      "output.reports",
    );
  });

  it("is refused by the resolver as well, when the document did not come through the schema", async () => {
    const root = await project({});

    // Defence in depth, exercised deliberately: a branded document that skipped validation still cannot anchor an
    // escaping path. This is the case that makes the second line of defence worth having, and the only way to reach it —
    // through the loader, the schema has already refused.
    const resolution = resolveConfiguration({
      loaded: markLoaded(
        {
          version: 1,
          framework: "cypress",
          output: { reports: "../escape", evidence: "ok" },
        },
        join(root, "qat.config.json"),
      ),
      projectRoot: root,
    });

    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;

    expect(resolution.issues).toHaveLength(1);
    expect(resolution.issues[0]).toMatchObject({
      code: "PATH_OUTSIDE_PROJECT_ROOT",
      field: "output.reports",
    });
    // A failure carries no resolved value: a configuration that cannot be anchored must not be used in part.
    expect("resolved" in resolution).toBe(false);
  });

  it("refuses an unknown field at the schema, not at resolution", async () => {
    const root = await project({
      "qat.config.json": JSON.stringify({
        version: SUPPORTED_CONFIG_VERSION,
        framework: "cypress",
        reports: { directory: "out" },
      }),
    });

    const loaded = await loadConfiguration(join(root, "qat.config.json"));

    // A misspelled or outdated key is named while the document is read. If it reached resolution, this stage would fill
    // fields nobody wrote and validation would later reject every project for them.
    expect(loaded.kind).toBe(ConfigurationLoad.Invalid);
    if (loaded.kind !== ConfigurationLoad.Invalid) return;

    expect(loaded.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      ConfigurationDiagnosticCode.UnknownField,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Environments                                                               */
/* -------------------------------------------------------------------------- */

describe("an environment", () => {
  it("reaches resolution exactly as the reader wrote it", async () => {
    const root = await project({
      "qat.config.json": withEnvironments({ staging: STAGING_PROFILE }),
    });

    const resolved = resolvedOrFail(await resolveIn(root));

    // The resolution stage carries environments and does not interpret them: it does not strip a profile down to its
    // variables, expand a secret reference, or add a field the reader did not write. Whatever reads a profile later sees
    // what the file said.
    expect(resolved.document.environments).toStrictEqual({
      staging: STAGING_PROFILE,
    });
  });

  it("is not resolved by this stage, so a secret stays a reference", async () => {
    const root = await project({
      "qat.config.json": withEnvironments({ staging: STAGING_PROFILE }),
    });

    const resolved = resolvedOrFail(await resolveIn(root));
    const environments = resolved.document.environments as Record<
      string,
      { secrets?: Record<string, { from?: string; name?: string }> }
    >;

    // A reference is a promise something else keeps. Resolution naming the source and nothing more is what keeps a
    // credential out of every value this stage hands downstream.
    expect(environments["staging"]?.secrets?.["API_TOKEN"]).toStrictEqual({
      from: SecretSource.Environment,
      name: "QAT_STAGING_API_TOKEN",
    });
  });

  it("uses the one the configuration names", async () => {
    const root = await project({
      "qat.config.json": withEnvironments(
        {
          staging: STAGING_PROFILE,
          production: { baseUrl: "https://example.test" },
        },
        "staging",
      ),
    });

    expect(
      resolvedOrFail(await resolveIn(root)).defaultEnvironment,
    ).toStrictEqual({
      origin: "configured",
      name: "staging",
    });
  });

  it("uses the only environment declared", async () => {
    const root = await project({
      "qat.config.json": withEnvironments({
        only: { variables: { A: "1" } },
      }),
    });

    expect(
      resolvedOrFail(await resolveIn(root)).defaultEnvironment,
    ).toStrictEqual({
      origin: "sole",
      name: "only",
    });
  });

  it("refuses to choose between several", async () => {
    const root = await project({
      "qat.config.json": withEnvironments({
        staging: { variables: { A: "1" } },
        production: { variables: { A: "2" } },
      }),
    });

    // A valid configuration, and an unresolved target. The document is fine; the run is what has no answer. Reporting
    // `none` keeps the decision where it belongs — with the command that needs an environment.
    expect(
      resolvedOrFail(await resolveIn(root)).defaultEnvironment,
    ).toStrictEqual({
      origin: "none",
    });
  });

  it("is refused at the schema when a profile declares nothing", async () => {
    const root = await project({
      "qat.config.json": withEnvironments({ staging: {} }),
    });

    const loaded = await loadConfiguration(join(root, "qat.config.json"));

    // A profile that validates as an object and applies nothing would be selected, reported, and change no behaviour —
    // so it is refused while the document is read, at the profile's own path.
    expect(loaded.kind).toBe(ConfigurationLoad.Invalid);
    if (loaded.kind !== ConfigurationLoad.Invalid) return;

    expect(loaded.diagnostics.map((diagnostic) => diagnostic.path)).toContain(
      "environments.staging",
    );
  });

  it("refuses a reserved profile name read from a real file", async () => {
    // Written as text, because this is the only way the key exists: `JSON.parse` keeps `__proto__` as an own property,
    // and the guard that refuses it is the one thing in the schema that has to inspect the raw value before anything
    // rebuilds it. A unit test can construct the case; only a real file proves it arrives.
    const root = await project({
      "qat.config.json": `{"version": ${String(SUPPORTED_CONFIG_VERSION)}, "framework": "cypress", "environments": {"__proto__": {"baseUrl": "https://example.test"}}}`,
    });

    const loaded = await loadConfiguration(join(root, "qat.config.json"));

    expect(loaded.kind).toBe(ConfigurationLoad.Invalid);
    if (loaded.kind !== ConfigurationLoad.Invalid) return;

    expect(loaded.diagnostics.map((diagnostic) => diagnostic.path)).toContain(
      "environments.__proto__",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The loaded-document guard                                                  */
/* -------------------------------------------------------------------------- */

describe("a document that did not come through the loader", () => {
  it("is refused, whatever it contains", async () => {
    const root = await project({});

    // No assertion here, and that is the point of the test. The brand property is optional, so this object genuinely
    // satisfies `LoadedConfigurationDocument`: the compiler cannot tell a forged document from a loaded one, and does not
    // try. What refuses it is the non-enumerable marker that only `markLoaded` sets, checked inside the resolver — which
    // is why the check exists at runtime rather than in the type.
    const forged: LoadedConfigurationDocument = {
      document: { version: 1, framework: "cypress" },
      source: join(root, "qat.config.json"),
    };

    expect(() =>
      resolveConfiguration({ loaded: forged, projectRoot: root }),
    ).toThrow(LoadedConfigurationRequiredError);
  });
});

/* -------------------------------------------------------------------------- */
/* Nothing is created                                                         */
/* -------------------------------------------------------------------------- */

describe("side effects on disk", () => {
  it("creates no directories while loading or resolving", async () => {
    const root = await project({ "qat.config.json": minimal() });

    const resolved = resolvedOrFail(await resolveIn(root));

    // The lazy-creation policy, asserted rather than assumed: a project that has been inspected but never run contains
    // exactly one file. Empty output directories are repository noise and a misleading signal.
    expect((await readdir(root)).sort()).toStrictEqual(["qat.config.json"]);
    expect(outputDirectories(resolved)).toStrictEqual([
      resolved.paths.reportsDirectory.absolute,
      resolved.paths.evidenceDirectory.absolute,
    ]);
  });

  it("produces a path a writer can create, and no other", async () => {
    const root = await project({ "qat.config.json": minimal() });

    const resolved = resolvedOrFail(await resolveIn(root));
    const reports = resolved.paths.reportsDirectory.absolute;
    const evidence = resolved.paths.evidenceDirectory.absolute;

    // Nothing exists yet. This is the lazy-creation policy asserted from the other side: resolution named a location and
    // left the disk alone.
    await expect(stat(reports)).rejects.toThrow();

    // In production this call belongs to `ensureDirectory`, immediately before the first write. Recursive creation is
    // part of the contract: the default is `results/reports`, so the parent appears with the leaf.
    await mkdir(reports, { recursive: true });

    // The anchored path is a location the process is actually allowed to use, which no string comparison can prove.
    expect((await stat(reports)).isDirectory()).toBe(true);
    expect((await stat(dirname(reports))).isDirectory()).toBe(true);

    // The tree gained exactly one leaf: the directory the run is about to write to, and not the one it is not.
    const topLevel = await readdir(root);
    expect(topLevel).toContain("qat.config.json");
    expect(topLevel).toContain(basename(dirname(reports)));
    expect(await readdir(dirname(reports))).toStrictEqual(["reports"]);
    await expect(stat(evidence)).rejects.toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* Non-functional                                                             */
/* -------------------------------------------------------------------------- */

describe("non-functional behaviour", () => {
  it("is deterministic", async () => {
    const root = await project({ "qat.config.json": minimal() });

    expect(await resolveIn(root)).toStrictEqual(await resolveIn(root));
  });

  it("does not modify the file it read", async () => {
    const root = await project({ "qat.config.json": minimal() });
    const path = join(root, "qat.config.json");
    const before = await stat(path);

    await resolveIn(root);

    const after = await stat(path);
    expect({ size: after.size, mtimeMs: after.mtimeMs }).toStrictEqual({
      size: before.size,
      mtimeMs: before.mtimeMs,
    });
  });

  it("returns a frozen configuration a later consumer cannot alter", async () => {
    const root = await project({ "qat.config.json": minimal() });

    const resolved = resolvedOrFail(await resolveIn(root));

    // Reporting and execution both read this value; freezing turns one of them editing a path into an immediate error
    // rather than a mystery in the other.
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.paths.reportsDirectory)).toBe(true);
    expect(
      Reflect.set(
        resolved.paths.reportsDirectory,
        "absolute",
        "/tmp/elsewhere",
      ),
    ).toBe(false);
  });
});
