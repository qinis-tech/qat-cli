#!/usr/bin/env node
/**
 * Writes a coverage summary to the GitHub Actions job summary.
 *
 * Why this exists: a coverage number buried in a log is read only when something
 * is already suspected. A summary rendered on the pull request is read while the
 * change is still being discussed, which is the only moment it can influence
 * anything.
 *
 * Reads `coverage/coverage-summary.json`, produced by the `json-summary`
 * reporter. Missing or malformed input is not an error: coverage is informative
 * here, not a gate, and a failed summary must never fail a run.
 */
import { readFile } from "node:fs/promises";

const SUMMARY_PATH = "coverage/coverage-summary.json";
const METRICS = ["lines", "statements", "functions", "branches"];

let summary;

try {
  summary = JSON.parse(await readFile(SUMMARY_PATH, "utf8"));
} catch {
  console.log("Coverage summary unavailable; skipping.");
  process.exit(0);
}

const total = summary.total ?? {};

const rows = METRICS.map((metric) => {
  const entry = total[metric] ?? {};
  const percentage = typeof entry.pct === "number" ? entry.pct.toFixed(2) : "—";

  return `| ${metric} | ${percentage}% | ${entry.covered ?? "—"} / ${entry.total ?? "—"} |`;
});

console.log("### Coverage\n");
console.log("| Metric | Coverage | Covered / Total |");
console.log("| --- | --- | --- |");
console.log(rows.join("\n"));
console.log(
  "\nNo threshold is enforced yet; see `docs/development/testing-standards.md` for why.",
);
