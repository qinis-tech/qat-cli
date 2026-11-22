# Storage Design

What QAT remembers about a run after the process that ran it has exited, and what it deliberately
forgets.

## 1. Scope

This document establishes the persistence architecture and the contracts. It does not implement
historical run management: listing, comparison and pruning are later work, and the contracts here are
shaped so that adding them does not require changing what a caller already depends on.

## 2. What lives where

Four kinds of thing, deliberately separated.

| Kind            | Lives in   | Size                 | Written by                                    |
| --------------- | ---------- | -------------------- | --------------------------------------------- |
| Run metadata    | SQLite     | One row per run      | The execution service                         |
| Result document | Filesystem | Kilobyte to megabyte | The execution service, atomically             |
| Evidence        | Filesystem | Kilobyte to gigabyte | The framework, collected into a directory     |
| Report          | Filesystem | Kilobyte to megabyte | The reporting layer, from the result document |

The boundary rule: **SQLite holds what you would want to query; the filesystem holds what you would
want to read.**

Nothing large goes into the database. A screenshot in a BLOB makes every backup of the history
directory enormous, makes a `SELECT` on metadata compete with megabytes of image data for the page
cache, and gains nothing over a path — the file has to be on disk anyway for a browser or a person to
open it.

The database stores the _path_ to the result document and a _count_ of evidence files. It does not
store the paths of individual evidence files: those are in the result document, they are only ever
needed alongside that document, and duplicating them creates a second list that can disagree with the
first.

## 3. Responsibilities

| Responsibility             | Where                                | Notes                                       |
| -------------------------- | ------------------------------------ | ------------------------------------------- |
| Run identification         | `execution_id`, primary key          | Opaque; generated once by the caller        |
| Completion status          | `status` column                      | Constrained to the known set plus `running` |
| Start and completion times | `started_at`, `completed_at`         | ISO 8601 UTC; ordered by string comparison  |
| Project association        | `project_root`                       | Absolute; the grouping key for history      |
| Environment                | `environment`                        | The configured environment the run used     |
| Framework and version      | `framework`, `framework_version`     | Recorded so an old run can be interpreted   |
| Result summary             | Five integer columns                 | Counts only; the detail is in the document  |
| Result document location   | `result_path`                        | Relative to the project root                |
| Evidence                   | `evidence_count`, plus files on disk | Never the bytes                             |

## 4. Contracts

`ExecutionRepository`, declared in the application layer alongside the ports it serves. The interface
names no database and no SQL; an implementation may be SQLite, memory, or a file.

| Operation  | Contract                                                                  |
| ---------- | ------------------------------------------------------------------------- |
| `create`   | Records a run that has started. Rejects a duplicate identifier            |
| `complete` | Records how it ended. Rejects an unknown or already-completed run         |
| `findById` | Returns the record, or `undefined`. A missing record is not a failure     |
| `list`     | Newest first, ordered by start time then identifier so the order is total |

**A record is append-then-complete.** Nothing else about it is mutable, and there is no general
update. That removes a category of question — which version of this row is the real one — before
anybody has to ask it.

**Every method is atomic.** No caller sees a partially applied write.

## 5. Database location

```
<project root>/.qat/qat.db
```

Per project, not per machine. A single database in the user's home directory would mix unrelated
projects and would need a project identity that survives renaming, moving and cloning — a problem
that does not need solving to store run history.

Consequences, stated plainly: running the same project from a copy of its directory produces separate
histories, and running from a different working directory against the same project root finds the same
history only if the root is resolved identically. Both are the right trade for a tool that is used per
repository.

`.qat/` is already git-ignored and already the home of local execution artefacts.

## 6. Initialisation and schema ownership

The schema is owned by the code, not by the database. It is defined as executable DDL in
`src/persistence/schema.ts`, applied on first connection, and versioned by `SCHEMA_VERSION`.

- The directory is created before the database is opened.
- The DDL is idempotent, so applying it to an existing database is a no-op.
- `schema_meta` records the version the file was created with.

A database whose recorded version is **newer** than the running code is refused with an actionable
error rather than opened optimistically. Silently ignoring columns the code does not know about is how
a downgrade corrupts history.

## 7. Migrations

Forward only, one statement set per version, applied in order inside a transaction.

There are no down-migrations. A history database is a record of runs that happened; the idea that the
record can be reconstructed by reversing a schema change is optimistic, and the value of a rollback
path is not worth the cost of maintaining and testing one.

A migration that cannot complete leaves the database at its previous version, because the transaction
rolls back. It never leaves it half-migrated.

## 8. Connection lifecycle

| Aspect       | Decision                                                                     |
| ------------ | ---------------------------------------------------------------------------- |
| When opened  | Lazily, by the composition root, on the first command that needs history     |
| How many     | One connection per process                                                   |
| Concurrency  | WAL mode, so a reader and a writer proceed together                          |
| Busy timeout | 5 seconds, so a concurrent run waits briefly rather than failing immediately |
| When closed  | On process exit, and explicitly in tests                                     |

A run that is executing and a `qat history` in another terminal must not block each other. WAL is why.

## 9. Transactions

A single repository method is one atomic unit. For a single-row insert or update that is the default
behaviour of the engine and needs no explicit transaction; for a future multi-statement operation —
recording a batch of evidence, say — the implementation opens one explicitly and the contract still
promises atomicity.

Reads are not wrapped. A listing that observes two rows from the same run is observing two writes,
not one, and a consistent snapshot across unrelated runs is not a property anyone needs.

## 10. Integrity

Enforced by the database rather than by the code that writes to it, because the code is not the only
thing that will ever write:

- `status` is constrained to the known values plus `running`.
- Counts cannot be negative.
- `completed_at` cannot precede `started_at`.
- A finished row must have a completion time; a running row must not.
- The identifier is the primary key, so a duplicate is rejected rather than merged.

`PRAGMA foreign_keys = ON` is set even though the initial schema has no foreign key. It is set now so
that the first table to gain one behaves correctly without anyone having to remember.

## 11. Failure behaviour

| Situation                             | Behaviour                                                         |
| ------------------------------------- | ----------------------------------------------------------------- |
| Directory missing                     | Created before opening                                            |
| Database file locked past the timeout | `StorageError`, retryable, with the waiting time in the context   |
| Corrupt file                          | `StorageError`, fatal, naming the file and suggesting its removal |
| Disk full                             | `StorageError`, from the failed write                             |
| Schema version newer than the code    | Refused with an actionable error                                  |
| Any other engine failure              | `StorageError` with the underlying failure as the cause           |

**A storage failure never fails a test run.** History is auxiliary: if the run completed and the
result document was written, the run succeeded, and reporting an infrastructure failure as the
command's outcome would tell CI that a green build was red. The failure is logged at error level and
reported as a warning to the user, and the command exits with the run's own status.

That is a deliberate degradation and it has a cost: a user whose database is permanently broken keeps
getting correct exit codes and no history, and may not notice for weeks. The mitigation is the
warning, which must name the file and say what is not being recorded.

## 12. Verification

| What                                         | How                                                                                                                   |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| The contracts are implementable              | `tests/contract/execution-repository.contract.test.ts`, parameterised over implementations                            |
| The schema is valid SQL                      | `tests/integration/persistence/schema.test.ts`, applied to an in-memory database                                      |
| Application services do not depend on SQLite | The interface lives in `src/core/application`; `src/persistence` is the only module that may import a database driver |

The contract suite is the important one. It currently runs against one implementation, and exists so
that adding the SQLite one means adding a row to a list rather than writing a second suite.

## 13. Deferred

| Item                             | Trigger                                           |
| -------------------------------- | ------------------------------------------------- |
| SQLite repository implementation | The execution service existing to use it          |
| Migrations beyond version 1      | The first schema change                           |
| Pruning and retention            | History growing enough to notice                  |
| Per-spec timing aggregation      | A question that needs it                          |
| A global, cross-project database | A user working across repositories asking for one |
