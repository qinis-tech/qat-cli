/**
 * An in-memory implementation of the execution repository.
 *
 * Two jobs, both real: it is the reference implementation the contract suite runs against, and it is
 * what every integration test will inject instead of a database. A test that needs a repository
 * should not need SQLite installed, and an assertion about orchestration should not pay for a disk.
 *
 * The methods are not `async`. They complete synchronously, and marking them `async` would be a claim
 * that something is awaited when nothing is — which the linter rejects, correctly. Returning a promise
 * from a synchronous body honours the interface without the false statement.
 */
import type {
  ExecutionCompletion,
  ExecutionQuery,
  ExecutionRecord,
  ExecutionRepository,
  ExecutionSummary,
} from "../../core/application/ports.js";
import type { ExecutionId } from "../../core/domain/index.js";
import { ErrorCode } from "../../core/errors/codes.js";
import { StorageError } from "../../core/errors/errors.js";

export class InMemoryExecutionRepository implements ExecutionRepository {
  /**
   * The store.
   *
   * A `Map` rather than an array: `findById` is the most frequent operation and an array would make
   * it a linear scan. Insertion order is deliberately not relied on for listings — `list` sorts
   * explicitly, because an order that comes from insertion would differ between implementations.
   */
  readonly #records = new Map<ExecutionId, ExecutionRecord>();

  create(record: ExecutionRecord): Promise<void> {
    if (this.#records.has(record.executionId)) {
      return Promise.reject(
        new StorageError(
          ErrorCode.storageFailure,
          `An execution with id ${record.executionId} already exists.`,
          {
            context: { executionId: record.executionId },
            remediation:
              "This is a defect: execution identifiers must be unique.",
          },
        ),
      );
    }

    // Mirrors the pairing constraint in the schema. Without it this implementation accepts a record
    // the SQLite one rejects, and the contract suite stops proving that the two are interchangeable.
    const consistent =
      (record.status === "running" && record.completedAt === undefined) ||
      (record.status !== "running" && record.completedAt !== undefined);

    if (!consistent) {
      return Promise.reject(
        new StorageError(
          ErrorCode.storageFailure,
          `Execution ${record.executionId} has an inconsistent status and completion time.`,
          {
            context: { executionId: record.executionId, status: record.status },
            remediation:
              "A running record must not carry a completion time, and a finished one must.",
          },
        ),
      );
    }

    // Copied, so a caller that keeps a reference cannot mutate stored state afterwards. The cost is
    // one shallow copy per write, which is nothing next to the bug it prevents.
    this.#records.set(record.executionId, { ...record });

    return Promise.resolve();
  }

  complete(
    executionId: ExecutionId,
    completion: ExecutionCompletion,
  ): Promise<void> {
    const existing = this.#records.get(executionId);

    if (existing === undefined) {
      // A completion for a record that is not there means the store lost something a caller had just
      // written. That is a defect, not a missing record, and it must not pass silently.
      return Promise.reject(this.#notFound(executionId));
    }

    if (existing.status !== "running") {
      return Promise.reject(
        new StorageError(
          ErrorCode.storageFailure,
          `Execution ${executionId} has already been completed.`,
          {
            context: { executionId, status: existing.status },
            remediation: "This is a defect: a run is completed once.",
          },
        ),
      );
    }

    // The spread keeps every field the completion does not mention, so a partial update is not
    // possible by accident and a full one is not required either.
    this.#records.set(executionId, { ...existing, ...completion });

    return Promise.resolve();
  }

  findById(executionId: ExecutionId): Promise<ExecutionRecord | undefined> {
    const record = this.#records.get(executionId);

    // A copy, for the same reason `create` takes one: a caller holding the stored object could
    // otherwise change the store without any method being called.
    return Promise.resolve(record === undefined ? undefined : { ...record });
  }

  list(query: ExecutionQuery): Promise<readonly ExecutionSummary[]> {
    const summaries = [...this.#records.values()]
      .filter(
        (record) =>
          query.projectRoot === undefined ||
          record.projectRoot === query.projectRoot,
      )
      .filter(
        (record) =>
          query.environment === undefined ||
          record.environment === query.environment,
      )
      // Newest first, then by identifier: two runs can share a start time, and a partial order would
      // make a listing depend on insertion order, which differs between implementations.
      .sort(compareDescending)
      // Clamped, so a negative limit from a malformed query returns nothing rather than everything —
      // `slice` with a negative argument counts from the end, which would be the worst possible
      // reading of "give me none".
      .slice(0, Math.max(0, query.limit))
      .map((record) => ({
        executionId: record.executionId,
        startedAt: record.startedAt,
        status: record.status,
        environment: record.environment,
        // Zero while running: the counts live in the completion, and a summary of an unfinished run
        // has none. Reporting undefined would make every caller handle a case with one obvious answer.
        total: record.totals?.total ?? 0,
        failed: record.totals?.failed ?? 0,
      }));

    return Promise.resolve(summaries);
  }

  /** Shared by `complete`, so the two failure modes cannot drift apart. */
  #notFound(executionId: ExecutionId): StorageError {
    return new StorageError(
      ErrorCode.storageFailure,
      `No execution with id ${executionId}.`,
      {
        context: { executionId },
        remediation: "Check the identifier, or list the available executions.",
      },
    );
  }
}

/**
 * Newest first, with a total order.
 *
 * ISO 8601 timestamps compare correctly as strings, so no parsing is needed. The identifier
 * tie-break exists because two runs can start in the same millisecond, and an order that is not
 * total makes a listing depend on how the store happens to be laid out.
 */
function compareDescending(
  left: ExecutionRecord,
  right: ExecutionRecord,
): number {
  if (left.startedAt !== right.startedAt)
    return left.startedAt < right.startedAt ? 1 : -1;

  // Identifiers are unique, so this cannot be reached — but a comparator that never returns zero is
  // not a valid comparator, and leaving it wrong invites a copy into a place where equality happens.
  if (left.executionId === right.executionId) return 0;

  return left.executionId < right.executionId ? 1 : -1;
}
