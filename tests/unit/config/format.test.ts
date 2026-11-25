import { readdir, readFile } from "node:fs/promises";
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
 *
 * ## Why the block check collects instead of asserting
 *
 * An expectation inside a loop aborts at the first failure, so a document with three bad blocks reports one and hides
 * two — and fixing it becomes three rounds of edit-and-run rather than one. The check below gathers every offending
 * block and asserts once, so a single run names all of them.
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

/** A `json` block that is not a whole valid configuration. */
interface BlockFailure {
  /** Zero-based index among the document's `json` blocks, so a reader can count to it. */
  readonly block: number;
  /** A parse error, or the issue paths — never both, because a block that will not parse has no fields to report. */
  readonly issues: readonly string[];
}

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
 * Every `json` block that is not a whole valid configuration.
 *
 * Collected rather than thrown, for the reason in the header: the loop keeps going after a bad block so the reader sees
 * the whole document's worth of problems at once.
 *
 * `JSON.parse` runs first and separately: invalid JSON and an invalid configuration are different mistakes, and a block
 * with a trailing comma should say so rather than reporting a schema issue at the root.
 */
function blockFailures(markdown: string): readonly BlockFailure[] {
  return jsonBlocks(markdown).flatMap((block, index) => {
    let value: unknown;

    try {
      value = JSON.parse(block);
    } catch (error) {
      return [
        {
          block: index,
          issues: [
            `not JSON: ${error instanceof Error ? error.message : String(error)}`,
          ],
        },
      ];
    }

    const result = qatConfigSchema.safeParse(value);

    return result.success
      ? []
      : [
          {
            block: index,
            issues: result.error.issues.map(
              (issue) => issue.path.map(String).join(".") || "(root)",
            ),
          },
        ];
  });
}

/**
 * Every field path documented as the first cell of a table row.
 *
 * Narrow on purpose: the shape has to be a backticked dotted identifier, so a rule in a table (`..`, `results/reports`)
 * is not mistaken for a field. A table whose first column holds something else is invisible to this, which is why the
 * assertion below checks the count as well as the contents — a regex that matches nothing would otherwise pass.
 *
 * Deliberately *not* extended to cover a profile's own properties. `baseUrl`, `variables` and `secrets` are properties
 * of a value rather than paths through the document, so `CONFIG_FIELD_PATHS` does not list them and a table of them here
 * would fail the comparison below. The correct response is to document them in `environment-profiles.md`, or as prose,
 * rather than to widen this extractor.
 */
function documentedFields(markdown: string): string[] {
  const pattern = /^\|\s`([a-zA-Z][a-zA-Z.]*)`\s*\|/gm;

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
  it.each([
    "qat.config.minimal.json",
    "qat.config.json",
    "qat.config.profiles.json",
  ])("parses examples/configuration/%s", async (name) => {
    const value: unknown = JSON.parse(
      await readFile(join(EXAMPLES, name), "utf8"),
    );

    const result = qatConfigSchema.safeParse(value);

    // The issue list rather than a bare boolean, so a failure says which field disagrees rather than "expected false to
    // be true".
    expect(result.success ? [] : result.error.issues).toStrictEqual([]);
  });

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
      // Every offending block in one assertion. The alternative — an expectation inside the loop — reported one block per
      // run, which is how a three-block mistake took three runs to find.
      expect(blockFailures(await read(document))).toStrictEqual([]);
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

  it("reports every bad block rather than the first", () => {
    // The behaviour the collector exists for, asserted directly: one valid document, one fragment, one broken document —
    // and both bad ones named, with their own indices, from a single call.
    const markdown = [
      '```json\n{"version": 1, "framework": "cypress"}\n```',
      '```json\n"secrets": {}\n```',
      '```json\n{ "version": 1, }\n```',
    ].join("\n");

    const failures = blockFailures(markdown);

    expect(failures.map((failure) => failure.block)).toStrictEqual([1, 2]);
    expect(failures[0]?.issues[0]).toContain("not JSON");
    expect(failures[1]?.issues[0]).toContain("not JSON");
  });

  it("keeps every example file in the examples directory accounted for", async () => {
    const files = (await readdir(EXAMPLES)).filter((name) =>
      name.endsWith(".json"),
    );

    // A fourth example added without a case above is a file nothing validates. Cheaper to notice here than when somebody
    // copies it.
    expect(files.sort()).toStrictEqual([
      "qat.config.json",
      "qat.config.minimal.json",
      "qat.config.profiles.json",
    ]);
  });
});
