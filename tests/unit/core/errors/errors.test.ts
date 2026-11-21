import { describe, expect, it } from "vitest";

import {
  ApplicationError,
  describeError,
  ErrorCategory,
  ErrorCode,
  ExitCode,
  exitCodeForError,
  FilesystemError,
  FrameworkExecutionError,
  InternalError,
  INTERNAL_ERROR_HINT,
  InvalidArgumentError,
  InvalidConfigurationError,
  InvalidProjectError,
  isApplicationError,
  MissingDependencyError,
  ProcessExecutionError,
  Recoverability,
  ReportGenerationError,
  StorageError,
  toApplicationError,
  UnsupportedEnvironmentError,
} from "~/core/errors/index.js";

/**
 * Classification table.
 *
 * One row per error class, and the rows are the specification: category, code,
 * recoverability and exit code are all decisions, and every one of them is asserted rather
 * than inferred from the implementation.
 *
 * `create` is a factory rather than a constructed instance so each test gets a fresh error
 * and a failure message names the class through `$name` without the assertion having to
 * stringify the object.
 *
 * Imported through `~/core/errors/index.js` deliberately: that is the path a consumer
 * takes, so a symbol disappearing from the barrel fails here rather than in whichever
 * module needs it next.
 */
interface Classification {
  readonly name: string;
  readonly create: () => ApplicationError;
  readonly category: ErrorCategory;
  readonly code: ErrorCode;
  readonly recoverability: Recoverability;
  readonly exitCode: ExitCode;
}

const CLASSIFICATIONS: readonly Classification[] = [
  {
    name: "InvalidArgumentError",
    create: () =>
      new InvalidArgumentError(
        ErrorCode.invalidArgument,
        "Unknown flag --nope.",
      ),
    category: ErrorCategory.UserInput,
    code: ErrorCode.invalidArgument,
    recoverability: Recoverability.UserActionable,
    exitCode: ExitCode.InvalidInput,
  },
  {
    name: "InvalidProjectError",
    create: () =>
      new InvalidProjectError(ErrorCode.projectNotFound, "No project found."),
    category: ErrorCategory.Project,
    code: ErrorCode.projectNotFound,
    recoverability: Recoverability.UserActionable,
    exitCode: ExitCode.InvalidInput,
  },
  {
    name: "InvalidConfigurationError",
    create: () =>
      new InvalidConfigurationError(
        ErrorCode.configurationInvalid,
        "baseUrl is not a URL.",
      ),
    category: ErrorCategory.Configuration,
    code: ErrorCode.configurationInvalid,
    recoverability: Recoverability.UserActionable,
    exitCode: ExitCode.InvalidInput,
  },
  {
    name: "MissingDependencyError",
    create: () =>
      new MissingDependencyError(
        ErrorCode.dependencyMissing,
        "Cypress is not installed.",
      ),
    category: ErrorCategory.Environment,
    code: ErrorCode.dependencyMissing,
    recoverability: Recoverability.UserActionable,
    exitCode: ExitCode.Environment,
  },
  {
    name: "UnsupportedEnvironmentError",
    create: () =>
      new UnsupportedEnvironmentError(
        ErrorCode.runtimeUnsupported,
        "Node 22 is unsupported.",
      ),
    category: ErrorCategory.Environment,
    code: ErrorCode.runtimeUnsupported,
    recoverability: Recoverability.Fatal,
    exitCode: ExitCode.Environment,
  },
  {
    name: "FilesystemError",
    create: () =>
      new FilesystemError(
        ErrorCode.filesystemFailure,
        "EACCES writing results.",
      ),
    category: ErrorCategory.Infrastructure,
    code: ErrorCode.filesystemFailure,
    recoverability: Recoverability.Retryable,
    exitCode: ExitCode.Environment,
  },
  {
    name: "ProcessExecutionError",
    create: () =>
      new ProcessExecutionError(ErrorCode.processFailure, "Child exited 127."),
    category: ErrorCategory.Infrastructure,
    code: ErrorCode.processFailure,
    recoverability: Recoverability.Retryable,
    exitCode: ExitCode.Environment,
  },
  {
    name: "FrameworkExecutionError",
    create: () =>
      new FrameworkExecutionError(
        ErrorCode.frameworkExecutionFailed,
        "The browser did not start.",
      ),
    category: ErrorCategory.Execution,
    code: ErrorCode.frameworkExecutionFailed,
    recoverability: Recoverability.Retryable,
    exitCode: ExitCode.Environment,
  },
  {
    name: "StorageError",
    create: () =>
      new StorageError(
        ErrorCode.storageFailure,
        "The history database is locked.",
      ),
    category: ErrorCategory.Storage,
    code: ErrorCode.storageFailure,
    recoverability: Recoverability.Retryable,
    exitCode: ExitCode.Environment,
  },
  {
    name: "ReportGenerationError",
    create: () =>
      new ReportGenerationError(
        ErrorCode.reportGenerationFailed,
        "The report template is missing.",
      ),
    category: ErrorCategory.Reporting,
    code: ErrorCode.reportGenerationFailed,
    recoverability: Recoverability.Retryable,
    exitCode: ExitCode.Environment,
  },
  {
    name: "InternalError",
    create: () => new InternalError({ cause: new TypeError("boom") }),
    category: ErrorCategory.Internal,
    code: ErrorCode.internalError,
    recoverability: Recoverability.Fatal,
    exitCode: ExitCode.Internal,
  },
];

describe("error classification", () => {
  it.each(CLASSIFICATIONS)("classifies $name", (row) => {
    const error = row.create();

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ApplicationError);
    expect(error.code).toBe(row.code);
    expect(error.category).toBe(row.category);
    expect(error.recoverability).toBe(row.recoverability);
    expect(exitCodeForError(error)).toBe(row.exitCode);
  });

  it("covers every defined category", () => {
    // If a category exists with no class mapped to it, the exit-code table has an entry
    // nothing can ever produce — which means a failure mode was designed and not built.
    const covered = new Set(CLASSIFICATIONS.map((row) => row.category));

    expect(covered).toStrictEqual(new Set(Object.values(ErrorCategory)));
  });

  it("distinguishes recoverability within a single category", () => {
    // Environment spans both a fixable and an unfixable condition. If these ever collapse
    // to the same class, the message for one of them becomes wrong advice.
    const missingDependency = new MissingDependencyError(
      ErrorCode.dependencyMissing,
      "x",
    );
    const unsupported = new UnsupportedEnvironmentError(
      ErrorCode.runtimeUnsupported,
      "x",
    );

    expect(missingDependency.category).toBe(unsupported.category);
    expect(missingDependency.recoverability).not.toBe(
      unsupported.recoverability,
    );
  });
});

describe("exit-code mapping", () => {
  it("never produces the test-failure code from an application error", () => {
    // The contract a CI script depends on: 1 means the tests ran and failed. No
    // application error may ever mean that, or a broken tool becomes indistinguishable
    // from broken code under test.
    for (const row of CLASSIFICATIONS) {
      expect(exitCodeForError(row.create())).not.toBe(ExitCode.TestsFailed);
    }
  });

  it("treats anything unrecognised as internal", () => {
    expect(exitCodeForError(new TypeError("x"))).toBe(ExitCode.Internal);
    expect(exitCodeForError("a thrown string")).toBe(ExitCode.Internal);
    expect(exitCodeForError(undefined)).toBe(ExitCode.Internal);
    expect(exitCodeForError(null)).toBe(ExitCode.Internal);
  });
});

describe("unexpected failures", () => {
  it("wraps without discarding the original", () => {
    // AC10 in one assertion: an unexpected failure must not be swallowed. The original is
    // retained as the cause so a logger — and a maintainer — can still see it.
    const original = new RangeError("unexpected value");
    const wrapped = toApplicationError(original);

    expect(wrapped).toBeInstanceOf(InternalError);
    expect(wrapped.code).toBe(ErrorCode.internalError);
    expect(wrapped.cause).toBe(original);
  });

  it("passes an application error through without re-wrapping", () => {
    const original = new StorageError(ErrorCode.storageFailure, "locked");

    expect(toApplicationError(original)).toBe(original);
  });

  it("does not expose the original message to the user", () => {
    const rendered = describeError(
      new Error("connection string postgres://user:secret@host/db"),
    );

    expect(rendered.code).toBe(ErrorCode.internalError);
    expect(rendered.message).not.toContain("secret");
    expect(rendered.diagnostics).toBeUndefined();
  });

  it("handles a non-Error throw", () => {
    const rendered = describeError("a thrown string");

    expect(rendered.code).toBe(ErrorCode.internalError);
    expect(rendered.message).toBe("An unexpected internal error occurred.");
  });
});

describe("error description", () => {
  it("renders context as sorted details", () => {
    const error = new InvalidProjectError(
      ErrorCode.projectNotFound,
      "No project found.",
      {
        context: { root: "/tmp/example", inspected: 3 },
      },
    );

    // Sorted so the output is stable regardless of how the context object was assembled.
    expect(describeError(error).details).toStrictEqual([
      "inspected: 3",
      "root: /tmp/example",
    ]);
  });

  it("includes a supplied remediation", () => {
    const error = new MissingDependencyError(
      ErrorCode.dependencyMissing,
      "Cypress is missing.",
      {
        remediation: "Install it with `npm install --save-dev cypress`.",
      },
    );

    expect(describeError(error).remediation).toBe(
      "Install it with `npm install --save-dev cypress`.",
    );
  });

  it("omits remediation entirely rather than setting it undefined", () => {
    const rendered = describeError(
      new InvalidProjectError(ErrorCode.projectNotFound, "x"),
    );

    // Absent, not present-and-undefined. JSON serialises the latter as `null`, and a
    // consumer then cannot tell "no advice" from "advice that was null".
    expect("remediation" in rendered).toBe(false);
  });

  it("provides guidance for an internal error that has none", () => {
    expect(describeError(new TypeError("x")).remediation).toBe(
      INTERNAL_ERROR_HINT,
    );
  });

  it("keeps the stack out of the structured log form", () => {
    const error = new FilesystemError(
      ErrorCode.filesystemFailure,
      "Could not write.",
      {
        cause: new Error("secret detail"),
      },
    );

    const logged = error.toLogObject();

    expect(logged).not.toHaveProperty("stack");
    expect(logged).not.toHaveProperty("cause");
    expect(JSON.stringify(logged)).not.toContain("secret detail");
  });

  it("reports the concrete class name", () => {
    // Guards against `this.name = new.target.name` being replaced by a hardcoded string,
    // which would make every error indistinguishable in a log.
    expect(new StorageError(ErrorCode.storageFailure, "x").name).toBe(
      "StorageError",
    );
    expect(new InternalError().name).toBe("InternalError");
  });
});

describe("error codes", () => {
  it("are unique", () => {
    const codes = Object.values(ErrorCode);

    // Nothing in the type system prevents two keys sharing a value, and the symptom —
    // two unrelated failures reporting the same code — survives review easily.
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("follow the documented range pattern", () => {
    for (const code of Object.values(ErrorCode)) {
      expect(code).toMatch(/^QAT[1-9]\d{3}$/);
    }
  });
});

describe("type guard", () => {
  it("recognises application errors only", () => {
    expect(isApplicationError(new InternalError())).toBe(true);
    expect(isApplicationError(new Error("x"))).toBe(false);
    expect(isApplicationError("thrown string")).toBe(false);
    expect(isApplicationError({ code: ErrorCode.internalError })).toBe(false);
  });
});
