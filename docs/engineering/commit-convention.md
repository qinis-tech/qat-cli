# Commit Convention Specification

| | |
| --- | --- |
| **Status** | Normative |
| **Applies to** | All commits on all branches of the QAT repository |
| **Owner** | Technical Lead |
| **Enforced by** | `commitlint.config.mjs`, `.github/workflows/contribution-standards.yml` |
| **Based on** | [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/) |
| **Last reviewed** | <!-- YYYY-MM-DD --> |

---

## 1. Purpose and scope

This document specifies how commit messages are written in the QAT repository.

It exists to serve four purposes:

1. **Human legibility.** `git log` is the primary record of why the code looks the
   way it does. It must be readable without opening a pull request.
2. **An exact record on `main`.** QAT squash-merges, so the pull request title becomes
   the sole commit on `main`. There is no commit detail to fall back on.
3. **Machine consumption.** Types and scopes drive automated changelog generation and
   semantic versioning. Consistent messages make releases derivable from history
   instead of assembled by hand.
4. **Traceability.** A footer links each change to the WBS task or defect that
   authorised it.

### 1.1 Normative language

The terms MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are used as defined in RFC 2119.

### 1.2 Relationship to tooling

`commitlint.config.mjs` is the **authoritative** definition of the machine-checked
rules. This document is the authoritative definition of **intent** and of the rules
that are reviewed by a human rather than validated by a parser.

If the two disagree, that is a defect in whichever changed without the other. Fix both
in the same pull request.

---

## 2. Message format

A commit message consists of a header, an optional body, and optional footers.

```
<type>(<scope>): <subject>
<BLANK LINE>
<body>
<BLANK LINE>
<footer(s)>
```

Only the header is mandatory.

### 2.1 Structural grammar

Descriptive grammar, not an exhaustive parser:

```abnf
message     = header LF [ LF body ] [ LF footers ]
header      = type [ "(" scope ")" ] [ "!" ] ": " subject
type        = "feat" / "fix" / "perf" / "refactor" / "test"
            / "docs" / "build" / "ci" / "chore" / "revert"
scope       = 1*( lowercase-letter / "-" )
subject     = 1*60( visible-char )      ; header total MUST be <= 72
body        = 1*( line )                ; lines MUST be <= 100
footer      = footer-token ": " footer-value LF
footer-token= "BREAKING CHANGE" / "Refs" / "Closes"
            / "Reverts" / "Co-authored-by"
```

### 2.2 Hard limits

| Element | Limit | Enforced |
| --- | --- | --- |
| Header (type + scope + subject) | ≤ 72 characters | `header-max-length` |
| Body line | ≤ 100 characters | `body-max-line-length` |
| Subject | No trailing period | `subject-full-stop` |
| Subject | Lowercase first letter | `subject-case` |

The 72-character header limit is deliberate: `git log --oneline` and most terminal
diff views truncate around there, and a subject that only fits by scrolling is not
doing its job.

---

## 3. Types

Exactly one type MUST be used per commit.

| Type | Use for | Release effect | Changelog |
| --- | --- | --- | --- |
| `feat` | A new user-facing capability | MINOR | Features |
| `fix` | A defect correction | PATCH | Bug Fixes |
| `perf` | Performance improvement with no behaviour change | PATCH | Performance |
| `refactor` | Restructuring with no behaviour change | none | hidden |
| `test` | Adding or correcting tests | none | hidden |
| `docs` | Documentation only | none | hidden |
| `build` | Build system, bundling, packaging, TypeScript config | none | hidden |
| `ci` | CI configuration and workflow files | none | hidden |
| `chore` | Maintenance, dependencies, tooling | none | hidden |
| `revert` | Reverting a previous commit | none | Reverts |

### 3.1 Choosing between `fix` and `feat`

A change is `fix` when the behaviour it produces was always the documented intent. It
is `feat` when the behaviour is new.

If a user would have described the old behaviour as a bug, it is a `fix`. If they
would have described it as missing, it is a `feat`.

### 3.2 Choosing between `refactor` and `fix`

`refactor` MUST NOT change observable behaviour. If the change alters output, exit
codes, timing characteristics that users notice, or error text, it is not a
`refactor`. Mislabelling a behaviour change as `refactor` hides it from the changelog,
which is the one thing the changelog exists to prevent.

### 3.3 Choosing between `chore` and `build`

`build` covers anything that affects how the code is compiled or packaged. `chore`
covers repository maintenance that affects neither the product nor the build: adding a
description to an issue template, updating `.editorconfig`, moving a file.

---

## 4. Scopes

A scope MUST be used when the change is confined to one area. It MUST be omitted when a
change genuinely spans the repository.

Scopes correspond to top-level directories under `src/`, plus reserved scopes.

| Scope | Directory or meaning |
| --- | --- |
| `cli` | `src/cli/` — commands, output formatting, prompts |
| `config` | `src/config/` — schema, loader, resolver |
| `core` | `src/core/` — application, domain, errors, filesystem, logging, process |
| `execution` | `src/execution/` — orchestration, process, metadata |
| `cypress` | `src/execution/adapters/cypress/` |
| `results` | `src/results/` — parsers, normalisation, domain |
| `reporting` | `src/reporting/` — generators, security, templates |
| `diagnostics` | `src/diagnostics/` — checks, models |
| `evidence` | `src/evidence/` — discovery, manifest |
| `persistence` | `src/persistence/` — database, repositories |
| `project` | `src/project/` — detection, validation |
| `ci` | `src/ci/templates/` — workflow templates shipped to users |
| `shared` | `src/shared/` — types, utils |
| `deps` | Dependency additions, removals and upgrades |
| `release` | Versioning, publishing, changelog configuration |
| `docs` | `docs/` and repository-level Markdown |

### 4.1 `ci` is ambiguous — here is the rule

- `ci(github)` — changes to **this repository's** `.github/workflows/`
- `ci(ci)` — changes to the **workflow templates QAT generates for users** in
  `src/ci/templates/`

Neither of these is `build`. Build configuration is `build`.

### 4.2 One scope only

Selecting the single most relevant scope forces the author to decide where the change
actually belongs, and a wrong answer is a signal that the change spans boundaries it
should not.

If a change genuinely touches two unrelated areas, it is two commits or two pull
requests.

### 4.3 Adding a scope

A new scope requires the corresponding directory to exist, or a reserved scope entry to
be added deliberately. Adding a scope means updating **all** of:

1. This document (§4)
2. `commitlint.config.mjs` (`scope-enum`)
3. `CONTRIBUTING.md` §3

Missing any one of the three means the scope is either rejected by CI or silently
undocumented.

---

## 5. Subject line

The subject completes the sentence "<type>(<scope>): …".

| Rule | Correct | Incorrect |
| --- | --- | --- |
| Imperative mood | `add project detection` | `added project detection` |
| Lowercase | `add project detection` | `Add project detection` |
| No trailing period | `add project detection` | `add project detection.` |
| Describes effect | `return exit code 1 on spec failure` | `work on exit codes` |
| ≤ 60 characters | `reject unknown config keys` | `reject unknown configuration keys and warn the user` |
| No ticket numbers | `add project detection` | `add project detection [WBS 2.3.1]` |
| No WIP markers | `add project detection` | `WIP add project detection` |

**Imperative mood test:** the subject MUST read correctly when prefixed with
"This commit will…". "This commit will add project detection" — correct. "This commit
will added project detection" — incorrect.

Traceability belongs in a footer, not in the subject. The subject line is permanent
history; the WBS ID is metadata.

---

## 6. Body

The body MAY be omitted when the effect of the change is fully conveyed by the subject.

It SHOULD be included when any of the following is true:

- The reason for the change is not obvious from the diff
- An approach was chosen over a plausible alternative
- A subtle constraint or upstream limitation shaped the implementation
- The change is a workaround for a defect elsewhere
- A reviewer asked a question that future readers will also ask

The body SHOULD answer **why**, not **what**. The diff already states what changed.

```
fix(cypress): return exit code 1 when specs fail

Cypress exits non-zero on spec failure, but the adapter resolved its
promise regardless and the CLI exited 0. CI reported green while the
suite was red.

Map the Cypress exit code onto the QAT exit-code contract and add a
regression test that uses a deliberately failing spec.

Refs: WBS 2.4.7
Closes #112
```

---

## 7. Footers

Footers appear after a blank line following the body. Multiple footers are separated by
blank lines or placed on consecutive lines.

| Token | Purpose | Example |
| --- | --- | --- |
| `BREAKING CHANGE` | Declares a breaking change and its migration path | `BREAKING CHANGE: exit code 2 now means invalid configuration` |
| `Refs` | Traceability to a WBS task or tasks | `Refs: WBS 2.1.2` |
| `Closes` | Closes an issue on merge | `Closes #42` |
| `Reverts` | Identifies the reverted commit | `Reverts 4a1b2c3` |
| `Co-authored-by` | Attribution | `Co-authored-by: A Name <a@example.com>` |

### 7.1 `Refs` format

```
Refs: WBS 2.1.2
Refs: WBS 2.1.2, WBS 2.1.3
Refs: #42
Refs: #42, #57
```

The `Refs` footer SHOULD be present on `feat`, `fix` and `perf` commits. It is the
mechanism that connects a line of code to the requirement that justified it.

---

## 8. Breaking changes

A breaking change is any change that requires users to modify their configuration,
their scripts, or their integration with QAT.

A change is breaking if it alters:

- An exit code or its meaning
- A configuration key name, type, or default
- A command name, flag name, or flag semantics
- A field in the execution-result schema
- An adapter contract that third parties implement
- Minimum supported Node.js version

### 8.1 Declaring one

Either append `!` before the colon, **or** include a `BREAKING CHANGE:` footer. The
footer is REQUIRED regardless, because it is the only place the migration path is
described.

```
fix(config)!: exit code 2 now means invalid configuration

Previously an invalid configuration exited 1, which was indistinguishable
from a test failure. Exit 1 now means "tests failed" only.

BREAKING CHANGE: A CI script that treated exit code 1 as a configuration
error must check for exit code 2. No configuration file changes are needed.

Refs: WBS 2.4.7
```

The footer text is read by users during upgrade. Write it for them, not for the
reviewer.

---

## 9. Revert commits

Use the `revert` type and the `Reverts` footer.

```
revert: feat(cli): add project detection

This reverts commit 4a1b2c3.

The detection heuristic treated any package.json containing a Cypress
dependency as a Cypress project root, which is wrong for monorepos. It
produced incorrect results for three of four test repositories.

Refs: WBS 2.3.1
Reverts 4a1b2c3
```

`git revert` generates a body automatically. It MUST be retained, and the reason for
the revert MUST be added. A revert without a stated reason is a future archaeological
exercise.

---

## 10. Version mapping

While QAT is pre-1.0 (`0.x`), the following mapping applies. This deviates from strict
SemVer and is intentional: at `0.x`, breaking changes are expected and the minor number
is the signal for them.

| Change | `0.x` | `1.x+` |
| --- | --- | --- |
| `feat` | PATCH | MINOR |
| `fix`, `perf` | PATCH | PATCH |
| Breaking change (`!` or footer) | MINOR | MAJOR |
| `refactor`, `test`, `docs`, `build`, `ci`, `chore` | no release | no release |

This table is applied by semantic-release. Changing it is a `release` scope commit and
requires an ADR.

---

## 11. Worked examples

### Valid

| Message | Why it is correct |
| --- | --- |
| `feat(cli): add project detection for Cypress repositories` | Type, scope, imperative, lowercase, 60 chars |
| `fix(cypress): return exit code 1 when specs fail` | States the observable effect |
| `perf(results): stream large JUnit XML files` | Type distinguishes a performance change from a functional one |
| `docs(cli): update installation guide` | Scope matches the subject of the docs |
| `chore(deps): bump execa to 9.5.1` | `deps` scope, no misleading `build` |
| `refactor(core): separate orchestration from adapters` | Pure restructuring, correctly not `fix` |

### Invalid

| Message | Problem | Correction |
| --- | --- | --- |
| `fixed the bug` | No type, past tense, no information | `fix(config): reject unknown keys` |
| `Feat(CLI): Add Detection` | Capitalised type and subject; `CLI` not in scope enum | `feat(cli): add project detection` |
| `feat: add project detection.` | Trailing period | `feat(cli): add project detection` |
| `feat(cli): add detection, fix exit codes, update docs` | Three unrelated changes, no scope precision | Three commits |
| `update stuff` | No type, no effect described | Depends what changed — name it |
| `WIP` | Not a commit message | Do not commit; use a draft PR |
| `fix: WBS 2.4.7` | WBS ID in subject, no description of the change | `fix(cypress): …` with `Refs: WBS 2.4.7` |
| `refactor(execution): change exit code on timeout` | Behaviour change mislabelled as `refactor` | `fix(execution): return exit code 1 on timeout` |

---

## 12. Validation and enforcement

### 12.1 Layers

| Layer | Mechanism | Failure mode |
| --- | --- | --- |
| Local, at commit time | `commitlint` via `.husky/commit-msg` | Commit rejected |
| Pull request | `commitlint` over `base..head` in CI | Check fails |
| Pull request title | `action-semantic-pull-request` in CI | Check fails |
| Review | Human check of sections 5, 6, 8 | Change requested |

The local hook is a convenience. **CI is the authority** — a commit that only passed
locally because `--no-verify` was used WILL fail the pull request.

### 12.2 Rule-to-enforcement matrix

| Rule | commitlint | CI review | Human review |
| --- | --- | --- | --- |
| Valid type | ✅ `type-enum` | ✅ | — |
| Valid scope | ✅ `scope-enum` | ✅ | — |
| Header ≤ 72 chars | ✅ `header-max-length` | ✅ | — |
| Subject lowercase | ✅ `subject-case` | ✅ | — |
| Subject has no full stop | ✅ `subject-full-stop` | ✅ | — |
| Body leading blank line | ✅ `body-leading-blank` | ✅ | — |
| Body lines ≤ 100 | ✅ `body-max-line-length` | ✅ | — |
| Imperative mood | ❌ not machine-checkable | ❌ | ✅ |
| Subject describes the effect, not the activity | ❌ | ❌ | ✅ |
| `refactor` genuinely changes no behaviour | ❌ | ❌ | ✅ |
| Correct type chosen (`fix` vs `feat`) | ❌ | ❌ | ✅ |
| Breaking change declared | ⚠️ footer presence only | ✅ | ✅ |
| `Refs` footer present on `feat`/`fix` | ❌ | ❌ | ✅ |

The rows marked ❌ are the reason this document exists. A linter can enforce syntax; only
the author and reviewer can enforce meaning.

---

## 13. Common objections

**"The type list is too granular. Why distinguish `chore` from `build`?"**
Because the changelog and release process consume the distinction. `build` and `chore`
are both hidden from the changelog, so the cost of mislabelling between those two is
low — but mislabelling a `fix` as a `refactor` hides a user-facing correction from the
release notes. The granularity exists to protect the `feat`/`fix` boundary, not to
police trivia.

**"Why no ticket number in the subject?"**
The subject becomes permanent history on `main`. WBS identifiers change when a plan is
re-cut; the description of the change does not. The `Refs` footer carries traceability
without decaying the subject line.

**"Why squash every pull request to one commit?"**
Because a single commit per pull request keeps `git bisect` usable and makes the
changelog derivable. In-progress commits are welcome on the branch — they are simply
discarded at merge.

**"Can I use `--no-verify`?"**
No, not for commits that reach a pull request. If the hook is producing a false
positive, fix the hook in its own pull request.

**"What if the change genuinely spans two types?"**
It is two commits, or two pull requests. If they cannot be separated, the change is
doing too much and should be reconsidered rather than labelled.

---

## 14. Amending this specification

This document is changed by pull request with scope `docs` or `release`.

Any change to a type or scope MUST be applied to all three of: this document,
`commitlint.config.mjs`, and `CONTRIBUTING.md` §3. A change to the release mapping
(§10) additionally requires an ADR.

---

## Appendix A — Quick reference

```
feat(cli): add project detection
fix(cypress): return exit code 1 when specs fail
perf(results): stream large JUnit XML files
refactor(core): separate orchestration from adapters
test(config): add configuration validation tests
docs(cli): update installation guide
build(tsconfig): enable noUncheckedIndexedAccess
ci(github): add Windows job to the test matrix
chore(deps): bump execa to 9.5.1
revert: feat(cli): add project detection
```

```
Types:  feat fix perf refactor test docs build ci chore revert
Scopes: cli config core execution cypress results reporting
        diagnostics evidence persistence project ci shared
        deps release docs
```