# ADR-0002: Verify every change in continuous integration

Date: 2026-11-21

## Status

Accepted

## Context

Every quality gate this project needs already exists as an npm script: formatting
verification, linting, type checking, the test suite, and a check that the
decision-record index matches the records on disk. A pre-push hook runs them.

The hook is the problem. It is installed by `npm install` via a `prepare` script,
so it is absent on any machine where that has not happened, and it is bypassable
with `--no-verify`. In practice this means a contribution is verified only if its
author happened to configure their machine correctly and chose not to skip. That
is not a property of the repository; it is a property of a person's habits.

Nothing in the project currently verifies a change that arrives from someone who
did not run the hook, and nothing verifies the state of `main` after two
individually-green branches are merged.

The repository is hosted on GitHub. There is no existing CI infrastructure, no
cloud account beyond that, and no requirement for private networking or custom
hardware.

## Decision

We will run continuous integration on GitHub Actions, defined in
`.github/workflows/ci.yml`, triggered by pull requests targeting `main`, pushes to
`main`, and manual dispatch.

The workflow consists of three jobs, because they answer three distinct questions:
whether the code is acceptable before execution (static gates), whether it behaves
correctly on each supported platform (tests), and whether the artefact we would
publish can be produced (build).

The workflow holds `contents: read` and no other permission. Checkout runs with
`persist-credentials: false`, so the token is not left in `.git/config` and no
later step can push.

Every gate is an npm script, not a workflow feature. The workflow orchestrates;
the scripts define. This keeps the gates runnable locally, keeps the CI
configuration small, and means moving to a different provider would mean
rewriting one file rather than reimplementing the checks.

Branch protection will require the workflow's jobs to pass before a pull request
can merge, so the workflow is the authority rather than an advisory signal.

## Consequences

**Easier**

- Every merge candidate is verified, regardless of who contributed it or how their
  machine is configured.
- A reviewer is never asked to spend time on a branch that cannot pass.
- Verifying `main` after merge catches semantic conflicts between two branches
  that were each green in isolation.
- Least privilege means a compromised third-party action cannot push a commit,
  publish a release, or comment on an issue with this workflow's credentials.
- Because the gates live in npm scripts, reproducing a CI failure locally is a
  single command rather than an exercise in reading workflow YAML.

**Harder**

- Every pull request now costs three runner jobs. Trivial documentation changes pay
  the same price as code changes unless path filtering is added later.
- Two definitions of "acceptable" now exist: `ci.yml` and the pre-push hook. They
  can drift apart, and nothing enforces that they agree. The mitigation is a
  written rule, not a mechanism, and rules are forgotten.
- CI will fail for reasons that are not the contributor's fault — a runner image
  update, a transient network failure, registry trouble. Each occurrence spends
  trust in the signal.
- Someone must now maintain workflow configuration, action versions and runner
  compatibility. That is ongoing work that did not previously exist.
- PRs from forks run with a read-only token and no secrets, which is the correct
  behaviour but permanently forecloses any gate that would need one.

**Neutral**

- GitHub Actions is the delivery platform. The coupling is shallow because the
  gates are npm scripts.
- The workflow runs on hosted runners, so runtime characteristics are outside our
  control and will change without notice.
- A manual dispatch trigger exists, so recovering from an infrastructure failure
  does not require an empty commit.

## Options considered

| Option                                               | Why not                                                                                                                                                                                         |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rely on the local pre-push hook only                 | Opt-in, bypassable with `--no-verify`, and silently absent on any machine that never ran `npm install`. Verifies habits, not the repository.                                                    |
| GitHub Actions                                       | Chosen. The repository is already hosted there, no additional account or billing relationship is needed, and fork pull requests receive a read-only token by default.                           |
| A dedicated CI service (CircleCI, Buildkite, Travis) | Another account, another configuration surface and another set of secrets to manage, for capabilities GitHub Actions already provides at this project's scale.                                  |
| Self-hosted runner                                   | Gives full control of the environment and full responsibility for keeping it patched, available and secure. Nothing here needs custom hardware or private networking, so the cost buys nothing. |
| Scheduled verification only (nightly)                | Moves feedback from minutes to a day. Conflicts are then discovered after merge, by which point the fix lands on `main` rather than on a branch.                                                |

## References

- `docs/development/continuous-integration.md`
- `.github/workflows/ci.yml`
- ADR-0001, for the record format and the immutability rule
- GitHub Actions documentation, workflow syntax and the permissions model
