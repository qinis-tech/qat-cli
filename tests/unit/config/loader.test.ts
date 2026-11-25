import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ConfigurationLoad,
  loadConfiguration,
  parseJsonDocument,
} from "~/config/loader/index.js";
import { isLoadedDocument } from "~/config/resolver/index.js";
import { SUPPORTED_CONFIG_VERSION } from "~/config/schema/index.js";
import type { ConfigurationDiagnostic } from "~/config/validation/index.js";
import { ConfigurationDiagnosticCode } from "~/core/application/configuration.js";
import {
  isApplicationError,
  type ApplicationError,
} from "~/core/errors/index.js";

/**
 * Reading a configuration file, against a real filesystem.
 *
 * The parser cases below need none — they are text in, answer out — which is deliberate: error positions are the easiest
 * thing in this module to get wrong and the slowest to test through a directory. The loader cases use real files because
 * absence, a directory, a BOM and a size bound are properties of a file rather than of a string.
 *
 * The invalid cases assert *codes* rather than messages. A message is prose and changes; a code is what a caller keys on
 * and what a reader quotes, and it is the one thing the validation service adds to what the loader used to report.
 *
 * ## `config` is a branded wrapper, not the document
 *
 * A successful load returns `{ document, source }`, where the marker on the wrapper is set only by the loader. That is
 * what makes "apply defaults to a file that never loaded" a compile error rather than a review note, so the document is
 * read as `result.config.document`. The extra hop is the price of the guarantee and is asserted here rather than
 * assumed.
 *
 * ## Narrowing a load result in a test
 *
 * `expect(result.kind).toBe(ConfigurationLoad.Loaded)` does not narrow anything: Vitest's `expect` returns void, so the
 * `if` that follows is what tells the compiler which variant is in hand. Where a case has already asserted the kind, the
 * guard is a formality. Where it has not, the guard throws — because a bare `return` there turns a fixture that stopped
 * being valid into a test that passes without asserting anything, which is how a stale fixture survives a green run.
 *
 * ## Where the codes come from
 *
 * `ConfigurationDiagnosticCode` is declared in `core/application/configuration.ts` and imported from there. The config
 * barrel publishes the diagnostic *shape* and not the identifiers, because the identifiers are vocabulary a layer above
 * needs to name — so importing them from `~/config/validation/index.js` resolves to nothing.
 */
let created: string[] = [];

async function makeFile(name: string, contents: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "qat-load-"));
  created.push(root);

  const path = join(root, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);

  return path;
}

async function failure(run: Promise<unknown>): Promise<ApplicationError> {
  const caught: unknown = await run.then(
    () => undefined,
    (error: unknown) => error,
  );

  if (!isApplicationError(caught)) {
    throw new Error(
      `Expected an application error, received ${String(caught)}.`,
    );
  }

  return caught;
}

/** The codes present, so an assertion names the condition rather than restating the mapping. */
function codesOf(diagnostics: readonly ConfigurationDiagnostic[]): string[] {
  return diagnostics.map((diagnostic) => diagnostic.code);
}

/** The paths present, sorted, so a case about fields compares two lists rather than two mappings. */
function pathsOf(diagnostics: readonly ConfigurationDiagnostic[]): string[] {
  return diagnostics.map((diagnostic) => diagnostic.path).sort();
}

/** The two required fields, at the version this build reads. Built from the constant so a version bump does not break it. */
const VALID = JSON.stringify({
  version: SUPPORTED_CONFIG_VERSION,
  framework: "cypress",
});

const FULL = JSON.stringify({
  version: SUPPORTED_CONFIG_VERSION,
  framework: "cypress",
  defaultEnvironment: "staging",
  environments: {
    staging: {
      baseUrl: "https://staging.example.test",
      variables: { API_URL: "https://staging.example.test/api" },
    },
  },
  output: { reports: "out/reports", evidence: "out/evidence" },
});

afterEach(async () => {
  await Promise.all(
    created.map((path) => rm(path, { recursive: true, force: true })),
  );
  created = [];
});

describe("a valid configuration", () => {
  it("loads a minimal file and applies the schema defaults", async () => {
    const path = await makeFile("qat.config.json", VALID);

    const result = await loadConfiguration(path);

    expect(result.kind).toBe(ConfigurationLoad.Loaded);
    if (result.kind !== ConfigurationLoad.Loaded) return;

    // The defaults are the schema's, applied once, in one place. A loader that also defaulted would be a second opinion.
    expect(result.config.document.output).toStrictEqual({
      reports: "results/reports",
      evidence: "results/evidence",
    });
    expect(result.path).toBe(path);
  });

  it("preserves the values it was given", async () => {
    const result = await loadConfiguration(
      await makeFile("qat.config.json", FULL),
    );

    expect(result).toMatchObject({
      kind: ConfigurationLoad.Loaded,
      config: {
        document: {
          defaultEnvironment: "staging",
          // The profile passes through untouched: a target and a variable map, no key invented and none dropped. Without
          // this line the fixture could regress to a shape the schema refuses, and only the case below would notice —
          // by throwing rather than by asserting.
          environments: {
            staging: {
              baseUrl: "https://staging.example.test",
              variables: { API_URL: "https://staging.example.test/api" },
            },
          },
          output: { reports: "out/reports" },
        },
      },
    });
  });

  it("strips a byte-order mark rather than reporting valid JSON as broken", async () => {
    // What an editor on Windows writes. `JSON.parse` rejects the prefix, and refusing the file would blame the author for
    // their editor.
    const result = await loadConfiguration(
      await makeFile("qat.config.json", `\uFEFF${VALID}`),
    );

    expect(result.kind).toBe(ConfigurationLoad.Loaded);
  });

  it("accepts a file with Windows line endings", async () => {
    const crlf = `{\r\n  "version": ${String(SUPPORTED_CONFIG_VERSION)},\r\n  "framework": "cypress"\r\n}\r\n`;

    await expect(
      loadConfiguration(await makeFile("qat.config.json", crlf)),
    ).resolves.toMatchObject({
      kind: ConfigurationLoad.Loaded,
    });
  });
});

describe("the loaded document", () => {
  it("is branded, so defaulting cannot be reached through a failure", async () => {
    const result = await loadConfiguration(
      await makeFile("qat.config.json", VALID),
    );

    expect(result.kind).toBe(ConfigurationLoad.Loaded);
    if (result.kind !== ConfigurationLoad.Loaded) return;

    // The marker is what the resolution stage requires before it will fill anything in. Without this assertion the brand
    // could be dropped in a refactor and every downstream test would still pass.
    expect(isLoadedDocument(result.config)).toBe(true);
  });

  it("carries the file it came from", async () => {
    const path = await makeFile("qat.config.json", VALID);

    const result = await loadConfiguration(path);

    if (result.kind !== ConfigurationLoad.Loaded) {
      // Thrown rather than returned: this case's whole subject is a successful load, so being handed anything else means
      // the fixture or the loader changed, and a bare `return` would report that as a pass.
      throw new Error(
        `expected a loaded configuration, received ${result.kind}`,
      );
    }

    // Asserted to equal the outcome's own path: a caller may hold the document without the outcome, and a diagnostic
    // that quotes a different path from the one that was read is worse than one that quotes nothing.
    expect(result.config.source).toBe(path);
    expect(result.config.source).toBe(result.path);
  });

  it("adds a claim without copying or leaking anything", async () => {
    const result = await loadConfiguration(
      await makeFile("qat.config.json", FULL),
    );

    if (result.kind !== ConfigurationLoad.Loaded) {
      // Same reasoning as above, and the reason this case sat green while `FULL` was still the pre-profile shape: it
      // returned early and asserted nothing.
      throw new Error(
        `expected a loaded configuration, received ${result.kind}`,
      );
    }

    // Exactly two own keys. A marker that was enumerable would appear here; one that serialised would reach every log
    // line, snapshot and `--json` document.
    expect(Object.keys(result.config).sort()).toStrictEqual([
      "document",
      "source",
    ]);
    expect(JSON.stringify(result)).not.toContain("qat.configuration.loaded");
  });

  it("is absent from every outcome that is not a successful load", async () => {
    const malformed = await loadConfiguration(
      await makeFile("qat.config.json", '{ "version": '),
    );
    const invalid = await loadConfiguration(
      await makeFile("qat.config.json", JSON.stringify({ version: 2 })),
    );

    // The brand is not a badge added to failures: a failure carries a reason and nothing else, which is the only reason
    // a caller cannot accidentally default one.
    expect("config" in malformed).toBe(false);
    expect("config" in invalid).toBe(false);
  });
});

describe("a file that is not there", () => {
  it("reports not-found rather than failing", async () => {
    const root = await mkdtemp(join(tmpdir(), "qat-load-"));
    created.push(root);

    // The file being removed between discovery and loading is a race, and the caller's remedy is the same as for a direct
    // call: discover again.
    await expect(
      loadConfiguration(join(root, "qat.config.json")),
    ).resolves.toStrictEqual({
      kind: ConfigurationLoad.NotFound,
      path: join(root, "qat.config.json"),
    });
  });
});

describe("a file with nothing in it", () => {
  const BLANK: readonly [label: string, contents: string][] = [
    ["empty", ""],
    ["whitespace only", "  \n\t\n "],
  ];

  it.each(BLANK)(
    "reports an %s file as empty rather than as malformed",
    async (_label, contents) => {
      const result = await loadConfiguration(
        await makeFile("qat.config.json", contents),
      );

      // One fix, and it is not the same fix as a missing comma: `JSON.parse('')` says "unexpected end of input at position
      // 0", which is accurate and tells the reader nothing.
      expect(result.kind).toBe(ConfigurationLoad.Empty);
    },
  );
});

describe("a file that is not JSON", () => {
  it("reports where the parser stopped", async () => {
    // A trailing comma: the offending token is the closing brace, on a line of its own, so the location is unambiguous
    // rather than a function of where the engine decides to notice.
    const path = await makeFile(
      "qat.config.json",
      '{\n  "version": 1,\n  "framework": "cypress",\n}\n',
    );

    const result = await loadConfiguration(path);

    expect(result.kind).toBe(ConfigurationLoad.Malformed);
    if (result.kind !== ConfigurationLoad.Malformed) return;

    expect(result.location.line).toBe(4);
    expect(result.location.excerpt).toBe("}");
    expect(result.location.position).toBeGreaterThan(0);
    // The parser's own sentence is engine-specific, so it is asserted to exist rather than to say anything in particular.
    expect(result.reason.length).toBeGreaterThan(0);
  });

  const MALFORMED: readonly string[] = ["{", '{"a": }', "[]]", "nul"];

  it.each(MALFORMED)(
    "reports a location for %j, not only the convenient cases",
    async (contents) => {
      // One case per input rather than a loop: a loop reports "the body failed", which is the same message for four
      // different documents, and the difference between them is the whole subject.
      const result = await loadConfiguration(
        await makeFile("qat.config.json", contents),
      );

      expect(result.kind).toBe(ConfigurationLoad.Malformed);
      if (result.kind !== ConfigurationLoad.Malformed) return;

      expect(result.location.line).toBeGreaterThanOrEqual(1);
      expect(result.location.column).toBeGreaterThanOrEqual(1);
      expect(result.location.position).toBeLessThanOrEqual(contents.length);
    },
  );

  it("does not apply defaults to a malformed file", async () => {
    const result = await loadConfiguration(
      await makeFile("qat.config.json", '{ "version": '),
    );

    // The whole point of the decision record: a failure carries a reason and nothing else. `config` is not on the variant,
    // so a caller cannot accidentally read a defaulted one.
    expect(result.kind).toBe(ConfigurationLoad.Malformed);
    expect("config" in result).toBe(false);
  });
});

describe("a file that is JSON but not a configuration", () => {
  it("reports an unsupported version as a single coded diagnostic", async () => {
    const result = await loadConfiguration(
      await makeFile(
        "qat.config.json",
        JSON.stringify({ version: 2, framework: "playwright" }),
      ),
    );

    expect(result.kind).toBe(ConfigurationLoad.Invalid);
    if (result.kind !== ConfigurationLoad.Invalid) return;

    // One diagnostic, not two. The file also names a framework this build does not support, and it is not reported: at
    // another schema version, a field complaint is a guess about a schema this build has never seen. This is the case
    // that proves the loader delegates to the validation service — a loader still calling the schema directly would
    // report both.
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      code: ConfigurationDiagnosticCode.UnsupportedVersion,
      path: "version",
    });
    expect("config" in result).toBe(false);
  });

  it("reports each field problem when the version is one it reads", async () => {
    const result = await loadConfiguration(
      await makeFile(
        "qat.config.json",
        JSON.stringify({
          version: SUPPORTED_CONFIG_VERSION,
          framework: "playwright",
          output: { reports: "/var/reports" },
        }),
      ),
    );

    expect(result.kind).toBe(ConfigurationLoad.Invalid);
    if (result.kind !== ConfigurationLoad.Invalid) return;

    // Two independent problems, collected in one pass — which is what a reader fixing a file needs. Every diagnostic
    // carries a code, so a caller branches on the category rather than on the sentence.
    expect(pathsOf(result.diagnostics)).toStrictEqual([
      "framework",
      "output.reports",
    ]);
    expect(codesOf(result.diagnostics)).toContain(
      ConfigurationDiagnosticCode.UnsupportedValue,
    );
  });

  const ROOTS: readonly [label: string, contents: string][] = [
    ["an array", "[]"],
    ["null", "null"],
    ["a string", '"hello"'],
    ["a number", "42"],
  ];

  it.each(ROOTS)("rejects %s at the root", async (_label, contents) => {
    // Valid JSON and not a document. One diagnostic with no path, because there are no fields to point at.
    const result = await loadConfiguration(
      await makeFile("qat.config.json", contents),
    );

    expect(result.kind).toBe(ConfigurationLoad.Invalid);
    if (result.kind !== ConfigurationLoad.Invalid) return;

    expect(result.diagnostics[0]).toMatchObject({
      code: ConfigurationDiagnosticCode.NotAnObject,
      path: "",
    });
  });
});

describe("something that cannot be read as a file", () => {
  it("rejects a directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "qat-load-"));
    created.push(root);
    const path = join(root, "qat.config.json");
    await mkdir(path);

    const error = await failure(loadConfiguration(path));

    // A directory reaching a JSON parser produces an `EISDIR` message naming nothing useful. The caller's mistake is
    // upstream — discovery reports a directory on the name — so this is an argument error, not a load outcome.
    expect(error.code).toBe("QAT1001");
    expect(error.message).toContain("is not a file");
  });
});

describe("boundaries", () => {
  it("loads a file exactly at the size limit", async () => {
    const contents = `${VALID}${" ".repeat(64)}`;

    await expect(
      loadConfiguration(await makeFile("qat.config.json", contents), {
        maxBytes: contents.length,
      }),
    ).resolves.toMatchObject({ kind: ConfigurationLoad.Loaded });
  });

  it("refuses a file one byte past the limit without reading it", async () => {
    const contents = `${VALID}${" ".repeat(64)}`;

    const result = await loadConfiguration(
      await makeFile("qat.config.json", contents),
      {
        maxBytes: contents.length - 1,
      },
    );

    expect(result).toMatchObject({
      kind: ConfigurationLoad.TooLarge,
      limitBytes: contents.length - 1,
    });
  });
});

describe("the parser, without a filesystem", () => {
  it("parses a document", () => {
    expect(parseJsonDocument('{"a":1}')).toStrictEqual({
      kind: "parsed",
      value: { a: 1 },
    });
  });

  it.each(["", "   ", "\n\t"])("reports %j as empty", (text) => {
    expect(parseJsonDocument(text)).toStrictEqual({ kind: "empty" });
  });

  it("reports a position of zero for an error on the first character", () => {
    const result = parseJsonDocument("x");

    expect(result).toMatchObject({
      kind: "malformed",
      location: { line: 1, column: 1 },
    });
  });

  it("computes a column from the last newline rather than the file start", () => {
    const result = parseJsonDocument('{\n  "a": 1,\n  "b" 2\n}');

    expect(result).toMatchObject({ kind: "malformed", location: { line: 3 } });
  });

  it("is pure: the same text produces the same answer", () => {
    const text = '{ "a": }';

    expect(parseJsonDocument(text)).toStrictEqual(parseJsonDocument(text));
  });
});

describe("non-functional behaviour", () => {
  it("does not modify the file it reads", async () => {
    const path = await makeFile("qat.config.json", VALID);
    const before = await stat(path);

    await loadConfiguration(path);

    const after = await stat(path);
    expect({ size: after.size, mtimeMs: after.mtimeMs }).toStrictEqual({
      size: before.size,
      mtimeMs: before.mtimeMs,
    });
  });

  it("is deterministic", async () => {
    const path = await makeFile("qat.config.json", FULL);

    expect(await loadConfiguration(path)).toStrictEqual(
      await loadConfiguration(path),
    );
  });

  it("keeps concurrent loads independent", async () => {
    const first = await makeFile("a/qat.config.json", VALID);
    const second = await makeFile("b/qat.config.json", "{");

    const [loaded, broken] = await Promise.all([
      loadConfiguration(first),
      loadConfiguration(second),
    ]);

    // A module-level cache would make one of these report the other's file.
    expect(loaded.kind).toBe(ConfigurationLoad.Loaded);
    expect(broken.kind).toBe(ConfigurationLoad.Malformed);
  });

  it("does not change the process working directory", async () => {
    const before = process.cwd();
    await loadConfiguration(await makeFile("qat.config.json", VALID));

    expect(process.cwd()).toBe(before);
  });
});
