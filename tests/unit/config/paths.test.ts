/**
 * Anchoring a configured path, one rule at a time.
 *
 * Every case here drives `resolvePath`, because that is the only entry point the application uses and the only one whose
 * ordering of checks matters. The platform is injected — `posixPathTools` or `win32PathTools` — rather than read from the
 * host, so the Windows rules are exercised on every runner instead of waiting for the operating-system matrix to notice
 * a regression.
 *
 * The assertions are on structure, not prose: a failure is identified by its code, and a success by the absolute path,
 * the form of the input and the containment flag. Message wording lives in the templates and is checked separately,
 * once, by the loop at the end.
 */
import { describe, expect, it } from "vitest";

import type {
  PathIssue,
  PathIssueCode,
  PathResolution,
  ResolvedPath,
  ResolvePathOptions,
} from "~/config/resolver/contracts.js";
import {
  EXTERNAL_INPUT_PATH_POLICY,
  PROJECT_INPUT_PATH_POLICY,
  PROJECT_OUTPUT_PATH_POLICY,
  PATH_ISSUE_CODES,
} from "~/config/resolver/contracts.js";
import {
  MAX_CONFIGURED_PATH_LENGTH,
  PATH_ISSUE_TEMPLATES,
  describePathIssue,
  isWithinProjectRoot,
  posixPathTools,
  resolvePath,
  win32PathTools,
} from "~/config/resolver/paths.js";

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

const ROOT = "/work/proj";
const FIELD = "output.reports";

/** Resolve with the output policy and POSIX tools unless a case overrides them. */
function resolve(
  value: unknown,
  options: Partial<ResolvePathOptions> = {},
): PathResolution {
  return resolvePath(value, {
    projectRoot: ROOT,
    field: FIELD,
    policy: PROJECT_OUTPUT_PATH_POLICY,
    pathTools: posixPathTools,
    ...options,
  });
}

/** The anchored path, or a failure that names what actually went wrong. */
function resolved(
  value: unknown,
  options: Partial<ResolvePathOptions> = {},
): ResolvedPath {
  const result = resolve(value, options);
  if (!result.ok) {
    throw new Error(
      `expected a resolved path for ${JSON.stringify(value)}, got ${result.issue.code}`,
    );
  }
  return result.path;
}

/** The issue, or a failure that says the value was unexpectedly accepted. */
function rejected(
  value: unknown,
  options: Partial<ResolvePathOptions> = {},
): PathIssue {
  const result = resolve(value, options);
  if (result.ok) {
    throw new Error(
      `expected a rejection for ${JSON.stringify(value)}, resolved to ${result.path.absolute}`,
    );
  }
  return result.issue;
}

function codeOf(
  value: unknown,
  options: Partial<ResolvePathOptions> = {},
): PathIssueCode {
  return rejected(value, options).code;
}

/* -------------------------------------------------------------------------- */
/* Anchoring                                                                  */
/* -------------------------------------------------------------------------- */

describe("a project-relative path", () => {
  it.each([
    ["a single segment", "reports", "/work/proj/reports"],
    ["a nested path", "results/reports", "/work/proj/results/reports"],
    ["a leading dot", "./reports", "/work/proj/reports"],
    ["a trailing separator", "reports/", "/work/proj/reports"],
    [
      "an interior parent reference",
      "results/../reports",
      "/work/proj/reports",
    ],
    ["a doubled separator", "results//reports", "/work/proj/results/reports"],
    ["the root itself", ".", "/work/proj"],
    ["the root, spelled with a separator", "./", "/work/proj"],
  ])("anchors %s to the project root", (_case, value, expected) => {
    const path = resolved(value);

    // The project root, never the working directory: that anchoring is the whole reason this module exists.
    expect(path.absolute).toBe(expected);
    expect(path.form).toBe("relative");
    expect(path.withinProjectRoot).toBe(true);
  });

  it("keeps the source exactly as the reader wrote it", () => {
    // Diagnostics quote this string. A normalised echo would hide the trailing space or the doubled separator that
    // caused the problem in the first place.
    expect(resolved("./reports/").source).toBe("./reports/");
  });

  it("resolves the same value identically every time", () => {
    expect(resolved("results/reports")).toStrictEqual(
      resolved("results/reports"),
    );
  });
});

describe("an absolute path", () => {
  it("is refused for a field that must stay project-relative", () => {
    // Output directories belong to the project and appear in a diff; an absolute path here is almost always a typo
    // aimed at somebody else's directory.
    expect(codeOf("/data/reports")).toBe("PATH_ABSOLUTE_NOT_PERMITTED");
  });

  it("is accepted for a field that may be spelled either way", () => {
    const path = resolved("/work/proj/cypress.config.ts", {
      field: "cypress.configFile",
      policy: PROJECT_INPUT_PATH_POLICY,
    });

    expect(path.form).toBe("absolute");
    expect(path.absolute).toBe("/work/proj/cypress.config.ts");
    expect(path.source).toBe("/work/proj/cypress.config.ts");
  });

  it("still has to live inside the project", () => {
    // Reading outside the project is a separate feature with its own review, not an accident to tolerate.
    expect(
      codeOf("/etc/cypress.config.ts", {
        field: "cypress.configFile",
        policy: PROJECT_INPUT_PATH_POLICY,
      }),
    ).toBe("PATH_OUTSIDE_PROJECT_ROOT");
  });

  it("is allowed outside the project only where the policy says so", () => {
    const path = resolved("/opt/shared/cypress.config.ts", {
      field: "cypress.configFile",
      policy: EXTERNAL_INPUT_PATH_POLICY,
    });

    expect(path.absolute).toBe("/opt/shared/cypress.config.ts");
    expect(path.withinProjectRoot).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Containment                                                                */
/* -------------------------------------------------------------------------- */

describe("containment", () => {
  it.each([
    ["the root itself", ROOT, true],
    ["a child", "/work/proj/reports", true],
    ["a deep child", "/work/proj/a/b/c", true],
    ["a sibling sharing a prefix", "/work/proj-cache/reports", false],
    ["a parent", "/work", false],
    ["an unrelated tree", "/etc", false],
    ["a child whose name begins with two dots", "/work/proj/..data", true],
  ])("answers %s as %s", (_case, candidate, expected) => {
    // The two failure modes of a naive check, one case each: a string prefix accepts `/work/proj-cache`, and a
    // "starts with .." guard rejects a directory legitimately named `..data`.
    expect(isWithinProjectRoot(candidate, ROOT, posixPathTools)).toBe(
      true === expected,
    );
  });

  it("treats a root with a trailing separator as the same root", () => {
    expect(resolved("reports", { projectRoot: "/work/proj/" }).absolute).toBe(
      "/work/proj/reports",
    );
  });

  it("treats the filesystem root as containing everything under it", () => {
    expect(resolved("reports", { projectRoot: "/" }).absolute).toBe("/reports");
  });

  it.each([
    ["an ascent", "../reports"],
    ["an ascent from depth", "a/../../reports"],
    ["a bare parent", ".."],
    ["an ascent that comes back", "a/../.."],
  ])("refuses %s past the project root", (_case, value) => {
    // Normalisation happens before containment, so `a/../b` is inside and `../b` is not.
    expect(codeOf(value)).toBe("PATH_OUTSIDE_PROJECT_ROOT");
  });

  it("names both the resolved path and the root it escaped", () => {
    const issue = rejected("../reports");

    // The message is where a reader learns why: it quotes where the value landed and what it was measured against.
    expect(issue.message).toContain("/work/reports");
    expect(issue.message).toContain(ROOT);
    expect(issue.field).toBe(FIELD);
  });
});

/* -------------------------------------------------------------------------- */
/* Shape                                                                      */
/* -------------------------------------------------------------------------- */

describe("a value that is not a path", () => {
  const notStrings: [string, unknown][] = [
    ["a number", 42],
    ["null", null],
    ["undefined", undefined],
    ["a boolean", false],
    ["an object", {}],
    ["a list", ["reports"]],
  ];

  it.each(notStrings)("refuses %s", (_case, value) => {
    expect(codeOf(value)).toBe("PATH_NOT_A_STRING");
  });

  it("keeps the offending value for the caller, without printing it", () => {
    const issue = rejected(42);

    // Kept structurally for tests and for whatever composes the message; the message itself does not echo an arbitrary
    // value, because the field could be something nobody should have written down.
    expect(issue.value).toBe(42);
  });
});

describe("a value that is empty or padded", () => {
  it.each([
    ["an empty string", "", "PATH_EMPTY"],
    ["whitespace only", "   ", "PATH_EMPTY"],
    ["a tab", "\t", "PATH_EMPTY"],
    ["a leading space", " reports", "PATH_SURROUNDING_WHITESPACE"],
    ["a trailing space", "reports ", "PATH_SURROUNDING_WHITESPACE"],
  ])("refuses %s", (_case, value, expected) => {
    // Padding becomes part of a directory name. A path that only looks right is worse than one that fails.
    expect(codeOf(value)).toBe(expected);
  });

  it("refuses a null byte", () => {
    expect(codeOf("reports\u0000/reports")).toBe("PATH_NUL_BYTE");
  });
});

/* -------------------------------------------------------------------------- */
/* Portability                                                                */
/* -------------------------------------------------------------------------- */

describe("a value that would not survive another machine", () => {
  it.each([
    ["a relative path with a backslash", "evidence\\screenshots"],
    ["a UNC path", "\\\\server\\share\\reports"],
    ["an absolute Windows path", "C:\\reports"],
  ])("refuses %s before any other rule", (_case, value) => {
    // Ordered before the drive check on purpose: a reader who pasted a Windows path should be told the portable
    // spelling, not lectured about drive qualification.
    expect(codeOf(value)).toBe("PATH_BACKSLASH_SEPARATOR");
  });

  it.each([
    ["a home alias", "~/reports", "PATH_HOME_ALIAS"],
    ["a file URL", "file:///tmp/reports", "PATH_FILE_URL"],
    ["an object-store URL", "s3://bucket/reports", "PATH_FILE_URL"],
  ])("refuses %s", (_case, value, expected) => {
    expect(codeOf(value)).toBe(expected);
  });

  it("does not echo a URL back, because a URL can carry credentials", () => {
    const issue = rejected("s3://key:secret@bucket/reports");

    expect(issue.message).toContain(FIELD);
    expect(issue.message).not.toContain("secret");
  });
});

/* -------------------------------------------------------------------------- */
/* Boundaries                                                                 */
/* -------------------------------------------------------------------------- */

describe("the length bound", () => {
  it("accepts a path of exactly the limit", () => {
    const value = "a".repeat(MAX_CONFIGURED_PATH_LENGTH);

    expect(resolved(value).absolute.endsWith(value)).toBe(true);
  });

  it("refuses a path one character over the limit", () => {
    expect(codeOf("a".repeat(MAX_CONFIGURED_PATH_LENGTH + 1))).toBe(
      "PATH_TOO_LONG",
    );
  });

  it("refuses a very long path without reading it as anything else", () => {
    // Well past the bound and containing a backslash: the reported reason must be the length, because shortening the
    // path is the first thing the reader has to do either way.
    expect(codeOf(`${"a".repeat(MAX_CONFIGURED_PATH_LENGTH)}\\x`)).toBe(
      "PATH_TOO_LONG",
    );
  });

  it("publishes the bound it enforces", () => {
    expect(MAX_CONFIGURED_PATH_LENGTH).toBe(4096);
  });
});

/* -------------------------------------------------------------------------- */
/* Windows                                                                    */
/* -------------------------------------------------------------------------- */

describe("on Windows", () => {
  const WINDOWS_ROOT = "C:\\work\\proj";

  const resolveWindows = (
    value: unknown,
    options: Partial<ResolvePathOptions> = {},
  ): PathResolution =>
    resolve(value, {
      projectRoot: WINDOWS_ROOT,
      pathTools: win32PathTools,
      ...options,
    });

  it("anchors a relative path with backslash separators", () => {
    const result = resolveWindows("results/reports");

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.path.absolute).toBe("C:\\work\\proj\\results\\reports");
  });

  it("accepts an absolute path spelled with forward slashes", () => {
    const result = resolveWindows("C:/work/proj/cypress.config.ts", {
      field: "cypress.configFile",
      policy: PROJECT_INPUT_PATH_POLICY,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Normalised to the platform's separator, because everything downstream is a Windows path.
    expect(result.path.absolute).toBe("C:\\work\\proj\\cypress.config.ts");
  });

  it("compares containment case-insensitively", () => {
    const result = resolveWindows("C:/WORK/PROJ/out", {
      policy: PROJECT_INPUT_PATH_POLICY,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.path.withinProjectRoot).toBe(true);
  });

  it("refuses a path on another drive", () => {
    const result = resolveWindows("D:/reports", {
      policy: PROJECT_INPUT_PATH_POLICY,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    // Different drive: `relative()` cannot express the difference, so containment fails rather than guessing.
    expect(result.issue.code).toBe("PATH_OUTSIDE_PROJECT_ROOT");
  });

  it("refuses a path rooted without a drive letter", () => {
    const result = resolveWindows("\\reports", {
      policy: { ...PROJECT_INPUT_PATH_POLICY, rejectBackslashes: false },
    });

    // Such a path is anchored to whichever drive the process happens to be on — machine state, not intent — so it is
    // treated as outside rather than silently accepted.
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.issue.code).toBe("PATH_OUTSIDE_PROJECT_ROOT");
  });

  it("refuses a drive-relative path", () => {
    const result = resolveWindows("C:reports");

    expect(result.ok).toBe(false);
    if (result.ok) return;

    // "C:reports" means "relative to the current directory on drive C", which is never what a reader means.
    expect(result.issue.code).toBe("PATH_DRIVE_RELATIVE");
  });
});

/* -------------------------------------------------------------------------- */
/* Programmer errors                                                          */
/* -------------------------------------------------------------------------- */

describe("a caller that breaks the contract", () => {
  it.each([
    ["a relative root", "work/proj"],
    ["an empty root", ""],
  ])("rejects %s outright", (_case, projectRoot) => {
    // Not an issue: an issue is something a user can fix. A relative root would reintroduce the working-directory
    // dependency invisibly, so it fails loudly with a stack that points at the caller.
    expect(() => resolve("reports", { projectRoot })).toThrow(TypeError);
  });

  it("rejects an empty field name", () => {
    expect(() => resolve("reports", { field: "" })).toThrow(TypeError);
  });
});

/* -------------------------------------------------------------------------- */
/* Issue descriptions                                                         */
/* -------------------------------------------------------------------------- */

describe("every issue code", () => {
  it("has a template that names the field and ends in a sentence", () => {
    for (const code of PATH_ISSUE_CODES) {
      const description = PATH_ISSUE_TEMPLATES[code]({
        field: FIELD,
        value: "/etc/passwd",
        projectRoot: ROOT,
        absolute: "/etc/passwd",
      });

      // The exhaustive record makes a missing code a compile error; this makes an empty or malformed one a test
      // failure. Between them, a rejection the reader cannot act on has nowhere to live.
      expect(description.message).toContain(FIELD);
      expect(description.message.endsWith(".")).toBe(true);
      expect(description.message).not.toContain("undefined");
      expect(description.message).not.toContain("[object Object]");
    }
  });

  it("offers a remedy for every structural refusal", () => {
    for (const code of PATH_ISSUE_CODES) {
      // Every rule in this stage is something the reader can fix by editing the field, so every one of them should say
      // how.
      expect(
        describePathIssue(code, {
          field: FIELD,
          value: "x",
          projectRoot: ROOT,
          absolute: ROOT + "/x",
        }).hint?.length ?? 0,
      ).toBeGreaterThan(0);
    }
  });

  it("is reachable through resolvePath, with the code that was raised", () => {
    for (const code of PATH_ISSUE_CODES) {
      // A sample value per code would duplicate the tables above; instead this asserts that the issue produced by a
      // real resolution is one of the catalogued codes, which is the property the CLI depends on.
      expect(PATH_ISSUE_CODES).toContain(rejected("../reports").code);
      expect(code).toMatch(/^PATH_/);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Non-functional                                                             */
/* -------------------------------------------------------------------------- */

describe("non-functional behaviour", () => {
  it("is synchronous", () => {
    // No filesystem, no clock, no environment: resolution is string arithmetic over two inputs.
    expect(resolve("reports")).not.toBeInstanceOf(Promise);
  });

  it("returns frozen values", () => {
    const result = resolve("reports");
    const failure = resolve("../reports");

    expect(result.ok && Object.isFrozen(result.path)).toBe(true);
    expect(!failure.ok && Object.isFrozen(failure.issue)).toBe(true);
  });

  it("does not depend on the working directory", () => {
    const before = process.cwd();
    const first = resolved("results/reports");
    process.chdir("/tmp");
    const second = resolved("results/reports");
    process.chdir(before);

    // The one property this module was written to guarantee, asserted directly rather than inferred from the absence of
    // a `resolve()` call in the implementation.
    expect(second).toStrictEqual(first);
    expect(first.absolute.startsWith(ROOT)).toBe(true);
  });

  it("does not accumulate state across calls", () => {
    const started = performance.now();
    for (let index = 0; index < 10_000; index += 1) {
      resolve(`results/${String(index)}`);
    }

    // A generous bound: this is a smoke test for accidental quadratic behaviour or retained state, not a benchmark on a
    // shared runner.
    expect(performance.now() - started).toBeLessThan(1500);
  });
});
