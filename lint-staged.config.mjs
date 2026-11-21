// @ts-check
/**
 * Commands applied only to staged files.
 *
 * lint-staged stashes unstaged changes, runs these commands, re-stages the
 * result, then restores the stash. That handling of partially staged files is
 * the reason this exists rather than a hand-written loop: doing it manually
 * silently commits hunks the author did not stage.
 *
 * Ignored paths need no special handling. Both tools honour their own ignore
 * files for explicitly passed paths, so a staged file under tests/fixtures/ is
 * skipped rather than reformatted.
 */

/** @type {import('lint-staged').Configuration} */
export default {
  "*.{ts,mts,cts}": ["eslint --fix", "prettier --write"],
  "*.{js,mjs,cjs}": ["eslint --fix", "prettier --write"],
  "*.{json,md,yml,yaml}": ["prettier --write"],
};
