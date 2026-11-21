# Continuous Integration

Everything that must be true before a change reaches `main` runs in
`.github/workflows/ci.yml` on GitHub Actions.

## Jobs and required checks

| Job name (required check) | Runs on        | Gates                                            |
| ------------------------- | -------------- | ------------------------------------------------ |
| `Quality gates`           | ubuntu-latest  | `format:check`, `lint`, `typecheck`, `adr:check` |
| `Test (ubuntu-latest)`    | ubuntu-latest  | `npm test`, then `test:coverage`                 |
| `Test (windows-latest)`   | windows-latest | `npm test`                                       |
| `Build`                   | ubuntu-latest  | `npm run build`, tarball upload                  |

**Branch protection must reference these four names exactly.** A required check
whose name does not match any job never reports, so the pull request waits
forever. If a job is renamed, update the protection rule in the same change —
GitHub will not warn you.

## Triggers

| Trigger                 | Why                                                                |
| ----------------------- | ------------------------------------------------------------------ |
| `pull_request` → `main` | Verify before review, so nobody reviews a branch that cannot pass  |
| `push` → `main`         | Re-verify post-merge: two green branches can merge into a red tree |
| `workflow_dispatch`     | Re-run after a runner image change or an infrastructure incident   |

Pull requests from forks run with a read-only token and no repository secrets,
which is why no job depends on either.

## Node.js version policy

`tsconfig.json` targets ES2024; `package.json` declares
`engines.node: ">=24.0.0"`; CI runs `24.x`.

**There is no Node version matrix.** Reasoning:

- Testing the latest 24.x patch verifies the version we actually run on.
- Adding 26 would double runtime to prove something nobody has asked about. When
  a compatibility question becomes real — a consumer reports a failure, or the
  `engines` floor is widened — add the entry then, with the reason recorded.
- The floor is the real risk, and 24.x tracks it closely enough for now. If a
  floor-specific failure ever occurs, add `24.0.0` as a matrix entry rather than
  replacing `24.x`.

There **is** an OS matrix. Process spawning, path separators and filesystem
behaviour differ between Windows and Linux, and those are exactly the areas a
CLI touches. One OS would hide the defects this project is most likely to have.

## Permissions

Workflow-level `permissions: contents: read`; every other scope is `none`.

Nothing here needs to write to the repository: no releases, no comments, no
issue updates. Artifact upload uses the Actions runtime token, not
`GITHUB_TOKEN`, so it needs no scope.

The effect is that a compromised action in this workflow cannot push a commit or
publish a release. `persist-credentials: false` on checkout goes further and
keeps the token out of `.git/config`, so no later step can push either.

## Caching

`actions/setup-node` with `cache: npm` caches `~/.npm`, keyed on the hash of
`package-lock.json`.

Two properties that matter:

1. It caches **downloaded tarballs, not `node_modules`**. A stale cache can make a
   run slower; it can never make a run pass with the wrong dependency tree.
2. `npm ci` still validates the lockfile on every run, so the cache cannot mask a
   lockfile/`package.json` disagreement.

## Local equivalence

`npm run verify` runs the same gates as `Quality gates` plus the test suite:

```bash
npm run verify
```

This is what the pre-push hook runs. Keep it identical to CI — a developer should
be able to reach a green build locally, without a round trip.

**Drift rule:** a gate added to `ci.yml` must be added to `verify`, and the
reverse. CI is the authority; if they disagree, CI wins and `verify` is the thing
that is wrong. The steps are one line each specifically so duplication stays
cheap and visible.

## Adding a gate

1. Add the command as its own named step in the relevant job — not appended to an
   existing step, so the failing gate is identifiable from the check list alone.
2. Add it to `npm run verify`.
3. If the failure should block merges, add the job name to branch protection.
4. Update this document.

## Not in CI yet

| Item                       | Trigger to enable                                                                                                          |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `npm run verify:package`   | The commit that adds `src/cli/index.ts`; the script requires it                                                            |
| End-to-end suite           | First command that spawns the built binary                                                                                 |
| Coverage threshold         | First real feature; see `testing-standards.md`                                                                             |
| Scheduled re-run on `main` | When dependency or runner-image drift starts matters — a weekly `schedule` trigger catches a break with no commit involved |

## Troubleshooting

| Symptom                                          | Cause                                                                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| PR shows "Expected — waiting for status" forever | A required check name does not match a job name in `ci.yml`                                                                    |
| `npm ci` fails                                   | `package.json` and `package-lock.json` disagree — run `npm install` locally and commit the lockfile                            |
| Windows job fails, Linux passes                  | Almost always a path, separator or child-process assumption. Reproduce with a Windows path, not by reading the diff            |
| Coverage artifact missing                        | The run failed before the coverage step; the summary step is `if: always()`, the report upload requires the directory to exist |
| Build fails on the asset copy step               | `src/ci/templates/` has no tracked files. Git does not store empty directories, so the source of the copy does not exist       |
