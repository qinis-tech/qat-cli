/**
 * Contracts for the configuration resolution stage.
 *
 * The resolver sits between loading (bytes -> document) and validation
 * (document -> verdict), and does exactly two things: it fills the values a
 * user omitted, and it anchors every path to the project root.
 *
 * Design constraints that shape this file:
 *
 * - No imports. This module is the leaf of the resolver's dependency graph, so
 *   every other module in the stage can depend on it without risking a cycle.
 *   Consequently nothing here may touch the filesystem, the clock, or the
 *   process working directory.
 * - Runtime-checkable invariants, not just compile-time ones. A type-only brand
 *   disappears at runtime; the brand below is a module-private symbol, so a
 *   document can only claim to be "loaded" by passing through {@link markLoaded}.
 * - Data over branching. Path policies and default rules are values, so adding
 *   a field is a table entry rather than a new code path.
 * - Loose about what it receives, strict about what it produces. The incoming
 *   document is described with `unknown` fields, because the resolver never
 *   interprets a value — it only decides whether to fill or anchor it. That
 *   indifference is what lets a fully validated document be accepted without a
 *   cast, whichever way its own module chose to declare it.
 */

/* -------------------------------------------------------------------------- */
/* Paths                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Whether the caller wrote an absolute path or a project-relative one.
 *
 * Kept on the resolved value because the difference is user-visible: a relative
 * path is a promise the configuration makes about portability, and operators
 * asking "why did this write here?" need to see which form they supplied.
 */
export type PathForm = "absolute" | "relative";

/** A configured path after validation and anchoring. */
export interface ResolvedPath {
  /** Exactly what the user or a default supplied; never rewritten, so diagnostics can quote it. */
  readonly source: string;
  /**
   * Normalised absolute path.
   *
   * Anchored to the project root, never to the working directory, so the same
   * configuration resolves identically from a shell, a CI job and an editor.
   */
  readonly absolute: string;
  /** Form of the input, so callers can explain what was accepted. */
  readonly form: PathForm;
  /** True when the anchored path is the project root itself or lives beneath it. */
  readonly withinProjectRoot: boolean;
}

/* -------------------------------------------------------------------------- */
/* Path issues                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Every way a configured path can be rejected.
 *
 * Declared as a runtime tuple so the diagnostics catalogue, the documentation
 * generator and the tests can all iterate the same source of truth; the union
 * type is derived from it so a new code cannot be added without a matching
 * message.
 */
export const PATH_ISSUE_CODES = [
  "PATH_NOT_A_STRING",
  "PATH_EMPTY",
  "PATH_SURROUNDING_WHITESPACE",
  "PATH_NUL_BYTE",
  "PATH_BACKSLASH_SEPARATOR",
  "PATH_HOME_ALIAS",
  "PATH_FILE_URL",
  "PATH_DRIVE_RELATIVE",
  "PATH_TOO_LONG",
  "PATH_OUTSIDE_PROJECT_ROOT",
  "PATH_ABSOLUTE_NOT_PERMITTED",
] as const;

export type PathIssueCode = (typeof PATH_ISSUE_CODES)[number];

/**
 * Severity of a finding.
 *
 * Mirrors the diagnostic severities used across the application. Every rule in
 * this stage is structural today, so all of them block; keeping severity on the
 * value means a future relaxation (a warning for a redundant "../") is a data
 * change rather than a signature change.
 */
export type IssueSeverity = "error" | "warning";

/**
 * A rejected path.
 *
 * Shaped for three audiences at once: the CLI prints {@link PathIssue.message}
 * and {@link PathIssue.hint} verbatim, the diagnostics catalogue keys off
 * {@link PathIssue.code}, and tests assert on structure instead of on prose.
 */
export interface PathIssue {
  readonly code: PathIssueCode;
  readonly severity: IssueSeverity;
  /** Dotted location inside the configuration document, e.g. "reports.directory". */
  readonly field: string;
  /** The offending value as supplied, so the message can echo it back. */
  readonly value: unknown;
  /** The root the value was anchored to; makes the message self-explanatory. */
  readonly projectRoot: string;
  /** One sentence stating the problem, ending in a full stop. */
  readonly message: string;
  /** What to write instead. Omitted only when the correction is self-evident. */
  readonly hint?: string;
}

/* -------------------------------------------------------------------------- */
/* Path policies                                                              */
/* -------------------------------------------------------------------------- */

/**
 * How a single path field is allowed to behave.
 *
 * Policies are data because the rules genuinely differ per field: an output
 * directory belongs to the project and must stay inside it, while a reference
 * to a tool's configuration file may legitimately be written as an absolute
 * path. Encoding that as three booleans at the call site invites drift; naming
 * the policy does not.
 */
export interface PathFieldPolicy {
  /** Accept an input that is already absolute. */
  readonly allowAbsolute: boolean;
  /** Require the anchored result to be the project root or inside it. */
  readonly requireWithinProjectRoot: boolean;
  /** Reject `\` so a shared configuration file stays portable across systems. */
  readonly rejectBackslashes: boolean;
}

/**
 * Output the tool itself creates and owns: reports and captured evidence.
 *
 * Relative-only is deliberate. These paths are reviewed in a diff and travel
 * with a run, so an absolute path here is almost always a typo that would write
 * into someone else's directory.
 */
export const PROJECT_OUTPUT_PATH_POLICY: PathFieldPolicy = Object.freeze({
  allowAbsolute: false,
  requireWithinProjectRoot: true,
  rejectBackslashes: true,
});

/**
 * A path the tool reads inside the project, which the user may spell absolutely.
 *
 * Containment is still required: reading outside the project is a different
 * feature with different review requirements, not an accident to tolerate.
 */
export const PROJECT_INPUT_PATH_POLICY: PathFieldPolicy = Object.freeze({
  allowAbsolute: true,
  requireWithinProjectRoot: true,
  rejectBackslashes: true,
});

/**
 * A read-only reference that may point outside the project root.
 *
 * Provided so that decision, if the product ever makes it, is a one-line change
 * at a call site. Not used by default: enabled carelessly, it would let a
 * configuration file publish paths that tests on another machine cannot reach.
 */
export const EXTERNAL_INPUT_PATH_POLICY: PathFieldPolicy = Object.freeze({
  allowAbsolute: true,
  requireWithinProjectRoot: false,
  rejectBackslashes: true,
});

/* -------------------------------------------------------------------------- */
/* Path resolution                                                            */
/* -------------------------------------------------------------------------- */

/** The subset of `node:path` the resolver needs, so tests can pose as any platform. */
export interface PathTools {
  readonly isAbsolute: (value: string) => boolean;
  readonly normalize: (value: string) => string;
  readonly join: (...parts: string[]) => string;
  readonly relative: (from: string, to: string) => string;
  readonly separator: string;
}

export interface ResolvePathOptions {
  /** Absolute project root, taken from project context rather than the working directory. */
  readonly projectRoot: string;
  /** Dotted field name, carried into every issue for traceability. */
  readonly field: string;
  /** Required: a path rule that is not stated at the call site is a rule nobody can review. */
  readonly policy: PathFieldPolicy;
  /** Platform abstraction; defaults to the host. Injected in tests. */
  readonly pathTools?: PathTools;
}

/** Outcome of anchoring one path. Failure carries the single most actionable reason. */
export type PathResolution =
  | { readonly ok: true; readonly path: ResolvedPath }
  | { readonly ok: false; readonly issue: PathIssue };

/* -------------------------------------------------------------------------- */
/* Configuration defaults                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The documented rule for one optional field.
 *
 * Every optional MVP field appears here exactly once: either it has a default,
 * or it is a value QAT must never invent. A field that is not listed is a field
 * whose behaviour nobody has agreed on, and a test asserts the catalogue and the
 * defaults object stay in step.
 */
export interface DefaultDescriptor {
  /** Dotted field name inside the configuration document. */
  readonly field: string;
  /**
   * - `default`  — the value below is used when the field is omitted.
   * - `derived`  — the value is computed from other fields, never from a constant.
   * - `none`     — no default exists, and supplying one would be actively unsafe.
   */
  readonly rule: "default" | "derived" | "none";
  /** Literal default. Present only when `rule` is `default`. */
  readonly value?: unknown;
  /** Why this default, or why none. Carries the reasoning the table cannot. */
  readonly rationale: string;
}

/* -------------------------------------------------------------------------- */
/* Configuration document                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Makes every field of a described document optional, and explicitly accepts
 * `undefined`.
 *
 * The `| undefined` is not decoration. Under `exactOptionalPropertyTypes` an
 * optional property does not accept an explicit `undefined` value, and a
 * validated document written as `cypress?: CypressSettings | undefined` carries
 * exactly that. Expressing the rule once, in a mapped type, means there is no
 * line to forget when a field is added.
 */
type OptionalFields<TFields> = {
  readonly [TKey in keyof TFields]?: TFields[TKey] | undefined;
};

/**
 * Structural view of the document the resolver accepts.
 *
 * Intentionally narrow and intentionally vague. It names only the fields the
 * resolver may fill or anchor, under the same names the schema uses, and types
 * every value `unknown` because the resolver never reads a value — it only asks
 * "was this supplied?" and "is this a path I can place?".
 *
 * Both choices are load-bearing:
 *
 * - `unknown` values, not the schema's own types, so a malformed file reaches
 *   validation with its original content intact. `"output": "reports"` and
 *   `"reports": 42` must survive this stage rather than be replaced by something
 *   plausible; the complaint about them belongs to validation.
 * - A structural type with optional properties and no index signature, so any
 *   validated document is assignable here. An index signature would have rejected
 *   a document declared as an `interface`, which is how the schema module declares
 *   its own.
 *
 * Unknown top-level keys are still permitted at runtime: the merge spreads the
 * document, so a field nobody recognises survives this stage and is rejected by
 * the schema layer with a message that names it.
 *
 * Nothing may be listed here that the schema does not define. A tolerant view that
 * names an invented field is worse than no view at all: defaults would introduce
 * that field into every document, and validation would then reject every project
 * for a field the user never wrote.
 */
export type DefaultableConfiguration = OptionalFields<{
  readonly version: unknown;
  readonly framework: unknown;
  /** Which declared environment to use; derived when omitted, never guessed. */
  readonly defaultEnvironment: unknown;
  readonly environments: unknown;
  /** Where output goes. Two paths, both project-relative. */
  readonly output: OptionalFields<{
    readonly reports: unknown;
    readonly evidence: unknown;
  }>;
  readonly cypress: OptionalFields<{
    readonly configFile: unknown;
  }>;
}>;

/* -------------------------------------------------------------------------- */
/* Loaded (branded) document                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Module-private brand.
 *
 * A type-only brand is erased at runtime, so a cast or a loosely typed caller
 * could hand the resolver a failed load result and have plausible defaults
 * paper over a parse error, a missing file or an unsupported schema version.
 * Because this symbol is never exported, {@link markLoaded} is the only way to
 * produce a value that satisfies {@link isLoadedDocument}.
 */
const LOADED_DOCUMENT_BRAND = Symbol("qat.configuration.loaded");

/**
 * A configuration document that came out of a successful load.
 *
 * Holding one of these is the precondition for defaulting: defaults apply to
 * fields a user omitted, never to a file the tool could not read.
 *
 * Generic over the document so the validated type survives the hand-off. The
 * loader stamps its own validated type, consumers that only need to default see
 * the tolerant view through the default parameter, and neither needs a cast in
 * between — the property is `readonly`, so the wrapper is covariantly assignable.
 */
export interface LoadedConfigurationDocument<
  TDocument extends DefaultableConfiguration = DefaultableConfiguration,
> {
  readonly document: TDocument;
  /** Absolute path of the file the document came from, for diagnostics. */
  readonly source: string;
  /** Present at runtime so the invariant is checkable, not merely declared. */
  readonly [LOADED_DOCUMENT_BRAND]?: true;
}

/** Raised when defaulting is attempted without a successfully loaded document. */
export class LoadedConfigurationRequiredError extends Error {
  public readonly code = "CONFIGURATION_NOT_LOADED";

  public constructor(detail: string) {
    super(
      `Configuration defaults require a successfully loaded document: ${detail}.` +
        "Fix the reported loading problem instead of substituting defaults.",
    );
    this.name = "LoadedConfigurationRequiredError";
  }
}

/**
 * Brand a successfully loaded document.
 *
 * The brand is defined as a non-enumerable property so it never leaks into
 * logging, JSON output, object spreads or snapshots. Light validation happens
 * here rather than at use sites: catching a bad hand-off at construction gives a
 * far better stack trace than failing later inside path arithmetic.
 *
 * The object is annotated rather than asserted, so the compiler — not a cast —
 * confirms it satisfies the contract. The brand property is optional in the
 * interface precisely so an honest literal can express the expected shape; the
 * narrowing functions still require the marker to be present at runtime.
 *
 * No copy is made: the document is passed through unchanged, and only the claim
 * around it is new. A brand that cloned its input would let a caller keep editing
 * a document the resolver believes it has already accepted.
 */
export function markLoaded<TDocument extends DefaultableConfiguration>(
  document: TDocument,
  source: string,
): LoadedConfigurationDocument<TDocument> {
  if (
    document === null ||
    typeof document !== "object" ||
    Array.isArray(document)
  ) {
    throw new LoadedConfigurationRequiredError(
      "the loaded document is not an object",
    );
  }
  if (typeof source !== "string" || source.length === 0) {
    throw new LoadedConfigurationRequiredError(
      "the source path of the loaded document is empty",
    );
  }

  const branded: LoadedConfigurationDocument<TDocument> = { document, source };
  Object.defineProperty(branded, LOADED_DOCUMENT_BRAND, {
    value: true,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return branded;
}

/**
 * The shape {@link isLoadedDocument} inspects.
 *
 * Named rather than inlined so the one unavoidable assertion in this file is
 * confined to a single statement with a stated purpose: the value is `unknown`
 * and must be probed for a marker that only this module can set.
 */
interface BrandedCandidate {
  readonly [LOADED_DOCUMENT_BRAND]?: unknown;
  readonly source?: unknown;
  readonly document?: unknown;
}

/**
 * Whether a value is a document produced by {@link markLoaded}.
 *
 * Defensive by construction: callers reach this with `unknown`, including
 * primitives, null and objects that merely happen to have `document` and
 * `source` properties.
 */
export function isLoadedDocument(
  value: unknown,
): value is LoadedConfigurationDocument {
  if (value === null || typeof value !== "object") return false;

  const candidate = value as BrandedCandidate;

  return (
    candidate[LOADED_DOCUMENT_BRAND] === true &&
    typeof candidate.source === "string" &&
    candidate.source.length > 0 &&
    candidate.document !== null &&
    typeof candidate.document === "object" &&
    !Array.isArray(candidate.document)
  );
}

/**
 * Narrow a value to a loaded document or fail loudly.
 *
 * Used by the resolver, where continuing with an unloaded document would mean
 * running a test suite against invented values.
 */
export function assertLoadedDocument(
  value: unknown,
): asserts value is LoadedConfigurationDocument {
  if (!isLoadedDocument(value)) {
    throw new LoadedConfigurationRequiredError(
      "the value was not produced by a successful load",
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Resolved configuration                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Which environment a run will use, and how that choice was reached.
 *
 * `origin` is carried because the three cases are operationally different: an
 * operator who never named an environment should be able to see that QAT chose
 * the only one available, rather than assuming it was configured.
 */
export type DefaultEnvironmentResolution =
  | {
      readonly origin: "configured" | "declared" | "sole";
      readonly name: string;
    }
  | {
      readonly origin: "none";
      readonly name?: undefined;
    };

/** Anchored paths for every path-bearing MVP field. */
export interface ResolvedConfigurationPaths {
  readonly reportsDirectory: ResolvedPath;
  readonly evidenceDirectory: ResolvedPath;
  /** Present only when the configuration or project detection supplied one. */
  readonly cypressConfigFile?: ResolvedPath;
}

/** A fully defaulted document with every path anchored. Deeply frozen. */
export interface ResolvedConfiguration {
  /** The defaulted document. Original user values are preserved, never rewritten. */
  readonly document: DefaultableConfiguration;
  readonly paths: ResolvedConfigurationPaths;
  readonly defaultEnvironment: DefaultEnvironmentResolution;
}

/* -------------------------------------------------------------------------- */
/* Resolution entry point                                                     */
/* -------------------------------------------------------------------------- */

export interface ResolveConfigurationInput {
  /**
   * Branded document: proof that loading succeeded.
   *
   * Typed with the default parameter, so any branded document is accepted — the
   * loader's `LoadedConfigurationDocument<QatConfig>` included, with no widening
   * at the call site.
   */
  readonly loaded: LoadedConfigurationDocument;
  /**
   * Absolute project root, taken from project context.
   *
   * Passed explicitly rather than read from the environment so resolution stays
   * a pure function and tests need no directory switch.
   */
  readonly projectRoot: string;
  /** Replacement defaults, for a future CI or monorepo profile. */
  readonly defaults?: Readonly<DefaultableConfiguration>;
}

/**
 * Outcome of resolving a configuration.
 *
 * Findings are returned alongside the result rather than thrown, so the caller
 * can render every problem in one pass. A failure carries no resolved value:
 * a configuration that cannot be anchored must not be used partially.
 */
export type ConfigurationResolution =
  | {
      readonly ok: true;
      readonly resolved: ResolvedConfiguration;
      /** Non-blocking findings. Empty today; the shape leaves room for relaxations. */
      readonly issues: readonly PathIssue[];
    }
  | {
      readonly ok: false;
      readonly issues: readonly PathIssue[];
    };
