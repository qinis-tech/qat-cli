# Cypress health fixtures

Fourteen Cypress projects, each frozen in one state the health checks must tell apart. They are
plain, repository-shaped directories: a `package.json`, sometimes a `node_modules`, never a test
runner and never a real binary.

## What a fixture contains, and what the harness adds

A fixture contains **only what a user's repository would contain**. Everything a test needs to
control — the cache location, PATH, file modes, symlinks — is applied by the harness when it
materialises the fixture into a temporary project (`tests/helpers/temp-project.ts`). That rule is why
there are no `expected.json` files: an expectation is a property of a scenario in the test suite, not
of the repository a user would commit.

Three things are therefore created programmatically, never checked in:

| Thing | Why it cannot live in the repository |
| --- | --- |
| Execute permissions | Git stores only the exec bit, and it does not exist on Windows at all; a checked-in `0o755` file proves nothing on a FAT checkout. |
| `node_modules/cypress` → `.pnpm/…` symlink | Symlinks survive `git` but not a Windows checkout without developer mode. |
| A `cypress` shim on `PATH` | A `global-only` fixture must be able to reach a binary on PATH *while* having none installed. |

## No ancestor `node_modules`

Nothing above a fixture may contain a `node_modules/cypress`. Resolution walks up from the project
root exactly as Node does, so a single stray package in `tests/fixtures/` would make every fixture
resolve it and quietly invalidate the whole matrix. The `.cache/` directory is dot-prefixed for the
same class of reason: a directory whose name starts with a dot is not a fixture, and a loader that
enumerates fixtures by directory name will skip it.

## The shared cache

`.cache/` holds complete Cypress cache roots — `<root>/<version>/<platform entry>` — for the fixtures
that need a binary. Each root contains the entry for **all three supported platforms**, so a single
committed fixture works on a Linux, macOS and Windows runner without a generator step. The "binary"
files are a few bytes of shell stub: the checks inspect them, they are never executed.

The harness sets `CYPRESS_CACHE_FOLDER` to one of these roots for every fixture. Without that, the
checks would read the developer's real cache and the tests would pass or fail on the machine rather
than on the fixture.

## Expected outcomes

| Fixture | DEP-003 | DEP-004 | DEP-008 |
| --- | --- | --- | --- |
| `healthy` | pass | pass | pass |
| `healthy-dependencies` | pass | pass | pass |
| `not-declared-not-installed` | fail `CYPRESS_NOT_DECLARED` (error) | skipped | skipped |
| `declared-not-installed` | fail `CYPRESS_DECLARED_NOT_INSTALLED` (error) | skipped | skipped |
| `installed-not-declared` | fail `CYPRESS_INSTALLED_BUT_UNDECLARED` (warning) | pass | pass |
| `version-unreadable` | pass | indeterminate `CYPRESS_VERSION_UNKNOWN` | skipped |
| `version-below-minimum` | pass | fail `CYPRESS_VERSION_BELOW_MINIMUM` (error) | skipped |
| `version-above-maximum` | pass | fail `CYPRESS_VERSION_ABOVE_TESTED_MAXIMUM` (warning) | skipped |
| `binary-absent` | pass | pass | fail `CYPRESS_BINARY_NOT_INSTALLED` (error) |
| `binary-not-executable` | pass | pass | fail `CYPRESS_BINARY_INACCESSIBLE` (error) |
| `cache-folder-override` | pass | pass | pass (cache root comes from the environment) |
| `global-only` | fail `CYPRESS_DECLARED_NOT_INSTALLED` (error) | skipped | skipped |
| `pnpm-layout` | pass | pass | pass |
| `corrupt-package-json` | fail `CYPRESS_MANIFEST_UNREADABLE` (error) | skipped | skipped |

`global-only` is the decisive one. A `cypress` binary is reachable on PATH and the fixture must still
fail, because a globally installed Cypress is not this project's dependency.

## House rules for adding a fixture

- One state per directory. If a fixture needs an explanation containing "and", it is two fixtures.
- No lifecycle scripts in any `package.json`: a fixture that runs code on install is a fixture that
  can execute anything the test machine happens to have.
- No `cypress.config.ts` unless the state under test is about the configuration file. The health
  checks never read it, and a fixture that includes one suggests they do.