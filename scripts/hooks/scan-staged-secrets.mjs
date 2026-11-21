#!/usr/bin/env node
/**
 * Blocks commits that introduce a credential.
 *
 * Scans the STAGED DIFF, not the working tree. Two consequences, both wanted:
 *
 *   1. Only added lines are inspected. A secret already in history would
 *      otherwise fail every commit forever, with no way to comply except
 *      rewriting history — which makes people disable the hook instead.
 *   2. Unstaged edits are invisible. Committing is the moment that matters;
 *      the working tree is the user's business.
 *
 * Exits 0 when clean, 1 when a credential is found.
 */
import { execFileSync } from "node:child_process";

import { findSecrets } from "../lib/secret-patterns.mjs";

/**
 * Reads the staged patch.
 *
 * --unified=0  no context lines, so every line is either added or removed.
 * --diff-filter=ACMR  deletions cannot introduce a secret; ignore them.
 * --no-ext-diff  a user's configured external diff tool would change the
 *                output format and silently defeat the parser below.
 */
function readStagedDiff() {
  return execFileSync(
    "git",
    [
      "diff",
      "--cached",
      "--unified=0",
      "--diff-filter=ACMR",
      "--no-color",
      "--no-ext-diff",
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
}

/**
 * Extracts added lines with their file and line number.
 *
 * @param {string} diff
 * @returns {Array<{ path: string, line: number, text: string }>}
 */
function parseAdditions(diff) {
  const additions = [];

  let currentPath = null;
  let nextLineNumber = 0;

  for (const rawLine of diff.split("\n")) {
    // A new file section begins with the b-side path. The a-side is ignored
    // because /dev/null appears there for newly added files.
    if (rawLine.startsWith("+++ ")) {
      currentPath = rawLine.slice(4).replace(/^b\//, "").trim();
      continue;
    }

    // Hunk header: @@ -oldStart,oldCount +newStart,newCount @@
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(rawLine);
    if (hunk) {
      nextLineNumber = Number.parseInt(hunk[1], 10);
      continue;
    }

    if (currentPath === null) continue;

    // Removed line: does not advance the new-file line counter.
    if (rawLine.startsWith("-")) continue;

    if (rawLine.startsWith("+")) {
      additions.push({
        path: currentPath,
        line: nextLineNumber,
        text: rawLine.slice(1),
      });
      nextLineNumber += 1;
    }
  }

  return additions;
}

const additions = parseAdditions(readStagedDiff());

if (additions.length === 0) {
  // Nothing staged, or only deletions. Nothing to do.
  process.exit(0);
}

const findings = [];

for (const addition of additions) {
  for (const reason of findSecrets(addition.text)) {
    findings.push({ ...addition, reason });
  }
}

if (findings.length === 0) {
  process.exit(0);
}

console.error(
  "\nCommit blocked: a credential appears in the staged changes.\n",
);

for (const finding of findings) {
  console.error(`  ${finding.path}:${finding.line}  ${finding.reason}`);
}

console.error(`
If this is a real credential, treat it as compromised now:

  1. Rotate it. Revocation comes before cleanup — cleaning history does not
     un-leak a key.
  2. Remove it from the file and commit that removal.
  3. Move the value to a secret store, or to a git-ignored .env file.

If this is a false positive — a documentation example, a test fixture — make it
obviously fake so the pattern cannot match: use "example-not-a-real-key" rather
than something that resembles a live credential.

Do not bypass this check. See docs/development/git-hooks.md.
`);

process.exit(1);
