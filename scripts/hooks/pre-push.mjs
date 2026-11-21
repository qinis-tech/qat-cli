#!/usr/bin/env node
/**
 * Pre-push hook.
 *
 * Two jobs, in this order:
 *
 *   1. Refuse a direct push to a protected branch. Cheap, and the only check
 *      here that protects something a later step cannot fix.
 *   2. Run the full local verification so a broken branch never reaches CI.
 *
 * Deliberately NOT included: packaging verification. That builds dist/ and
 * belongs in CI and the release workflow, where it is authoritative. Adding it
 * here would push the hook past the point where people start using --no-verify,
 * and a bypassed hook is worse than an absent one because it creates false
 * confidence.
 */
import { execFileSync } from "node:child_process";

/** Branches nobody pushes to directly. Changes arrive by reviewed pull request. */
const PROTECTED_BRANCHES = new Set(["refs/heads/main"]);

/** All-zero object name means the remote ref is being deleted. */
const ZERO_SHA = /^0+$/;

/** Emit a warning above this, so hook creep is visible rather than tolerated. */
const SLOW_THRESHOLD_MS = 60_000;

/**
 * Reads the push specification git writes to stdin.
 *
 * One line per ref: <localRef> <localSha> <remoteRef> <remoteSha>
 */
async function readPushSpecification() {
  const chunks = [];

  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks)
    .toString("utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [localRef, localSha, remoteRef, remoteSha] = line.split(/\s+/);
      return { localRef, localSha, remoteRef, remoteSha };
    });
}

/** Runs an npm script with output streamed straight to the terminal. */
function runNpmScript(script) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  execFileSync(npm, ["run", script], { stdio: "inherit" });
}

const refs = await readPushSpecification();

// A tag push carries no branch content. Verification for a release tag happens
// in the release workflow, on a commit CI already validated.
if (!refs.some(({ remoteRef }) => remoteRef?.startsWith("refs/heads/"))) {
  console.log("pre-push: no branch refs to push, skipping verification.");
  process.exit(0);
}

const protectedPush = refs.find(({ remoteRef }) =>
  PROTECTED_BRANCHES.has(remoteRef),
);

if (protectedPush) {
  console.error(`
Push blocked: ${protectedPush.remoteRef.replace("refs/heads/", "")} is protected.

Changes reach this branch through a reviewed pull request, squash-merged. A
direct push skips review entirely — and on a protected branch it also skips the
checks that assume review happened.

  git push origin HEAD:refs/heads/<feature-branch>
  gh pr create

If this is a genuine emergency, that is a decision for a maintainer to make
deliberately, with the bypass, and afterwards — not a reflex in a terminal.
`);
  process.exit(1);
}

const deletions = refs.filter(
  ({ remoteRef, localSha }) =>
    remoteRef.startsWith("refs/heads/") && ZERO_SHA.test(localSha),
);

if (deletions.length === refs.length) {
  console.log("pre-push: branch deletion only, skipping verification.");
  process.exit(0);
}

const startedAt = Date.now();

console.log(
  "pre-push: running verification (format, lint, typecheck, test)...\n",
);

try {
  runNpmScript("verify");
} catch {
  console.error(`
Push blocked: verification failed.

Fix the failure above, or run the steps individually to see it in isolation:

  npm run format:check
  npm run lint
  npm run typecheck
  npm test

Do not push with --no-verify. CI runs the same checks and will reject the
branch, but by then the failure costs a review cycle instead of a minute.
`);
  process.exit(1);
}

const elapsed = Date.now() - startedAt;
console.log(
  `\npre-push: verification passed in ${(elapsed / 1000).toFixed(1)}s.`,
);

if (elapsed > SLOW_THRESHOLD_MS) {
  console.warn(
    `pre-push: this hook took ${(elapsed / 1000).toFixed(1)}s, above the ${SLOW_THRESHOLD_MS / 1000}s budget.\n` +
      "Slow hooks get bypassed. Consider narrowing what runs here or speeding up the suite.",
  );
}
