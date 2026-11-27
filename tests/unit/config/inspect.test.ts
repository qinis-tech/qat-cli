/**
 * The six states, from object literals.
 *
 * `inspectConfiguration` takes its five collaborators as ports, so every state and every failure code is a table row
 * rather than a directory tree. Nothing here touches a disk: a test that needed one would be testing the machine it
 * happens to run on, and the interesting cases — an empty file, an oversized one, a permission denied, a schema from the
 * future — are exactly the ones that are awkward or unsafe to construct for real.
 *
 * The five are not four plus an extra: locating, loading, projecting, validating and resolving are what the façade does,
 * and the projection is in the list because the loader's output and the schema's input are not the same value. In this
 * file they happen to be identical, which is exactly why the seam is worth naming rather than assuming.
 *
 * The assertions are on the *state*, never on a message. Prose is the guidance catalogue's business, and a test that
 * pins a sentence turns every wording improvement into a failing build.
 */
import { describe, expect, it, vi } from "vitest";

import {
  ConfigurationLoadFailure,
  MAX_CONFIG_BYTES,
  inspectConfiguration,
  isAbsentConfig,
  isUsableConfig,
  type ConfigInspection,
  type ConfigIssue,
  type InspectConfigurationDependencies,
} from "~/config/inspect.js";

/* ------------------------------------------------------------------------- *
 * Fixtures
 * ------------------------------------------------------------------------- */

const ROOT = "/project";
const CONFIG_PATH = "/project/qat.config.json";

/**
 * The loader's output: untrusted JSON.
 *
 * A record of unknown rather than a shape with a `version` field, because that is what the loader actually hands over —
 * the façade is the first thing entitled to look inside it, and this test file never does. Declaring `version` as
 * required would type away the very case one of these tests exists for.
 */
type Document = Readonly<Record<string, unknown>>;

const DOCUMENT: Document = Object.freeze({ version: 1 });

/** The resolver's output. Same role: passed through, asserted by identity. */
const RESOLVED = Object.freeze({
  reportsDirectory: "reports",
  evidenceDirectory: "evidence",
});

type Resolved = typeof RESOLVED;

/** What the loader port promises to return. */
interface Loaded {
  readonly value: Document;
}

/**
 * A loader that yields a document.
 *
 * `Promise.resolve` rather than an `async` arrow, because there is no awaiting to do: the port returns a promise because
 * loading *is* I/O in production, and a double that pretends to be asynchronous without being so is a small lie that a
 * linter is right to flag. It also makes the failure factory below read as its mirror image.
 */
function loads(
  document: Document = DOCUMENT,
): (path: string) => Promise<Loaded> {
  return () => Promise.resolve({ value: document });
}

/**
 * A loader that fails, with the reason the test is about.
 *
 * `Promise.reject` for the same reason as above, and because it keeps each failure case one line: `fails(new
 * ConfigurationLoadFailure("MALFORMED", 4, 17))` says what it means without a `throw` block wrapped around it.
 */
function fails(error: Error): (path: string) => Promise<Loaded> {
  return () => Promise.reject(error);
}

interface Overrides {
  readonly locate?: (
    projectRoot: string,
  ) => { readonly path: string } | undefined;
  readonly load?: (path: string) => Promise<Loaded>;
  /**
   * `unknown`, not `Document`.
   *
   * The port types the verifier's parameter as `unknown` because the façade does not know what a loader hands over — the
   * schema is the first thing entitled to narrow it. A double typed to `Document` would be *narrower* than the contract,
   * and the assignment would fail: the compiler refusing to let a test describe the producer's shape in the consumer's
   * slot. That refusal is worth keeping; it is the same mistake, in type form, as handing the schema a bundle.
   */
  readonly verify?: (value: unknown) => {
    readonly issues: readonly ConfigIssue[];
  };
  /**
   * Overridable so a case can assert the projection happens once rather than once per stage.
   *
   * It receives `TDocument` — the value inside the loader *port's* envelope, `{ value: TDocument }` — and not the
   * envelope itself; the façade unwraps that before projecting. In this file `TDocument` is a bare document, so the
   * default below is the identity. In production `TDocument` is the loader's branded bundle, which is why the assembly's
   * projection is `(bundle) => bundle.document` and why the seam exists at all.
   */
  readonly documentOf?: (document: Document) => unknown;
  readonly resolve?: (value: Document) => Resolved;
  readonly supportedVersions?: readonly number[];
}

/**
 * Collaborators that succeed, with any single behaviour replaced.
 *
 * Defaults describe the happy path — the file is there, it loads, it validates, it resolves — so each test states only
 * the one thing it is about. That is what makes a failure readable: the diff shows the single override, not five.
 */
function makeDeps(
  overrides: Overrides = {},
): InspectConfigurationDependencies<Document, Resolved> {
  return {
    locator: { locate: overrides.locate ?? (() => ({ path: CONFIG_PATH })) },
    loader: { load: overrides.load ?? loads() },
    /**
     * Identity, because in this file the loader yields a bare document.
     *
     * Two different wrappers are in play and it is worth keeping them apart: the loader *port's* envelope is the
     * façade's own (`{ value: TDocument }`, unwrapped before this point), while the loader's *branded bundle*
     * (`{ source, document }`) is a production concern. Here only the first exists, so there is nothing left to project
     * and saying so explicitly keeps a fixture from inventing the second.
     */
    documentOf: overrides.documentOf ?? ((document) => document),
    verifier: { verify: overrides.verify ?? (() => ({ issues: [] })) },
    resolver: { resolve: overrides.resolve ?? (() => RESOLVED) },
    supportedVersions: overrides.supportedVersions ?? [1],
  };
}

/**
 * Narrows an inspection to one state.
 *
 * An assertion function rather than a cast: the expectation runs here, so a wrong state fails at the assertion with the
 * state that was actually returned, instead of failing later on a property that only exists on the branch the test
 * expected.
 */
function assertState<TState extends ConfigInspection<unknown>["state"]>(
  inspection: ConfigInspection<unknown>,
  state: TState,
): asserts inspection is Extract<ConfigInspection<unknown>, { state: TState }> {
  expect(inspection.state).toBe(state);
}

/* ------------------------------------------------------------------------- *
 * Policy constants
 * ------------------------------------------------------------------------- */

describe("MAX_CONFIG_BYTES", () => {
  it("is the single megabyte the guidance quotes back", () => {
    // Two places state this limit — the loader enforces it, the prose reprints it — so the value is pinned here rather
    // than asserted twice in two styles.
    expect(MAX_CONFIG_BYTES).toBe(1024 * 1024);
  });
});

/* ------------------------------------------------------------------------- *
 * missing
 * ------------------------------------------------------------------------- */

describe("absent configuration", () => {
  it("reports missing when the locator finds nothing", async () => {
    const load = vi.fn(loads());
    const deps = makeDeps({ locate: () => undefined, load });

    const result = await inspectConfiguration(ROOT, deps);

    expect(result).toStrictEqual({ state: "missing", searchedAt: "." });
    // Nothing was read, so nothing can be wrong with what was read.
    expect(load).not.toHaveBeenCalled();
  });

  it("reports missing when the file vanishes between locate and load", async () => {
    // The user will look, find nothing, and be told "missing" — which is what they will observe. Reporting an I/O error
    // for a file that is genuinely gone would be technically true and practically useless.
    const deps = makeDeps({
      load: fails(new ConfigurationLoadFailure("ENOENT")),
    });

    const result = await inspectConfiguration(ROOT, deps);

    expect(result).toStrictEqual({
      state: "missing",
      searchedAt: "qat.config.json",
    });
  });

  it("treats a platform ENOENT identically to a classified one", async () => {
    const deps = makeDeps({
      load: fails(Object.assign(new Error("no such file"), { code: "ENOENT" })),
    });

    const result = await inspectConfiguration(ROOT, deps);

    expect(result.state).toBe("missing");
  });
});

/* ------------------------------------------------------------------------- *
 * inaccessible
 * ------------------------------------------------------------------------- */

describe("unreadable configuration", () => {
  it.each(["EACCES", "EPERM", "EISDIR", "ENOTDIR", "ELOOP", "EIO"] as const)(
    "keeps the loader's %s code",
    async (code) => {
      const deps = makeDeps({
        load: fails(new ConfigurationLoadFailure(code)),
      });

      const result = await inspectConfiguration(ROOT, deps);

      assertState(result, "inaccessible");
      expect(result.code).toBe(code);
      expect(result.path).toBe("qat.config.json");
    },
  );

  it("reports an oversized file as TOO_LARGE, not as a parse failure", async () => {
    const deps = makeDeps({
      load: fails(new ConfigurationLoadFailure("TOO_LARGE")),
    });

    const result = await inspectConfiguration(ROOT, deps);

    assertState(result, "inaccessible");
    expect(result.code).toBe("TOO_LARGE");
  });

  it("does not guess a cause it was not given", async () => {
    // Unknown is a documented answer. Inventing "permission denied" here would send a reader to check a permission that
    // may be perfectly fine.
    const deps = makeDeps({ load: fails(new Error("something odd")) });

    const result = await inspectConfiguration(ROOT, deps);

    assertState(result, "inaccessible");
    expect(result.code).toBe("UNKNOWN");
  });

  it("classifies a failing locator as unreadable rather than as absent", async () => {
    // Discovery failing means we could not finish looking. "Missing" would be a statement we did not establish.
    const deps = makeDeps({
      locate: () => {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      },
    });

    const result = await inspectConfiguration(ROOT, deps);

    assertState(result, "inaccessible");
    expect(result.code).toBe("EACCES");
  });
});

/* ------------------------------------------------------------------------- *
 * malformed
 * ------------------------------------------------------------------------- */

describe("malformed configuration", () => {
  it("carries the position the loader established", async () => {
    const deps = makeDeps({
      load: fails(new ConfigurationLoadFailure("MALFORMED", 4, 17)),
    });

    const result = await inspectConfiguration(ROOT, deps);

    assertState(result, "malformed");
    expect(result.line).toBe(4);
    expect(result.column).toBe(17);
    expect(result.path).toBe("qat.config.json");
  });

  it("treats an empty document as malformed, with no invented position", async () => {
    const deps = makeDeps({
      load: fails(new ConfigurationLoadFailure("EMPTY")),
    });

    const result = await inspectConfiguration(ROOT, deps);

    assertState(result, "malformed");
    expect(result).not.toHaveProperty("line");
    expect(result).not.toHaveProperty("column");
  });

  it("still recognises a platform SyntaxError, for a loader that throws one", async () => {
    // The classified failure is the preferred route; this is the fallback that keeps a loader written against the
    // platform's own vocabulary from being reported as an I/O error.
    const deps = makeDeps({
      load: fails(new SyntaxError("Unexpected token } in JSON at position 11")),
    });

    const result = await inspectConfiguration(ROOT, deps);

    assertState(result, "malformed");
    expect(result.column).toBe(12);
  });
});

/* ------------------------------------------------------------------------- *
 * version gate
 * ------------------------------------------------------------------------- */

describe("version gate", () => {
  it("stops at an unsupported version without validating anything", async () => {
    const verify = vi.fn(() => ({ issues: [] as readonly ConfigIssue[] }));
    const deps = makeDeps({ load: loads({ version: 7 }), verify });

    const result = await inspectConfiguration(ROOT, deps);

    assertState(result, "version-unsupported");
    expect(result.declared).toBe(7);
    expect(result.supported).toStrictEqual([1]);
    // A page of field errors against a schema from the future would bury the one fact the reader can act on.
    expect(verify).not.toHaveBeenCalled();
  });

  it("reports the supported set in ascending order, whatever order it was given", async () => {
    // Two things have to be true for this to test anything: a version outside the set, so the gate fires at all, and a
    // supported set given in the wrong order, so the assertion is about sorting rather than about echoing the input.
    // With the default document (`{ version: 1 }`) the first condition is false and the case quietly asserts `valid`.
    const deps = makeDeps({
      load: loads({ version: 9 }),
      supportedVersions: [3, 1, 2],
    });

    const result = await inspectConfiguration(ROOT, deps);

    assertState(result, "version-unsupported");
    expect(result.supported).toStrictEqual([1, 2, 3]);
    expect(result.declared).toBe(9);
  });

  it("does not treat a missing version as an unsupported one", async () => {
    // The key is absent entirely, not present-and-undefined. The façade cannot tell the two apart —
    // `readDeclaredVersion` returns `undefined` for both — and it does not need to: absence is a required-field error,
    // which the schema words better than this stage can. "Version is missing" is true; "version 0 is unsupported"
    // describes something the reader never wrote.
    const deps = makeDeps({
      load: loads({}),
      verify: () => ({
        issues: [
          { path: ["version"], code: "invalid_type", message: "Required" },
        ],
      }),
    });

    const result = await inspectConfiguration(ROOT, deps);

    assertState(result, "schema-invalid");
    expect(result.version).toBe(-1);
    expect(result.issues).toHaveLength(1);
  });

  it("does not treat a non-numeric version as an unsupported one", async () => {
    const deps = makeDeps({
      load: loads({ version: "1" }),
      verify: () => ({
        issues: [
          {
            path: ["version"],
            code: "invalid_type",
            message: "Expected number",
          },
        ],
      }),
    });

    const result = await inspectConfiguration(ROOT, deps);

    assertState(result, "schema-invalid");
    expect(result.version).toBe(-1);
  });
});

/* ------------------------------------------------------------------------- *
 * schema
 * ------------------------------------------------------------------------- */

describe("schema rejection", () => {
  it("reports the version it interpreted alongside the issues", async () => {
    const deps = makeDeps({
      verify: () => ({
        issues: [
          {
            path: ["output", "reports"],
            code: "custom",
            message: "Must be relative",
          },
          {
            path: ["framework"],
            code: "invalid_enum_value",
            message: "Unsupported",
          },
        ],
      }),
    });

    const result = await inspectConfiguration(ROOT, deps);

    assertState(result, "schema-invalid");
    expect(result.version).toBe(1);
    expect(result.issues).toHaveLength(2);
  });

  it("orders issues by path, so two runs produce identical output", async () => {
    const deps = makeDeps({
      verify: () => ({
        issues: [
          { path: ["output", "reports"], code: "custom", message: "b" },
          { path: ["framework"], code: "invalid_enum_value", message: "a" },
          { path: ["output", "evidence"], code: "custom", message: "c" },
        ],
      }),
    });

    const result = await inspectConfiguration(ROOT, deps);

    assertState(result, "schema-invalid");
    expect(result.issues.map((issue) => issue.path.join("."))).toStrictEqual([
      "framework",
      "output.evidence",
      "output.reports",
    ]);
  });

  it("does not call the resolver for a document it refused", async () => {
    const resolve = vi.fn(() => RESOLVED);
    const deps = makeDeps({
      verify: () => ({
        issues: [
          { path: ["framework"], code: "invalid_enum_value", message: "x" },
        ],
      }),
      resolve,
    });

    await inspectConfiguration(ROOT, deps);

    // Defaults are applied to omitted fields on a document the schema accepted. Applying them to a rejected one would
    // produce a configuration nobody chose.
    expect(resolve).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------------- *
 * valid
 * ------------------------------------------------------------------------- */

describe("usable configuration", () => {
  it("returns the resolved configuration and the interpreted version", async () => {
    const deps = makeDeps({ load: loads({ version: 1 }) });

    const result = await inspectConfiguration(ROOT, deps);

    assertState(result, "valid");
    expect(result.version).toBe(1);
    expect(result.config).toBe(RESOLVED);
    expect(result.path).toBe("qat.config.json");
    expect(isUsableConfig(result)).toBe(true);
    expect(isAbsentConfig(result)).toBe(false);
  });
});

/* ------------------------------------------------------------------------- *
 * internal inconsistencies
 * ------------------------------------------------------------------------- */

/**
 * Two tiers, and the difference is who can be blamed.
 *
 * Validation and resolution judge project data, so their failures could be the document's fault and become states a
 * reader can act on — `inaccessible`, with `UNKNOWN` as the cause when we genuinely cannot attribute it.
 *
 * The projection cannot. It is a pure function of the loader's output, supplied by assembly, so a throw from it means
 * this program is broken. That one propagates, and the case below pins that: `inaccessible` would name the wrong
 * subject (the file was read perfectly well) and would make the defect invisible on the command whose job is to
 * describe failures.
 */
describe("failures that belong to the program, not the project", () => {
  it("reports a throwing verifier as unreadable rather than inventing a field complaint", async () => {
    const deps = makeDeps({
      verify: () => {
        throw new Error("schema exploded");
      },
    });

    const result = await inspectConfiguration(ROOT, deps);

    assertState(result, "inaccessible");
    expect(result.code).toBe("UNKNOWN");
  });

  it("reports a throwing resolver as unreadable, never as a successful default", async () => {
    // A document that parsed and validated but cannot be resolved is a defect in this program. Substituting defaults
    // for a file that exists would hide it behind a configuration nobody chose.
    const deps = makeDeps({
      resolve: () => {
        throw new Error("resolution exploded");
      },
    });

    const result = await inspectConfiguration(ROOT, deps);

    assertState(result, "inaccessible");
    expect(result.code).toBe("UNKNOWN");
  });

  it("propagates a failing projection, because that can only be a defect in this program", async () => {
    // The asymmetry with the two cases above is the assertion. A schema can reject a document and a resolver can refuse
    // a path, so those failures are about the file; the projection has nothing to say about the file at all. Swallowing
    // it into `inaccessible` would also mean the one command that exists to report problems was the one hiding this one.
    const deps = makeDeps({
      documentOf: () => {
        throw new Error("projection exploded");
      },
    });

    await expect(inspectConfiguration(ROOT, deps)).rejects.toThrow(
      "projection exploded",
    );
  });
});

/* ------------------------------------------------------------------------- *
 * port wiring
 * ------------------------------------------------------------------------- */

describe("port wiring", () => {
  it("passes the located path to the loader, and the projected document onward", async () => {
    const load = vi.fn(loads());
    const verify = vi.fn(() => ({ issues: [] as readonly ConfigIssue[] }));
    const resolve = vi.fn(() => RESOLVED);

    await inspectConfiguration(ROOT, makeDeps({ load, verify, resolve }));

    expect(load).toHaveBeenCalledWith(CONFIG_PATH);
    // The same projected document object reaches the schema that the gate read, and the resolver receives the loader's
    // own output: a copy anywhere in that chain would be a second reading of one file.
    expect(verify).toHaveBeenCalledWith(DOCUMENT);
    expect(resolve).toHaveBeenCalledWith(DOCUMENT);
  });

  it("projects the loader's output once, so the gate and the schema read the same value", async () => {
    const documentOf = vi.fn((document: Document) => document);

    await inspectConfiguration(ROOT, makeDeps({ documentOf }));

    // Once, not twice. In production the two projections would be the bug rather than the symptom: a schema handed the
    // bundle reports every required field as missing, and a gate handed one finds no version and skips itself. Both are
    // silent, which is why the count is the assertion.
    expect(documentOf).toHaveBeenCalledTimes(1);
    expect(documentOf).toHaveBeenCalledWith(DOCUMENT);
  });

  it("asks the locator only for the project root it was given", async () => {
    const locate = vi.fn(() => ({ path: CONFIG_PATH }));

    await inspectConfiguration(ROOT, makeDeps({ locate }));

    expect(locate).toHaveBeenCalledTimes(1);
    expect(locate).toHaveBeenCalledWith(ROOT);
  });
});

/* ------------------------------------------------------------------------- *
 * guarantees
 * ------------------------------------------------------------------------- */

describe("guarantees", () => {
  it("returns a frozen envelope for every state", async () => {
    const cases: readonly (() => Promise<ConfigInspection<Resolved>>)[] = [
      () => inspectConfiguration(ROOT, makeDeps({ locate: () => undefined })),
      () =>
        inspectConfiguration(
          ROOT,
          makeDeps({ load: fails(new ConfigurationLoadFailure("EACCES")) }),
        ),
      () =>
        inspectConfiguration(
          ROOT,
          makeDeps({
            load: fails(new ConfigurationLoadFailure("MALFORMED", 1, 1)),
          }),
        ),
      () =>
        inspectConfiguration(ROOT, makeDeps({ load: loads({ version: 9 }) })),
      () =>
        inspectConfiguration(
          ROOT,
          makeDeps({
            verify: () => ({
              issues: [
                {
                  path: ["framework"],
                  code: "invalid_enum_value",
                  message: "x",
                },
              ],
            }),
          }),
        ),
      () => inspectConfiguration(ROOT, makeDeps()),
    ];

    for (const scenario of cases) {
      // No caller can mutate a shared result, so no consumer can change what another one sees.
      expect(Object.isFrozen(await scenario())).toBe(true);
    }
  });

  it("produces equal results for equal inputs", async () => {
    // Determinism is what makes a stored diagnostic session comparable with a fresh run.
    const first = await inspectConfiguration(
      ROOT,
      makeDeps({ load: loads({ version: 9 }) }),
    );
    const second = await inspectConfiguration(
      ROOT,
      makeDeps({ load: loads({ version: 9 }) }),
    );

    expect(first).toStrictEqual(second);
  });

  it("does not mutate the supported versions it was given", async () => {
    const supportedVersions: readonly number[] = Object.freeze([3, 1, 2]);

    await inspectConfiguration(ROOT, makeDeps({ supportedVersions }));

    expect(supportedVersions).toStrictEqual([3, 1, 2]);
  });

  it("reports project-relative paths for every state that names a file", async () => {
    // A path in evidence must never be absolute: on a developer machine it routinely contains a username, and a
    // diagnostic is the artefact most likely to be pasted into a public issue.
    const results = await Promise.all([
      inspectConfiguration(ROOT, makeDeps()),
      inspectConfiguration(
        ROOT,
        makeDeps({
          load: fails(new ConfigurationLoadFailure("MALFORMED", 2, 3)),
        }),
      ),
      inspectConfiguration(
        ROOT,
        makeDeps({ load: fails(new ConfigurationLoadFailure("EACCES")) }),
      ),
    ]);

    for (const result of results) {
      if (result.state === "missing") continue;
      expect(result.path).toBe("qat.config.json");
      expect(result.path.startsWith("/")).toBe(false);
    }
  });

  it("relativises a Windows-style root the same way", async () => {
    const root = "C:\\project";
    const deps = makeDeps({
      locate: () => ({ path: "C:\\project\\qat.config.json" }),
    });

    const result = await inspectConfiguration<Document, Resolved>(root, deps);

    expect(result.state).toBe("valid");
    expect(result.state === "valid" ? result.path : "").toBe("qat.config.json");
  });
});
