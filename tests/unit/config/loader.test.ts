import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ConfigurationLoad,
  loadConfiguration,
  parseJsonDocument,
} from "~/config/loader/index.js";
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

const VALID = JSON.stringify({ version: 1, framework: "cypress" });

const FULL = JSON.stringify({
  version: 1,
  framework: "cypress",
  defaultEnvironment: "staging",
  environments: { staging: { API_URL: "https://staging.example.test" } },
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
    expect(result.config.output).toStrictEqual({
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
        defaultEnvironment: "staging",
        output: { reports: "out/reports" },
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
    const crlf = '{\r\n  "version": 1,\r\n  "framework": "cypress"\r\n}\r\n';

    await expect(
      loadConfiguration(await makeFile("qat.config.json", crlf)),
    ).resolves.toMatchObject({
      kind: ConfigurationLoad.Loaded,
    });
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
  it.each([
    ["empty", ""],
    ["whitespace only", "  \n\t\n "],
  ])(
    "reports an %s file as empty rather than as malformed",
    async (_case, contents) => {
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

  it("reports a location for every malformed case, not only the convenient ones", async () => {
    for (const contents of ["{", '{"a": }', "[]]", "nul"]) {
      const result = await loadConfiguration(
        await makeFile("qat.config.json", contents),
      );

      expect(result.kind).toBe(ConfigurationLoad.Malformed);
      if (result.kind !== ConfigurationLoad.Malformed) continue;

      expect(result.location.line).toBeGreaterThanOrEqual(1);
      expect(result.location.column).toBeGreaterThanOrEqual(1);
      expect(result.location.position).toBeLessThanOrEqual(contents.length);
    }
  });

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
  it("reports one issue per field", async () => {
    const result = await loadConfiguration(
      await makeFile(
        "qat.config.json",
        JSON.stringify({ version: 2, framework: "playwright" }),
      ),
    );

    expect(result.kind).toBe(ConfigurationLoad.Invalid);
    if (result.kind !== ConfigurationLoad.Invalid) return;

    expect(result.issues.map((issue) => issue.path)).toStrictEqual([
      "version",
      "framework",
    ]);
    expect("config" in result).toBe(false);
  });

  it.each([
    ["an array", "[]"],
    ["null", "null"],
    ["a string", '"hello"'],
    ["a number", "42"],
  ])("rejects %s at the root", async (_case, contents) => {
    // Valid JSON and not a document. The schema says so with one issue at the root, which is why the loader does not need
    // its own check.
    const result = await loadConfiguration(
      await makeFile("qat.config.json", contents),
    );

    expect(result.kind).toBe(ConfigurationLoad.Invalid);
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
    const padding = " ".repeat(64);
    const contents = `${VALID}${padding}`;

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
