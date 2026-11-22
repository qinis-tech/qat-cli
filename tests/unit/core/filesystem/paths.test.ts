import { join, sep } from "node:path";

import { describe, expect, it } from "vitest";

import { ErrorCode, FilesystemError } from "~/core/errors/index.js";
import {
  assertWithin,
  fromPortablePath,
  isWithin,
  normalizeAbsolutePath,
  resolveAgainst,
  toPortableRelativePath,
} from "~/core/filesystem/index.js";

/**
 * Path expectations are written with `join` and `sep` rather than with literal separators, so the
 * same assertions hold on Windows and Linux. That is also the only honest way to verify
 * platform behaviour from one machine: the module delegates separator handling to `node:path`, and
 * these tests verify it delegates rather than reimplements.
 */

const absolute = (path: string): string => join(sep, path);

describe("normalizeAbsolutePath", () => {
  it("normalises redundant separators and segments", () => {
    expect(
      normalizeAbsolutePath(`${sep}${sep}a${sep}${sep}b${sep}.${sep}c`),
    ).toBe(absolute(join("a", "b", "c")));
  });

  it("removes a trailing separator but keeps a filesystem root intact", () => {
    expect(normalizeAbsolutePath(`${absolute("a")}${sep}`)).toBe(absolute("a"));
    expect(normalizeAbsolutePath(sep)).toBe(sep);
  });

  it("rejects a relative path rather than resolving it against the working directory", () => {
    const error = (() => {
      try {
        normalizeAbsolutePath("relative/path");
        return undefined;
      } catch (caught: unknown) {
        return caught as FilesystemError;
      }
    })();

    expect(error).toBeInstanceOf(FilesystemError);
    expect(error?.code).toBe(ErrorCode.filesystemPathInvalid);
  });

  it("rejects an empty path, which would otherwise become the working directory", () => {
    expect(() => normalizeAbsolutePath("   ")).toThrow(FilesystemError);
  });

  it("rejects a null byte", () => {
    expect(() => normalizeAbsolutePath(`${absolute("a")}\0`)).toThrow(
      FilesystemError,
    );
  });
});

describe("resolveAgainst", () => {
  it("joins a relative path onto the base", () => {
    expect(resolveAgainst(absolute("project"), "cypress/config.ts")).toBe(
      absolute(join("project", "cypress", "config.ts")),
    );
  });

  it("returns an absolute target unchanged, ignoring the base", () => {
    const target = absolute(join("elsewhere", "file.txt"));

    expect(resolveAgainst(absolute("project"), target)).toBe(target);
  });

  it("resolves a parent-relative target, because that is what the caller asked for", () => {
    // Neutrality is the point: containment is a separate check, applied by whoever needs it.
    expect(resolveAgainst(absolute("project/sub"), "../file.txt")).toBe(
      absolute(join("project", "file.txt")),
    );
  });

  it("rejects a base that is not absolute", () => {
    expect(() => resolveAgainst("relative", "file.txt")).toThrow(
      FilesystemError,
    );
  });
});

describe("portable paths", () => {
  it("converts a stored path to the platform separator", () => {
    expect(fromPortablePath("cypress/e2e/smoke.cy.ts")).toBe(
      join("cypress", "e2e", "smoke.cy.ts"),
    );
  });

  it("round-trips with toPortableRelativePath", () => {
    const absolutePath = absolute(join("project", "cypress", "e2e", "a.cy.ts"));

    const stored = toPortableRelativePath(absolute("project"), absolutePath);

    expect(stored).toBe("cypress/e2e/a.cy.ts");
    expect(fromPortablePath(stored)).toBe(join("cypress", "e2e", "a.cy.ts"));
  });

  it("rejects an absolute stored path", () => {
    expect(() => fromPortablePath("/tmp/a")).toThrow(FilesystemError);
  });
});

describe("boundary checks", () => {
  it("accepts a path inside the root and the root itself", () => {
    expect(isWithin(absolute("out"), absolute(join("out", "a.json")))).toBe(
      true,
    );
    expect(isWithin(absolute("out"), absolute("out"))).toBe(true);
    expect(() => {
      assertWithin(absolute("out"), absolute(join("out", "a.json")), "write");
    }).not.toThrow();
  });

  it("rejects a sibling whose name shares a prefix", () => {
    // A string-prefix check would accept this. Path arithmetic does not.
    expect(isWithin(absolute("out"), absolute("out-backup/a.json"))).toBe(
      false,
    );
    expect(() => {
      assertWithin(absolute("out"), absolute("out-backup/a.json"), "write");
    }).toThrow(FilesystemError);
  });

  it("names the operation in the refusal", () => {
    const error = (() => {
      try {
        assertWithin(absolute("out"), absolute("etc"), "report write");
        return undefined;
      } catch (caught: unknown) {
        return caught as FilesystemError;
      }
    })();

    expect(error?.message).toContain("report write");
    expect(error?.context["candidate"]).toBe(absolute("etc"));
  });
});
