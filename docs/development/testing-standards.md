# Testing Standards

|                 |                                                                              |
| --------------- | ---------------------------------------------------------------------------- |
| **Status**      | Normative                                                                    |
| **Applies to**  | `tests/`, and any source under test                                          |
| **Framework**   | Vitest 4, coverage via `@vitest/coverage-v8`                                 |
| **Enforced by** | `npm run verify`, CI                                                         |
| **Strategy**    | [`docs/quality/testing-architecture.md`](../quality/testing-architecture.md) |

**This document covers how an individual test is written and run.** Which _kind_ of test a module
needs — unit, integration, contract, application service, infrastructure — is decided in
[`docs/quality/testing-architecture.md`](../quality/testing-architecture.md), together with the
verification matrix, the isolation policy and the mocking rules. Where the two overlap, that document
sets the boundary and this one supplies the mechanics.

## 1. Directory layout

| Path                  | Contains                                                                                                               |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `tests/unit/`         | One module at a time, mirroring `src/`                                                                                 |
| `tests/integration/`  | More than one real module, or a real external program                                                                  |
| `tests/contract/`     | One suite run against every interchangeable implementation                                                             |
| `tests/e2e/`          | The built CLI binary, spawned as a child process                                                                       |
| `tests/fixtures/`     | Static input: sample Cypress projects, config files, captured output                                                   |
| `tests/helpers/`      | Shared test utilities. Not product code, not measured by coverage                                                      |
| `tests/unit/quality/` | Repository invariants. The only tests that do not mirror `src/`, because they test the repository rather than a module |

`tests/unit/` mirrors the `src/` tree. A source file at `src/shared/utils/duration.ts` is tested at
`tests/unit/shared/utils/duration.test.ts`.

`tests/contract/` is not yet in the Vitest `include`. The first contract suite adds the pattern —
until then, an include matching nothing would be indistinguishable from one that is broken.

### Correction to the previous version

The table above previously described `tests/unit/` as having _no filesystem or process side effects_.
That was wrong for this codebase. A test of `ensureDirectory` that does not create a directory tests
nothing, and a test of `runProcess` that does not spawn a process tests a mock.

The rule now: **a unit test touches the operating system only where that is the module's purpose, and
only through a temporary directory it created.** A test may not reach another module of ours for its
own setup, which is what separates it from an integration test.

## 2. Naming conventions

- Test files end in `.test.ts`. No exceptions.
- The file name matches the module under test: `duration.ts` → `duration.test.ts`.
- Where a module needs a second test file, it is named for its concern:
  `paths.containment.test.ts`, not `paths2.test.ts`.
- **The directory determines the suite, not the file name.** There is no `.int.test.ts` or
  `.e2e.test.ts` suffix. Two mechanisms that both claim to identify a suite drift apart the first time
  someone adds a test in a hurry.
- `describe` names the exported symbol: `describe('formatDuration', ...)`.
- Each `it` states one observable behaviour in the present tense: `it('throws on a negative
duration')`.
- **Never begin a test name with "should".** "Should" is a hedge, and a test that hedges is a test
  nobody relies on.

## 3. Commands

| Command                    | Purpose                                        |
| -------------------------- | ---------------------------------------------- |
| `npm test`                 | Run unit and integration tests once            |
| `npm run test:unit`        | Unit tests only                                |
| `npm run test:integration` | Integration tests only                         |
| `npm run test:watch`       | Watch mode, local development only             |
| `npm run test:coverage`    | Run once with a coverage report                |
| `npm run test:ci`          | Run once, also writing JUnit XML to `reports/` |

`npm test` never runs end-to-end tests. Those spawn the built binary and are executed on demand once
that configuration exists.

`test:integration` no longer carries `--passWithNoTests`. It was there while the directory was
legitimately empty; the process runner now lives there, and the flag would hide an accidentally empty
suite.

Never use watch mode in CI. `vitest run` is the only CI-safe form; the bare `vitest` command waits for
input and will hang until the job times out.

## 4. Module format

QAT is ESM under `moduleResolution: nodenext`. This has one consequence that catches everyone at least
once:

```ts
import { formatDuration } from "~/shared/utils/duration.js"; // correct
import { formatDuration } from "~/shared/utils/duration"; // tsc error
```

The `.js` extension is mandatory even though the file is `duration.ts`. `tsc` compiles the specifier
as written; it does not add extensions.

### The `~` alias

`~` maps to `src/` and exists **for tests only**. Relative imports from `tests/unit/shared/utils/` into
`src/` would need four levels of `../`, which break on every file move and fail at runtime rather than
compile time.

**Never use `~` inside `src/`.** `tsc` does not rewrite module specifiers, so `~/...` would be emitted
verbatim into `dist/` and fail for every consumer of the published package. An ESLint rule enforces
this.

Inside `src/`, use relative imports with `.js` extensions.

## 5. Coverage

### What is measured

`src/**/*.ts`, explicitly included. Because `include` is set, a source file that no test imports is
reported at 0% rather than being absent from the report.

### What is excluded, and why

| Path                                   | Reason                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------ |
| `src/**/*.d.ts`                        | Type declarations only; nothing executable                                     |
| `src/**/index.ts`                      | Barrel re-exports only. **If an `index.ts` gains logic, delete its exclusion** |
| `src/cli/index.ts`                     | Process bootstrap. Covered by e2e tests, not unit tests                        |
| `tests/**`                             | Not product behaviour; would inflate the number                                |
| `vitest.config.ts`, `eslint.config.js` | Configuration                                                                  |

Excluding a path requires a stated reason. "It was hard to test" is not one.

### Thresholds: deliberately not set

**No coverage threshold is enforced.** This is a decision, not an omission.

The original justification — that any percentage would describe a single sample module — no longer
holds literally: the library has several modules now. The reason the threshold is still absent is
different and stronger. None of those modules is the product. Verification coverage on a filesystem
wrapper says nothing about whether a test run can be trusted, and a threshold set now would be a
number describing scaffolding.

The plan:

1. Build the first real feature (the Cypress adapter).
2. Record the measured coverage as the baseline, **per directory** rather than as one global number,
   so a well-covered utility cannot mask an unverified adapter.
3. Set thresholds to that baseline.
4. Raise thresholds deliberately. **Never lower them to make CI pass** — a lowered threshold is a
   decision that coverage regressed, and should be stated as one.

**A 100% target is explicitly rejected.** Coverage measures which lines executed, not whether anything
was asserted. A 100% requirement rewards tests that call code and check nothing, raising the number
while lowering confidence. QAT's argument is that results can be trusted, and a vanity metric
undermines precisely that.

### Reading the report

`npm run test:coverage` writes `coverage/lcov-report/index.html`. Look at branch coverage, not the
headline total: an untaken `else` branch is where the unhandled case hides.

Both `coverage/` and `reports/` are git-ignored. Never commit generated reports.

## 6. Test quality rules

1. **Assert behaviour, not implementation.** A test that breaks when a function is renamed without
   changing behaviour is testing the wrong thing.
2. **One behaviour per test.** Multiple asserts are fine when they describe one behaviour; they are not
   fine when a failure message could mean two things.
3. **No test depends on another.** Order must never matter. `clearMocks`, `restoreMocks` and
   `unstubGlobals` are on for this reason.
4. **No network in any test.** The previous version said integration tests needing network "are marked
   and excluded from the default run" — no such marking mechanism exists, so the rule was not
   implementable. The rule is now simply: no network. A future test that genuinely needs it needs a
   mechanism first, and the mechanism needs a record.
5. **No real credentials, hostnames or customer data in fixtures**, including in screenshots and
   captured output. Use synthetic values.
6. **Test the edge case, not the happy path twice.** `formatDuration` covers sub-second, seconds,
   minutes, hours, the exact boundaries, and both invalid inputs. Covering `1000` and `2000` proves
   half as much as covering `999` and `1000`.
7. **A test that cannot fail is not a test.** If you have not seen it fail, you do not know it works.
8. **Never depend on the machine.** No `process.env` as set by the developer, no Cypress installation,
   no local database, no wall-clock time. Where a module takes a dependency as a parameter, the test
   passes one. This is the mechanism; the isolation policy in the strategy document is its
   consequence.

## 7. Verifying failure reporting

The suite must be capable of failing. Confirm it rather than assume it:

```bash
cat > tests/unit/canary.test.ts <<'EOF'
import { expect, it } from 'vitest';

it('is deliberately wrong', () => {
  expect(1).toBe(2);
});
EOF

npm test; echo "exit=$?"     # expect non-zero
rm tests/unit/canary.test.ts
```

If that exits 0, the suite is not actually gating anything.

## 8. CI

CI runs `npm run test:ci`. Requirements for CI compatibility:

- Non-interactive: `vitest run`, never bare `vitest`
- No network access required for any test
- No dependency on `src/` being built, except for e2e
- Deterministic: no reliance on wall-clock time, locale, timezone, or test order

`npm run verify` runs format check, lint, typecheck, the architecture guard and tests, in that order.

## 9. Not yet in place

Deliberately deferred, each with the trigger that will bring it in:

| Item                                         | Trigger                                                         |
| -------------------------------------------- | --------------------------------------------------------------- |
| End-to-end suite                             | First command that spawns the built binary                      |
| Contract suite include in `vitest.config.ts` | First interface with a second implementation                    |
| Coverage thresholds                          | First real feature; see §5                                      |
| Vitest `projects` for per-suite config       | Integration tests needing a different timeout or pool           |
| Type-level tests via `expectTypeOf`          | First published declaration file                                |
| Network-dependent tests                      | A marking mechanism, which does not exist                       |
| Regression test per defect                   | Every defect that reaches `main`; mandatory per CONTRIBUTING §9 |

## 10. Adding a test

1. Decide the kind, using the verification matrix in the strategy document. The matrix already states
   what the module requires.
2. Put the file in the directory for that kind, named after the module.
3. Pass dependencies in rather than reading them from the environment.
4. Cover the negative and boundary cases the matrix requires, not only the success path.
5. Run `npm run verify`.
