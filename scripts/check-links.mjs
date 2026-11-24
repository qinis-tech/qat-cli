/**
 * Checks every relative link in the repository's documentation.
 *
 * ## Why this is a script rather than an npm one-liner
 *
 * The obvious command is `markdown-link-check docs/**\/*.md`, and it is wrong on half the matrix: `cmd.exe` does not
 * expand globs, so on Windows the pattern arrives as a literal path that does not exist — and a check that silently
 * inspects nothing reports success. Node does the walking instead, which also makes this file the only place that decides
 * what "the documentation" means.
 *
 * ## Why external links are not checked
 *
 * A link to GitHub is a request to a network the build does not control. A slow DNS answer or a rate limit turns a
 * documentation typo into a red build on one leg of the matrix, and the response to that is always to disable the check
 * entirely. Only relative links are verified — which is where every real defect in this repository has been: a document
 * pointing at an ADR that was never written, or was written under a different name.
 *
 * ## Why one process per file
 *
 * The CLI's handling of multiple positional arguments differs between versions, and a check that inspects one file out of
 * thirty is worse than a slow one. Sequential rather than concurrent, so the output is readable when three files fail at
 * once and the order of the report is the order of the traversal.
 *
 * ## How it is invoked
 *
 * `node scripts/check-links.mjs`, through the `docs:links` script. No shebang and no executable bit: everything is passed
 * as an argument to `node`, so no shell is involved and no `.bin` shim is either.
 */
import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * Directories that hold generated output, vendored code or the repository's own history.
 *
 * Dot-directories are **not** skipped wholesale: `.github` can hold markdown, and its links are ones a contributor
 * follows. `.git` is named explicitly for the opposite reason — it is not documentation and walking it is wasted work.
 *
 * `examples` is absent on purpose: an example that ships documentation has links, and those are the ones a reader follows
 * first.
 */
const SKIPPED = new Set(["node_modules", "dist", "coverage", ".git"]);

/**
 * The CLI entry point, resolved from the installed package rather than from a hard-coded path.
 *
 * ## Why `bin` needs handling in two shapes
 *
 * npm allows a package to declare `"bin"` as a string — one command named after the package — or as an object mapping
 * command names to paths. Reading only one of them works until it meets the other, and the failure is a `join` receiving
 * an object rather than a message about a bin entry. `markdown-link-check` uses the object form.
 *
 * ## Why the file is run through `node` rather than executed
 *
 * No executable bit and no shell are involved, which is the second Windows portability problem avoided: a `.bin` shim is
 * a shell script on POSIX and a `.cmd` on Windows, and neither is the thing that should be running a check.
 */
const require = createRequire(import.meta.url);

function cliEntryPoint() {
  const manifestPath = require.resolve("markdown-link-check/package.json");
  const { bin } = require(manifestPath);

  const entry = typeof bin === "string" ? bin : Object.values(bin ?? {})[0];

  // A dependency update that removed the bin would otherwise fail as a missing file two steps later, with a path that
  // says nothing about why.
  if (typeof entry !== "string") {
    throw new Error(
      "markdown-link-check declares no bin entry, so there is nothing to run.",
    );
  }

  return join(dirname(manifestPath), entry);
}

/**
 * Sorts by name without the locale.
 *
 * `localeCompare` orders differently under different ICU data, and a check whose report order changes between two
 * machines is a check whose output cannot be diffed.
 */
function byName(left, right) {
  if (left.name < right.name) return -1;
  if (left.name > right.name) return 1;

  return 0;
}

/** Every `.md` file under `directory`, depth first, in a stable order. */
async function markdownFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const found = [];

  for (const entry of entries.sort(byName)) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      if (SKIPPED.has(entry.name)) continue;
      found.push(...(await markdownFiles(path)));
      continue;
    }

    if (entry.name.endsWith(".md")) found.push(path);
  }

  return found;
}

/**
 * Runs the CLI over one file.
 *
 * @returns The failing output, or `undefined` when every link resolved.
 *
 * `--quiet` reduces the output to the links that failed, which is the only part worth printing: a report of thirty-six
 * passing links per file trains the reader to scroll past the one that matters.
 */
async function check(file) {
  try {
    // The path is a single argv element, so a checkout under `~/My Projects` reaches the CLI intact — the same quoting
    // problem a shell would introduce, absent because there is no shell.
    await run(
      process.execPath,
      [
        cliEntryPoint(),
        "--quiet",
        "--config",
        join(ROOT, ".markdown-link-check.json"),
        file,
      ],
      { cwd: ROOT },
    );

    return undefined;
  } catch (error) {
    const output = typeof error.stdout === "string" ? error.stdout.trim() : "";

    // A non-zero exit with output is a broken link. A non-zero exit without output is the CLI failing to start — a
    // missing dependency, an unreadable config — which is a different problem and must not be reported as a
    // documentation defect, or somebody will spend an afternoon editing links that are fine.
    return output.length > 0
      ? output
      : `the checker could not run: ${String(error.message)}`;
  }
}

const files = await markdownFiles(ROOT);
const failures = [];

for (const file of files) {
  const output = await check(file);

  if (output !== undefined)
    failures.push({ file: relative(ROOT, file), output });
}

if (failures.length === 0) {
  process.stdout.write(`${String(files.length)} files, no broken links.\n`);
} else {
  for (const { file, output } of failures) {
    process.stderr.write(`\n${file}\n${output}\n`);
  }

  process.stderr.write(
    `\n${String(failures.length)} of ${String(files.length)} files have broken links.\n` +
      "A relative link is checked against this checkout, so a document referencing a record that was never written " +
      "fails here — which is the defect this check exists for.\n",
  );

  process.exitCode = 1;
}
