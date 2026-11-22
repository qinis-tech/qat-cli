import { describe, expect, it } from "vitest";

import type {
  ExecutionRecord,
  ExecutionRepository,
} from "~/core/application/ports.js";
import { ErrorCode, StorageError } from "~/core/errors/index.js";
import { InMemoryExecutionRepository } from "~/persistence/index.js";

/**
 * The same suite, run against every implementation.
 *
 * Adding an implementation means adding a row to this list, not writing a second suite. That property
 * is the entire reason the suite exists: a contract that each implementation tests separately is a
 * contract nobody is checking.
 */
const IMPLEMENTATIONS: readonly {
  readonly name: string;
  readonly create: () => ExecutionRepository;
}[] = [{ name: "in-memory", create: () => new InMemoryExecutionRepository() }];

function record(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    executionId: "run-1",
    projectRoot: "/project",
    environment: "staging",
    framework: "cypress",
    frameworkVersion: "13.15.0",
    status: "running",
    startedAt: "2026-01-01T10:00:00.000Z",
    evidenceCount: 0,
    ...overrides,
  };
}

describe.each(IMPLEMENTATIONS)("ExecutionRepository ($name)", ({ create }) => {
  describe("create", () => {
    it("stores a record that can be read back", async () => {
      const repository = create();
      const stored = record();

      await repository.create(stored);

      expect(await repository.findById(stored.executionId)).toStrictEqual(
        stored,
      );
    });

    it("rejects a duplicate identifier rather than merging", async () => {
      const repository = create();
      await repository.create(record());

      const error = await repository
        .create(record())
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(StorageError);
      expect((error as StorageError).code).toBe(ErrorCode.storageFailure);
    });

    it("does not expose internal state to a caller that mutates what it passed", async () => {
      const repository = create();
      const mutable = { ...record() };

      await repository.create(mutable);
      mutable.status = "failed";

      expect((await repository.findById("run-1"))?.status).toBe("running");
    });
  });

  describe("findById", () => {
    it("returns undefined for an unknown identifier rather than failing", async () => {
      // An ordinary question with an ordinary answer. Throwing here would force every caller to
      // treat "not there" as an exception.
      await expect(create().findById("absent")).resolves.toBeUndefined();
    });
  });

  describe("complete", () => {
    it("records the outcome of a running execution", async () => {
      const repository = create();
      await repository.create(record());

      await repository.complete("run-1", {
        status: "failed",
        completedAt: "2026-01-01T10:03:00.000Z",
        durationMs: 180_000,
        totals: { total: 4, passed: 3, failed: 1, pending: 0, skipped: 0 },
      });

      const stored = await repository.findById("run-1");

      expect(stored).toMatchObject({
        status: "failed",
        completedAt: "2026-01-01T10:03:00.000Z",
        durationMs: 180_000,
        totals: { total: 4, failed: 1 },
      });
    });

    it("rejects an unknown identifier, because the store should not lose a row it just wrote", async () => {
      const error = await create()
        .complete("absent", {
          status: "succeeded",
          completedAt: "2026-01-01T10:03:00.000Z",
          durationMs: 1,
          totals: { total: 0, passed: 0, failed: 0, pending: 0, skipped: 0 },
        })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(StorageError);
    });

    it("rejects a second completion rather than overwriting the first", async () => {
      const repository = create();
      await repository.create(record());

      const completion = {
        status: "succeeded" as const,
        completedAt: "2026-01-01T10:03:00.000Z",
        durationMs: 1,
        totals: { total: 0, passed: 0, failed: 0, pending: 0, skipped: 0 },
      };

      await repository.complete("run-1", completion);

      const error = await repository
        .complete("run-1", { ...completion, status: "failed" })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(StorageError);
      expect((await repository.findById("run-1"))?.status).toBe("succeeded");
    });
  });

  describe("list", () => {
    it("returns an empty list for an empty store", async () => {
      await expect(create().list({ limit: 10 })).resolves.toStrictEqual([]);
    });

    it("returns newest first", async () => {
      const repository = create();

      await repository.create(
        record({ executionId: "a", startedAt: "2026-01-01T10:00:00.000Z" }),
      );
      await repository.create(
        record({ executionId: "b", startedAt: "2026-01-02T10:00:00.000Z" }),
      );
      await repository.create(
        record({ executionId: "c", startedAt: "2026-01-03T10:00:00.000Z" }),
      );

      const listed = await repository.list({ limit: 10 });

      expect(listed.map((entry) => entry.executionId)).toStrictEqual([
        "c",
        "b",
        "a",
      ]);
    });

    it("breaks a start-time tie by identifier so the order is total", async () => {
      const repository = create();

      await repository.create(record({ executionId: "a" }));
      await repository.create(record({ executionId: "b" }));

      // Two runs can start in the same millisecond. An order that is not total makes a listing depend
      // on insertion order, which differs between implementations.
      expect(
        (await repository.list({ limit: 10 })).map(
          (entry) => entry.executionId,
        ),
      ).toStrictEqual(["b", "a"]);
    });

    it("filters by project", async () => {
      const repository = create();

      await repository.create(
        record({ executionId: "a", projectRoot: "/one" }),
      );
      await repository.create(
        record({ executionId: "b", projectRoot: "/two" }),
      );

      const listed = await repository.list({ limit: 10, projectRoot: "/one" });

      expect(listed.map((entry) => entry.executionId)).toStrictEqual(["a"]);
    });

    it("filters by environment", async () => {
      const repository = create();

      await repository.create(
        record({ executionId: "a", environment: "staging" }),
      );
      await repository.create(
        record({ executionId: "b", environment: "production" }),
      );

      expect(
        (await repository.list({ limit: 10, environment: "production" })).map(
          (entry) => entry.executionId,
        ),
      ).toStrictEqual(["b"]);
    });

    it("honours the limit, including a limit larger than the store", async () => {
      const repository = create();
      await repository.create(record({ executionId: "a" }));
      await repository.create(record({ executionId: "b" }));

      expect(await repository.list({ limit: 1 })).toHaveLength(1);
      expect(await repository.list({ limit: 0 })).toHaveLength(0);
      expect(await repository.list({ limit: 100 })).toHaveLength(2);
    });

    it("summarises counts from the completion, defaulting to zero while running", async () => {
      const repository = create();
      await repository.create(record({ executionId: "running" }));
      await repository.create(record({ executionId: "done" }));
      await repository.complete("done", {
        status: "failed",
        completedAt: "2026-01-01T10:03:00.000Z",
        durationMs: 1,
        totals: { total: 4, passed: 3, failed: 1, pending: 0, skipped: 0 },
      });

      const listed = await repository.list({ limit: 10 });
      const done = listed.find((entry) => entry.executionId === "done");
      const running = listed.find((entry) => entry.executionId === "running");

      expect(done).toMatchObject({ total: 4, failed: 1, status: "failed" });
      expect(running).toMatchObject({ total: 0, failed: 0, status: "running" });
    });
  });

  describe("isolation", () => {
    it("keeps two repository instances independent", async () => {
      const first = create();
      const second = create();

      await first.create(record({ executionId: "only-in-first" }));

      // A shared store would make one instance's writes visible in the other, which is exactly the
      // problem an in-memory implementation must not have.
      await expect(second.findById("only-in-first")).resolves.toBeUndefined();
    });
  });
});
