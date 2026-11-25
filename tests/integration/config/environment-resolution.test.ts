/**
 * Selecting an environment, through the real pipeline.
 *
 * Every case here starts with a file on disk and ends with a value an execution request could carry:
 *
 *   qat.config.json  ->  load  ->  validate  ->  defaults  ->  anchor  ->  derive a default environment
 *                    ->  select  ->  resolve the target, the variables and the secrets
 *
 * The unit suite covers the resolver against literals. This file covers the two things only the seam can show: that the
 * default environment this stage receives is the one the configuration stage derived, and that a profile the schema
 * refuses never reaches the resolver at all.
 *
 * ## Two fixtures, because a resolution is all or nothing
 *
 * A profile that declares a secret fails the whole resolution when the variable is absent — correct for a run, and noise
 * for a test about target precedence. So the documents are separated by subject: `THREE_PROFILES` where the secret is
 * part of what is being asserted, and `TARGETS_ONLY` where it is not. Sprinkling an unrelated token through four
 * precedence tests would make those tests look like they depend on it.
 */
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CONFIG_FILE_NAME } from "~/config/contracts.js";
import { ConfigurationLoad, loadConfiguration } from "~/config/loader/index.js";
import type { EnvironmentResolution } from "~/config/resolver/contracts.js";
import {
  BASE_URL_ENVIRONMENT_VARIABLE,
  resolveEnvironment,
} from "~/config/resolver/environment.js";
import { resolveConfiguration } from "~/config/resolver/resolve.js";
import { SUPPORTED_CONFIG_VERSION } from "~/config/schema/index.js";
import type { ExecutionRequest } from "~/core/domain/index.js";

/* -------------------------------------------------------------------------- */
/* A project on disk                                                          */
/* -------------------------------------------------------------------------- */

let created: string[] = [];

async function project(configuration: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "qat-env-"));
  created.push(root);

  await writeFile(
    join(root, CONFIG_FILE_NAME),
    `${JSON.stringify(configuration, null, 2)}\n`,
    "utf8",
  );

  return root;
}

type Ambient = Readonly<Record<string, string | undefined>>;

interface Selection {
  readonly requested?: string;
  readonly baseUrlFlag?: string;
  /** One map for both jobs, as the process environment serves both: the override variable and the secret values. */
  readonly ambient?: Ambient;
  readonly requireEnvironment?: boolean;
}

/**
 * Run the whole pipeline and resolve an environment from it.
 *
 * The profiles come from the *loaded* document rather than from the resolved configuration, because the loader's result
 * carries the schema's own type — `EnvironmentProfiles | undefined` — while the tolerant view the resolver returns types
 * the field `unknown` on purpose. Taking them from the validated document is what the composition root does, and doing
 * it the same way here means the test exercises the hand-off the application actually makes.
 */
async function resolveFor(
  root: string,
  selection: Selection = {},
): Promise<EnvironmentResolution> {
  const loaded = await loadConfiguration(join(root, CONFIG_FILE_NAME));

  if (loaded.kind !== ConfigurationLoad.Loaded) {
    throw new Error(`expected a loaded configuration, received ${loaded.kind}`);
  }

  const configuration = resolveConfiguration({
    loaded: loaded.config,
    projectRoot: root,
  });

  if (!configuration.ok) {
    throw new Error(
      `expected a resolved configuration, received ${configuration.issues
        .map((issue) => issue.code)
        .join(", ")}`,
    );
  }

  const ambient = selection.ambient ?? {};

  return resolveEnvironment({
    profiles: loaded.config.document.environments,
    defaultEnvironment: configuration.resolved.defaultEnvironment,
    ...(selection.requested === undefined
      ? {}
      : { requested: selection.requested }),
    ...(selection.baseUrlFlag === undefined
      ? {}
      : { fromFlag: { baseUrl: selection.baseUrlFlag } }),
    environment: ambient,
    readSecret: (name) => ambient[name],
    ...(selection.requireEnvironment === undefined
      ? {}
      : { requireEnvironment: selection.requireEnvironment }),
  });
}

function environmentOf(resolution: EnvironmentResolution) {
  if (!resolution.ok) {
    throw new Error(
      `expected a resolved environment, received ${resolution.issues.map((issue) => issue.code).join(", ")}`,
    );
  }

  return resolution.environment;
}

function codesOf(resolution: EnvironmentResolution): readonly string[] {
  return resolution.ok ? [] : resolution.issues.map((issue) => issue.code);
}

/**
 * Three profiles, one of which needs a secret.
 *
 * For the cases where the secret is part of the subject: selection, secret resolution, the request hand-off.
 */
const THREE_PROFILES = {
  version: SUPPORTED_CONFIG_VERSION,
  framework: "cypress",
  defaultEnvironment: "staging",
  environments: {
    development: {
      baseUrl: "http://localhost:3000",
      variables: { API_URL: "http://localhost:8080" },
    },
    staging: {
      baseUrl: "https://staging.example.test",
      variables: { API_URL: "https://api.staging.example.test" },
      secrets: {
        API_TOKEN: { from: "environment", name: "QAT_STAGING_TOKEN" },
      },
    },
    production: { baseUrl: "https://example.test" },
  },
} as const;

/**
 * One profile with a target and no secrets.
 *
 * For the cases where the subject is the precedence order. A declared secret makes the resolution fail without its
 * variable, so using the document above would have forced a token into tests that never look at one — and would have
 * implied that the target's precedence depends on a secret being present.
 */
const TARGETS_ONLY = {
  version: SUPPORTED_CONFIG_VERSION,
  framework: "cypress",
  defaultEnvironment: "staging",
  environments: {
    staging: {
      baseUrl: "https://staging.example.test",
      variables: { API_URL: "https://api.staging.example.test" },
    },
  },
} as const;

afterEach(async () => {
  await Promise.all(
    created.map((path) => rm(path, { recursive: true, force: true })),
  );
  created = [];
});

/* -------------------------------------------------------------------------- */
/* Selection, end to end                                                      */
/* -------------------------------------------------------------------------- */

describe("a project with three profiles", () => {
  it("uses the default the configuration stage derived", async () => {
    const root = await project(THREE_PROFILES);

    const resolution = await resolveFor(root, {
      ambient: { QAT_STAGING_TOKEN: "token" },
    });

    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;

    // The name came from `defaultEnvironment` through the derivation, not from anything computed in this stage.
    expect(resolution.name).toBe("staging");
    expect(resolution.origin).toBe("default");
    expect(resolution.environment.baseUrl).toBe("https://staging.example.test");
    expect(resolution.environment.baseUrlSource).toBe("configuration");
  });

  it("resolves the variables and the secrets of the selected profile", async () => {
    const root = await project(THREE_PROFILES);

    const environment = environmentOf(
      await resolveFor(root, { ambient: { QAT_STAGING_TOKEN: "token" } }),
    );

    expect(environment.variables).toStrictEqual({
      API_URL: "https://api.staging.example.test",
    });
    expect(environment.secrets.entriesForFramework()).toStrictEqual([
      ["API_TOKEN", "token"],
    ]);
  });

  it("lets a request override the default", async () => {
    const root = await project(THREE_PROFILES);

    const resolution = await resolveFor(root, { requested: "production" });

    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;

    expect(resolution.name).toBe("production");
    expect(resolution.origin).toBe("requested");
    expect(resolution.environment.baseUrl).toBe("https://example.test");
  });

  it("names the declared environments when the requested one is not there", async () => {
    const root = await project(THREE_PROFILES);

    const resolution = await resolveFor(root, { requested: "prod" });

    expect(codesOf(resolution)).toStrictEqual(["ENVIRONMENT_UNKNOWN"]);
    if (resolution.ok) return;

    // Sorted, and every name — the reader's next action is to pick one.
    expect(resolution.issues[0]?.remediation).toContain(
      "development, production, staging",
    );
  });

  it("falls back to the only profile when the project declares no default", async () => {
    const root = await project({
      version: SUPPORTED_CONFIG_VERSION,
      framework: "cypress",
      environments: { only: { baseUrl: "https://only.example.test" } },
    });

    const resolution = await resolveFor(root);

    // The derivation that produced `sole` lives in `defaulting.ts`; this asserts the two stages agree about it.
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;

    expect(resolution.name).toBe("only");
    expect(resolution.origin).toBe("default");
  });

  it("refuses to choose when several profiles exist and none is default", async () => {
    const root = await project({
      version: SUPPORTED_CONFIG_VERSION,
      framework: "cypress",
      environments: {
        development: { baseUrl: "http://localhost:3000" },
        production: { baseUrl: "https://example.test" },
      },
    });

    expect(codesOf(await resolveFor(root))).toStrictEqual([
      "ENVIRONMENT_NONE_SELECTED",
    ]);
  });

  it("allows a project with no profiles when the caller does not need one", async () => {
    const root = await project({
      version: SUPPORTED_CONFIG_VERSION,
      framework: "cypress",
    });

    const permissive = await resolveFor(root, { requireEnvironment: false });
    const strict = await resolveFor(root);

    // Two callers, one document: inspection can describe a project with no environments, execution cannot run against
    // one.
    expect(permissive.ok).toBe(true);
    expect(codesOf(strict)).toStrictEqual(["ENVIRONMENT_NONE_SELECTED"]);
  });
});

/* -------------------------------------------------------------------------- */
/* The target, through the real precedence resolver                            */
/* -------------------------------------------------------------------------- */

describe("the target", () => {
  it("takes the profile's value when nothing overrides it", async () => {
    const root = await project(TARGETS_ONLY);

    const environment = environmentOf(await resolveFor(root));

    expect(environment.baseUrl).toBe("https://staging.example.test");
    expect(environment.baseUrlSource).toBe("configuration");
  });

  it("takes an environment variable above the profile", async () => {
    const root = await project(TARGETS_ONLY);

    const environment = environmentOf(
      await resolveFor(root, {
        ambient: {
          [BASE_URL_ENVIRONMENT_VARIABLE]: "https://from-env.example.test",
        },
      }),
    );

    expect(environment.baseUrl).toBe("https://from-env.example.test");
    expect(environment.baseUrlSource).toBe("environment");
  });

  it("takes the flag above the environment variable", async () => {
    const root = await project(TARGETS_ONLY);

    const environment = environmentOf(
      await resolveFor(root, {
        baseUrlFlag: "https://from-flag.example.test",
        ambient: {
          [BASE_URL_ENVIRONMENT_VARIABLE]: "https://from-env.example.test",
        },
      }),
    );

    // The full order in one assertion, and it is the real precedence resolver doing the deciding.
    expect(environment.baseUrl).toBe("https://from-flag.example.test");
    expect(environment.baseUrlSource).toBe("flag");
  });

  it("treats an empty variable as absent", async () => {
    const root = await project(TARGETS_ONLY);

    const environment = environmentOf(
      await resolveFor(root, {
        ambient: { [BASE_URL_ENVIRONMENT_VARIABLE]: "" },
      }),
    );

    // A blank a shell inherited is not an instruction to use nothing.
    expect(environment.baseUrl).toBe("https://staging.example.test");
    expect(environment.baseUrlSource).toBe("configuration");
  });

  it("reports no target when the profile has none", async () => {
    const root = await project({
      version: SUPPORTED_CONFIG_VERSION,
      framework: "cypress",
      defaultEnvironment: "bare",
      environments: { bare: { variables: { FLAG: "on" } } },
    });

    const environment = environmentOf(await resolveFor(root));

    expect("baseUrl" in environment).toBe(false);
    expect(environment.baseUrlSource).toBe("none");
  });
});

/* -------------------------------------------------------------------------- */
/* Secrets                                                                    */
/* -------------------------------------------------------------------------- */

describe("secrets", () => {
  it("names the variable an operator must set", async () => {
    const root = await project(THREE_PROFILES);

    const resolution = await resolveFor(root);

    expect(codesOf(resolution)).toStrictEqual(["SECRET_UNRESOLVED"]);
    if (resolution.ok) return;

    // The variable is configuration and may be printed; the profile's key tells the reader which secret it feeds.
    expect(resolution.issues[0]?.message).toContain("QAT_STAGING_TOKEN");
    expect(resolution.issues[0]?.message).toContain("API_TOKEN");
  });

  it("fails the whole resolution, not just the missing field", async () => {
    const root = await project(THREE_PROFILES);

    // A target was supplied explicitly, so the resolution could have produced a usable value without the token. It does
    // not: a run that authenticated as nobody would produce results nobody can trust, and a partial environment is not a
    // result. This is the decision the four precedence cases above were quietly relying on when they moved to a fixture
    // with no secrets.
    const resolution = await resolveFor(root, {
      baseUrlFlag: "https://from-flag.example.test",
    });

    expect(resolution.ok).toBe(false);
    expect("environment" in resolution).toBe(false);
  });

  it("never reaches a serialised result", async () => {
    const root = await project(THREE_PROFILES);

    const resolution = await resolveFor(root, {
      ambient: { QAT_STAGING_TOKEN: "tok_secret_51" },
    });

    // The whole pipeline's output, serialised the way a `--json` document or a failing assertion would serialise it.
    expect(JSON.stringify(resolution)).toContain("[redacted]");
    expect(JSON.stringify(resolution)).not.toContain("tok_secret_51");
  });

  it("does not take secret values from the profile's variable map", async () => {
    const root = await project({
      version: SUPPORTED_CONFIG_VERSION,
      framework: "cypress",
      defaultEnvironment: "staging",
      environments: {
        staging: { variables: { API_TOKEN: "written-into-the-file" } },
      },
    });

    const environment = environmentOf(await resolveFor(root));

    // A value written into the variable map is a variable, not a secret — and it is exactly the mistake the profile's
    // two maps exist to make visible.
    expect(environment.variables["API_TOKEN"]).toBe("written-into-the-file");
    expect(environment.secrets.has("API_TOKEN")).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* What never reaches this stage                                              */
/* -------------------------------------------------------------------------- */

describe("a profile the schema refuses", () => {
  it("stops at validation rather than reaching the resolver", async () => {
    const root = await project({
      version: SUPPORTED_CONFIG_VERSION,
      framework: "cypress",
      environments: { staging: { variables: {} } },
    });

    const loaded = await loadConfiguration(join(root, CONFIG_FILE_NAME));

    expect(loaded.kind).toBe(ConfigurationLoad.Invalid);
    if (loaded.kind !== ConfigurationLoad.Invalid) return;

    // The field is named, so the reader is sent to the line rather than to the environment machinery.
    expect(loaded.diagnostics.map((diagnostic) => diagnostic.path)).toContain(
      "environments.staging.variables",
    );
  });

  it("refuses an unknown property inside a profile", async () => {
    const root = await project({
      version: SUPPORTED_CONFIG_VERSION,
      framework: "cypress",
      environments: { staging: { timeout: 3000 } },
    });

    const loaded = await loadConfiguration(join(root, CONFIG_FILE_NAME));

    expect(loaded.kind).toBe(ConfigurationLoad.Invalid);
  });

  it("refuses a credential in a profile's target", async () => {
    const root = await project({
      version: SUPPORTED_CONFIG_VERSION,
      framework: "cypress",
      environments: {
        staging: { baseUrl: "https://user:pass@host.example.test" },
      },
    });

    const loaded = await loadConfiguration(join(root, CONFIG_FILE_NAME));

    // The security rule lives in the constraint, so it fires while the file is read — long before anything could put
    // that URL in a log line.
    expect(loaded.kind).toBe(ConfigurationLoad.Invalid);
  });
});

/* -------------------------------------------------------------------------- */
/* The result as a request                                                    */
/* -------------------------------------------------------------------------- */

describe("the resolved value", () => {
  it("goes onto an execution request without a cast", async () => {
    const root = await project(THREE_PROFILES);

    const resolution = await resolveFor(root, {
      ambient: { QAT_STAGING_TOKEN: "token" },
    });

    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;

    // The compile-time half of this test is the annotation: if `ResolvedExecutionEnvironment` and the request's field
    // ever drift apart, this line stops building.
    const request: ExecutionRequest = {
      executionId: "run-1",
      environment: resolution.name ?? "none",
      resolvedEnvironment: resolution.environment,
      specSelection: { kind: "all" },
      mode: "headless",
      options: { timeoutMs: 600_000, retries: 0, collectEvidence: false },
    };

    expect(request.environment).toBe("staging");
    expect(request.resolvedEnvironment?.baseUrl).toBe(
      "https://staging.example.test",
    );
    expect(request.resolvedEnvironment?.secrets.has("API_TOKEN")).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Non-functional                                                             */
/* -------------------------------------------------------------------------- */

describe("non-functional behaviour", () => {
  it("is deterministic", async () => {
    const root = await project(THREE_PROFILES);

    const first = environmentOf(
      await resolveFor(root, { ambient: { QAT_STAGING_TOKEN: "t" } }),
    );
    const second = environmentOf(
      await resolveFor(root, { ambient: { QAT_STAGING_TOKEN: "t" } }),
    );

    // Projections rather than the objects: the secrets container's contents are private, so a deep equality would
    // compare two empty enumerable shapes and pass for the wrong reason.
    expect(second.baseUrl).toBe(first.baseUrl);
    expect(second.baseUrlSource).toBe(first.baseUrlSource);
    expect(second.variables).toStrictEqual(first.variables);
    expect(second.secrets.entriesForFramework()).toStrictEqual(
      first.secrets.entriesForFramework(),
    );
  });

  it("does not enumerate the ambient environment into the variables", async () => {
    const root = await project(THREE_PROFILES);

    const environment = environmentOf(
      await resolveFor(root, {
        ambient: {
          QAT_STAGING_TOKEN: "t",
          UNRELATED_SECRET: "leak",
          HOME: "/home/someone",
        },
      }),
    );

    // A project cannot gain a variable from the machine that runs it; the ambient map is read by name and never swept.
    expect(Object.keys(environment.variables)).toStrictEqual(["API_URL"]);
  });

  it("does not modify the file it read", async () => {
    const root = await project(THREE_PROFILES);
    const path = join(root, CONFIG_FILE_NAME);
    const before = await stat(path);

    await resolveFor(root, { ambient: { QAT_STAGING_TOKEN: "t" } });

    const after = await stat(path);
    expect({ size: after.size, mtimeMs: after.mtimeMs }).toStrictEqual({
      size: before.size,
      mtimeMs: before.mtimeMs,
    });
  });
});
