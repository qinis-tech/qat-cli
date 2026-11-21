#!/usr/bin/env node
/**
 * ADR tooling: create records, regenerate the index, detect index drift.
 *
 * Three commands, because those are the three things that go wrong:
 *
 *   new <title>   Hand-numbering collides, and the number is in a filename, so a
 *                 collision is a silent overwrite.
 *   index         A hand-maintained index goes stale without announcing itself.
 *   check         Makes staleness a build failure instead of a review oversight.
 *
 * No dependencies. Reads and writes Markdown; it never interprets the prose.
 */
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ADR_DIR = fileURLToPath(
  new URL("../docs/architecture/adr", import.meta.url),
);
const INDEX_PATH = join(ADR_DIR, "adr-index.md");
const TEMPLATE_PATH = join(ADR_DIR, "template.md");

/**
 * Only numbered records are records. This is what excludes `template.md` and
 * `adr-index.md` from discovery, so neither needs an exclusion list that could
 * be forgotten when a new sidecar file appears.
 */
const RECORD_FILENAME = /^(\d{4})-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/;

/** Longest filename slug before it becomes unreadable in a directory listing. */
const MAX_SLUG_LENGTH = 60;

/**
 * @typedef {object} Record
 * @property {number} number
 * @property {string} filename
 * @property {string} id        Formatted as ADR-0001, for display.
 * @property {string} title
 * @property {string} status
 * @property {string} date
 * @property {number | null} supersededBy
 */

/** @returns {Promise<string[]>} Absolute paths of numbered records. */
async function listRecordPaths() {
  const entries = await readdir(ADR_DIR);
  return entries
    .filter((name) => RECORD_FILENAME.test(name))
    .map((name) => join(ADR_DIR, name));
}

/**
 * Returns the raw text of a level-2 section, excluding its heading.
 *
 * Line-based rather than one regex: section bodies here contain Markdown tables
 * and fenced code, and a single pattern that survives both is harder to trust
 * than a small loop.
 *
 * @param {string} source
 * @param {string} heading Case-insensitive level-2 heading text.
 * @returns {string}
 */
function extractSection(source, heading) {
  const lines = source.split("\n");
  const startIndex = lines.findIndex((line) =>
    new RegExp(`^##\\s+${heading}\\s*$`, "i").test(line.trim()),
  );

  if (startIndex === -1) return "";

  const body = [];

  for (let index = startIndex + 1; index < lines.length; index += 1) {
    // Any heading closes the section; records never nest a level-2 inside one.
    if (/^#{1,6}\s/.test(lines[index])) break;
    body.push(lines[index]);
  }

  return body.join("\n");
}

/**
 * @param {string} rawStatus
 * @returns {{ status: string, supersededBy: number | null }}
 */
function parseStatus(rawStatus) {
  const firstLine = rawStatus
    .replace(/<!--[\s\S]*?-->/g, "") // comments are guidance, not content
    .split("\n")
    .map((line) => line.replace(/[*_`]/g, "").trim())
    .find((line) => line.length > 0);

  if (!firstLine) return { status: "Unknown", supersededBy: null };

  const superseding = /^Superseded by ADR-(\d{4})/i.exec(firstLine);

  return {
    status: firstLine,
    supersededBy: superseding ? Number.parseInt(superseding[1], 10) : null,
  };
}

/**
 * @param {string} path
 * @returns {Promise<Record>}
 */
async function parseRecord(path) {
  const filename = path.slice(path.lastIndexOf("/") + 1);
  const source = await readFile(path, "utf8");

  const match = RECORD_FILENAME.exec(filename);
  const number = Number.parseInt(match[1], 10);
  const fallbackSlug = match[2];

  const title =
    /^#\s+ADR-\d{4}:\s*(.+)$/m.exec(source)?.[1]?.trim() ?? fallbackSlug;
  const date = /^Date:\s*(\d{4}-\d{2}-\d{2})\s*$/m.exec(source)?.[1] ?? "";
  const { status, supersededBy } = parseStatus(
    extractSection(source, "Status"),
  );

  return {
    number,
    filename,
    id: `ADR-${String(number).padStart(4, "0")}`,
    title,
    status,
    date,
    supersededBy,
  };
}

/** @returns {Promise<Record[]>} Records sorted oldest first. */
async function loadRecords() {
  const paths = await listRecordPaths();
  const records = await Promise.all(paths.map((path) => parseRecord(path)));
  return records.sort((a, b) => a.number - b.number);
}

/**
 * @param {string} title
 * @returns {string}
 */
function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, "");
}

/**
 * Renders the index. Deterministic: same records, same bytes. `check` depends
 * on that, so no timestamps and no non-deterministic ordering.
 *
 * @param {Record[]} records
 * @returns {string}
 */
function renderIndex(records) {
  const byNumber = new Map(records.map((record) => [record.number, record]));

  const rows = [...records]
    .sort((a, b) => b.number - a.number) // newest first
    .map((record) => {
      const successor = record.supersededBy
        ? byNumber.get(record.supersededBy)
        : undefined;

      const status = successor
        ? `Superseded by [${successor.id}](${successor.filename})`
        : record.status;

      return `| [${record.id}](${record.filename}) | ${record.title} | ${status} | ${record.date || "—"} |`;
    });

  return `<!--
GENERATED FILE. Do not edit by hand — \`npm run adr:index\` overwrites it, and
\`npm run verify\` fails if it is out of date.

Why an index at all: a directory of numbered files is browsable but not scannable.
The index answers "what has been decided, and is it still in force?" in one screen,
which is the question people actually arrive with.
-->

# Architecture Decision Records

A record of the architecturally significant decisions made on QAT. Each record
states the forces at play, the choice made, and what it cost. Records are
immutable once accepted: a reversal is a new record that supersedes the old one,
so the reasoning behind a change stays visible.

Newest first.

| # | Title | Status | Date |
| --- | --- | --- | --- |
${rows.join("\n")}

## Status legend

| Status | Meaning |
| --- | --- |
| **Proposed** | Written, not yet agreed |
| **Accepted** | In force |
| **Deprecated** | No longer relevant; nothing replaced it |
| **Superseded** | Replaced; the replacement is linked from the status cell |

## Creating a record

\`\`\`bash
npm run adr:new -- "Short noun phrase naming the decision"
\`\`\`

That allocates the next number, copies \`template.md\`, and regenerates this index.

## What counts as architecturally significant

A decision qualifies when reversing it later would be expensive, or when it
constrains how everyone else works. In practice, for this project:

- Anything that changes the **exit-code contract** or the **result schema**
- Anything that changes a **command name, flag or configuration key**
- Any new **abstraction or dependency boundary**, including a new adapter contract
- Any **toolchain** choice with an escape cost — language, compiler, test runner,
  package manager, runtime version
- Any **distribution or licensing** decision
- Any decision you have already had to explain twice

If it would take one paragraph to reverse, it is probably not significant, and a
comment in the code is the right place for it.
`;
}

/** @returns {Promise<void>} */
async function commandIndex() {
  const records = await loadRecords();
  await writeFile(INDEX_PATH, renderIndex(records), "utf8");
  console.log(
    `indexed ${records.length} record${records.length === 1 ? "" : "s"}`,
  );
}

/**
 * A stale index is a lie that nobody notices, so staleness is a build failure.
 *
 * @returns {Promise<void>}
 */
async function commandCheck() {
  const records = await loadRecords();
  const expected = renderIndex(records);

  let actual;

  try {
    actual = await readFile(INDEX_PATH, "utf8");
  } catch {
    console.error("FAIL  adr-index.md is missing. Run `npm run adr:index`.");
    process.exitCode = 1;
    return;
  }

  if (actual !== expected) {
    console.error(
      "FAIL  adr-index.md does not match the records on disk.\n\n" +
        "Run `npm run adr:index` and commit the result. Do not edit the index by hand:\n" +
        "it is generated, so a manual edit will be overwritten and any nuance in it lost.",
    );
    process.exitCode = 1;
    return;
  }

  console.log(`PASS  adr-index.md matches ${records.length} record(s)`);
}

/**
 * @param {string} title
 * @returns {Promise<void>}
 */
async function commandNew(title) {
  if (!title || title.trim().length === 0) {
    console.error(
      'usage: npm run adr:new -- "Short noun phrase naming the decision"',
    );
    process.exitCode = 1;
    return;
  }

  const records = await loadRecords();

  const nextNumber =
    records.length === 0 ? 1 : records[records.length - 1].number + 1;
  const paddedNumber = String(nextNumber).padStart(4, "0");
  const slug = slugify(title);

  if (slug.length === 0) {
    console.error("FAIL  title contains no characters usable in a filename.");
    process.exitCode = 1;
    return;
  }

  const filename = `${paddedNumber}-${slug}.md`;
  const path = join(ADR_DIR, filename);

  // Never overwrite. A collision here means the numbering logic is wrong, and
  // silently replacing an accepted record would be unrecoverable.
  try {
    await readFile(path, "utf8");
    console.error(
      `FAIL  ${filename} already exists. Refusing to overwrite a record.`,
    );
    process.exitCode = 1;
    return;
  } catch {
    // Absent, as expected.
  }

  const template = await readFile(TEMPLATE_PATH, "utf8");
  const today = new Date().toISOString().slice(0, 10);

  const contents = template
    .replace("ADR-NNNN:", `ADR-${paddedNumber}:`)
    .replace(/^#\s+ADR-\d{4}:\s*.*$/m, `# ADR-${paddedNumber}: ${title.trim()}`)
    .replace(/^Date:\s*\d{4}-\d{2}-\d{2}\s*$/m, `Date: ${today}`);

  await writeFile(path, contents, "utf8");

  await commandIndex();

  console.log(`\ncreated docs/architecture/adr/${filename}`);
  console.log(
    "Fill in Context, Decision and Consequences, then set Status to Proposed.",
  );
}

const [command, ...args] = process.argv.slice(2);

switch (command) {
  case "new":
    await commandNew(args.join(" "));
    break;
  case "index":
    await commandIndex();
    break;
  case "check":
    await commandCheck();
    break;
  default:
    console.error(
      "usage: node scripts/adr.mjs <new|index|check> [title]\n\n" +
        '  new "Title"   create the next numbered record and refresh the index\n' +
        "  index         regenerate adr-index.md from the records on disk\n" +
        "  check         fail if adr-index.md is out of date",
    );
    process.exitCode = 1;
}
