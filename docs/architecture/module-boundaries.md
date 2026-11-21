# Module Boundaries

Five layers. Dependencies point one way, downward. No module imports upward.

```
        ┌─────────────────────────────────────────┐
        │  cli                                    │  user interaction, exit codes
        │  (src/cli)                              │  index.ts = composition root
        └───────────────────┬─────────────────────┘
                            │ may import
        ┌───────────────────▼─────────────────────┐
        │  application                            │  use cases, orchestration
        │  (src/core/application)                 │  ports only, never implementations
        └───────────────────┬─────────────────────┘
                            │ may import
        ┌───────────────────▼─────────────────────┐
        │  domain                                 │  types and pure logic
        │  (src/core/domain)                      │  imports nothing
        └─────────────────────────────────────────┘

        Implementations sit beside the application layer, not above it:

  execution/adapters/cypress  persistence  reporting  evidence  project  config
  core/filesystem  core/process  core/logging  core/errors
        │
        └── implement a port from core/application/ports.ts, import domain and leaves
```

## Responsibility matrix

| Module                  | Directory                        | Owns                                                                 | May import                                                              | Must not import                                    |
| ----------------------- | -------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------- |
| CLI                     | `src/cli`                        | Argument parsing, terminal output, exit codes                        | application, domain, `core/logging` (in `index.ts` only)                | any other implementation, except `cli/index.ts`    |
| Application             | `src/core/application`           | Use cases, sequencing, port interfaces                               | domain, `core/errors`                                                   | implementations, `node:` modules with side effects |
| Domain                  | `src/core/domain`                | Types, statuses, pure predicates                                     | nothing                                                                 | everything, including `core/errors`                |
| Project discovery       | `src/project`                    | Locating and describing a project                                    | domain, `core/filesystem`, `core/errors`                                | execution, persistence, reporting                  |
| Configuration           | `src/config`                     | Loading and validating configuration                                 | domain, `core/filesystem`, `core/errors`                                | execution, persistence, reporting                  |
| Execution orchestration | `src/execution`                  | Selecting a suite, driving an adapter, assembling a result           | domain, application, evidence, `core/errors`                            | reporting, persistence (except through ports)      |
| Cypress adapter         | `src/execution/adapters/cypress` | Every Cypress-specific decision                                      | domain, application, `core/process`, `core/filesystem`, `core/errors`   | any other adapter, reporting, persistence          |
| Result processing       | `src/results`                    | Normalising framework output into `ExecutionResult`                  | domain, `core/errors`                                                   | filesystem, process, adapters                      |
| Evidence                | `src/evidence`                   | Discovering and describing artefacts                                 | domain, `core/filesystem`, `core/errors`                                | reporting                                          |
| Reporting               | `src/reporting`                  | Rendering a completed result                                         | domain, `core/filesystem`, `core/errors`                                | execution, adapters, persistence                   |
| Storage                 | `src/persistence`                | Persisting and querying results                                      | domain, `core/filesystem`, `core/errors`                                | reporting, execution                               |
| Filesystem              | `src/core/filesystem`            | Path primitives, containment, atomic writes, JSON and text utilities | `node:`, `core/errors`                                                  | domain, application                                |
| Process                 | `src/core/process`               | Child process execution, exit codes                                  | `node:`, `core/errors`                                                  | domain, application                                |
| Logging                 | `src/core/logging`               | Structured logging, levels, redaction                                | application (the port it implements), `node:`, a logging implementation | domain, other implementations                      |
| Errors                  | `src/core/errors`                | Error codes, classes, categories, exit-code mapping                  | nothing                                                                 | everything                                         |
| Templates               | `src/ci/templates`               | Files shipped for users                                              | nothing                                                                 | everything                                         |

`src/diagnostics` is not an approved module. It is reserved for a later phase and no code may
depend on it until it has a documented responsibility.

## Shared leaves

Two modules import nothing from `src/`, and that property is what makes them safe to import
from anywhere:

- **`src/core/errors`** — codes, classes and the exit-code mapping. Imports nothing, not even
  `node:`. Any layer may import it, because importing a leaf cannot create a cycle and cannot
  drag an implementation into a layer that must not have one.
- **`src/shared`** — path and formatting helpers. Imports nothing from `src/`.

**The domain is the exception, and it is deliberate.** The domain does not import
`core/errors`, even though doing so would be harmless from a cycle perspective. The domain is
the product's vocabulary; a result type carrying an `ErrorCode` would make the vocabulary
depend on the error model, and every consumer of a result would then depend on the error
taxonomy whether it wanted to or not. That is why `ExecutionErrorInfo.code` in
`core/domain/execution.ts` is a plain `string`: the mapping from an error to a code happens
where the error is raised, not where the result is defined.

`src/core/logging` is **not** a leaf. It implements the `Logger` port, so it depends on
`core/application`, which means it must be constructed in the composition root and passed to
everything else as the port. A service that imports `core/logging` directly has coupled itself
to the implementation and cannot be tested without a real logger.

## Prohibited dependencies

| Prohibited                                       | Why                                                                                                                                                                                             |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anything → `src/cli`                             | The CLI is the outermost layer. An import upward means the application cannot be used headlessly, which is what makes it testable.                                                              |
| Domain → anything                                | The domain is the vocabulary. If it imports an implementation, every consumer inherits that implementation. Includes `core/errors`, for the reason above.                                       |
| Application → implementation                     | The application declares what it needs. Choosing who provides it belongs to the composition root.                                                                                               |
| Application → `node:` modules                    | The application should not touch a filesystem, a clock or a process directly; each of those is a port. The one exception is pure path arithmetic, and even that is better as a value passed in. |
| Cypress → any other adapter                      | A second adapter must be addable without editing the first.                                                                                                                                     |
| Reporting or persistence → execution             | Reporting consumes a finished result. Needing to import execution means the result is incomplete.                                                                                               |
| Adapter → adapter internals                      | One adapter reaching into another couples their release cadence.                                                                                                                                |
| Anything → `core/logging`, except `cli/index.ts` | Logging is an implementation of a port. Importing it directly makes the consumer untestable without a real logger; take the `Logger` port instead.                                              |
| Anything → another module's internal path        | Import from `index.ts` or the documented public file, never `../../foo/internal/thing.js`.                                                                                                      |

## The composition root

`src/cli/index.ts` is the only file permitted to import implementations. It constructs them,
passes them into the application, and hands control over. It contains no business logic and is
excluded from coverage for that reason.

It is also the only file that constructs a logger, resolves the effective log level, chooses a
destination, and translates a caught value into an exit code.

Everything else receives its collaborators as arguments. That single rule is what makes every
other module testable without a real filesystem, a real Cypress install, or a real clock.

## Enforcement

Documented rules that nothing checks are suggestions. These are lint errors:

| Rule                           | Enforced by                                                         |
| ------------------------------ | ------------------------------------------------------------------- |
| Domain imports nothing         | `no-restricted-imports` on `src/core/domain/**`                     |
| CLI imports no implementation  | `no-restricted-imports` on `src/cli/**`, excluding `index.ts`       |
| Nothing imports the CLI        | `no-restricted-imports` on every other source tree                  |
| `~` alias never used in `src/` | `no-restricted-imports`, applied in every block through one factory |

Reviewed by a human, not machine-enforced:

- Cross-adapter imports.
- Reporting reaching into `src/execution` internals.
- Application importing a `node:` module, which the lint rules cannot distinguish from a
  legitimate type-only import.
- Anything importing `core/logging` outside the composition root.

If the first two become real problems rather than theoretical ones, adopt
`eslint-plugin-boundaries` instead of extending the pattern lists. A pattern list that grows to
cover a graph is a graph described badly.

## Scalability of this shape

Adding a framework adapter means implementing `ports.FrameworkAdapter` and registering it in the
composition root. Adding a report format means implementing `ports.ReportGenerator`. Adding a
storage backend means implementing `ports.ExecutionRepository`. No existing module changes.

That property — adding a capability without editing what exists — is the entire justification for
the extra indirection. If a change of that kind requires editing three modules, the boundary is in
the wrong place, and that is worth raising in review rather than working around.
