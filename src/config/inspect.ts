/**
 * QAT configuration inspection.
 *
 * The single, non-throwing entry point used by diagnostics to describe the
 * state of a project's QAT configuration.
 *
 * Why this file exists
 * ────────────────────
 * The discovery, loader, schema and resolver services already do their jobs
 * well and already carry their own tests. What was missing is one place that
 * composes them *without throwing*, so that "the configuration is broken" can
 * be rendered as a diagnostic instead of terminating the command.
 *
 * Why a discriminated union
 * ─────────────────────────
 * The doctor must distinguish six genuinely different situations. A nullable
 * result or a boolean cannot represent them, and any shape that cannot
 * represent them invites callers to guess which one they are looking at.
 *
 *     missing              → no file at the project root (defaults may apply)
 *     inaccessible         → the file is there and cannot be read
 *     malformed            → the file is not valid JSON
 *     version-unsupported  → the schema version is outside the supported set
 *     schema-invalid       → the schema rejected specific fields
 *     valid                → parsed, version-checked, validated and resolved
 *
 * Guarantees
 * ──────────
 *  • Never throws for an expected configuration condition. A diagnostic that
 *    throws cannot report.
 *  • Reads the configuration at most once.
 *  • Never writes, creates, migrates or repairs anything.
 *  • Never spawns a process and never touches the network.
 *  • Stops at the version gate rather than producing field errors that would
 *    be meaningless against a schema we do not understand.
 *  • Returns frozen data, so no caller can mutate a shared result.
 *
 * What it *does* throw on
 * ───────────────────────
 * A defect in this program. The collaborators below are of three kinds, and the
 * distinction decides how a failure is reported:
 *
 *   • stages that judge project data — validation, resolution — can fail because
 *     of the file, so their failure becomes a state a reader can act on;
 *   • the projection takes the assembly's own function and calls it, so its only
 *     possible failure is a bug, and a bug reported as "the file could not be
 *     read" would name the wrong subject;
 *   • a collaborator that is missing altogether is a wiring fault, and `present`
 *     in the catalogue throws for the same reason.
 *
 * Why the collaborators are generic over the document
 * ──────────────────────────────────────────────────
 * The resolver downstream is branded: it accepts only a document that loading
 * produced and validation accepted, and it checks a marker at runtime to prove
 * it. Erasing that document to `unknown` inside this facade would mean either a
 * cast at the boundary or a re-brand — and re-branding here would make this file
 * a second place able to declare a document loaded, which is exactly what the
 * marker exists to prevent.
 *
 * So the document type is a parameter. The composition root instantiates it with
 * the loader's own output type, and every stage below is handed the real value
 * with its type intact.
 *
 * That parameter is also why `documentOf` exists. A loader may attach provenance
 * to the document — a source path, a marker — and hand back a bundle rather than
 * the document. The gate and the schema want the document, so the projection is a
 * declared dependency instead of an assumption about the loader's shape. Getting
 * it wrong is silent in both directions, which is what makes it worth a member of
 * its own rather than an inline field access.
 *
 * Why only loading returns a promise
 * ──────────────────────────────────
 * Only loading reads a disk. Locating is a name at a known place, projecting is a
 * field read, validating is a pure function of a value, and resolving applies
 * defaults to a value already in hand. Advertising promises for those would force
 * every caller to defend against a failure that cannot occur, and would let a
 * future implementation start doing I/O without anyone noticing the contract
 * change.
 */

/**
 * Upper bound on a configuration file QAT will parse.
 *
 * A configuration file measured in megabytes is a mistake — a committed build
 * artefact, a bundled log — and parsing it wastes the doctor's time budget.
 *
 * The **loader** enforces this: it answers `TooLarge`, and the translation at
 * the composition boundary turns that into the `TOO_LARGE` access code below.
 * The constant is published because two other things quote it — the guidance
 * prose that tells a reader what the limit is, and the test that pins both
 * halves together — and because a limit enforced in one place and described in
 * another must have a single value to disagree about.
 */
export const MAX_CONFIG_BYTES = 1024 * 1024;

/**
 * The field that carries the configuration schema version.
 *
 * `version`, not `schemaVersion`. This string must be the one the schema reads,
 * and the schema reads `version`.
 *
 * That disagreement was a live defect rather than a naming preference: this file
 * looked for a key nobody writes, found nothing, skipped the gate, and let a
 * document from a future schema through to validation. Validation then refused
 * it — so the user still saw a failure — but on the field-error path instead of
 * the upgrade path, and the short-circuit this file promises was quietly broken.
 *
 * Fixing the literal makes the two agree; it does not remove the duplication,
 * which is the actual defect. The durable version is to export the field name
 * from the schema module and import it here. That costs this file its "imports
 * nothing" property and buys one owner for a name that must match.
 */
const SCHEMA_VERSION_KEY = "version";

/* ------------------------------------------------------------------------- *
 * Failure vocabulary
 * ------------------------------------------------------------------------- */

/** Reason a file could not be read. Kept explicit so remediation can be specific. */
export type ConfigAccessCode =
  | "EACCES" // permission denied
  | "EPERM" // operation not permitted (some Windows ACL cases)
  | "EISDIR" // the path is a directory
  | "ENOTDIR" // a path segment is not a directory
  | "ELOOP" // symlink loop
  | "EIO" // an I/O failure
  | "TOO_LARGE" // exceeded MAX_CONFIG_BYTES
  | "AMBIGUOUS" // discovery found more than one candidate
  | "UNKNOWN"; // anything else; never silently swallowed

/**
 * A load that failed, carrying the reason the loader already established.
 *
 * The loader returns a discriminated outcome to its own callers, which is the
 * right contract for something that wants to branch. This facade classifies
 * instead — so the translation at the composition boundary converts each
 * outcome into one of these, and **the reason survives the crossing**. Mapping
 * `Empty` onto a generic read error would throw away the single most useful fact
 * the loader had, and the facade would then have to re-infer it from a message.
 *
 * This type also removes a heuristic: without it, "the file is not JSON" could
 * only be recognised by sniffing `SyntaxError` and parsing a position out of its
 * text. A classified failure is information; a message pattern is a guess.
 */
export class ConfigurationLoadFailure extends Error {
  constructor(
    readonly code:
      | "ENOENT" // not there
      | "EACCES" // permission denied
      | "EPERM" // operation not permitted
      | "EISDIR" // the path is a directory
      | "ENOTDIR" // a path segment is not a directory
      | "ELOOP" // symlink loop
      | "EIO" // I/O failure
      | "EMPTY" // zero bytes, or whitespace only
      | "MALFORMED" // not a JSON document
      | "TOO_LARGE", // exceeded MAX_CONFIG_BYTES
    /** 1-based, when the failure has a position. */
    readonly line?: number,
    /** 1-based, when the failure has a position. */
    readonly column?: number,
  ) {
    super(code);
    this.name = "ConfigurationLoadFailure";
  }
}

/* ------------------------------------------------------------------------- *
 * States
 * ------------------------------------------------------------------------- */

/**
 * A single validation problem, shaped after the schema layer's issue type.
 *
 * Only three facts travel: where, what kind, and a stable explanation. The
 * rejected *value* is deliberately not carried — some of those values are
 * secrets, and evidence shaping is the only place allowed to summarise them.
 */
export interface ConfigIssue {
  /** Field path from the root, e.g. ["reports", "directory"]. Empty at the root. */
  readonly path: readonly (string | number)[];
  /** Stable code from the schema layer, e.g. "invalid_type", "unrecognized_keys". */
  readonly code: string;
  /** Stable, content-free explanation suitable for terminal output. */
  readonly message: string;
}

export interface MissingConfig {
  readonly state: "missing";
  /** Project-relative location that was inspected, for reproducible reporting. */
  readonly searchedAt: string;
}

export interface InaccessibleConfig {
  readonly state: "inaccessible";
  readonly path: string;
  readonly code: ConfigAccessCode;
}

export interface MalformedConfig {
  readonly state: "malformed";
  readonly path: string;
  /** 1-based, when the parser reported a position. */
  readonly line?: number;
  /** 1-based, when the parser reported a position. */
  readonly column?: number;
}

export interface UnsupportedVersionConfig {
  readonly state: "version-unsupported";
  readonly path: string;
  /** Exactly what the file declared — could be a number, a string or absent. */
  readonly declared: unknown;
  readonly supported: readonly number[];
}

export interface SchemaInvalidConfig {
  readonly state: "schema-invalid";
  readonly path: string;
  /** The declared version, or -1 when the file supplied no usable one. */
  readonly version: number;
  /** Sorted by path, so two runs against one file produce identical output. */
  readonly issues: readonly ConfigIssue[];
}

export interface ValidConfig<TConfig> {
  readonly state: "valid";
  readonly path: string;
  readonly version: number;
  /** Resolved and frozen by the resolver; defaults applied to omitted fields only. */
  readonly config: TConfig;
}

export type ConfigInspection<TConfig = unknown> =
  | MissingConfig
  | InaccessibleConfig
  | MalformedConfig
  | UnsupportedVersionConfig
  | SchemaInvalidConfig
  | ValidConfig<TConfig>;

/* ------------------------------------------------------------------------- *
 * Collaborators
 *
 * These are narrow structural descriptions of the existing services. They are
 * declared here rather than imported so this file depends on *shape*, not on
 * import paths: any implementation with these members satisfies them, and the
 * facade stays compilable while those modules evolve internally.
 * ------------------------------------------------------------------------- */

export interface ConfigLocatorPort {
  /**
   * Where the configuration is expected to be, or undefined when the scheme
   * admits no single answer.
   *
   * Synchronous: QAT's configuration has one fixed name at the project root, so
   * locating it is a join rather than a search. A scheme that genuinely had to
   * look would change this signature, and that is the point — the change would
   * be visible rather than hidden behind a promise.
   */
  readonly locate: (
    projectRoot: string,
  ) => { readonly path: string } | undefined;
}

export interface ConfigLoaderPort<TDocument> {
  /**
   * Reads and parses the file.
   *
   * Throws {@link ConfigurationLoadFailure} for every expected failure — absent,
   * unreadable, empty, malformed, oversize — so the facade classifies a known
   * reason instead of inferring one.
   *
   * The envelope is this port's own: `value` is the `TDocument` the caller
   * configured, not necessarily a bare document. Anything the loader attaches to
   * the document lives *inside* `value`, and `documentOf` is how the stages below
   * reach past it.
   */
  readonly load: (path: string) => Promise<{ readonly value: TDocument }>;
}

export interface ConfigVerifierPort<TDocument> {
  /**
   * Validates an already-parsed document and returns schema issues (empty when valid).
   *
   * Takes the *projected* value, which is `unknown` by construction: the facade
   * cannot know what a schema accepts, and the schema is the first thing entitled
   * to narrow it. A verifier declared over a concrete type would be narrower than
   * this contract, and the assembly would not compile — which is the type system
   * refusing to let a producer's shape describe a consumer's input.
   */
  readonly verify: (value: TDocument) => {
    readonly issues: readonly ConfigIssue[];
  };
}

export interface ConfigResolverPort<TDocument, TConfig> {
  /** Applies documented defaults to omitted fields, resolves paths, freezes the result. */
  readonly resolve: (value: TDocument) => TConfig;
}

export interface InspectConfigurationDependencies<TDocument, TConfig> {
  readonly locator: ConfigLocatorPort;
  readonly loader: ConfigLoaderPort<TDocument>;
  /**
   * Projects the loader's output onto the value a schema judges and a version
   * gate reads.
   *
   * It receives `TDocument` — what the loader yielded, already unwrapped from
   * this port suite's own `{ value: TDocument }` envelope — and returns the value
   * the gate and the schema judge. Those are usually the same thing and
   * occasionally are not: a loader that attaches provenance (`{ source,
   * document }`, with a marker proving the document was loaded) yields a bundle,
   * and handing that bundle to the schema reports every required field as
   * missing while handing it to the gate makes the gate find no version and skip
   * itself. Both failures are silent, which is why the projection is a declared
   * dependency rather than an assumption.
   */
  readonly documentOf: (loaded: TDocument) => unknown;
  readonly verifier: ConfigVerifierPort<unknown>;
  readonly resolver: ConfigResolverPort<TDocument, TConfig>;
  /**
   * The schema versions this build reads, owned by the schema layer.
   *
   * A set rather than a single value even though it currently holds one: the
   * version gate exists to answer "may I interpret this document?", and the day
   * a legacy version becomes migratable the answer stops being a single number.
   * Changing an array's contents is not a signature change; changing a number to
   * an array is.
   */
  readonly supportedVersions: readonly number[];
}

/* ------------------------------------------------------------------------- *
 * Inspection
 * ------------------------------------------------------------------------- */

/**
 * Inspects the project's QAT configuration and returns the outcome as data.
 *
 * Order of operations matters and mirrors the order a user needs to fix things:
 *
 *   1. locate        — is there a file at all?
 *   2. load          — can it be read, and is it a JSON document?
 *   3. version gate  — is it a version we are allowed to interpret?
 *   4. verify        — does it match the schema?
 *   5. resolve       — apply defaults to omitted fields and freeze
 *
 * Each step stops the pipeline on failure, so exactly one state is reported and
 * the user is never asked to fix five things at once.
 *
 * @param projectRoot Absolute path to the project being diagnosed.
 * @param deps        Existing configuration services, injected.
 */
export async function inspectConfiguration<TDocument, TConfig>(
  projectRoot: string,
  deps: InspectConfigurationDependencies<TDocument, TConfig>,
): Promise<ConfigInspection<TConfig>> {
  /* ── 1. Locate ─────────────────────────────────────────────────────────── */
  let located: { readonly path: string } | undefined;

  try {
    located = deps.locator.locate(projectRoot);
  } catch (error) {
    // Discovery failing is not "no configuration": it means we could not finish
    // looking, and saying "missing" would be a statement we did not establish.
    return inaccessible(projectRoot, projectRoot, error);
  }

  if (located === undefined) {
    return missing(projectRoot, projectRoot);
  }

  /* ── 2. Load and parse ─────────────────────────────────────────────────── */
  let loaded: { readonly value: TDocument };

  try {
    loaded = await deps.loader.load(located.path);
  } catch (error) {
    // A file deleted between discovery and read is reported as missing, because
    // that is what the user will observe when they look.
    return isMissingFileError(error)
      ? missing(projectRoot, located.path)
      : classifyLoadFailure(projectRoot, located.path, error);
  }

  /* ── 3. Version gate (short-circuit) ────────────────────────────────────── */
  /**
   * Projected once, and used by both the gate and the schema, so the two cannot
   * read different values out of one load.
   *
   * Deliberately **not** wrapped in the `try`/`catch` that guards the two stages
   * below. Those can fail because of the data — a schema can reject a document, a
   * resolver can refuse a path — so "we could not establish anything about this
   * file" is a defensible reading of their failure. This call cannot: it is a pure
   * function of the loader's output, supplied by assembly, so a throw here is a
   * defect in this program and nothing else. Reporting it as `inaccessible` would
   * name the wrong subject — the file was read perfectly well — and would make the
   * defect invisible on the one command whose job is to describe failures.
   *
   * If that reading ever stops holding — a projection that reads the disk, say —
   * the right change is to move this call inside the guarded block *and* to say in
   * the finding that the cause was ours rather than the file's. Adding a `catch`
   * without that second half would be the worse repair.
   */
  const document = deps.documentOf(loaded.value);
  const declaredVersion = readDeclaredVersion(document);

  // A numeric version we do not support is reported on its own, and nothing
  // else: listing field errors against a schema from the future buries the one
  // fact the user can act on.
  if (
    typeof declaredVersion === "number" &&
    !deps.supportedVersions.includes(declaredVersion)
  ) {
    return Object.freeze({
      state: "version-unsupported",
      path: relativeTo(projectRoot, located.path),
      declared: declaredVersion,
      supported: Object.freeze(
        [...deps.supportedVersions].sort((a, b) => a - b),
      ),
    });
  }

  // A missing or non-numeric version is intentionally NOT handled here: it is a
  // field-level type error, and the schema layer words it better than we can.
  //
  // Narrowed once, here, so neither branch below needs a cast: -1 is the "no
  // usable version" marker, and it reaches the caller as such rather than as a
  // version that happens to look real.
  const version = typeof declaredVersion === "number" ? declaredVersion : -1;

  /* ── 4. Schema validation ──────────────────────────────────────────────── */
  let issues: readonly ConfigIssue[];

  try {
    issues = deps.verifier.verify(document).issues;
  } catch (error) {
    // Validation itself failing is an internal problem, not a user problem.
    // Report it as unreadable rather than inventing a field complaint.
    return inaccessible(projectRoot, located.path, error);
  }

  if (issues.length > 0) {
    return Object.freeze({
      state: "schema-invalid",
      path: relativeTo(projectRoot, located.path),
      version,
      issues: Object.freeze(sortIssues(issues)),
    });
  }

  /* ── 5. Defaults and resolution ────────────────────────────────────────── */
  try {
    const config = deps.resolver.resolve(loaded.value);

    return Object.freeze({
      state: "valid",
      path: relativeTo(projectRoot, located.path),
      version,
      // The resolver freezes its own output; freezing the envelope here keeps
      // the whole inspection immutable to callers.
      config,
    });
  } catch (error) {
    // Defaults are applied to *omitted* fields. If resolution fails on a file
    // that parsed and validated, that is an internal inconsistency, and we must
    // not silently substitute defaults for a file that exists.
    return inaccessible(projectRoot, located.path, error);
  }
}

/* ------------------------------------------------------------------------- *
 * Helpers — small, pure, individually testable
 * ------------------------------------------------------------------------- */

/**
 * Reads the declared schema version without validating anything else.
 *
 * Reads `version` — the field the schema itself reads. Kept deliberately dumb:
 * it must work on a value that may be null, an array or a primitive, and it must
 * never throw, because it runs before validation.
 *
 * A non-numeric value comes back as-is rather than being coerced, because the
 * schema is the layer entitled to say "this should be a number" and it words that
 * better than a comparison here could.
 */
function readDeclaredVersion(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  return (value as Record<string, unknown>)[SCHEMA_VERSION_KEY];
}

function missing(projectRoot: string, path: string): MissingConfig {
  return Object.freeze({
    state: "missing",
    searchedAt: relativeTo(projectRoot, path),
  });
}

function malformed(
  projectRoot: string,
  path: string,
  line?: number,
  column?: number,
): MalformedConfig {
  return Object.freeze({
    state: "malformed",
    path: relativeTo(projectRoot, path),
    ...(line === undefined ? {} : { line }),
    ...(column === undefined ? {} : { column }),
  });
}

/**
 * Maps a load failure to a state.
 *
 * The distinction between "not there", "cannot read" and "not a document" is the
 * entire value of this check, so it is spelled out rather than collapsed into a
 * generic failure. A classified failure is read first, because that is the case
 * where the loader told us *why*; the errno and `SyntaxError` branches remain for
 * an implementation that throws in the platform's own vocabulary instead.
 */
function classifyLoadFailure(
  projectRoot: string,
  path: string,
  error: unknown,
): ConfigInspection<never> {
  if (error instanceof ConfigurationLoadFailure) {
    switch (error.code) {
      case "ENOENT":
        return missing(projectRoot, path);

      // An empty file is not a JSON document. Reporting it as malformed keeps the
      // six states honest rather than inventing a seventh for "zero bytes", and
      // the guidance for `malformed` already covers the empty case in words.
      case "EMPTY":
      case "MALFORMED":
        return malformed(projectRoot, path, error.line, error.column);

      case "TOO_LARGE":
        return Object.freeze({
          state: "inaccessible",
          path: relativeTo(projectRoot, path),
          code: "TOO_LARGE" as const,
        });

      default:
        return inaccessible(projectRoot, path, error);
    }
  }

  if (isMissingFileError(error)) return missing(projectRoot, path);
  if (isJsonSyntaxError(error)) {
    const position = positionFromJsonError(error);
    return malformed(projectRoot, path, position?.line, position?.column);
  }

  return inaccessible(projectRoot, path, error);
}

function inaccessible(
  projectRoot: string,
  path: string,
  error: unknown,
): InaccessibleConfig {
  return Object.freeze({
    state: "inaccessible",
    path: relativeTo(projectRoot, path),
    code: accessCodeFor(error),
  });
}

const ACCESS_CODES: ReadonlySet<string> = new Set([
  "EACCES",
  "EPERM",
  "EISDIR",
  "ENOTDIR",
  "ELOOP",
  "EIO",
]);

/** Narrows unknown error values to one of our documented access codes. */
function accessCodeFor(error: unknown): ConfigAccessCode {
  const code = codeOf(error);
  return code !== undefined && ACCESS_CODES.has(code)
    ? (code as ConfigAccessCode)
    : "UNKNOWN";
}

function isMissingFileError(error: unknown): boolean {
  return codeOf(error) === "ENOENT";
}

/**
 * Recognises a JSON parse failure without depending on a specific message.
 * Node's SyntaxError carries a "position N" suffix; that is a stable enough
 * signal, and nothing here reuses the message text itself.
 *
 * Only reached for a loader that throws the platform's own error rather than a
 * {@link ConfigurationLoadFailure} — the classified path above is preferred and
 * is what the composition root supplies.
 */
function isJsonSyntaxError(error: unknown): boolean {
  return error instanceof SyntaxError && codeOf(error) === undefined;
}

/** Converts "… at position 42" into a 1-based line and column. */
function positionFromJsonError(
  error: unknown,
): { line: number; column: number } | undefined {
  const message = error instanceof Error ? error.message : "";
  const match = /position (\d+)/.exec(message);
  if (match === null) return undefined;

  const index = Number(match[1]);
  return Number.isFinite(index) ? { line: 1, column: index + 1 } : undefined;
}

function codeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Makes a path safe to print: relative to the project root so an absolute home
 * directory never lands in a shared CI log.
 *
 * Implemented without path utilities on purpose — this file performs no I/O and
 * imports nothing, so the whole module can be exercised with plain objects.
 */
function relativeTo(projectRoot: string, target: string): string {
  const normalisedRoot = projectRoot.replace(/[\\/]+$/, "");
  if (!target.startsWith(normalisedRoot)) return target;

  const remainder = target.slice(normalisedRoot.length).replace(/^[\\/]+/, "");
  return remainder === "" ? "." : remainder;
}

/** Deterministic ordering so two runs against one file produce identical output. */
function sortIssues(issues: readonly ConfigIssue[]): ConfigIssue[] {
  return [...issues].sort((a, b) =>
    a.path.join(".").localeCompare(b.path.join(".")),
  );
}

/* ------------------------------------------------------------------------- *
 * Convenience guards for callers
 * ------------------------------------------------------------------------- */

/** True only for a fully validated, resolved configuration. */
export function isUsableConfig<TConfig>(
  inspection: ConfigInspection<TConfig>,
): inspection is ValidConfig<TConfig> {
  return inspection.state === "valid";
}

/**
 * True when the configuration is absent, which is a normal condition rather
 * than a fault: callers that can proceed on documented defaults should ask this
 * question instead of treating "missing" as an error.
 */
export function isAbsentConfig(
  inspection: ConfigInspection,
): inspection is MissingConfig {
  return inspection.state === "missing";
}
