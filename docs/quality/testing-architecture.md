# Testing Architecture

|               |                                                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Status**    | Normative                                                                                                                      |
| **Owner**     | QA / test automation                                                                                                           |
| **Companion** | [`docs/development/testing-standards.md`](../development/testing-standards.md) — mechanics: layout, naming, coverage, commands |

This document decides **what kind of test a module needs and why**. The companion document decides
**how an individual test is written and run**. Where the two touch the same subject, this one sets the
boundary and the companion supplies the detail.

## 1. The five kinds

A test's kind is a property of what it exercises, not of where it sits. The directory mirrors `src/`
so a module is findable; the kind is recorded in the matrix in §2.

### Unit

**Purpose:** one module, its own behaviour, its own contract. Nothing of ours is substituted and
nothing of ours is real except the module itself.

**Boundary:** it may touch the operating system where the module's entire purpose is touching the
operating system — a filesystem helper may create a directory, a process helper may analyse an error
object. What it may not do is depend on another module of ours being correct, or on state it did not
create.

**Must be true:** deterministic, isolated from `process.env`, isolated from the current working
directory, and finished in single-digit milliseconds unless the module genuinely waits.

**Lives in:** `tests/unit/<mirrored path>/`.

### Integration

**Purpose:** several real modules composed, or one real external program driven.

"Several real modules" is the definition — not "real I/O". A service exercised through its public
method, with its ports replaced by in-memory fakes, is an integration test because it crosses a
module boundary; the fact that it touches no disk makes it fast, not unit.

**Boundary:** anything it writes goes into a temporary directory it created and removed. Anything it
spawns is the runtime already running the suite.

**Lives in:** `tests/integration/<area>/`.

### Contract

**Purpose:** the same suite, run against every interchangeable implementation.

A contract test exists because there will be more than one implementation and they must be
indistinguishable to callers. It is written once, parameterised over the implementations, and adding
an implementation means adding a row to that parameter list — not writing a new suite.

**Boundary:** it may only assert what the interface promises. A contract that tests an implementation
detail is a contract that the second implementation will fail for no good reason.

**Lives in:** `tests/contract/<interface>/`.

**Required for:**

| Interface             | Implementations                          |
| --------------------- | ---------------------------------------- |
| `ExecutionRepository` | SQLite, in-memory, JSON — none built yet |
| `ReportGenerator`     | One per format                           |
| `FrameworkAdapter`    | Cypress, and any future adapter          |

### Application service

**Purpose:** a use case end to end — the ordering, the branches, the failure paths — with every port
replaced by a fake this document's mocking rules allow.

**Boundary:** it asserts what the service _does_, never how. A service test that asserts an
implementation was called in a particular order has become a test of the implementation.

**Lives in:** `tests/integration/application/`.

### Infrastructure

**Purpose:** an implementation layer that talks to the operating system: filesystem, child processes,
logging, environment.

**Boundary:** these are unit-sized and unit-shaped, and they sit under `tests/unit/core/*` because
that is where the module is mirrored. A test for `ensureDirectory` that does not create a directory
tests nothing, so the OS access is the subject rather than a dependency.

**Lives in:** `tests/unit/core/<module>/`.

## 2. Verification matrix

Every module that contains code must appear here with the verification it requires. A module with no
row is a module whose verification nobody decided.

| Component               | Directory                        | Required verification                                                                                                                                    | Current state                                                                         |
| ----------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Domain                  | `src/core/domain`                | None at runtime: types and constants only. Compilation is the test.                                                                                      | ✅ Covered by `typecheck`                                                             |
| Application ports       | `src/core/application`           | None directly: an interface has no behaviour. Exercised through the services that implement and consume it.                                              | ⬜ No services yet                                                                    |
| Error model             | `src/core/errors`                | Unit: classification, exit-code mapping, message rendering, cause retention, code uniqueness.                                                            | ✅ `tests/unit/core/errors`                                                           |
| Filesystem              | `src/core/filesystem`            | Unit **and failure**: permission refusal, missing parent, atomic write leaving no temporary file, path containment including a prefix-sharing sibling.   | ✅ `tests/unit/core/filesystem`                                                       |
| Logging                 | `src/core/logging`               | Unit **and redaction**: output shape, level filtering, correlation bindings, a secret absent from serialised output, a failing destination not throwing. | ✅ `tests/unit/core/logging`                                                          |
| Environment utilities   | `src/core/environment`           | Precedence and platform: three-state lookup, all four precedence levels, redaction, portable-path conversion.                                            | ✅ `tests/unit/core/environment`                                                      |
| Process execution       | `src/core/process`               | **Child-process integration** for the runner, unit for classification.                                                                                   | ✅ classification in `tests/unit/core/process`, runner in `tests/integration/process` |
| Project context         | `src/project`                    | Discovery and boundary: valid, missing, ambiguous, bounded ascent, determinism, no shared state.                                                         | ✅ `tests/unit/project`                                                               |
| Shared utilities        | `src/shared`                     | Unit, including every branch and both rejection paths.                                                                                                   | ✅ `tests/unit/shared`                                                                |
| Storage                 | `src/persistence`                | **Repository contract**, against every implementation.                                                                                                   | ⬜ Not built                                                                          |
| Cypress adapter         | `src/execution/adapters/cypress` | **Adapter contract** plus a fixture project.                                                                                                             | ⬜ Not built                                                                          |
| Application composition | `src/cli`                        | Integration: a command end to end, asserting exit code and output stream.                                                                                | ⬜ Not built                                                                          |
| Repository invariants   | —                                | Architectural guard: this document listing every module.                                                                                                 | ✅ `tests/unit/quality`                                                               |

## 3. Naming conventions

- Test files end in `.test.ts`. No exceptions.
- A test file mirrors the module it tests: `src/core/filesystem/paths.ts` →
  `tests/unit/core/filesystem/paths.test.ts`.
- Where a module needs more than one file of tests, the second is named for its concern:
  `paths.containment.test.ts`.
- `describe` names the unit under test, exactly as exported: `describe('resolveWithin', …)`.
- `it` states one observable behaviour in the present tense, third person:
  `it('rejects a relative path rather than resolving it', …)`.
- The first word after `it(` is never `should`. "Should" is a hedge, and a test that hedges is a test
  nobody relies on.

## 4. Fixtures

| Kind              | Location                      | Rules                                                                    |
| ----------------- | ----------------------------- | ------------------------------------------------------------------------ |
| Inline data       | The test file                 | Preferred. A fixture used once belongs beside the assertion that uses it |
| Shared builders   | `tests/helpers/`              | A function that builds a value, not a constant that is mutated           |
| File fixtures     | `tests/fixtures/`             | Never imported by production code. Never executed as a test              |
| External projects | `tests/fixtures/<framework>/` | Self-contained, excluded from lint, format and test discovery            |

Rules:

1. **No production code may read `tests/`.** A fixture is input to a test, not configuration.
2. **No real customer data, hostnames, tokens or screenshots**, including in recorded video.
3. **A fixture that is a whole project is excluded from the suite's own tooling.** Linting a sample
   Cypress project with this project's rules fails on code this project does not own.
4. **Prefer generating data to committing it.** A committed fixture is a file nobody re-reads; a
   generator is code that stays honest.

## 5. Temporary directories and cleanup

Every test that writes creates a directory it owns and removes it, whether or not the test passed.

- Project-shaped trees: `withTempProject` from `tests/helpers/temp-project.ts`, which creates under
  the system temporary directory and removes on both paths.
- Everything else: `mkdtemp` in a `beforeEach` and `rm` with `recursive` and `force` in `afterEach`.
- Cleanup runs on both paths. A helper that only cleans up after success leaves a directory behind
  exactly when someone is debugging and least wants to hunt for it.
- A test that fails and leaves a temporary directory is a test whose cleanup is wrong, not a test
  whose cleanup is inconvenient.

## 6. Isolation policy

A test may depend on:

- The repository contents, at a known commit.
- A temporary directory it created.
- `process.execPath`, the runtime running the suite.
- Nothing else.

A test **may not** depend on:

| Not allowed                                              | Because                                                             |
| -------------------------------------------------------- | ------------------------------------------------------------------- |
| `process.env` as set by the machine                      | Two machines running the same suite reach different conclusions     |
| The current working directory beyond the repository root | `vitest` may be started from anywhere                               |
| A Cypress installation                                   | The tool under test must not require its own subject                |
| A local database file                                    | Same reason, and it makes the suite order-dependent                 |
| Network access                                           | Non-deterministic and unavailable in many CI environments           |
| Wall-clock time                                          | Every assertion becomes an assertion about timing                   |
| Order relative to another test                           | A suite whose result depends on sequence cannot be run in isolation |

Where a module takes a dependency as a parameter — `process.env`, a clock, an id generator — the test
passes one. That is the mechanism; the policy is a consequence of it.

## 7. Mocking and stubbing

**Mock the boundary, never the subject.** If a test replaces the thing it claims to be testing, it
tests the replacement.

**Prefer a fake to a mock.** An in-memory `ExecutionRepository` that behaves correctly is worth more
than a mock that records calls, because it can be used by any test and it fails when the interface
changes.

**Do not assert on call order.** It restates the implementation. Assert on the outcome and on the
values passed when the value is the point.

**Do not mock what you can construct.** A record with four fields does not need a builder with a
mocked method.

**Never mock a module you own with `vi.mock` when a parameter will do.** Module mocking is for
third-party boundaries that cannot be injected; dependency injection is for everything else.

**When a spy is unavoidable**, restore it in the same test that installed it, and assert it was
called — a spy nobody asserts on is a test that would pass if the call were deleted.

## 8. Required negative and boundary scenarios

Every module's tests must include, where the behaviour exists:

| Category     | Example                                                                           |
| ------------ | --------------------------------------------------------------------------------- |
| Absent       | The file, variable or project does not exist                                      |
| Malformed    | Invalid JSON, a relative path where an absolute one is required                   |
| Boundary     | An empty collection, a depth of zero, a limit reached exactly and exceeded by one |
| Failure path | Permission denied, a process that cannot start, a write that fails mid-way        |
| Idempotence  | Running it twice produces the same state                                          |
| Determinism  | Two invocations produce equal results                                             |

A module with only success-path tests is not verified. It is demonstrated.

## 9. Consistency with the Vitest configuration

| Kind                | Discovered | How                                                                                |
| ------------------- | ---------- | ---------------------------------------------------------------------------------- |
| Unit                | ✅         | `tests/unit/**/*.test.ts`                                                          |
| Integration         | ✅         | `tests/integration/**/*.test.ts`                                                   |
| Contract            | ⬜         | Requires `tests/contract/**/*.test.ts` in `include` when the first contract exists |
| Application service | ✅         | Under `tests/integration/`                                                         |
| Infrastructure      | ✅         | Under `tests/unit/core/`                                                           |

Two consequences of the current configuration:

- **`tests/fixtures/` and `tests/e2e/` are excluded** from discovery, so a fixture project is never
  collected as a test.
- **`tests/contract/` is not yet included.** It is deliberately not added before there is a contract
  to run: an include pattern matching nothing is indistinguishable from one that is broken.

## 10. Architectural guards

A document that nothing checks becomes advice. Two invariants are enforced as tests:

| Invariant                                                | Test                                             |
| -------------------------------------------------------- | ------------------------------------------------ |
| Every module containing code appears in the matrix in §2 | `tests/unit/quality/verification-matrix.test.ts` |
| The five test kinds are defined                          | Same file                                        |

The guard reads this document. Adding a module without adding a row fails the suite, which is the
only way the matrix stays true a year from now.

## 11. Adding a module

1. Write the module under `src/`.
2. Add a row to the matrix in §2: the verification it requires, and its current state.
3. Add tests of the required kind in the mirrored location.
4. If it introduces an interface with more than one eventual implementation, add a contract suite.
5. Run `npm run verify`. The guard in §10 will fail until step 2 is done.
