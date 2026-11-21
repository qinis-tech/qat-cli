# Git Hooks

Hooks are a **local courtesy**, not a gate. They are opt-in, bypassable with
`--no-verify`, and never executed by CI. Every check they run also runs in CI,
which is the authority.

Their job is to shorten feedback from minutes to seconds.

## Division of labour

| Hook         | Runs                                                    | Budget | Rationale                                  |
| ------------ | ------------------------------------------------------- | ------ | ------------------------------------------ |
| `commit-msg` | commitlint                                              | < 1s   | Message formatting is free to check        |
| `pre-commit` | credential scan, format and lint staged files           | < 3s   | Cheap, local, and fixes are mechanical     |
| `pre-push`   | full verification: format check, lint, typecheck, tests | < 60s  | Catches what staged-file checks cannot see |

**Pre-commit deliberately does not typecheck.** Type checking is whole-program
work — it cannot be scoped to staged files — and takes long enough that people
start committing with `--no-verify`. It runs at push, where one slow step is
tolerable because it happens once per branch rather than once per commit.

## The time budget is a requirement

A hook that costs more than a few seconds gets bypassed, and a bypassed hook
enforces nothing while creating the impression that something was enforced. That
is worse than having no hook.

`pre-push` warns when it exceeds 60 seconds. When that warning appears, fix the
cause — do not raise the threshold.

## Protected branches

`pre-push` refuses a direct push to `main`. Changes arrive by reviewed,
squash-merged pull request. This is the one check here that protects something no
later step can repair.

Bypass in a genuine emergency only, deliberately, and reviewed afterwards.

## What is not checked here

| Check                 | Where it runs        | Why not here                          |
| --------------------- | -------------------- | ------------------------------------- |
| Full test suite       | `pre-push`           | Yes — and again in CI                 |
| Packaging inventory   | CI, release workflow | Requires a build; too slow for a push |
| Windows compatibility | CI                   | Cannot be checked on a single machine |
| Dependency audit      | CI                   | Network-dependent, non-deterministic  |

## `--no-verify`

Not permitted, with one exception: verifying that a hook is the thing failing, by
running the same command manually. If that reveals a genuine hook bug, fix the
hook in its own pull request.

## Credential scanning

`pre-commit` scans the **staged diff**, so only added lines are inspected. A
secret already in history will not fail every future commit.

Patterns are high-signal on purpose — private key blocks, cloud access key
formats, npm and GitHub token formats. A scanner that flags the word "password"
in a README gets disabled within a week.

If a false positive blocks you, make the value obviously fake. Use
`example-not-a-real-key` rather than something resembling a live credential.

If a real credential is caught, **rotate it first**. Removing it from the working
tree does not un-leak a key that was pushed.

## Troubleshooting

| Symptom                            | Cause                               | Fix                                                           |
| ---------------------------------- | ----------------------------------- | ------------------------------------------------------------- |
| Hooks never run                    | `npm install` not run since cloning | `npm install` — `prepare` installs them                       |
| `command not found: node`          | Node absent from the shell's PATH   | Install Node; verify `node -v` in the same shell git uses     |
| Hooks run but do nothing           | `core.hooksPath` overridden         | `git config --get core.hooksPath` should be `.husky/_`        |
| `pre-push` sees no input           | Hook run manually                   | Expected — pass a push spec on stdin, or run `npm run verify` |
| Credential scan fails on a fixture | Pattern matched an example value    | Make the value obviously fake                                 |

## Adding a hook

1. Put the logic in `scripts/hooks/`, not in the `.husky/` file. Shell logic is
   unreadable and untestable; Node logic can be run by hand to reproduce.
2. Keep the `.husky/` file to the minimum: a comment stating the budget and one
   command.
3. Add the same check to CI. A hook without a CI counterpart is advisory only,
   which is fine — provided nobody believes otherwise.
