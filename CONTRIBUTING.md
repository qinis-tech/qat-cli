# Contributing to QAT

QAT is a CLI-first test automation engineering platform. This document defines how
changes reach `main`. It is **normative**: pull requests that do not follow it will be
asked to change before review.

Read [`SECURITY.md`](SECURITY.md) before reporting a vulnerability. Do not open a
public issue for a security defect.

## Contents

1. [Quick start](#1-quick-start)
2. [Branch naming conventions](#2-branch-naming-conventions)
3. [Commit message conventions](#3-commit-message-conventions)
4. [Pull request naming](#4-pull-request-naming)
5. [Pull request description requirements](#5-pull-request-description-requirements)
6. [Review expectations](#6-review-expectations)
7. [Merge strategy](#7-merge-strategy)
8. [Feature development workflow](#8-feature-development-workflow)
9. [Defect correction workflow](#9-defect-correction-workflow)
10. [Documentation contribution workflow](#10-documentation-contribution-workflow)
11. [Version-control hygiene](#11-version-control-hygiene)
12. [Definition of Done](#12-definition-of-done)
13. [Required repository settings](#13-required-repository-settings)

---

## 1. Quick start

**Requirements:** Node.js 24 LTS or later, npm 10 or later, Git.

```bash
git clone https://github.com/qinis/qat-cli.git
cd qat-cli
npm ci
npm run build
npm test
```

| Command                 | Purpose                 |
| ----------------------- | ----------------------- |
| `npm run build`         | Compile TypeScript      |
| `npm test`              | Run the Vitest suite    |
| `npm run test:coverage` | Run tests with coverage |
| `npm run lint`          | ESLint                  |
| `npm run format`        | Prettier (write)        |
| `npm run typecheck`     | `tsc --noEmit`          |

Before opening a pull request, all three of these must pass locally:

```bash
npm run lint && npm run typecheck && npm test
```

CI runs the same checks on Linux and Windows. A change that passes on one platform and
fails on the other is not done.

If something in this document is unclear, that is a documentation defect — open an
issue rather than guessing.

---

## 2. Branch naming conventions

```
<type>/<wbs-id>[-<slug>]
```

| Part       | Rule                                                                                |
| ---------- | ----------------------------------------------------------------------------------- |
| `<type>`   | `feat`, `fix`, `docs`, `test`, `refactor`, `chore`, `perf`, `ci`, `build`, `hotfix` |
| `<wbs-id>` | WBS identifier with dots replaced by hyphens, e.g. `2-1-2`                          |
| `<slug>`   | Optional, lowercase, hyphens, at most 5 words                                       |

**Valid examples**

```
feat/2-1-2-git-workflow
feat/2-3-1-cypress-detection
fix/2-4-7-exit-code-on-timeout
docs/2-9-1-quick-start-guide
hotfix/2-5-2-config-loader-crash
chore/2-1-1-repository-provisioning
```

**Invalid examples**

```
feature/git-workflow           # unrecognised type
feat/Git_Workflow              # uppercase and underscore
my-changes                     # no type, no WBS id
2.1.2                          # dots are not permitted
feat/2-1-2_exit_codes          # underscores are not permitted
```

Rules:

1. Branch from `main`, and keep it current with `git rebase origin/main`.
2. `main` is the only long-lived branch. Release tags are cut from `main`.
3. One WBS task or one defect per branch. Do not bundle unrelated work.
4. Never commit directly to `main` — this applies to maintainers too.
5. Delete the branch after merge.

Validation pattern: `^(feat|fix|docs|test|refactor|chore|perf|ci|build|hotfix)/[a-z0-9]+(-[a-z0-9]+)*$`

---

## 3. Commit message conventions

QAT follows [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/).

```
<type>(<scope>): <subject>

[optional body]

[optional footer(s)]
```

### Types

| Type       | Use for                                      | In changelog |
| ---------- | -------------------------------------------- | ------------ |
| `feat`     | New user-facing capability                   | Yes — minor  |
| `fix`      | Defect correction                            | Yes — patch  |
| `perf`     | Performance improvement, no behaviour change | Yes — patch  |
| `refactor` | Restructuring, no behaviour change           | No           |
| `test`     | Adding or correcting tests                   | No           |
| `docs`     | Documentation only                           | No           |
| `build`    | Build system, bundling, packaging            | No           |
| `ci`       | CI configuration and workflows               | No           |
| `chore`    | Maintenance, dependencies, tooling           | No           |
| `revert`   | Reverting a previous commit                  | Yes          |

### Scopes

Scopes map to top-level directories under `src/`, plus reserved scopes.

| Scope         | Covers                                                                  |
| ------------- | ----------------------------------------------------------------------- |
| `cli`         | `src/cli/` — commands, output formatting                                |
| `config`      | `src/config/` — schema, loader, resolver                                |
| `core`        | `src/core/` — application, domain, errors, filesystem, logging, process |
| `execution`   | `src/execution/` — orchestration, process, metadata                     |
| `cypress`     | `src/execution/adapters/cypress/`                                       |
| `results`     | `src/results/` — parsers, normalisation, domain                         |
| `reporting`   | `src/reporting/`                                                        |
| `diagnostics` | `src/diagnostics/`                                                      |
| `evidence`    | `src/evidence/`                                                         |
| `persistence` | `src/persistence/`                                                      |
| `project`     | `src/project/` — detection, validation                                  |
| `ci`          | `src/ci/templates/`                                                     |
| `shared`      | `src/shared/` — types, utils                                            |
| `deps`        | Dependency updates                                                      |
| `release`     | Versioning and publishing                                               |
| `docs`        | Documentation, repository-level files                                   |

Omit the scope only when a change is genuinely repository-wide.

### Subject line

- Imperative mood — `add`, not `added` or `adds`
- Lowercase first letter
- No trailing period
- At most 72 characters
- Describes the effect, not the activity: `return exit code 1 on spec failure`, not
  `work on exit codes`

### Body

Include a body when the _why_ is not obvious from the diff. Wrap at 100 characters.
Explain the problem, the chosen approach, and what was rejected. Do not restate the diff.

### Footers

| Footer                           | Purpose                                           |
| -------------------------------- | ------------------------------------------------- |
| `BREAKING CHANGE: <description>` | Major version transition; include migration steps |
| `Refs: WBS 2.1.2`                | Traceability to the WBS task                      |
| `Closes #123`                    | Closes an issue on merge                          |
| `Co-authored-by: Name <email>`   | Attribution                                       |

`feat!` or a `BREAKING CHANGE:` footer triggers a major release.

### Valid examples

```
feat(cli): add project detection for Cypress repositories
fix(execution): handle missing Cypress dependency
fix(cypress): return exit code 1 when specs fail
docs(cli): update installation guide
test(config): add configuration validation tests
refactor(core): separate execution orchestration from adapters
chore(deps): configure Vitest
perf(results): stream large JUnit XML files instead of buffering
ci(github): add Windows job to the test matrix
```

With a body and footer:

```
fix(cypress): return exit code 1 when specs fail

Cypress exits non-zero on spec failure, but the adapter resolved the
promise and the CLI exited 0. CI reported green while tests were red.

Map the Cypress exit code onto the QAT exit-code contract and add a
regression test using a deliberately failing spec.

Refs: WBS 2.4.7
Closes #112
```

### Invalid examples

```
fixed the bug                          # no type, no scope, past tense
Feat(CLI): Add Project Detection       # capitalised type and subject
feat: add project detection.           # trailing period
feat(cli): add detection, fix exit codes and update docs
                                       # three unrelated changes
update stuff                           # no type, no effect described
WIP                                    # no type, no subject
```

### Enforcement

- Local: `commitlint` via the `commit-msg` hook
- CI: `.github/workflows/contribution-standards.yml` validates every commit in the
  pull request range

`--no-verify` is not acceptable on commits that reach a pull request. If a hook is
wrong, fix the hook in its own pull request.

---

## 4. Pull request naming

Because QAT squash-merges, **the pull request title becomes the commit message on
`main`**. It must therefore obey section 3 exactly:

```
<type>(<scope>): <subject>
```

Rules:

1. Imperative mood, lowercase subject, no trailing period, at most 72 characters.
2. One scope maximum.
3. Do not put the WBS ID or issue number in the title. Reference it in the body. The
   title is a permanent line of repository history; the template already carries
   traceability.
4. `feat` and `fix` titles must reference a WBS task or defect in the body.

|         | Example                                                     |
| ------- | ----------------------------------------------------------- |
| Valid   | `feat(cli): add project detection for Cypress repositories` |
| Valid   | `fix(config): reject unknown keys instead of ignoring them` |
| Invalid | `Feature/Project detection`                                 |
| Invalid | `[WBS 2.3.1] Add project detection`                         |
| Invalid | `WIP`                                                       |
| Invalid | `feat(cli): Added project detection`                        |

Enforced by the semantic-pull-request check in CI.

---

## 5. Pull request description requirements

Use `.github/pull_request_template.md`. Every section must be completed or explicitly
marked `N/A` with a reason.

| Section                          | Requirement                                                  |
| -------------------------------- | ------------------------------------------------------------ |
| Change summary                   | What changed and why, 2–5 sentences                          |
| Related requirement or issue     | `Closes #123` or `WBS 2.3.1`. Mandatory for `feat` and `fix` |
| Implementation details           | Approach, trade-offs, files and modules touched              |
| Tests performed                  | Exact commands run and their outcome                         |
| Acceptance criteria verification | Each criterion, with pass/fail and evidence                  |
| Breaking changes                 | Impact and migration path, or `None`                         |
| Documentation impact             | Docs updated, or justification for none                      |

A pull request that leaves these blank will not be reviewed. Draft pull requests may be
incomplete — mark them ready for review only when complete.

---

## 6. Review expectations

### Author

1. Self-review the diff before requesting review. Read every changed line.
2. Keep pull requests reviewable — target under 400 changed lines; split larger work.
3. Confirm CI is green before requesting review.
4. Request review from the owners listed in `.github/CODEOWNERS`.
5. Respond to every review comment. **The author resolves threads**, not the reviewer.
6. Do not force-push a branch under active review without a comment explaining why.

### Reviewer

1. First response within **1 business day**.
2. Review against the acceptance criteria, not personal preference. Formatting is
   settled by Prettier and ESLint, not by review comments.
3. Classify each comment, or it will be misread:

   | Prefix        | Meaning                        |
   | ------------- | ------------------------------ |
   | `blocking:`   | Must change before merge       |
   | `suggestion:` | Non-blocking improvement       |
   | `nit:`        | Optional, explicitly ignorable |
   | `question:`   | Requires an answer             |

4. Approve only when: CI is green, threads are resolved, the change is tested, and
   documentation is updated or its absence justified.
5. An approval is invalidated by any subsequent push. Re-approval is required.

### Approval requirements

| Change type                                                           | Approvals                                             |
| --------------------------------------------------------------------- | ----------------------------------------------------- |
| Default                                                               | 1                                                     |
| Touches `src/execution/`, `src/config/schema/`, or `src/core/`        | 2                                                     |
| Touches `.github/`, release configuration, or security-sensitive code | 2, including the Technical Lead                       |
| Documentation only                                                    | 1                                                     |
| Hotfix                                                                | 1, then a retrospective review within 2 business days |

You may not approve your own pull request.

---

## 7. Merge strategy

QAT maintains a **linear history on `main`**.

| Aspect                  | Decision                                                      |
| ----------------------- | ------------------------------------------------------------- |
| Strategy                | **Squash and merge**, exclusively                             |
| Merge commits on `main` | Not permitted                                                 |
| Rebase and merge        | Not permitted — loses the squash boundary and PR traceability |
| Updating a branch       | `git rebase origin/main`, never `git merge main`              |
| Branch deletion         | Automatic on merge                                            |
| Result on `main`        | One commit per pull request; message = PR title + body        |
| Release tagging         | Annotated `v<semver>` tag on a `main` commit                  |

**Rationale.** A single commit per pull request keeps `git bisect` usable, makes the
changelog derivable from history, and preserves a one-to-one trace between a WBS task
and the code that delivered it. Merge commits make all three of those harder for no
benefit at this project's scale.

Release notes are generated from Conventional Commits.

---

## 8. Feature development workflow

```
WBS task approved
  → branch:  feat/<wbs-id>-<slug>
  → implement + tests
  → documentation updated
  → PR opened against main, template completed, WBS id referenced
  → CI green + required approvals
  → squash and merge
  → branch deleted, WBS task marked complete
```

Steps in detail:

1. **Confirm the task exists.** Work without an approved WBS task is not accepted.
   If the task is missing, raise an issue first.
2. **Assess architectural impact.** If the change introduces a new abstraction, a new
   dependency boundary, a schema change, or an adapter contract change, add an ADR to
   `docs/architecture/adr/` **before** writing the implementation. ADR merged first,
   code second. This is the single cheapest defence against the project's stated risk
   of accumulating unjustified abstractions.
3. **Write the test first where practical.** Each area under `src/` corresponds to
   tests under `tests/unit/` or `tests/integration/`. A feature that cannot be tested
   is an architectural problem to resolve, not an exemption to grant.
4. **Update documentation in the same pull request.** A new or changed command
   requires a `docs/` update. There is no follow-up-docs ticket.
5. **Open the pull request** referencing the WBS id.
6. **Merge** per section 7.

Partial work is encouraged: ship a smaller complete slice rather than a large
unfinished branch. Put unfinished behaviour behind an undocumented flag, or leave it
out entirely.

---

## 9. Defect correction workflow

```
Defect observed
  → GitHub issue from the "Defect report" template
  → triage: severity and area label assigned
  → reproduce as a failing test on main (regression test first)
  → branch:  fix/<wbs-id>-<slug>
  → fix; regression test green; full suite green
  → PR referencing the defect issue
  → squash and merge
  → defect closed; regression test retained permanently
```

Rules:

1. **Every defect gets an issue**, including ones found by maintainers. Terminal
   output, version, environment, and reproduction steps are mandatory.
2. **A regression test is mandatory** for any defect that reached `main`. The fix is
   incomplete without it. The test must fail before the fix and pass after — state
   both observations in the pull request.
3. **Severity dictates the path:**

   | Severity      | Meaning                                       | Path                                                             |
   | ------------- | --------------------------------------------- | ---------------------------------------------------------------- |
   | S1 — Critical | Data loss, credential leak, corrupted results | `hotfix/`, merge immediately, post-mortem within 2 business days |
   | S2 — Major    | Command unusable, wrong exit code, false pass | `fix/`, prioritised in the current iteration                     |
   | S3 — Minor    | Incorrect output, poor error message          | `fix/`, normal queue                                             |
   | S4 — Trivial  | Cosmetic                                      | `fix/` or `chore/`, batched                                      |

4. **A wrong exit code from `qat run` is always S1 or S2.** A false pass is worse than
   a crash: it destroys trust in every result the tool has ever produced. Treat exit
   code correctness as safety-critical.
5. **Never fix a defect inside an unrelated feature pull request.** Cherry-picking a
   fix out of a tangled diff is how it silently regresses later.
6. If the defect was caused by a missing test category rather than a typo, say so in
   the pull request and propose the broader test addition separately.

---

## 10. Documentation contribution workflow

```
Documentation requirement identified
  → branch:  docs/<wbs-id>-<slug>
  → write in docs/ (Markdown, VitePress-compatible)
  → verify locally: npm run docs:dev, check links and rendered code samples
  → PR, one reviewer
  → squash and merge
```

Rules:

1. **Code samples must be executable.** Copy each command into a shell and confirm the
   output before submitting. An untested snippet is a defect, not a shortcut.
2. **Use the documentation type that fits:**

   | Directory            | Purpose                                                    |
   | -------------------- | ---------------------------------------------------------- |
   | `docs/guides/`       | Task-oriented; the reader achieves a goal                  |
   | `docs/reference/`    | Command syntax, flags, exit codes, configuration keys      |
   | `docs/architecture/` | Design, ADRs, schemas                                      |
   | `docs/engineering/`  | Process standards, including this repository's conventions |

3. **Every CLI command change requires a matching `docs/reference/` update** in the
   same pull request.
4. Documentation-only pull requests still require one approval. Reviewers check
   technical accuracy, not writing style.
5. **No undocumented behaviour is supported behaviour.** If it is not documented, users
   are not expected to rely on it — which is precisely why shipping a feature without
   documentation counts as incomplete work.
6. Fixing a broken link, a typo, or a wrong command does not need a WBS task. Use a
   `docs/` branch and reference the surrounding task or write `N/A — correction`.

---

## 11. Version-control hygiene

### Never commit

- Secrets, tokens, API keys, `.env` files, credentials inside fixtures
- `node_modules/`, compiled output, coverage reports, build artefacts
- `.qat/` — local execution results, reports, screenshots and videos
- Editor and OS files beyond shared configuration
- Large binaries — fixtures stay under 100 KB; generate data instead
- Commented-out code — Git is the archive

### Commit discipline

1. One logical change per commit while working. History is squashed on merge.
2. Write messages for the future reader of `git log`, not as a save point.
3. Never rewrite history on `main`.
4. Force-push is permitted only on your own feature branch, and only before review is
   requested.
5. Do not commit files that CI can generate.

### Operational

1. Rebase onto `main` rather than merging `main` into your branch.
2. Line endings are normalised to LF by `.gitattributes`.
3. Sign your commits if your environment supports it — recommended, not required.
4. Tag releases as annotated `v<semver>` tags on `main` only.
5. Do not amend or edit a commit that another person has based work on.

### Test data and fixtures

Fixtures under `tests/fixtures/` must be synthetic. Never copy real customer data,
internal hostnames, or production URLs into the repository, including in screenshots
and recorded videos.

---

## 12. Definition of Done

A change is done when **all** of the following are true:

- [ ] Acceptance criteria in the WBS task are verifiably met
- [ ] Tests written and passing; regression test added for any defect
- [ ] `npm run lint`, `npm run typecheck`, `npm test` pass locally
- [ ] CI green on Linux and Windows
- [ ] Documentation updated, or its absence explicitly justified
- [ ] No secrets, artefacts, or unrelated changes in the diff
- [ ] Pull request title follows Conventional Commits
- [ ] Required approvals obtained and all threads resolved
- [ ] WBS task marked complete
- [ ] Follow-up work, if any, captured as an issue rather than left in a comment

---

## 13. Required repository settings

These settings on `main` make the conventions above enforceable rather than advisory.
They are configured by a maintainer in GitHub repository settings.

**Branch protection on `main`:**

- Require a pull request before merging
- Require the approvals stated in section 6
- Dismiss stale approvals when new commits are pushed
- Require review from Code Owners
- Require status checks to pass: `Validate pull request title`,
  `Validate commit messages`, plus the build and test jobs
- Require branches to be up to date before merging
- Require conversation resolution before merging
- Require linear history
- Block force pushes and deletions
- Do not allow bypassing the above settings, including for administrators

**Repository:**

- Enable squash merging only; disable merge commits and rebase merging
- Automatically delete head branches on merge
- Enable private vulnerability reporting and keep `SECURITY.md` current

---

## Questions

If this document does not answer your question, that is a gap worth fixing. Open an
issue describing what was unclear, and the document will be amended.
