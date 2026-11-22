import { describe, expect, it } from "vitest";

import {
  MessageKind,
  renderMessage,
  writeMessage,
} from "~/cli/output/messages.js";
import {
  renderError,
  renderResult,
  reportError,
  reportResult,
} from "~/cli/output/report.js";
import type { RenderedError } from "~/core/errors/index.js";

/**
 * Every assertion here is on the text a user would see, not on a call to a writer. The renderers return
 * strings precisely so that this is possible.
 */
interface Capture {
  readonly out: string[];
  readonly err: string[];
  readonly streams: {
    out: { write(text: string): void };
    err: { write(text: string): void };
  };
}

function capture(): Capture {
  const out: string[] = [];
  const err: string[] = [];

  return {
    out,
    err,
    streams: {
      out: {
        write: (text: string) => {
          out.push(text);
        },
      },
      err: {
        write: (text: string) => {
          err.push(text);
        },
      },
    },
  };
}

function renderedError(overrides: Partial<RenderedError> = {}): RenderedError {
  return {
    code: "QAT2001",
    message: "No project found.",
    details: ["root: /tmp/example"],
    ...overrides,
  };
}

describe("messages", () => {
  it("labels success, note and warning", () => {
    expect(renderMessage(MessageKind.Success, "Project initialised.")).toBe(
      "success: Project initialised.",
    );
    expect(renderMessage(MessageKind.Note, "Using qat.config.ts.")).toBe(
      "note: Using qat.config.ts.",
    );
    expect(renderMessage(MessageKind.Warning, "No specs matched.")).toBe(
      "warning: No specs matched.",
    );
  });

  it("leaves a progress line unprefixed", () => {
    // A progress line is already a sentence about the work; a label in front of every one is noise.
    expect(renderMessage(MessageKind.Progress, "Running checkout.cy.ts")).toBe(
      "Running checkout.cy.ts",
    );
  });

  it("writes every message to standard error", () => {
    const sink = capture();

    for (const kind of Object.values(MessageKind)) {
      writeMessage(kind, "text", sink.streams);
    }

    expect(sink.out).toStrictEqual([]);
    expect(sink.err).toHaveLength(Object.values(MessageKind).length);
  });

  it("strips terminal escape sequences", () => {
    // Text routinely arrives from a subprocess or a file. A sequence that clears the screen or moves the
    // cursor can make a user believe output came from this tool.
    expect(
      renderMessage(MessageKind.Note, "\u001B[2J\u001B[31mred\u001B[0m"),
    ).toBe("note: red");
  });

  it("strips control characters but keeps newlines and tabs", () => {
    expect(renderMessage(MessageKind.Note, "one\ntwo\tthree\u0007")).toBe(
      "note: one\ntwo\tthree",
    );
  });
});

describe("results", () => {
  it("renders lines for a person", () => {
    const text = renderResult(
      { lines: ["project    demo", "root       /tmp/demo"], document: {} },
      {
        json: false,
      },
    );

    expect(text).toBe("project    demo\nroot       /tmp/demo\n");
  });

  it("renders nothing when there are no lines", () => {
    // A command that produces no output should not produce a blank line.
    expect(renderResult({ lines: [], document: {} }, { json: false })).toBe("");
  });

  it("renders the document alone under --json", () => {
    const text = renderResult(
      { lines: ["human text"], document: { name: "demo" } },
      { json: true },
    );

    expect(JSON.parse(text)).toStrictEqual({ name: "demo" });
    // The human lines are absent, not filtered or prefixed. A consumer never skips a line that does not
    // parse.
    expect(text).not.toContain("human text");
  });

  it("renders a single line of JSON, so a streaming consumer can read it", () => {
    const text = renderResult(
      { lines: [], document: { a: 1, b: 2 } },
      { json: true },
    );

    expect(text.trimEnd().split("\n")).toHaveLength(1);
  });

  it("sanitises result lines as well as messages", () => {
    const text = renderResult(
      { lines: ["\u001B[31mred\u001B[0m"], document: {} },
      { json: false },
    );

    expect(text).toBe("red\n");
  });

  it("writes results to standard output and never to standard error", () => {
    const sink = capture();

    reportResult(
      { lines: ["line"], document: {} },
      { json: false },
      sink.streams,
    );

    expect(sink.out).toStrictEqual(["line\n"]);
    expect(sink.err).toStrictEqual([]);
  });

  it("writes nothing at all for an empty result", () => {
    const sink = capture();

    reportResult({ lines: [], document: {} }, { json: false }, sink.streams);

    expect(sink.out).toStrictEqual([]);
  });
});

describe("errors", () => {
  it("leads with the code, indents details and separates the remedy", () => {
    const text = renderError(
      renderedError({ remediation: "Run the command inside a project." }),
      { json: false },
    );

    expect(text).toBe(
      "error: QAT2001: No project found.\n  root: /tmp/example\n\nRun the command inside a project.\n",
    );
  });

  it("omits the separator when there is no remedy", () => {
    // An empty instruction reads as one that was forgotten, which is worse than none.
    expect(renderError(renderedError(), { json: false })).toBe(
      "error: QAT2001: No project found.\n  root: /tmp/example\n",
    );
  });

  it("renders the document alone under --json", () => {
    const text = renderError(renderedError(), { json: true });
    const document = JSON.parse(text) as { error?: { code?: string } };

    expect(document.error?.code).toBe("QAT2001");
    expect(text).not.toContain("error: ");
  });

  it("writes errors to standard error and never to standard output", () => {
    const sink = capture();

    reportError(renderedError(), { json: false }, sink.streams);

    expect(sink.err).toHaveLength(1);
    expect(sink.out).toStrictEqual([]);
  });

  it("sanitises the message, the details and the remedy", () => {
    const text = renderError(
      renderedError({
        message: "\u001B[2Jgone",
        details: ["\u0007detail"],
        remediation: "\u001B[0mremedy",
      }),
      { json: false },
    );

    expect(text).not.toContain("\u001B");
    expect(text).not.toContain("\u0007");
    expect(text).toContain("error: QAT2001: gone");
  });
});

describe("output boundaries", () => {
  it("never writes a stack trace, whatever it is given", () => {
    const sink = capture();

    reportError(
      renderedError({ details: [], message: "boom" }),
      { json: false },
      sink.streams,
    );

    expect(sink.err.join("")).not.toContain("at ");
  });

  it("produces no escape sequences in any mode", () => {
    const sink = capture();

    reportResult(
      { lines: ["\u001B[1mbold\u001B[0m"], document: {} },
      { json: false },
      sink.streams,
    );

    expect(sink.out.join("")).not.toContain("\u001B");
  });
});
