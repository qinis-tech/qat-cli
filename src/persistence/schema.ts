/**
 * The storage schema, as executable DDL.
 *
 * Timestamps are ISO 8601 UTC strings. That is not a storage convenience: ISO 8601 has the property
 * that lexicographic order equals chronological order for values in the same timezone and precision,
 * so `ORDER BY started_at DESC` is correct without parsing, and works in an index.
 */

/** Version of the schema these statements produce. Bumped by every migration, never by a fix. */
export const SCHEMA_VERSION = 1;

/**
 * Pragmas applied to every connection before anything else.
 *
 * `journal_mode = WAL` lets a reader and a writer proceed together, which matters when a long run is
 * writing while `qat history` reads. It is persistent — set once per database file — and harmless to
 * repeat.
 */
export const CONNECTION_PRAGMAS: readonly string[] = [
  "PRAGMA journal_mode = WAL",
  "PRAGMA foreign_keys = ON",
  "PRAGMA busy_timeout = 5000",
  "PRAGMA synchronous = NORMAL",
];

/**
 * Statements creating the schema, in order. All idempotent, so applying them to an existing database
 * is a no-op rather than an error.
 *
 * The constraints are the point. A status outside the known set, a negative count, or a completion
 * timestamp before the start are all rejected by the database rather than discovered later by
 * whatever reads the row.
 */
export const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS schema_meta (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS executions (
     execution_id      TEXT PRIMARY KEY,
     project_root      TEXT NOT NULL,
     environment       TEXT NOT NULL,
     framework         TEXT NOT NULL,
     framework_version TEXT NOT NULL,
     status            TEXT NOT NULL
                       CHECK (status IN ('running', 'succeeded', 'failed', 'errored', 'cancelled')),
     started_at        TEXT NOT NULL,
     completed_at      TEXT,
     duration_ms       INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
     total             INTEGER NOT NULL DEFAULT 0 CHECK (total >= 0),
     passed            INTEGER NOT NULL DEFAULT 0 CHECK (passed >= 0),
     failed            INTEGER NOT NULL DEFAULT 0 CHECK (failed >= 0),
     pending           INTEGER NOT NULL DEFAULT 0 CHECK (pending >= 0),
     skipped           INTEGER NOT NULL DEFAULT 0 CHECK (skipped >= 0),
     result_path       TEXT,
     evidence_count    INTEGER NOT NULL DEFAULT 0 CHECK (evidence_count >= 0),

     -- A run cannot finish before it started. ISO 8601 strings compare correctly here for the
     -- same reason they sort correctly.
     CHECK (completed_at IS NULL OR completed_at >= started_at),
     -- A finished run must say when it finished, and a running one must not claim to have.
     CHECK (
       (status = 'running' AND completed_at IS NULL) OR
       (status <> 'running' AND completed_at IS NOT NULL)
     )
   )`,

  `CREATE INDEX IF NOT EXISTS executions_by_project
     ON executions (project_root, started_at DESC, execution_id DESC)`,

  `CREATE INDEX IF NOT EXISTS executions_by_time
     ON executions (started_at DESC, execution_id DESC)`,
];
