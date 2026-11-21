# Testing Standards

|                 |                                              |
| --------------- | -------------------------------------------- |
| **Status**      | Normative                                    |
| **Applies to**  | `tests/`, and any source under test          |
| **Framework**   | Vitest 4, coverage via `@vitest/coverage-v8` |
| **Enforced by** | `npm run verify`, CI                         |

## 1. Directory layout

| Path                 | Contains                                                             |
| -------------------- | -------------------------------------------------------------------- |
| `tests/unit/`        | One module under test, no filesystem or process side effects         |
| `tests/integration/` | Several QAT modules together, including real filesystem access       |
| `tests/e2e/`         | The built CLI binary, spawned as a child process                     |
| `tests/fixtures/`    | Static input: sample Cypress projects, config files, captured output |
| `tests/helpers/`     | Shared test utilities. Not product code, not measured by coverage    |

`tests/unit/` mirrors the `src/` tree. A source file at
`src/shared/utils/duration.ts` is tested at
`tests/unit/shared/utils/duration.test.ts`.

## 2. Naming conventions

- Test files end in `.test.ts`. No exceptions.
- The file name matches the module under test: `duration.ts` → `duration.test.ts`.
- **The directory determines the suite, not the file name.** There is no
  `.int.test.ts` or `.e2e.test.ts` suffix. Two mechanisms that both claim to
  identify a suite drift apart the first time someone adds a test in a hurry.
- `describe` names the exported symbol: `describe('formatDuration', ...)`.
- Each `it` states an observable behaviour in the present tense:
  `it('throws on a negative duration')`, not `it('should throw')`.

## 3. Commands

| Command                    | Purpose                                        |
| -------------------------- | ---------------------------------------------- |
| `npm test`                 | Run unit and integration tests once            |
| `npm run test:unit`        | Unit tests only                                |
| `npm run test:integration` | Integration tests only                         |
| `npm run test:watch`       | Watch mode, local development only             |
| `npm run test:coverage`    | Run once with a coverage report                |
| `npm run test:ci`          | Run once, also writing JUnit XML to `reports/` |

`npm test` never runs end-to-end tests. Those spawn the built binary and are
executed on demand once that configuration exists.

Never use watch mode in CI. `vitest run` is the only CI-safe form; the bare
`vitest` command waits for input and will hang until the job times out.

## 4. Module format

QAT is ESM under `moduleResolution: nodenext`. This has one consequence that
catches everyone at least once:

```ts
import { formatDuration } from "~/shared/utils/duration.js"; // correct
import { formatDuration } from "~/shared/utils/duration"; // tsc error
```

The `.js` extension is mandatory even though the file is `duration.ts`. `tsc`
compiles the specifier as written; it does not add extensions.

### The `~` alias

`~` maps to `src/` and exists **for tests only**. Relative imports from
`tests/unit/shared/utils/` into `src/` would need four levels of `../`, which
break on every file move and fail at runtime rather than compile time.

**Never use `~` inside `src/`.** `tsc` does not rewrite module specifiers, so
`~/...` would be emitted verbatim into `dist/` and fail for every consumer of the
published package. An ESLint rule enforces this.

Inside `src/`, use relative imports with `.js` extensions.

## 5. Coverage

### What is measured

`src/**/*.ts`, explicitly included. Because `include` is set, a source file that
no test imports is reported at 0% rather than being absent from the report.

### What is excluded, and why

| Path                                   | Reason                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------ |
| `src/**/*.d.ts`                        | Type declarations only; nothing executable                                     |
| `src/**/index.ts`                      | Barrel re-exports only. **If an `index.ts` gains logic, delete its exclusion** |
| `src/cli/index.ts`                     | Process bootstrap. Covered by e2e tests, not unit tests                        |
| `tests/**`                             | Not product behaviour; would inflate the number                                |
| `vitest.config.ts`, `eslint.config.js` | Configuration                                                                  |

Excluding a path requires a stated reason. "It was hard to test" is not one.

### Thresholds: deliberately not set yet

**No coverage threshold is enforced at this stage.** This is a decision, not an
omission.

With one production module, any percentage describes the sample rather than the
codebase. A threshold chosen now would be either trivially satisfiable or
arbitrary, and would be rewritten the moment real modules land. Thresholds that
keep moving teach people to treat them as noise, which is worse than having none.

The plan:

1. Build the first real feature (Phase 2, Cypress adapter).
2. Record the measured coverage as the baseline.
3. Set thresholds to that baseline.
4. Raise thresholds deliberately. **Never lower them to make CI pass** — a
   lowered threshold is a decision that coverage regressed, and should be stated
   as one.

**A 100% target is explicitly rejected.** Coverage measures which lines executed,
not whether anything was asserted. A 100% requirement rewards tests that call
code and check nothing, raising the number while lowering confidence. QAT's
argument is that results can be trusted, and a vanity metric undermines precisely
that.

### Reading the report

`npm run test:coverage` writes `coverage/lcov-report/index.html`. Look at branch
coverage, not the headline total: an untaken `else` branch is where the unhandled
case hides.

Both `coverage/` and `reports/` are git-ignored. Never commit generated reports.

## 6. Test quality rules

1. **Assert behaviour, not implementation.** A test that breaks when a function is
   renamed without changing behaviour is testing the wrong thing.
2. **One behaviour per test.** Multiple asserts are fine when they describe one
   behaviour; they are not fine when a failure message could mean two things.
3. **No test depends on another.** Order must never matter. `clearMocks`,
   `restoreMocks` and `unstubGlobals` are on for this reason.
4. **No network in unit tests.** Integration tests that need network are marked
   and excluded from the default run.
5. **No real credentials, hostnames or customer data in fixtures**, including in
   screenshots and captured output. Use synthetic values.
6. **Test the edge case, not the happy path twice.** `formatDuration` covers
   sub-second, seconds, minutes, hours, the exact boundaries, and both invalid
   inputs. Covering `1000` and `2000` proves half as much as covering `999` and
   `1000`.
7. **A test that cannot fail is not a test.** If you have not seen it fail, you do
   not know it works.

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
- No network access required for unit tests
- No dependency on `src/` being built, except for e2e
- Deterministic: no reliance on wall-clock time, locale, timezone, or test order

`npm run verify` runs format check, lint, typecheck and tests in that order.

## 9. Not yet in place

Deliberately deferred, each with the trigger that will bring it in:

| Item                                   | Trigger                                                         |
| -------------------------------------- | --------------------------------------------------------------- |
| End-to-end suite                       | First command that spawns the built binary                      |
| Coverage thresholds                    | First real feature; see §5                                      |
| Vitest `projects` for per-suite config | Integration tests needing a different timeout or pool           |
| Type-level tests via `expectTypeOf`    | First published declaration file                                |
| Regression test per defect             | Every defect that reaches `main`; mandatory per CONTRIBUTING §9 |
