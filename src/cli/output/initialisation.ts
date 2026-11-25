import type { InitialisationResult } from "../../core/application/initialisation.js";

import { findingBlock } from "./diagnostics.js";

/** Labels padded to the same ten columns as every other report, then one space. */
function row(label: string, value: string): string {
  return `${label.padEnd(10)} ${value}`;
}

/**
 * The report for one initialisation outcome.
 *
 * Four shapes rather than one with optional parts: a refusal that printed the same lines as a success with a different
 * word would be scannable as "created", which is the one misreading this must not allow.
 */
export function initialisationLines(
  result: InitialisationResult,
): readonly string[] {
  switch (result.outcome) {
    case "created":
      return [
        row("created", result.path),
        row("root", result.root),
        "",
        "Edit the file to change the framework or add environments, then run `qat doctor`.",
      ];

    case "already-initialised":
      return [
        row("exists", result.path),
        row("root", result.root),
        "",
        "Nothing was changed. Delete the file first if you want a fresh one.",
      ];

    case "existing-configuration":
      return [
        row("unusable", result.path),
        row("root", result.root),
        "",
        ...result.findings.flatMap(findingBlock),
      ];

    case "project-not-usable":
      return [
        row("root", result.root),
        "",
        "This directory is not a Cypress project QAT can initialise.",
        "",
        ...result.findings.flatMap(findingBlock),
      ];
  }
}
