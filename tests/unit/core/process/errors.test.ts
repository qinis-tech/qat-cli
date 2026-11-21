import { describe, expect, it } from "vitest";

import { readProcessFailure } from "~/core/process/errors.js";

describe("readProcessFailure", () => {
  it("reads an errno from a declared code", () => {
    expect(readProcessFailure({ code: "ENOENT" }).errnoCode).toBe("ENOENT");
  });

  it("reads an errno from the message when no code is declared", () => {
    expect(
      readProcessFailure(
        new Error("Command failed with ENOENT: ci spawn ci ENOENT"),
      ).errnoCode,
    ).toBe("ENOENT");
  });

  it("finds an errno through the cause chain", () => {
    const cause = Object.assign(new Error("spawn"), { code: "EACCES" });

    expect(
      readProcessFailure(new Error("Command failed", { cause })).errnoCode,
    ).toBe("EACCES");
  });

  it("does not mistake a library code or an ordinary word for an errno", () => {
    expect(
      readProcessFailure({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" })
        .errnoCode,
    ).toBeUndefined();
    expect(
      readProcessFailure(new Error("Error: Execa command failed")).errnoCode,
    ).toBeUndefined();
  });
});
