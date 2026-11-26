# Package managers

What QAT recognises about a project's package-manager environment, what it will and will not do with that knowledge, and how the check reports each condition.

This document is **the published form of the policy** in `src/project/package-manager/policy.ts`. The table below is parsed by a contract test and compared with the code, so changing one without the other fails the build rather than drifting quietly. The file is referenced by that test through `PACKAGE_MANAGER_POLICY_DOC`, so moving it fails in one obvious place.

Related reading: `docs/architecture/doctor-checks.md` (the check's place in the report), `docs/architecture/diagnostics.md` (severity and status semantics), and ADR-0034 (why detection is evidence-based and never executes a binary).

---

## 1. Supported managers

A manager is **supported** when QAT will diagnose projects installed with it and name its install command. A manager that is recognised but unsupported is still _identified_ — "you are using Bun" and "I cannot tell what you are using" are different messages with different remedies.

| Manager | Lockfiles                                  | Install marker                    | Executable | Supported |
| ------- | ------------------------------------------ | --------------------------------- | ---------- | --------- |
| `npm`   | `package-lock.json`, `npm-shrinkwrap.json` | `node_modules/.package-lock.json` | `npm`      | yes       |
| `pnpm`  | `pnpm-lock.yaml`                           | `node_modules/.pnpm`              | `pnpm`     | yes       |
| `yarn`  | `yarn.lock`                                | `node_modules/.yarn-integrity`    | `yarn`     | yes       |
| `bun`   | `bun.lockb`, `bun.lock`                    | _(none)_                          | `bun`      | no        |

Notes that the table cannot carry:

- **`npm-shrinkwrap.json` and `package-lock.json` both mean npm.** Their co-existence is not a conflict and has no precedence rule; either is quoted as evidence, using the order above so reports stay stable across runs.
- **`bun` has no install marker QAT is willing to rely on**, so installation state for Bun is reported as _unknown_ rather than inferred. The manager is recognised so a Bun project is classified precisely.
- **Lockfile matching is case-insensitive.** The same repository checked out on a Windows or default-macOS volume resolves `PNPM-LOCK.yaml` to the same file.

## 2. Install commands

QAT never runs these. They appear in remediation text so that the advice cannot drift from the set of managers QAT claims to support, and each one is the invocation that **respects a committed lockfile**:

| Manager | Command                          | Why this one                                                                           |
| ------- | -------------------------------- | -------------------------------------------------------------------------------------- |
| `npm`   | `npm ci`                         | Fails instead of rewriting `package-lock.json` when the manifest and lockfile disagree |
| `pnpm`  | `pnpm install --frozen-lockfile` | Refuses to update `pnpm-lock.yaml`                                                     |
| `yarn`  | `yarn install --immutable`       | Refuses to modify `yarn.lock`                                                          |
| `bun`   | `bun install --frozen-lockfile`  | Same guarantee, for completeness                                                       |

A non-frozen install is what produces the second lockfile this check exists to detect. Recommending one would be advising the fault.

---

## 3. How the manager is identified

Two sources, one fixed precedence, and **no silent arbitration**:

1. **`packageManager`** in `package.json` — what the project says it does.
2. **Lockfiles at the project root** — what the project actually did.
3. **Disagreement between the two is reported**, never resolved.
4. **No evidence at all is `undeclared`**, never "npm by default".

Constraints that matter:

- **Root only.** A lockfile three directories down belongs to a different project. Counting it would misreport a plain single-package repository.
- **Presence, not content.** A zero-byte `pnpm-lock.yaml` still identifies pnpm. Reading the file would cost time, risk parsing a very large file, and tell us nothing about identity.
- **Identity is never established by executing anything.** QAT does not run `pnpm --version` to discover that the manager is pnpm: that would execute project-controlled code merely to read a label, and it answers a different question.
- **Unrecognised lockfiles are evidence, not identity.** A `deno.lock` in the root is mentioned; a small explicit list of other ecosystems' lockfiles (`Cargo.lock`, `poetry.lock`, `Gemfile.lock`, …) is ignored so that a mixed repository does not train users to ignore the finding.

## 4. What the check reports

One check, `environment.package-manager`, walking a ladder. The rungs are mutually exclusive in practice — nothing identified the tool, so there is no version to compare; the binary is absent, so no version could be read — and the first applicable rung is the one reported. Presenting every rung at once would show consequences of one cause as separate problems.

All of them are **advisory**. A missing or mismatched package manager does not prevent QAT from running an already-installed suite; it predicts a confusing install later. Strict mode is how a team opts into blocking.

| Code       | Condition                                                       | What the reader is told                                                   |
| ---------- | --------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `QAT-H002` | Nothing identifies the manager                                  | Declare it in `packageManager`, or commit the lockfile                    |
| `QAT-H010` | `packageManager` is present but unusable (bare name, malformed) | Correct the field to `name@version`                                       |
| `QAT-H011` | Manager identified but outside this policy                      | Recognised, not supported; QAT will not modify the lockfile               |
| `QAT-H012` | Two lockfiles, or a declaration contradicting the footprint     | Which files disagree; delete the one you do not use, do not install first |
| `QAT-H013` | Executable not on PATH                                          | `corepack enable` and `corepack prepare`, or a global install             |
| `QAT-H014` | Executable version outside what the project declares            | The expectation and its provenance; the `corepack use` command            |
| `QAT-H015` | A version was expected and could not be read                    | Timeout, failure or no usable output — named, and bounded                 |
| `QAT-H016` | Dependencies not installed                                      | The install command that respects the lockfile                            |
| `QAT-H017` | `node_modules` was created by another manager                   | Both managers named; reinstall with the declared one                      |

**`QAT-H015` is not a pass.** An unverified version is not a matching one. It is also not a failure: a toolchain that answered oddly is not a broken project. It is reported as indeterminate and never counted as clean.

**`not-probed` produces nothing.** It means no version was declared, or the platform requires a shell QAT refuses to enable. Reporting it as "unverified" would teach users to ignore the code that matters.

## 5. Guarantees

These hold for every run, and each has a test that fails if it stops holding:

| Guarantee                                       | Why it is a guarantee rather than an intention                                                                                           |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **Never installs, updates or repairs**          | Fixture file hashes and `mtime`s are asserted unchanged before and after; the check also runs against a read-only fixture directory      |
| **Never rewrites a lockfile or `package.json`** | Same fixture assertion; the code has no writer at all                                                                                    |
| **PATH only, never `node_modules/.bin`**        | That directory is writable by any dependency install, so resolving a tool from there would run project-controlled code to learn its name |
| **No shell**                                    | Commands are spawned with an argument array; a directory name containing `;` or `&` cannot become a command                              |
| **Bounded probing**                             | 2 s timeout, 512 bytes of output, and the probe is skipped entirely when no version was declared                                         |
| **No network, no `.npmrc`**                     | Registry credentials are never read, so they cannot appear in a finding, a log or a persisted record                                     |
| **One filesystem pass**                         | A single root listing; two reads of one tree are two reads that can disagree                                                             |

## 6. Changing the policy

Adding or removing a manager is a one-file change plus three companions, and the compiler enforces two of them:

1. `src/project/package-manager/policy.ts` — the table. The `PackageManagerPolicy` annotation is a total `Record` over the manager union, so a missing entry does not compile.
2. The union in `contracts.ts`, if the manager is genuinely new.
3. **This table.** The contract test compares it with the code.
4. A fixture under `tests/fixtures/package-manager/` proving the manager is detected. The contract test asserts one exists per supported manager — a support claim with no fixture is a claim nobody checked.

`findPolicyConflicts()` reports internal contradictions (a lockfile claimed by two managers, an entry with no executable). It runs as a test rather than a module-load assertion, so an injected policy can be examined without crashing the process.

## 7. What this policy does not cover

Stated so that silence is not read as support:

- **Yarn Plug'n'Play**, Berry-specific configuration, and `.yarnrc.yml` settings. `yarn.lock` identifies Yarn; nothing here interprets how it was configured.
- **Workspaces and monorepos.** Only the root is inspected. Running the command one directory too high is a real mistake this check can _see_ (no lockfile, a workspace declaration present) but does not currently diagnose.
- **Package-manager _versions_ in the general case.** A version is compared only when the project declares one, in `packageManager` or `engines.<manager>`. QAT does not maintain its own opinion about which manager versions are acceptable.
- **Managers other than the four above**, including Deno. An unrecognised `deno.lock` is mentioned as evidence; it is not a claim of support.
- **Manifest ↔ lockfile drift** — dependencies added to `package.json` without an install. That is a different check (`DEP-006`, lockfile consistency), and duplicating it here would give one condition two owners.

## 8. Test evidence

| Level                                         | What it proves                                                                                                                             |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Unit (`policy.test.ts`)                       | No duplicate lockfile or executable across managers; every entry has both                                                                  |
| Unit (`detect.test.ts`)                       | The full detection matrix over fixtures, including conflicts, case-insensitivity and root-only scanning                                    |
| Unit (`assess.test.ts`)                       | Every reason code, including "not installed" never reported as "unsupported"                                                               |
| Unit (`node-runtime`/`package-manager` rules) | The ladder returns the first applicable rung, and `not-probed` emits nothing                                                               |
| Integration                                   | Snapshot → detect → assess → finding, with a fake locator                                                                                  |
| Contract                                      | This document's table matches the code; one fixture per supported manager; `HealthCode` members are reachable from a scenario              |
| E2E                                           | `qat doctor` on a real project reports the detected manager, and `--format json` validates against the diagnostic schema                   |
| Non-functional                                | No writes, no install commands, no shell, no `node_modules` resolution, no `.npmrc`, bounded duration, byte-identical evidence across runs |
