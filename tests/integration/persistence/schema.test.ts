import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CONNECTION_PRAGMAS,
  SCHEMA_STATEMENTS,
  SCHEMA_VERSION,
} from "~/persistence/index.js";

/**
 * Runs the schema against a real engine.
 *
 * A DDL proposal that has never been executed is a guess, and the constraints — the parts that carry
 * the integrity argument — are the parts most likely to be written with a syntax the engine rejects.
 */
let database: Database.Database;

beforeEach(() => {
  database = new Database(":memory:");

  for (const pragma of CONNECTION_PRAGMAS) {
    // WAL is not supported for in-memory databases and raises no error, so the result is ignored.
    database.pragma(pragma.replace("PRAGMA ", ""));
  }

  for (const statement of SCHEMA_STATEMENTS) {
    database.exec(statement);
  }
});

afterEach(() => {
  database.close();
});

const VALID_ROW = {
  execution_id: "run-1",
  project_root: "/project",
  environment: "staging",
  framework: "cypress",
  framework_version: "13.15.0",
  status: "running",
  started_at: "2026-01-01T10:00:00.000Z",
  evidence_count: 0,
};

function insert(overrides: Record<string, unknown> = {}): void {
  const row = { ...VALID_ROW, ...overrides };
  const columns = Object.keys(row).join(", ");
  const placeholders = Object.keys(row)
    .map((column) => `@${column}`)
    .join(", ");

  database
    .prepare(`INSERT INTO executions (${columns}) VALUES (${placeholders})`)
    .run(row);
}

describe("the initial schema", () => {
  it("creates the tables and indexes it promises", () => {
    const names = database
      .prepare(
        `SELECT name FROM sqlite_master WHERE type IN ('table', 'index')`,
      )
      .all()
      .map((entry) => (entry as { name: string }).name);

    expect(names).toContain("executions");
    expect(names).toContain("schema_meta");
    expect(names).toContain("executions_by_project");
    expect(names).toContain("executions_by_time");
  });

  it("is idempotent, so applying it to an existing database is a no-op", () => {
    expect(() => {
      for (const statement of SCHEMA_STATEMENTS) database.exec(statement);
    }).not.toThrow();
  });

  it("accepts a running row with no completion time", () => {
    expect(() => {
      insert();
    }).not.toThrow();
  });

  it("rejects a duplicate identifier", () => {
    insert();

    expect(() => {
      insert();
    }).toThrow(/UNIQUE/);
  });

  it("rejects an unknown status", () => {
    expect(() => {
      insert({ status: "probably-fine" });
    }).toThrow(/CHECK/);
  });

  it("rejects a negative count", () => {
    expect(() => {
      insert({ failed: -1 });
    }).toThrow(/CHECK/);
  });

  it("rejects a completion before the start", () => {
    expect(() => {
      insert({ status: "failed", completed_at: "2025-12-31T00:00:00.000Z" });
    }).toThrow(/CHECK/);
  });

  it("rejects a finished row with no completion time", () => {
    // The pairing constraint is what stops a row claiming to be finished without saying when.
    expect(() => {
      insert({ status: "succeeded" });
    }).toThrow(/CHECK/);
  });

  it("rejects a running row that claims to have finished", () => {
    expect(() => {
      insert({ completed_at: "2026-01-01T10:05:00.000Z" });
    }).toThrow(/CHECK/);
  });
});

describe("schema version", () => {
  it("is a positive integer that the DDL records", () => {
    expect(SCHEMA_VERSION).toBeGreaterThan(0);

    database
      .prepare("INSERT INTO schema_meta (key, value) VALUES (?, ?)")
      .run("schema_version", String(SCHEMA_VERSION));

    const stored = database
      .prepare("SELECT value FROM schema_meta WHERE key = ?")
      .get("schema_version") as { value: string };

    expect(stored.value).toBe(String(SCHEMA_VERSION));
  });
});
