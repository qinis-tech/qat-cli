# ADR-0010: Store execution metadata in a local SQLite database

Date: 2026-11-21

## Status

Accepted

## Context

Every run produces a result document, written to the filesystem as JSON. The question this record
answers is whether anything else needs to be remembered beyond that document.

The document answers "what happened in this run" completely. It does not answer questions that span
runs, and those are the questions history exists for: which runs happened for this project, when did
they happen, how did they end, how many tests failed, and which of the last twenty were worst.

Answering those from files means opening every file and parsing it. The cost grows with the number of
runs rather than with the number of rows wanted, and a single malformed document breaks a listing
that has nothing to do with it. A project running a suite twenty times a day accumulates thousands of
files over a year, which is not large but is not nothing either.

Volumes are small in absolute terms. The argument for a database here is not scale; it is that the
main query — the most recent runs for this project, in order — is exactly what an index makes cheap
and a directory scan makes linear.

Constraints that shaped the answer:

- **Local first.** No server, no account, no network. A developer installs a CLI and it works.
- **No setup step.** The tool must be usable immediately after installation, so any storage has to be
  created on demand rather than configured.
- **Behind a contract.** Storage sits behind an application-facing interface, so nothing above it
  knows the technology. That lowers the stakes of this decision considerably: replacing it means
  adding an implementation, not rewriting callers. It also means the record does not need to be
  exhaustive about internals.
- **Artefacts stay on the filesystem.** Reports and evidence are files, deliberately, and this record
  does not change that.
- **The project has few dependencies and values that.** Every addition is a liability, and a native
  one doubly so.

No run has been recorded yet, so there is no measured pain. The decision is made before the first
row exists, which is the only moment it is free.

## Decision

We will store execution metadata in a SQLite database file at `<project root>/.qat/qat.db`, accessed
through `better-sqlite3`.

The database holds one row per run: its identifier, project, environment, framework, status, start
and completion times, the counts from the result summary, the path to the result document, and a
count of evidence files. It does not hold the document, the evidence, or reports.

The schema is owned by the code and applied on first connection. Migrations are forward-only. The
database is opened lazily by the composition root, one connection per process, in WAL mode so a write
from a running suite does not block a `qat history` in another terminal.

## Consequences

**Easier**

- The main history query becomes an indexed lookup rather than a directory scan, and the cost stops
  depending on how many runs have accumulated.
- A malformed result document cannot break a listing, because listing never parses one.
- Concurrent access is a solved problem rather than a hoped-for one: WAL lets a reader and a writer
  proceed together, which is exactly the situation of querying history while a suite runs.
- Integrity constraints live in the schema, so a bad row is rejected by the database rather than
  discovered later by whatever reads it.
- The file is created on first use, so there is no setup step and no migration a user has to run.
- Because the technology sits behind an interface, replacing it later is a new implementation and a
  contract suite that already exists — not a rewrite.

**Harder**

- **A native dependency, in a CLI whose appeal includes installing cleanly.** `better-sqlite3` needs a
  prebuilt binary or a compiler toolchain on every platform and architecture, and the absence of one
  is the most likely install failure a user will hit. It is also invisible to anyone developing on
  Linux x64, which is the environment where it is most likely to work.
- **One database per project.** Copying a project directory does not carry its history, and running
  the same project from two checkouts produces two histories that never reconcile. A user who
  reorganises their working tree loses a record they did not know was stored per directory.
- **Schema migrations are a permanent obligation from the first release.** A JSON format can be read
  leniently or translated on the fly; a schema change needs a forward migration that is written,
  tested and supported for every version that ever shipped.
- A file that can be locked, corrupted or grow without bound. A JSON file has two of those problems
  as well, but SQLite makes "locked" a first-class state with its own error and its own retry
  behaviour.
- Debugging requires a SQLite client. A JSON file can be inspected with `cat`, which matters more
  than it sounds when someone reports a problem from a machine you cannot reach.
- `drizzle-orm` is already installed and is now either adopted or removed. Leaving both a driver and
  an unused ORM in the tree is worse than committing to either.
- Install size and time grow, and for a tool that is expected to be installed once and used often
  that is a smaller cost than the first point but the same kind.

**Neutral**

- The database is disposable. It lives under `.qat/`, is git-ignored, and deleting it loses history
  while breaking nothing at all.
- The volumes involved are small enough that the performance argument is about avoiding a linear scan
  rather than about handling scale.
- Being local, it has no authentication, no concurrency across machines and no multi-user story — and
  no requirement for one.
- Whether history should instead be global and cross-project is a separate question, with its own
  record if a user asks for it.
- Whether to put an ORM in front of the driver is a smaller, separate decision. One table does not
  justify the indirection, and the schema will be read by people regardless.

## Options considered

| Option                                                       | Why not                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One JSON document per run, plus an index file                | What exists for results already. Listing means reading the index or every document; the index is a second source of truth that can disagree with the directory; and two concurrent runs updating it is unsafe unless it is locked, at which point the lock is doing the work a database would do properly |
| A single JSON file holding all history                       | Dependency-free and simple, and it must be read and rewritten in full on every write. One interrupted write loses everything, and concurrent runs corrupt it                                                                                                                                              |
| SQLite through `better-sqlite3`                              | Chosen. One file, real queries, atomic writes, no server                                                                                                                                                                                                                                                  |
| SQLite through the runtime's own `node:sqlite` module        | The most interesting alternative and not adopted yet. It would remove the native dependency entirely, which is the largest cost above, but the module is newer and its API surface and maturity are not something this project has verified. Worth re-examining before the implementation is written      |
| A hosted database (Postgres, Turso, a hosted SQLite service) | Solves a problem this tool does not have. It adds an account, credentials, a network dependency and an outage mode to something that must work on a train                                                                                                                                                 |
| An embedded key-value store                                  | Adequate for lookup and poor for "the ten most recent runs for this project, in order", which is the query that matters                                                                                                                                                                                   |

## References

- `docs/architecture/storage-design.md` — the schema, the lifecycle and the data boundaries
- `src/persistence/schema.ts` — the schema as executable DDL
- `src/core/application/ports.ts` — `ExecutionRepository`, the contract this technology sits behind
- SQLite documentation on write-ahead logging and on `PRAGMA busy_timeout`
- `better-sqlite3` documentation, for its prebuilt-binary distribution
