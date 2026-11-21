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
  core/filesystem             core/process core/logging
        │
        └── implement a port from core/application/ports.ts, import domain only
```

## Responsibility matrix

| Module                  | Directory                        | Owns                                                       | May import                          | Must not import                                    |
| ----------------------- | -------------------------------- | ---------------------------------------------------------- | ----------------------------------- | -------------------------------------------------- |
| CLI                     | `src/cli`                        | Argument parsing, terminal output, exit codes              | application, domain                 | any implementation, except `cli/index.ts`          |
| Application             | `src/core/application`           | Use cases, sequencing, port interfaces                     | domain                              | implementations, `node:` modules with side effects |
| Domain                  | `src/core/domain`                | Types, statuses, pure predicates                           | nothing                             | everything else                                    |
| Project discovery       | `src/project`                    | Locating and describing a project                          | domain, `core/filesystem`           | execution, persistence, reporting                  |
| Configuration           | `src/config`                     | Loading and validating configuration                       | domain, `core/filesystem`           | execution, persistence, reporting                  |
| Execution orchestration | `src/execution`                  | Selecting a suite, driving an adapter, assembling a result | domain, application, evidence       | reporting, persistence (except through ports)      |
| Cypress adapter         | `src/execution/adapters/cypress` | Every Cypress-specific decision                            | domain, application, `core/process` | any other adapter, reporting, persistence          |
| Result processing       | `src/results`                    | Normalising framework output into `ExecutionResult`        | domain                              | filesystem, process, adapters                      |
| Evidence                | `src/evidence`                   | Discovering and describing artefacts                       | domain, `core/filesystem`           | reporting                                          |
| Reporting               | `src/reporting`                  | Rendering a completed result                               | domain, `core/filesystem`           | execution, adapters, persistence                   |
| Storage                 | `src/persistence`                | Persisting and querying results                            | domain                              | reporting, execution                               |
| Filesystem              | `src/core/filesystem`            | Path and file primitives                                   | `node:` only                        | domain, application                                |
| Templates               | `src/ci/templates`               | Files shipped for users                                    | nothing                             | everything                                         |

`src/diagnostics` is not an approved module. It is reserved for a later phase and no code
may depend on it until it has a documented responsibility.

## Prohibited dependencies

| Prohibited                                | Why                                                                                                                                |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Anything → `src/cli`                      | The CLI is the outermost layer. An import upward means the application cannot be used headlessly, which is what makes it testable. |
| Domain → anything                         | The domain is the vocabulary. If it imports an implementation, every consumer inherits that implementation.                        |
| Application → implementation              | The application declares what it needs. Choosing who provides it belongs to the composition root.                                  |
| Cypress → any other adapter               | A second adapter must be addable without editing the first.                                                                        |
| Reporting/persistence → execution         | Reporting consumes a finished result. Needing to import execution means the result is incomplete.                                  |
| Adapter → adapter internals               | One adapter reaching into another couples their release cadence.                                                                   |
| Anything → another module's internal path | Import from `index.ts` or the documented public file, never `../../foo/internal/thing.js`.                                         |

## The composition root

`src/cli/index.ts` is the only file permitted to import implementations. It constructs them,
passes them into the application, and hands control over. It contains no business logic and
is excluded from coverage for that reason.

Everything else receives its collaborators as arguments. That single rule is what makes
every other module testable without a real filesystem, a real Cypress install, or a real
clock.

## Enforcement

Documented rules that nothing checks are suggestions. These are lint errors:

| Rule                           | Enforced                                                      |
| ------------------------------ | ------------------------------------------------------------- |
| Domain imports nothing         | `no-restricted-imports` on `src/core/domain/**`               |
| CLI imports no implementation  | `no-restricted-imports` on `src/cli/**`, excluding `index.ts` |
| Nothing imports the CLI        | `no-restricted-imports` on every other module                 |
| `~` alias never used in `src/` | `no-restricted-imports` (pre-existing)                        |

Not machine-enforced, and therefore reviewed by a human: cross-adapter imports, and
reporting reaching into `src/execution` internals. If either becomes a real problem, adopt
`eslint-plugin-boundaries` rather than extending the pattern lists.

## Scalability of this shape

Adding a framework adapter means implementing `ports.FrameworkAdapter` and registering it in
the composition root. Adding a report format means implementing `ports.ReportGenerator`. No
existing module changes. That property — adding a capability without editing what exists —
is the entire justification for the extra indirection.
