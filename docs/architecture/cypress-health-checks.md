# Cypress health checks

How QAT answers six separate questions about a Cypress installation, and why the answers are kept apart.

The short version: a Cypress project can be broken in six independent ways, each with a different fix, and the most
expensive failure mode in this area is a diagnostic that names the wrong one. The module in `src/project/cypress-health/`
therefore establishes each fact separately, reports each under its own reason code, and marks the second and third checks
`skipped` — not `failed` — when the fact they depend on was never established.

## The six conditions

| #   | Condition                                  | Established from                                     | Reported by | When it cannot be established                                                                                            |
| --- | ------------------------------------------ | ---------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------ |
| 1   | Cypress is **declared**                    | `package.json` `dependencies` / `devDependencies`    | `DEP-003`   | `CYPRESS_NOT_DECLARED` (error)                                                                                           |
| 2   | The declared package is **installed**      | project-local module resolution                      | `DEP-003`   | `CYPRESS_DECLARED_NOT_INSTALLED`, `CYPRESS_RESOLUTION_REJECTED_OUTSIDE_PROJECT` or `CYPRESS_MANIFEST_UNREADABLE` (error) |
| 3   | The version is **identifiable**            | resolved `cypress/package.json#version`              | `DEP-004`   | `CYPRESS_VERSION_UNKNOWN` (indeterminate)                                                                                |
| 4   | A binary is **installed** for that version | Cypress cache layout                                 | `DEP-008`   | `CYPRESS_BINARY_NOT_INSTALLED` (error) or `CYPRESS_BINARY_UNKNOWN` (indeterminate)                                       |
| 5   | The binary is **runnable**                 | existence, execute permission, bounded verification  | `DEP-008`   | `CYPRESS_BINARY_INACCESSIBLE` (error) or `CYPRESS_BINARY_UNVERIFIED` (indeterminate)                                     |
| 6   | The version is **compatible**              | adapter compatibility policy + shared version engine | `DEP-004`   | `CYPRESS_VERSION_BELOW_MINIMUM` (error), `CYPRESS_VERSION_ABOVE_TESTED_MAXIMUM` / `CYPRESS_VERSION_PRERELEASE` (warning) |

Conditions 4 and 5 share a check because they share an object and a cache location; they are distinguished by the reason
code, not by a second identifier.

## Layering

```
package.json#engines / package.json#dependencies      ← declarations owned by others
        │
        ▼
project/cypress-health/declaration.ts   (pure)        ← condition 1
project/cypress-health/resolution.ts    (I/O)         ← condition 2, reads the manifest as data
project/cypress-health/binary.ts        (I/O)         ← conditions 4 and 5
        │
        ▼
project/cypress-health/assess.ts        (pure)        ← conditions 3 and 6, plus skip logic
        │
        ▼
diagnostics/checks/rules/*.ts                         ← wording, identity, evidence allowlist
```

`assessCypressHealth(evidence)` is a pure function from one immutable snapshot to three condition results. It has no
filesystem, no process and no clock, which is what makes every mandatory installation state testable from a fixture with no
mocks. Gathering happens before it runs, in the workflow that produces the snapshot, because a check that can perform I/O is
a check that will eventually perform the wrong I/O.

## Detection rules

- **Only `dependencies` and `devDependencies` count as a declaration.** Cypress is a hard prerequisite for running Cypress
  tests, so an entry in `optionalDependencies` (best effort) or `peerDependencies` (a statement about consumers) does not
  describe an installed Cypress. Both are still recorded as _mentions_, so a "not declared" report can quote the entry the
  user is thinking of instead of appearing to have missed it.
- **Own properties only.** A dependency key inherited from the prototype chain is not something the user wrote.
- **`devDependencies` wins over `dependencies`** when both declare Cypress. A disagreement between the two is recorded as
  `conflict: true` rather than resolved silently.
- **Specifiers are recorded verbatim**, including `npm:` aliases and `file:` / `link:` / `workspace:` protocols. Whether
  such a specifier is evaluable is the version engine's decision, made once, elsewhere.

## Resolution rules

Resolution is anchored at `<projectRoot>/package.json` and uses Node's own algorithm via `createRequire`, so hoisting,
pnpm's symlinked store and workspaces behave exactly as they do for the package manager.

| Resolved location                                        | Outcome                                     |
| -------------------------------------------------------- | ------------------------------------------- |
| inside the project root                                  | accepted                                    |
| inside an ancestor's `node_modules` (workspace hoisting) | accepted, `hoistedFrom` recorded            |
| inside QAT's own installation                            | **rejected** — "not this project's Cypress" |
| anywhere else (sibling directory, global prefix, cache)  | **rejected**                                |

Three constraints make this safe:

- **The package is read as data, never imported.** Cypress's entry point does work on load; a health check must not execute
  project code to learn a version string. Only `cypress/package.json` is read, with a 1 MiB cap and full parse-failure
  handling.
- **Containment is judged on real paths.** A symlink inside `node_modules` can point anywhere, so the comparison happens
  after `realpath`; otherwise the guard is decorative.
- **No `PATH` or global fallback.** A globally installed Cypress must never make a broken project look healthy. This is a
  decisive rule with a dedicated fixture (`global-only`) proving it.

## Binary rules

The binary lives in a **version-keyed cache outside the project**, is fetched by a post-install step that is frequently
skipped (`--ignore-scripts`, read-only CI caches, offline images), and is platform-specific. That combination is why
"`npm ci` succeeded but Cypress cannot start" is the most misdiagnosed failure in this area.

| Platform | Cache root                     | Entry inside `<root>/<version>/`     |
| -------- | ------------------------------ | ------------------------------------ |
| `darwin` | `~/Library/Caches/Cypress`     | `Cypress.app/Contents/MacOS/Cypress` |
| `linux`  | `~/.cache/Cypress`             | `Cypress/Cypress`                    |
| `win32`  | `%LOCALAPPDATA%\Cypress\Cache` | `Cypress.exe`                        |

`CYPRESS_CACHE_FOLDER` overrides the root. A **relative** override is treated as undeterminable: its meaning depends on
Cypress's working directory, which is not ours to assume, so the check reports "unknown location" rather than a confidently
wrong path.

The approved verification method, in order (ADR-0035):

1. **Static inspection** — reproduce the layout above for the resolved version and inspect the file. Fast, offline, silent,
   and needs no cooperation from the project.
2. **Bounded verification** — only when static evidence is ambiguous, run the project's own Cypress CLI with `verify`
   through the shared process runner: hard timeout (30 s), `shell: false`, capped output, `CYPRESS_VERIFY_ARGUMENTS` frozen
   to `['verify']`.
3. **Never** `cypress run` or `cypress open`. A diagnostic answers "could a run start?"; it does not start one. This is a
   structural property: the rules have no process dependency at all.

The version string originates in an untrusted manifest, so it is validated against a path-safety pattern before being
joined into a path — otherwise a crafted version such as `../../etc` would turn a health check into an arbitrary-path stat
oracle. The pattern is dot-_separated_ runs rather than a flat character class, because a class that allows `.` also allows
`..`, and `path.join` collapses that into the parent directory without a single separator appearing in the string.

## Status and severity

```
skipped        a prerequisite was not established, so we did not look
indeterminate  we looked, and could not establish the fact
fail           we looked, and the fact is false
pass           the fact is true
```

Status and severity are independent, because they answer different questions: status says _what is true_, severity says _how
urgent it is_.

| Reason                                        | Severity    | Why                                                |
| --------------------------------------------- | ----------- | -------------------------------------------------- |
| `CYPRESS_NOT_DECLARED`                        | error       | nothing installs Cypress on a clean checkout       |
| `CYPRESS_DECLARED_NOT_INSTALLED`              | error       | the declared package is not there                  |
| `CYPRESS_RESOLUTION_REJECTED_OUTSIDE_PROJECT` | error       | something answered, but not this project's Cypress |
| `CYPRESS_MANIFEST_UNREADABLE`                 | error       | the installation is damaged                        |
| `CYPRESS_INSTALLED_BUT_UNDECLARED`            | warning     | the project runs today; it will not reproduce      |
| `CYPRESS_VERSION_BELOW_MINIMUM`               | error       | it cannot work                                     |
| `CYPRESS_VERSION_ABOVE_TESTED_MAXIMUM`        | warning     | it probably works; nobody has proven it            |
| `CYPRESS_VERSION_PRERELEASE`                  | warning     | support is claimed for released versions only      |
| `CYPRESS_VERSION_UNKNOWN`                     | warning     | the question was not answered                      |
| `CYPRESS_BINARY_NOT_INSTALLED`                | error       | a run cannot start                                 |
| `CYPRESS_BINARY_INACCESSIBLE`                 | error       | the file is there and unusable                     |
| `CYPRESS_BINARY_UNVERIFIED`                   | warning     | verification did not conclude                      |
| `CYPRESS_BINARY_UNKNOWN`                      | warning     | the cache location is not determinable             |
| skipped                                       | information | a statement about ordering, not about the project  |

A skipped check carries `information` severity deliberately. Giving it a warning would count one missing installation twice
and inflate the apparent severity of a single problem.

At the **finding boundary** that `information` has to be translated: a diagnostic finding is only ever `error` or `warning`,
so a skipped condition publishes its finding at `warning` while the condition's own status still reads `skipped`. The
translation happens in one exhaustive switch per rule rather than a cast, so a new severity in either vocabulary fails the
build instead of publishing something a renderer cannot place.

## The prerequisite rule

```
versionKnown = installed && version readable && compatibility not failed/indeterminate
```

- `DEP-004` is skipped when `DEP-003` did not establish an installed package, with the prerequisite's own reason attached.
- `DEP-008` is skipped when `DEP-004` did not establish a version — the cache is keyed by version, so there is no path to
  inspect.

A skip names its **immediate** blocker, and the blocked finding does **not** repeat the blocker's instructions. One problem,
one instruction, in the finding that actually observed it. The chain is `DEP-003 → DEP-004 → DEP-008`, so following two
pointers reaches the cause; a flat "everything blames `DEP-003`" would make the binary check claim a dependency it does not
have.

## Evidence contract

Evidence is a published contract: rendered to a terminal, serialised into `--format json`, persisted in the diagnostic
session and read back by history and explanation tooling. Once a field is in evidence, removing or renaming it is a breaking
change.

| Check     | Published keys                                                                                       |
| --------- | ---------------------------------------------------------------------------------------------------- |
| `DEP-003` | `declared`, `declaredIn`, `declaredSpecifier`, `installedVersion`, `supportedRange`                  |
| `DEP-004` | `detected`, `supported`, `supportedOrigin`, `evaluatorReason`, `blockedBy`, `blockedByReason`        |
| `DEP-008` | `detected`, `cacheRoot`, `expectedPath`, `verifiedBy`, `probeDetail`, `blockedBy`, `blockedByReason` |

`detected` is the version key for **both** version-bearing checks. It was `version` in `DEP-008` once, which meant the
finding layer — reading `detected` for every check — published a binary finding with no version at all: a field present in
the type, populated in the assessment, and silently dropped at the seam. A regression test asserts the sentence never
contains `(installed version)`.

Publication rules:

- **No absolute paths.** Paths are `~`-abbreviated display strings. Where the package was found is available from the
  collector for verbose logs; a home directory does not belong in a report.
- **No environment values, tokens or file contents.** Nothing from `.npmrc`, nothing from the process environment.
- **No `undefined`.** Absent observations are `null`, because `undefined` disappears during JSON serialisation and would
  erase the difference between "we looked and found nothing" and "we never looked".
- **Untrusted text is sanitised.** `probeDetail` comes from a binary the project controls. ANSI escapes and control
  characters are stripped, whitespace collapsed, and the tail kept to 300 characters — without that, a compromised install
  can repaint the doctor's output and hide the real finding.
- **Evidence is allowlisted, never spread.** The internal contract will keep growing; each growth should be a deliberate
  decision about what leaves the process.
- **`verifiedBy` is always published.** `static-cache-inspection` means "a file with execute bits"; `cypress-verify` means
  "Cypress started it". Publishing the method stops a `stat` from being read as proof of execution.

`DEP-003`'s `supportedRange` is the one field that does not come from the assessment: it is injected policy, carried so the
"any release inside the supported range" sentence can be composed without the rule holding a copy of the numbers. Everything
else in these tables is an observation.

## Supported Cypress range

`src/execution/adapters/cypress/compatibility.ts` is the single declaration:

| Field              | Meaning                                                                 |
| ------------------ | ----------------------------------------------------------------------- |
| `supportedRange`   | semver range, written with an explicit floor and exclusive ceiling      |
| `origin`           | provenance carried into evidence, e.g. `adapters/cypress#compatibility` |
| `documentation`    | anchor used by remediation                                              |
| `verifiedReleases` | Cypress releases exercised in CI                                        |

### Approved policy

| Field              | Value                            |
| ------------------ | -------------------------------- |
| `supportedRange`   | `>=12.0.0 <14.0.0`               |
| `verifiedReleases` | `12.17.4`, `13.6.0`              |
| `origin`           | `adapters/cypress#compatibility` |

This table is the single place the range is pinned. The contract test compares it against the module and against each
verified release, so the policy cannot move without the prose moving with it — and the boundary cases derive their floor and
ceiling from the range rather than restating it, so a legitimate change produces no spurious failures while an inclusive
floor turned into an exclusive one still fails both sides of the edge.

The range is declarative only. Comparison uses the shared version engine, so there is exactly one definition of "in range"
across the runtime, package-manager and Cypress checks — a convenience helper here would become a second semver
implementation with different `^` and pre-release semantics.

An explicit ceiling (`<14`) rather than a caret is deliberate: a caret would silently claim support for an untested major
the day it is published.

### Changing the supported range

1. Edit `supportedRange` and `verifiedReleases` in `src/execution/adapters/cypress/compatibility.ts`.
2. Update the **Approved policy** table above.
3. Run the contract test.

The contract test fails if the documentation and the module disagree, if a verified release falls outside the declared range,
or if the floor is not represented by a verified release — which is how "all approved boundaries verified" becomes executable
rather than aspirational.

## Non-goals

Stated because each one is tempting and wrong:

- **Never install anything.** `cypress install` is suggested in remediation, never executed. A diagnostic that repairs what
  it finds is a treatment wearing a stethoscope.
- **Never run the project's tests.** Not `cypress run`, not a spec glob. Asserted by a test that fails on any spawn whose
  arguments contain `run` or `open`.
- **Never import the package.** Loading Cypress executes project code.
- **Never resolve from `PATH` or `node_modules/.bin`.** The first makes broken projects look healthy; the second runs
  project-controlled code to learn a name.
- **Never delete or rewrite a cache entry.** Remediation says what to run.
- **Never merge the QAT runtime requirement with a project-level framework bound.** Different owners, different urgency; they
  produce different findings.

## Performance

| Path                     | Budget                                                    |
| ------------------------ | --------------------------------------------------------- |
| declaration + resolution | < 20 ms (one existence pass, one manifest read)           |
| static binary inspection | < 10 ms                                                   |
| bounded verification     | 30 s hard ceiling, only when static evidence is ambiguous |
| whole `qat doctor`       | inside the documented responsiveness budget               |

Determinism: identical fixture produces identical evidence across runs, with sorted lists and an injected clock.

## Testing

| Level                               | Covers                                                                                                            |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| unit (`project/cypress-health/*`)   | declaration parsing, resolution containment, cache layout, assessment matrix, skip cascade — pure, literal inputs |
| unit (`diagnostics/checks/rules/*`) | verdict mapping, reason narrowing, severity translation, guidance fallbacks                                       |
| integration                         | real resolution over fixture projects, fake binary inspector, aggregation                                         |
| contract                            | doc parity for the supported range; published-key sets; one fixture per mandatory state                           |
| e2e                                 | real `qat doctor`: detected and expected versions in output, JSON validates against the result schema             |

Fixture states (each a directory under `tests/fixtures/cypress/`): `healthy`, `healthy-dependencies`,
`not-declared-not-installed`, `declared-not-installed`, `installed-not-declared`, `version-unreadable`,
`version-below-minimum`, `version-above-maximum`, `binary-absent`, `binary-not-executable`, `cache-folder-override`,
`global-only`, `pnpm-layout`, `corrupt-package-json`.

`global-only` is the decisive one: a project whose only Cypress is global must not pass.

## Scenario traceability

| Scenario                       | Check                |
| ------------------------------ | -------------------- |
| `declared-and-installed`       | `DEP-003`            |
| `not-declared`                 | `DEP-003`            |
| `declared-not-installed`       | `DEP-003`            |
| `installed-not-declared`       | `DEP-003`            |
| `resolved-outside-project`     | `DEP-003`            |
| `manifest-unreadable`          | `DEP-003`            |
| `version-supported`            | `DEP-004`            |
| `version-below-minimum`        | `DEP-004`            |
| `version-above-tested-maximum` | `DEP-004`            |
| `version-prerelease`           | `DEP-004`            |
| `version-unknown`              | `DEP-004`            |
| `binary-present`               | `DEP-008`            |
| `binary-absent`                | `DEP-008`            |
| `binary-not-executable`        | `DEP-008`            |
| `verification-inconclusive`    | `DEP-008`            |
| `cache-location-unknown`       | `DEP-008`            |
| `precondition-unsatisfied`     | `DEP-004`, `DEP-008` |

## Known follow-ups

- **The runner should prefer `finding.severity` over `CheckDefinition.severity`.** Both checks produce warnings by design
  (ghost install, above-maximum version); if the runner reads only the definition's severity, both will block despite being
  classified as advisory.
- **`toFindingSeverity` is duplicated** across the rule modules. It belongs in one shared place, because three copies of a
  severity translation is how one of them ends up mapping `information` differently.

## References

- [ADR-0032](adr/0032-skip-a-check-whose-precondition-failed-rather-than-reporting.md) — a check whose precondition failed is
  skipped, not failed.
- [ADR-0035](adr/0035-verify-the-cypress-binary-by-inspecting-its-cache-before-inv.md) — cache inspection
  before bounded verification, and never the project's tests.
- [Cypress detection](cypress-detection.md) — how a project is recognised at all.
- [Diagnostics](diagnostics.md) — status vocabulary, severity model and the finding contract.
- [Doctor checks](doctor-checks.md) — the full check catalogue.
