import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CONFIG_FILE_NAME } from "~/config/contracts.js";
import { CONFIG_FIELD_PATHS, qatConfigSchema } from "~/config/schema/index.js";

/**
 * The format specification, checked against the schema it describes.
 *
 * ## Why a test reads the documentation
 *
 * A documented field list is a copy of the schema, and a copy is what lags. The same is true of every example in a
 * document: it is a claim, and the reader who copies it has no way to know whether it was ever parsed.
 *
 * Three assertions below close that gap. The field table is compared to the schema's own key set, the example files are
 * parsed, and every fenced `json` block in the two configuration documents must be a *whole valid configuration*. The
 * third is the one that constrains an author: a fragment pasted into the specification has to be tagged as something
 * other than `json`, or it fails.
 */
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const EXAMPLES = join(ROOT, "examples", "configuration");

/**
 * The documents whose `json` blocks are configurations.
 *
 * An allow-list rather than every document, because other documents legitimately contain JSON that is not a
 * configuration — the output specification shows a result document, and the schema document shows a worked example that
 * happens to be one.
 */
const CONFIGURATION_DOCUMENTS = [
  "docs/architecture/configuration-format.md",
  "docs/architecture/configuration-schema.md",
];

async function read(relativePath: string): Promise<string> {
  return readFile(join(ROOT, relativePath), "utf8");
}

/** Every fenced block tagged `json`, as its contents. */
function jsonBlocks(markdown: string): string[] {
  const pattern = /```json\n([\s\S]*?)```/g;

  return [...markdown.matchAll(pattern)]
    .map((match) => match[1])
    .filter((body): body is string => body !== undefined);
}

/**
 * Every field path documented as the first cell of a table row.
 *
 * Narrow on purpose: the shape has to be a backticked dotted identifier, so a rule in a table (`..`, `results/reports`)
 * is not mistaken for a field. A table whose first column holds something else is invisible to this, which is why the
 * assertion below checks the count as well as the contents — a regex that matches nothing would otherwise pass.
 */
function documentedFields(markdown: string): string[] {
  const pattern = /^\|\s*`([a-zA-Z][a-zA-Z.]*)`\s*\|/gm;

  return [...markdown.matchAll(pattern)]
    .map((match) => match[1])
    .filter((field): field is string => field !== undefined)
    .sort();
}

describe("the filename", () => {
  it("is the one the specification names", async () => {
    const format = await read("docs/architecture/configuration-format.md");

    // A rename in the constant and not in the document is the defect this catches. It is a weak assertion and it is the
    // only one available — nothing can check that a document is *understandable*, only that it names what the code does.
    expect(CONFIG_FILE_NAME).toBe("qat.config.json");
    expect(format).toContain(CONFIG_FILE_NAME);
  });
});

describe("the example files", () => {
  it.each(["qat.config.minimal.json", "qat.config.json"])(
    "parses examples/configuration/%s",
    async (name) => {
      const value: unknown = JSON.parse(
        await readFile(join(EXAMPLES, name), "utf8"),
      );

      const result = qatConfigSchema.safeParse(value);

      // The issue list rather than a bare boolean, so a failure says which field disagrees rather than "expected false to
      // be true".
      expect(result.success ? [] : result.error.issues).toStrictEqual([]);
    },
  );

  it("keeps the template to the two required fields", async () => {
    const value = JSON.parse(
      await readFile(join(EXAMPLES, "qat.config.minimal.json"), "utf8"),
    ) as object;

    // A template that grows stops being a starting point. Asserted on the keys rather than on the parsed result, because
    // the parsed result carries the defaults — which is exactly what a template should not spell out.
    expect(Object.keys(value).sort()).toStrictEqual(["framework", "version"]);
  });

  it("exercises every field in the populated example", async () => {
    const value = JSON.parse(
      await readFile(join(EXAMPLES, "qat.config.json"), "utf8"),
    ) as Record<string, unknown>;

    // Which fields have declared children comes from the schema, not from this walk. `environments` holds keys the user
    // chooses, so it contributes one path and not its contents — a rule this test would have to guess at otherwise, and
    // would guess wrong for the first record-shaped field added after it was written.
    const paths = Object.entries(value).flatMap(([field, entry]) => {
      const nested = CONFIG_FIELD_PATHS.some((path) =>
        path.startsWith(`${field}.`),
      );

      return nested &&
        typeof entry === "object" &&
        entry !== null &&
        !Array.isArray(entry)
        ? [field, ...Object.keys(entry).map((child) => `${field}.${child}`)]
        : [field];
    });

    // Every field the schema declares, and nothing else. A field added to the schema has to appear here, which is what
    // being documented and shown means in practice.
    expect(paths.sort()).toStrictEqual([...CONFIG_FIELD_PATHS]);
  });
});

describe("the specification", () => {
  it.each(CONFIGURATION_DOCUMENTS)(
    "has at least one complete example in %s",
    async (document) => {
      // A document with no example is a document nobody can copy. Asserted before the block check below, so an empty
      // result is a missing example rather than a silently passing loop.
      expect(jsonBlocks(await read(document)).length).toBeGreaterThan(0);
    },
  );

  it.each(CONFIGURATION_DOCUMENTS)(
    "validates every json block in %s",
    async (document) => {
      for (const block of jsonBlocks(await read(document))) {
        // `JSON.parse` first: invalid JSON and invalid configuration are different mistakes, and a document with a trailing
        // comma in it should say so rather than reporting a schema issue at the root.
        const value: unknown = JSON.parse(block);

        const result = qatConfigSchema.safeParse(value);

        expect(result.success ? [] : result.error.issues).toStrictEqual([]);
      }
    },
  );

  it("documents exactly the fields the schema declares", async () => {
    const documented = documentedFields(
      await read("docs/architecture/configuration-format.md"),
    );

    // Non-empty first, so a formatting change in the table — a leading space, a different column order — cannot make the
    // two lists agree by both being empty.
    expect(documented.length).toBeGreaterThan(0);
    expect(documented).toStrictEqual([...CONFIG_FIELD_PATHS]);
  });
});

describe("non-functional behaviour", () => {
  it("reads the same documents twice and gets the same answer", async () => {
    const first = documentedFields(
      await read("docs/architecture/configuration-format.md"),
    );
    const second = documentedFields(
      await read("docs/architecture/configuration-format.md"),
    );

    expect(second).toStrictEqual(first);
  });

  it("keeps every example file in the examples directory accounted for", async () => {
    const files = (await readdir(EXAMPLES)).filter((name) =>
      name.endsWith(".json"),
    );

    // A third example added without a case above is a file nothing validates. Cheaper to notice here than when somebody
    // copies it.
    expect(files.sort()).toStrictEqual([
      "qat.config.json",
      "qat.config.minimal.json",
    ]);
  });
});
