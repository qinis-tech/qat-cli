/**
 * Persisted evidence model for the environment diagnostics.
 *
 * Two things live here, and they are deliberately the same thing seen from two
 * sides:
 *
 *  • the **writer's shape** — what a rule is allowed to persist about an
 *    environment finding, with named fields instead of an open `Record`;
 *  • the **reader's gate** — a tolerant parser for evidence that comes back from
 *    disk, a hosted service or an older QAT version, none of which can be
 *    trusted to be well formed.
 *
 * Why this is not an alias of the domain types in `src/config/environment`:
 * a persisted contract and an internal type look alike today and diverge
 * tomorrow. Refactoring an internal type must not silently break records written
 * last month, so this file re-declares the fields it owns and maps explicitly.
 * The mapping cost is small; the alternative is a migration nobody planned.
 *
 * Evolution rules (mirroring how every other persisted contract in QAT behaves):
 *  • additive changes only within a schema version;
 *  • readers ignore unknown fields, so a newer writer does not break an older
 *    reader;
 *  • writers never remove or repurpose a field without incrementing the version.
 *
 * The one invariant this file exists to make obvious: **no field here can hold a
 * variable's value.** Every variable-related field is a list of *names*.
 */

// ─── Contract ────────────────────────────────────────────────────────────────

/** Bump only for breaking changes; see the evolution rules above. */
export const ENVIRONMENT_EVIDENCE_SCHEMA_VERSION = 1 as const;

export type EnvironmentEvidenceSchemaVersion =
  typeof ENVIRONMENT_EVIDENCE_SCHEMA_VERSION;

/** The two findings that can carry environment evidence. */
export type EnvironmentFindingId = "ENV-001" | "ENV-002";

/** Where the profile came from. `none` is the absence of a selection, not a source. */
export type EnvironmentSelectionOrigin =
  "explicit-cli" | "process-environment" | "configuration-default" | "none";

/**
 * Everything QAT may record about an environment finding.
 *
 * Optional members are conditional by design rather than by accident:
 *  • `prerequisite` appears only on a skipped finding;
 *  • the variable facet appears only on ENV-001;
 *  • the path/field facet appears only on ENV-002.
 * A reader must therefore treat absence as "not applicable", never as zero.
 */
export interface EnvironmentEvidenceModel {
  readonly schemaVersion: EnvironmentEvidenceSchemaVersion;
  readonly findingId: EnvironmentFindingId;

  /** The profile the finding is about; `null` when nothing was selected. */
  readonly profile: string | null;
  readonly selectionOrigin: EnvironmentSelectionOrigin;
  /** Project-relative path of the configuration file, never absolute. */
  readonly configPath: string | null;

  /** How many problems were reported by this finding. */
  readonly issueCount: number;

  /** Names examined, in report order. Never values. */
  readonly variables: readonly string[];

  /** Configured path *fields* examined, e.g. `reports.directory`. */
  readonly paths: readonly string[];

  // ── Skip facet ──
  /** The check that had to succeed first. Present only when the finding is skipped. */
  readonly prerequisite?: EnvironmentFindingId;

  // ── ENV-001 facet ──
  readonly variablesChecked?: number;
  readonly missing?: readonly string[];
  readonly blank?: readonly string[];
  readonly rejected?: readonly string[];
  readonly unverifiable?: readonly string[];

  // ── ENV-002 facet ──
  readonly fields?: readonly string[];
  readonly kinds?: readonly string[];
}

/**
 * Names of every field the model owns.
 *
 * Exported so documentation and any future schema generation are derived from
 * the code rather than retyped beside it. A contract test asserts this list
 * matches `EnvironmentEvidenceModel` in both directions.
 */
export const ENVIRONMENT_EVIDENCE_FIELDS = Object.freeze([
  "schemaVersion",
  "findingId",
  "profile",
  "selectionOrigin",
  "configPath",
  "issueCount",
  "variables",
  "paths",
  "prerequisite",
  "variablesChecked",
  "missing",
  "blank",
  "rejected",
  "unverifiable",
  "fields",
  "kinds",
] as const);

// ─── Read-side bounds ────────────────────────────────────────────────────────

/**
 * Caps applied by the parser.
 *
 * Duplicated numerically from the producer's limits on purpose: the producer is
 * allowed to change its bounds, but a *reader* must never be talked into
 * allocating an unbounded array by a file it did not write. If these drift, the
 * parser is simply stricter — which is the safe direction.
 */
const READ_LIMITS = Object.freeze({
  tokenLength: 256,
  listLength: 50,
  minFindingCount: 0,
});

// ─── Parse ───────────────────────────────────────────────────────────────────

/**
 * Validates and narrows evidence read from an untrusted source.
 *
 * Returns `undefined` rather than throwing: a record with unrecognisable evidence should render as
 * "evidence unavailable" in a report, not abort the report. Unknown fields are ignored so a newer writer
 * stays readable here.
 *
 * Two properties of this function are deliberate and worth preserving through future edits:
 *
 *  • **Every field it reads is named once, in one destructuring block.** That is partly what
 *    `noPropertyAccessFromIndexSignature` requires — a dotted read of an index signature is a compile
 *    error — and mostly what makes the parser auditable: the block below is the complete list of things
 *    it will ever look at in an object it did not create.
 *  • **Optional fields are omitted, never set to `undefined`.** `exactOptionalPropertyTypes` distinguishes
 *    the two, and so does the model: an absent facet means "this finding has none", whereas an explicit
 *    `undefined` would suggest a facet that exists and is empty. The conditional spreads below are the
 *    consequence, and they are not noise — they are the type system enforcing a decision the model needs.
 */
export function parseEnvironmentEvidence(
  value: unknown,
): EnvironmentEvidenceModel | undefined {
  if (!isRecord(value)) return undefined;

  const {
    findingId: rawFindingId,
    selectionOrigin: rawSelectionOrigin,
    profile: rawProfile,
    configPath: rawConfigPath,
    issueCount: rawIssueCount,
    variables: rawVariables,
    paths: rawPaths,
    prerequisite: rawPrerequisite,
    variablesChecked: rawVariablesChecked,
    missing: rawMissing,
    blank: rawBlank,
    rejected: rawRejected,
    unverifiable: rawUnverifiable,
    fields: rawFields,
    kinds: rawKinds,
  } = value;

  const findingId = asFindingId(rawFindingId);
  const selectionOrigin = asOrigin(rawSelectionOrigin);

  // The two fields without which nothing else is interpretable. A record missing either is not evidence
  // for an environment finding, and guessing which one it was meant to be would be worse than refusing.
  if (findingId === undefined || selectionOrigin === undefined)
    return undefined;

  const prerequisite = asFindingId(rawPrerequisite);
  const variablesChecked = asOptionalCount(rawVariablesChecked);
  const missing = asOptionalTokenList(rawMissing);
  const blank = asOptionalTokenList(rawBlank);
  const rejected = asOptionalTokenList(rawRejected);
  const unverifiable = asOptionalTokenList(rawUnverifiable);
  const fields = asOptionalTokenList(rawFields);
  const kinds = asOptionalTokenList(rawKinds);

  return Object.freeze({
    // A record written by a newer schema is readable; one written by an older schema without a version is
    // not, which is why the version is mandatory.
    schemaVersion: ENVIRONMENT_EVIDENCE_SCHEMA_VERSION,

    findingId,
    profile: asNullableToken(rawProfile),
    selectionOrigin,
    configPath: asNullableToken(rawConfigPath),

    issueCount: asCount(rawIssueCount),

    variables: asTokenList(rawVariables),
    paths: asTokenList(rawPaths),

    // ── Skip facet ──
    ...(prerequisite === undefined ? {} : { prerequisite }),

    // ── ENV-001 facet ──
    ...(variablesChecked === undefined ? {} : { variablesChecked }),
    ...(missing === undefined ? {} : { missing }),
    ...(blank === undefined ? {} : { blank }),
    ...(rejected === undefined ? {} : { rejected }),
    ...(unverifiable === undefined ? {} : { unverifiable }),

    // ── ENV-002 facet ──
    ...(fields === undefined ? {} : { fields }),
    ...(kinds === undefined ? {} : { kinds }),
  });
}

/**
 * Projects a finding into the persisted model.
 *
 * Structural input (`{ id, evidence }`) rather than a concrete diagnostics type,
 * so this file keeps working if the rule result shape is ever generalised — and
 * so it can be used by an exporter that only knows it is holding a finding.
 *
 * Writers should produce their evidence with
 * `config/environment/diagnostics#buildEnvironmentEvidence` first; this function
 * shapes it for storage and applies the read-side bounds again. Sanitising twice
 * is free, and the second pass is the one that actually protects the file.
 */
export function toEnvironmentEvidenceModel(input: {
  readonly id: string;
  readonly evidence: Readonly<Record<string, unknown>>;
}): EnvironmentEvidenceModel | undefined {
  return parseEnvironmentEvidence({
    ...input.evidence,
    schemaVersion: ENVIRONMENT_EVIDENCE_SCHEMA_VERSION,
    findingId: input.id,
  });
}

/** True when a value is evidence for one of the environment findings. */
export function isEnvironmentEvidence(
  value: unknown,
): value is EnvironmentEvidenceModel {
  return parseEnvironmentEvidence(value) !== undefined;
}

// ─── Narrowing helpers ───────────────────────────────────────────────────────

/**
 * Allowlist for printable tokens — the same rule the producer applies.
 *
 * Kept identical rather than imported so this module stays free of domain
 * imports; a parser that depends on the producer cannot validate output from a
 * *different* producer version, which is the only input that matters here.
 */
const DISALLOWED = /[^A-Za-z0-9._:/\\<>+@=-]/g;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asFindingId(value: unknown): EnvironmentFindingId | undefined {
  return value === "ENV-001" || value === "ENV-002" ? value : undefined;
}

function asOrigin(value: unknown): EnvironmentSelectionOrigin | undefined {
  switch (value) {
    case "explicit-cli":
    case "process-environment":
    case "configuration-default":
    case "none":
      return value;
    default:
      return undefined;
  }
}

/** Token-shaped string, or `null`. Never a coerced value: `123` is not a name. */
function asNullableToken(value: unknown): string | null {
  return typeof value === "string" ? sanitise(value) : null;
}

/** Non-negative integer, or `0`. A negative or fractional count is meaningless. */
function asCount(value: unknown): number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= READ_LIMITS.minFindingCount
    ? value
    : READ_LIMITS.minFindingCount;
}

function asOptionalCount(value: unknown): number | undefined {
  return value === undefined ? undefined : asCount(value);
}

/** Always an array — a malformed list becomes empty rather than `undefined`. */
function asTokenList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return Object.freeze([]);

  const safe = value
    .filter((entry): entry is string => typeof entry === "string")
    .slice(0, READ_LIMITS.listLength)
    .map(sanitise);

  return Object.freeze(safe);
}

/** `undefined` when absent, so "not applicable" stays distinguishable from "empty". */
function asOptionalTokenList(value: unknown): readonly string[] | undefined {
  return value === undefined ? undefined : asTokenList(value);
}

function sanitise(value: string): string {
  return value.replace(DISALLOWED, "?").slice(0, READ_LIMITS.tokenLength);
}
