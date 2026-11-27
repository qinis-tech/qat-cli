/**
 * The configuration module's entry point.
 *
 * Everything outside `src/config` — the composition root, the CLI, reporting and
 * evidence — imports from here, so this file is a published surface rather than a
 * convenience. Two rules keep it honest.
 *
 * ## Curation happens at the submodule boundary, composition happens here
 *
 * Each submodule already owns an `index.ts` that decides what leaves it: the
 * resolver withholds `freeze.ts` and its shape predicates, validation withholds
 * the advice it gives itself, discovery withholds the filesystem probes. Those
 * decisions were made once, by the people who know what the module looks like
 * inside.
 *
 * Re-listing every name here would duplicate those decisions and go stale the
 * first time a submodule adds a diagnostic or a contract. So this file composes
 * curated surfaces rather than curating again — which is the one place a wildcard
 * export is the right tool, because there is no longer any internal detail left
 * for it to leak.
 *
 * ## The cost of that choice, stated rather than discovered later
 *
 * `export *` from two submodules that publish the same name does **not** raise an
 * error: TypeScript silently drops the ambiguous name, and the omission shows up
 * as "property does not exist" at a call site far from the cause. A guard test
 * pins the published names for exactly that reason — see the note at the bottom of
 * this file.
 *
 * ## Two surfaces are published by name, not by wildcard
 *
 * `inspection` and `diagnostics` are listed explicitly below. Not because they
 * are less curated — they have their own `index.ts` and are just as deliberate —
 * but because their vocabulary deliberately *overlaps in concept* with
 * validation's: both speak of statuses, severities and issues. Naming the exports
 * here forces this file to state which of those the root publishes, instead of
 * letting a wildcard drop one of them silently and leaving a caller to guess.
 *
 * ## Never import this file from inside the module
 *
 * A submodule that reaches back through `../../index.js` creates a cycle through
 * every sibling. Imports run downward only: discovery, loader, validation and the
 * resolver each import what they need from `contracts`, `schema` or a sibling's
 * `contracts` directly.
 */

/* -------------------------------------------------------------------------- */
/* Shared vocabulary                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The file name a project is read from, and the vocabulary shared across the
 * stages. Small by design: anything that only one stage needs belongs in that
 * stage's own contracts.
 */
export * from "./contracts.js";

/* -------------------------------------------------------------------------- */
/* Schema: what a configuration may contain                                   */
/* -------------------------------------------------------------------------- */

/**
 * The rules, and the values of the fields that may be omitted.
 *
 * `output`'s defaults live here because a field's default is part of deciding
 * whether the field may be absent — so the resolution stage documents them but
 * never restates them.
 */
export * from "./schema/index.js";

/* -------------------------------------------------------------------------- */
/* Discovery: where the configuration file is                                 */
/* -------------------------------------------------------------------------- */

/** One name, at the project root, with no ascent into a parent directory. */
export * from "./discovery/index.js";

/* -------------------------------------------------------------------------- */
/* Loading: bytes to an outcome                                               */
/* -------------------------------------------------------------------------- */

/**
 * Six outcomes, none of them an error, and a branded document on the one that
 * succeeded. A caller that switches on the outcome gets exhaustiveness for free.
 */
export * from "./loader/index.js";

/* -------------------------------------------------------------------------- */
/* Validation: a parsed document to a verdict                                 */
/* -------------------------------------------------------------------------- */

/**
 * The diagnostics, the codes that make them traceable, and the two mappers that
 * present findings from other stages in the same shape.
 */
export * from "./validation/index.js";

/* -------------------------------------------------------------------------- */
/* Resolution: omitted values filled, paths anchored                          */
/* -------------------------------------------------------------------------- */

/**
 * The defaulting service, the defaults catalogue, the path policy per field, and
 * the one call that turns a loaded document into a configuration a writer can act
 * on: `resolveConfiguration`.
 */
export * from "./resolver/index.js";

/* -------------------------------------------------------------------------- */
/* Inspection: the pipeline composed into one non-throwing result             */
/* -------------------------------------------------------------------------- */

/**
 * `inspectConfiguration` runs the stages above — locate, load, version gate,
 * validate, resolve — and returns the outcome as one of six states instead of
 * throwing. It exists so that a caller whose job is to *describe* a broken
 * configuration (the doctor) does not have to catch exceptions from a pipeline
 * designed to stop.
 *
 * Published for the same reason the stages are: the `run` preflight and the
 * diagnostics checks must both ask the same question and get the same answer.
 *
 * `ConfigurationLoadFailure` is published with it, and it is the one name here
 * that exists for a *producer* rather than a consumer: the composition root
 * adapts the loader's outcome union into these so the facade can classify a known
 * reason instead of inferring one from an error message. Its two halves travel
 * together — a thrower that throws something the facade does not recognise is
 * worse than no classification at all — which is why it is exported here rather
 * than left reachable only through `./inspect.js`.
 *
 * `ConfigIssue` is deliberately *not* re-exported. A caller that needs the facade's
 * issue shape derives it from `SchemaInvalidConfig["issues"][number]`, which cannot
 * drift from the state that carries it; publishing a permanent name for a shape one
 * adapter reads would be a name maintained for no consumer.
 */
export {
  ConfigurationLoadFailure,
  inspectConfiguration,
  isAbsentConfig,
  isUsableConfig,
  MAX_CONFIG_BYTES,
} from "./inspect.js";

export type {
  ConfigAccessCode,
  ConfigInspection,
  ConfigResolverPort,
  ConfigLocatorPort,
  ConfigLoaderPort,
  ConfigVerifierPort,
  InaccessibleConfig,
  InspectConfigurationDependencies,
  MalformedConfig,
  MissingConfig,
  SchemaInvalidConfig,
  UnsupportedVersionConfig,
  ValidConfig,
} from "./inspect.js";

/* -------------------------------------------------------------------------- */
/* Diagnostics: inspection projected into findings and safe evidence          */
/* -------------------------------------------------------------------------- */

/**
 * `classifyConfiguration` turns an inspection into the two configuration
 * findings, and the evidence builders decide which bytes of it may be printed.
 * Neither validates anything: they read the verdict the pipeline already reached,
 * so the doctor cannot disagree with the command it is diagnosing.
 *
 * The status and severity types are published under `Config`-prefixed names.
 * They are structurally identical to the shared diagnostic contract today, and
 * the prefix makes it obvious at every import site which one a caller took —
 * which is cheaper than discovering the ambiguity when a wildcard silently drops
 * one of them.
 */
export { classifyConfiguration } from "./diagnostics/index.js";

export type {
  ClassifyOptions,
  ConfigGuidancePort,
  GuidanceInput,
} from "./diagnostics/index.js";

/** Read-only policy tables. Coverage tests enumerate these to prove every reason
 * has an owner, a default severity and a next step. */
export {
  CHECK_TITLE,
  DEFAULT_SEVERITY,
  REASON_OWNER,
  REASON_PREREQUISITE,
} from "./diagnostics/index.js";

export type {
  ConfigDiagnostic,
  ConfigDiagnosticIssue,
  ConfigEvidence,
  ConfigEvidenceValue,
  DiagnosticSeverity as ConfigDiagnosticSeverity,
  DiagnosticStatus as ConfigDiagnosticStatus,
  QatConfigCheckId,
  QatConfigReason,
  QatConfigState,
} from "./diagnostics/index.js";

/**
 * Evidence builders. Exported because a future configuration check must reach for
 * these rather than invent its own path handling or its own idea of a safe
 * string. `truncate` is published as `truncateEvidence` so it cannot be confused
 * with a general-purpose string helper.
 */
export {
  buildConfigEvidence,
  MAX_EVIDENCE_STRING,
  summariseValue,
  toProjectRelative,
  toSafeIssue,
  truncate as truncateEvidence,
} from "./diagnostics/index.js";

export type {
  ConfigEvidenceInput,
  SafeDetailKey,
} from "./diagnostics/index.js";

/* -------------------------------------------------------------------------- */
/* Guard                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * `tests/unit/config/index-exports.test.ts` pins the names this file publishes.
 *
 * It exists because the wildcards above fail silently: if two submodules ever
 * publish the same name, TypeScript keeps one, drops the other, and reports the
 * loss at a distant call site. The guard turns that into a failing test that names
 * both modules.
 *
 * When adding a submodule export, add its name to the guard in the same commit.
 * When removing one, the guard fails first — which is the intended order.
 *
 * `ConfigurationLoadFailure` must be added to that pinned list now: it is the only
 * *value* exported by name from `./inspect.js`, so a wildcard collision could
 * remove it without changing any other assertion in the suite.
 */
