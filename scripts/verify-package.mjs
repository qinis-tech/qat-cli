#!/usr/bin/env node
/**
 * Verifies the contents of the npm package before publication.
 *
 * `npm pack --dry-run` tells a human what would ship. This script makes that
 * answer a build gate, because a policy that is only visible in terminal output
 * is a policy nobody enforces on the release that matters.
 *
 * Three checks, in order of strictness:
 *   1. Allowlist  — every packed path must match an approved pattern.
 *   2. Denylist   — known-dangerous paths must be absent (defence in depth;
 *                   the allowlist already excludes them, but a mistake in the
 *                   allowlist should not be the only thing standing there).
 *   3. Content    — high-signal secret patterns in packed text files.
 *
 * Exit code 0 means the package matches policy. Anything else is a release
 * blocker.
 */
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Paths that must be present, or the package is unusable. */
const REQUIRED = [
  { label: "Package manifest", test: (path) => path === "package.json" },
  { label: "Readme", test: (path) => /^readme(\.[a-z]+)?$/i.test(path) },
  { label: "Licence", test: (path) => /^licen[cs]e(\.[a-z]+)?$/i.test(path) },
  { label: "Changelog", test: (path) => /^changelog(\.[a-z]+)?$/i.test(path) },
  { label: "CLI entry point", test: (path) => path === "dist/cli/index.js" },
  {
    label: "CI templates",
    test: (path) => path.startsWith("dist/ci/templates/"),
  },
];

/**
 * Every packed path must match one of these. This is the allowlist that
 * mirrors package.json "files" — narrow on purpose. Anything new must be
 * added here deliberately, which is exactly the review moment we want.
 */
const ALLOWED = [
  /^package\.json$/,
  /^readme(\.[a-z]+)?$/i,
  /^licen[cs]e(\.[a-z]+)?$/i,
  /^changelog(\.[a-z]+)?$/i,
  /^dist\//,
];

/** Patterns that must never appear, each with the reason it is dangerous. */
const FORBIDDEN = [
  {
    pattern: /^src\//,
    reason: "TypeScript source is not the published product",
  },
  { pattern: /^tests\//, reason: "development fixtures must not ship" },
  { pattern: /(^|\/)coverage\//, reason: "coverage output is generated" },
  { pattern: /\.test\.[cm]?[jt]sx?$/, reason: "test files must not ship" },
  { pattern: /(^|\/)\.env/, reason: "environment files may hold credentials" },
  {
    pattern: /\.(pem|key|p12|pfx|jks|keystore)$/i,
    reason: "key material must not ship",
  },
  {
    pattern: /\.(db|sqlite|sqlite3)(-wal|-shm|-journal)?$/i,
    reason: "local databases must not ship",
  },
  { pattern: /^\.git/, reason: "source control metadata must not ship" },
  {
    pattern: /(^|\/)\.github\//,
    reason: "repository automation is not part of the package",
  },
  { pattern: /^scripts\//, reason: "build tooling is not part of the package" },
];

/** High-signal credential patterns. Low false-positive rate by design. */
const SECRET_PATTERNS = [
  {
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/,
    reason: "private key block",
  },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/, reason: "AWS access key id" },
  { pattern: /\bnpm_[A-Za-z0-9]{36}\b/, reason: "npm access token" },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/, reason: "GitHub token" },
  { pattern: /\bsk-[A-Za-z0-9]{32,}\b/, reason: "provider API key" },
];

/** Files above this size are not scanned; large packed files are assets, not source. */
const MAX_SCAN_BYTES = 1_500_000;
/** Source maps are embedded source; scanning them duplicates the scan and is slow. */
const SCANNABLE = /\.(js|mjs|cjs|json|md|txt|yml|yaml|d\.ts)$/i;

/**
 * Reads the file inventory npm would publish.
 *
 * `--ignore-scripts` is essential: without it, `npm pack` runs `prepack`, which
 * builds, which would re-enter this verification and recurse.
 */
function readInventory() {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";

  const raw = execFileSync(
    npm,
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  // Defensive: some npm versions emit warnings around the JSON payload.
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");

  if (start === -1 || end === -1) {
    throw new Error(
      `Could not parse npm pack output as JSON:\n${raw.slice(0, 500)}`,
    );
  }

  const parsed = JSON.parse(raw.slice(start, end + 1));
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;

  if (!entry || !Array.isArray(entry.files)) {
    throw new Error("npm pack reported no file inventory.");
  }

  return entry.files.map((file) => ({ path: file.path, size: file.size ?? 0 }));
}

/** @returns {Promise<string[]>} */
async function scanForSecrets(inventory) {
  const findings = [];

  for (const file of inventory) {
    if (!SCANNABLE.test(file.path) || file.size > MAX_SCAN_BYTES) continue;

    let contents;
    try {
      contents = await readFile(join(PROJECT_ROOT, file.path), "utf8");
    } catch {
      continue; // Unreadable now; the inventory is authoritative either way.
    }

    for (const { pattern, reason } of SECRET_PATTERNS) {
      if (pattern.test(contents)) findings.push(`${file.path}: ${reason}`);
    }
  }

  return findings;
}

const inventory = readInventory();

if (inventory.length === 0) {
  console.error("FAIL  package contains no files. Run `npm run build` first.");
  process.exit(1);
}

const paths = inventory.map((file) => file.path);
const problems = [];

// 1. Allowlist
for (const path of paths) {
  if (!ALLOWED.some((pattern) => pattern.test(path))) {
    problems.push(`not on the publication allowlist: ${path}`);
  }
}

// 2. Required
for (const requirement of REQUIRED) {
  if (!paths.some(requirement.test)) {
    problems.push(`missing required file (${requirement.label})`);
  }
}

// 3. Denylist — defence in depth
for (const path of paths) {
  const hit = FORBIDDEN.find((rule) => rule.pattern.test(path));
  if (hit) problems.push(`forbidden path ${path} — ${hit.reason}`);
}

// 4. Content
problems.push(...(await scanForSecrets(inventory)));

// ── Inventory report ──────────────────────────────────────────────────────
const totalBytes = inventory.reduce((sum, file) => sum + file.size, 0);
const pad = String(Math.max(...paths.map((path) => path.length))).length;

console.log("\nPackage inventory\n");
for (const file of [...inventory].sort((a, b) =>
  a.path.localeCompare(b.path),
)) {
  console.log(
    `  ${file.path.padEnd(pad)}  ${(file.size / 1024).toFixed(1).padStart(7)} kB`,
  );
}
console.log(
  `\n  ${String(inventory.length).padStart(pad)} files, ${(totalBytes / 1024).toFixed(1)} kB unpacked\n`,
);

if (problems.length > 0) {
  console.error("FAIL  package does not match publication policy:\n");
  for (const problem of problems) console.error(`  • ${problem}`);
  console.error(
    "\nFix the cause, not this script. See docs/development/repository-hygiene.md\n",
  );
  process.exit(1);
}

console.log("PASS  package matches publication policy\n");
