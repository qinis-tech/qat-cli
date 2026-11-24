import { OUTPUT_DEFAULTS } from "../schema/config.js";

import type {
  DefaultableConfiguration,
  DefaultDescriptor,
} from "./contracts.js";
import { deepFreeze } from "./freeze.js";

/**
 * The configuration defaults the resolution stage documents.
 *
 * ## The schema owns the values; this table owns the reasoning
 *
 * `qat.config.json` decides which fields may be omitted, and `schema/config.ts` supplies the values for the two it
 * defaults today through `OUTPUT_DEFAULTS`. This module does not restate them — it imports them, so there is one
 * authority for "where does output go" and the documentation test compares against it rather than against prose.
 *
 * What lives here is the part a schema cannot carry: the rule for each field and the reason for it. `version` and
 * `framework` have no default and the reasoning is written down. `defaultEnvironment` is derived rather than fixed and
 * the derivation is named. `cypress.configFile` is supplied by project detection and never guessed.
 *
 * ## Why `environments` is filled here and not by the schema
 *
 * The schema leaves `environments` absent, which is a legitimate state: a project with no named profiles. The
 * resolution stage fills it with an empty map so a consumer never has to distinguish "no environments" from "an empty
 * set of them". Both this and the re-applied output paths are idempotent on a validated document, which is what makes
 * them a guarantee rather than a mechanism.
 *
 * ## No value constants are exported any more
 *
 * The previous revision published `DEFAULT_REPORTS_DIRECTORY` and friends, which is how two answers to one question
 * appear: a caller could import the constant while the schema applied a different one. `OUTPUT_DEFAULTS` is the value;
 * this module is the explanation.
 */

/**
 * The environment name the derivation prefers.
 *
 * Not a default value — `defaultEnvironment` is derived — but the conventional name, so a project that declares an
 * environment called "default" needs no further configuration to run against it.
 */
export const PREFERRED_ENVIRONMENT_KEY = "default";

/**
 * Values applied when an optional field is omitted.
 *
 * Deeply frozen: one instance is shared by every resolution in the process, so a single stray assignment would change
 * behaviour for the rest of the run.
 */
export const CONFIGURATION_DEFAULTS: Readonly<DefaultableConfiguration> =
  deepFreeze({
    environments: {},
    output: {
      reports: OUTPUT_DEFAULTS.reports,
      evidence: OUTPUT_DEFAULTS.evidence,
    },
  });

/**
 * Catalogue entries before the list is sealed.
 *
 * Declared with an explicit annotation so every literal is checked against `DefaultDescriptor`; without it, `rule:
 * "none"` widens to `string` the moment the array passes through `Object.freeze`.
 */
const CATALOGUE_ENTRIES: readonly DefaultDescriptor[] = [
  {
    field: "version",
    rule: "none",
    rationale:
      "Identifies the schema the file was written against. Guessing it would silently reinterpret the document against different rules.",
  },
  {
    field: "framework",
    rule: "none",
    rationale:
      "Names the system under test. A default would let QAT assume a framework and appear to work on a project it does not understand.",
  },
  {
    field: "cypress.configFile",
    rule: "none",
    rationale:
      "Supplied by project-layout detection. A default would create a second, drifting source of truth for a fact the project already states.",
  },
  {
    field: "defaultEnvironment",
    rule: "derived",
    rationale:
      'An environment named "default" when the project declares one, otherwise the only declared environment, otherwise none. QAT never guesses which target to test.',
  },
  {
    field: "environments",
    rule: "default",
    value: {},
    rationale:
      "No implicit variables, so anything a run depends on is visible in the file rather than inherited from the operator.",
  },
  {
    field: "output.reports",
    rule: "default",
    value: OUTPUT_DEFAULTS.reports,
    rationale:
      "Deterministic and project-relative: no timestamp, hostname or working-directory fragment can make two runs of one configuration disagree.",
  },
  {
    field: "output.evidence",
    rule: "default",
    value: OUTPUT_DEFAULTS.evidence,
    rationale:
      "The same reasoning as the reports directory, and deliberately beside it: output that lands in two unrelated trees is output nobody can archive.",
  },
];

/**
 * Every optional configuration field, with its rule and its reasoning.
 *
 * One entry per leaf field the schema declares, and a test compares this list against `CONFIG_FIELD_PATHS` in both
 * directions — so a field added to the schema without a rule fails the build rather than passing unnoticed, and a rule
 * left behind after a field is removed does the same.
 */
export const DEFAULT_CATALOGUE: readonly DefaultDescriptor[] = Object.freeze(
  // Frozen entry by entry: a shared, mutable descriptor would let one consumer reword a rationale that a published
  // document claims to quote.
  CATALOGUE_ENTRIES.map((descriptor) => Object.freeze(descriptor)),
);

/**
 * Supplies defaults to the resolution stage.
 *
 * The interface exists so a caller can substitute a different set without editing this module or adding a branch to the
 * resolver. The production provider takes no parameters: configuration surface added for the benefit of tests ships
 * without a user.
 */
export interface DefaultsProvider {
  readonly defaults: Readonly<DefaultableConfiguration>;
  readonly catalogue: readonly DefaultDescriptor[];
}

export function createDefaultsProvider(): DefaultsProvider {
  return { defaults: CONFIGURATION_DEFAULTS, catalogue: DEFAULT_CATALOGUE };
}

/** Keep a value safe inside a markdown table cell. */
function escapeCell(text: string): string {
  return text.replace(/\r?\n/gu, " ").replace(/\|/gu, "\\|");
}

/**
 * Render the catalogue as a markdown table.
 *
 * The architecture document embeds this output and a test compares the file against it, so the published table cannot
 * fall behind the code. Cell text is escaped because a stray pipe would otherwise break the table — a silent
 * documentation bug of exactly the kind this function exists to prevent.
 */
export function defaultsAsMarkdown(): string {
  const header = [
    "| Field | Rule | Default | Rationale |",
    "| --- | --- | --- | --- |",
  ];
  const rows = DEFAULT_CATALOGUE.map((descriptor) => {
    const value =
      descriptor.rule === "default"
        ? `\`${escapeCell(JSON.stringify(descriptor.value))}\``
        : descriptor.rule === "derived"
          ? "_derived_"
          : "_none_";
    return `| \`${descriptor.field}\` | ${descriptor.rule} | ${value} | ${escapeCell(descriptor.rationale)} |`;
  });
  return [...header, ...rows].join("\n");
}
