import {
  PROJECT_INPUT_PATH_POLICY,
  PROJECT_OUTPUT_PATH_POLICY,
  assertLoadedDocument,
  type ConfigurationResolution,
  type DefaultableConfiguration,
  type PathFieldPolicy,
  type PathIssue,
  type ResolvedConfiguration,
  type ResolvedConfigurationPaths,
  type ResolvedPath,
  type ResolveConfigurationInput,
} from "./contracts.js";
import {
  applyDefaults,
  isPlainObject,
  selectDefaultEnvironment,
} from "./defaulting.js";
import { CONFIGURATION_DEFAULTS } from "./defaults.js";
import { deepFreeze } from "./freeze.js";
import {
  assertAbsoluteProjectRoot,
  hostPathTools,
  resolvePath,
} from "./paths.js";

/**
 * Resolution orchestration: one document in, one fully defaulted and fully
 * anchored configuration out.
 *
 * The stages run in this order, and the order carries meaning:
 *
 * 1. **Loaded-document check.** Defaults are applied only to a document that
 *    loaded successfully. A file with a syntax error, a missing file or an
 *    unsupported schema version keeps its own diagnosis instead of acquiring
 *    plausible-looking values that would make the run appear to work.
 * 2. **Defaulting.** Runs *after* the caller has merged environment overrides
 *    into the document, so a default can never outrank a value a human supplied.
 *    The precedence chain stays: environment, then file, then default.
 * 3. **Environment selection.** Derived from what the project declares; never
 *    invented, because guessing a target is the most expensive mistake available.
 * 4. **Path anchoring.** Relative paths join the project root; absolute paths
 *    keep their location but still have to satisfy the policy of their field.
 *
 * The stage touches no filesystem. It names directories; it never creates them.
 * That is what keeps an initialised project containing a configuration file and
 * nothing else, and it is why an operator's `git status` stays clean after a
 * command that never ran.
 *
 * Structurally invalid documents are not this stage's business: validation runs
 * first, so the only documents reaching here have well-formed groups. That is why
 * a missing output path below means a wiring fault rather than a user mistake.
 */

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Whether a finding prevents the configuration from being used at all. */
function isBlocking(issue: PathIssue): boolean {
  return issue.severity === "error";
}

/**
 * Read one child of one settings group.
 *
 * Returns `undefined` for an absent group, for a group that is not a document
 * (a string, a list, a `Map`), and for an absent child. The three cases are
 * deliberately collapsed here: requiredness and group shape are schema questions,
 * answered with a precise message by the validation stage. Reporting
 * "output.reports must be text" when the whole `output` group is a string would
 * point the reader at the wrong line of their file.
 *
 * The group names are the schema's own. A tolerant view that renamed them would
 * anchor a field nobody wrote and leave the field they did write unexplored.
 */
function readChild(
  document: DefaultableConfiguration,
  group: "output" | "cypress",
  child: string,
): unknown {
  const container: unknown = document[group];
  if (!isPlainObject(container)) return undefined;
  return container[child];
}

/* -------------------------------------------------------------------------- */
/* Resolution                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Default and anchor a configuration document.
 *
 * Findings are returned rather than thrown: a file with two bad paths should
 * report both, not the first one the resolver happened to reach. The exception is
 * a broken hand-off — an unloaded document, a relative project root, defaults
 * that omit an output path — which is a programming error and fails loudly.
 */
export function resolveConfiguration(
  input: ResolveConfigurationInput,
): ConfigurationResolution {
  // A cast or a loose `any` upstream cannot smuggle a failed load past this: the
  // brand is checked at runtime, not merely declared in the type system.
  assertLoadedDocument(input.loaded);
  assertAbsoluteProjectRoot(input.projectRoot, hostPathTools);

  const document = applyDefaults(
    input.loaded.document,
    input.defaults ?? CONFIGURATION_DEFAULTS,
  );
  const defaultEnvironment = selectDefaultEnvironment(document);

  const issues: PathIssue[] = [];

  /**
   * Anchor one field and collect the reason if it cannot be.
   *
   * An absent value is not anchored at all, and produces no finding: whether a
   * field is required is decided upstream, with the diagnostic that belongs to
   * that question. Here, absence simply means there is nothing to place.
   */
  const anchor = (
    field: string,
    value: unknown,
    policy: PathFieldPolicy,
  ): ResolvedPath | undefined => {
    if (value === undefined) return undefined;
    const result = resolvePath(value, {
      field,
      projectRoot: input.projectRoot,
      policy,
    });
    if (result.ok) return result.path;
    issues.push(result.issue);
    return undefined;
  };

  // Output paths are relative-only: they belong to the project, travel with a run
  // and are reviewed in a diff, so an absolute path here is almost always a typo
  // aimed at somebody else's directory. A framework configuration file may be
  // written absolutely, but must still live inside the project — reading outside
  // it is a separate feature with its own review, not an accident to tolerate.
  const reportsDirectory = anchor(
    "output.reports",
    readChild(document, "output", "reports"),
    PROJECT_OUTPUT_PATH_POLICY,
  );
  const evidenceDirectory = anchor(
    "output.evidence",
    readChild(document, "output", "evidence"),
    PROJECT_OUTPUT_PATH_POLICY,
  );
  const cypressConfigFile = anchor(
    "cypress.configFile",
    readChild(document, "cypress", "configFile"),
    PROJECT_INPUT_PATH_POLICY,
  );

  if (issues.some(isBlocking)) {
    // No partially resolved configuration is returned. A configuration that cannot
    // be anchored must not be used in part, or a run would write reports to one
    // place and evidence to another with nobody able to say why.
    return { ok: false, issues: Object.freeze(issues) };
  }

  if (reportsDirectory === undefined || evidenceDirectory === undefined) {
    // Validation runs before this stage, so both paths are present unless a caller
    // supplied replacement defaults that omit one — or called this stage on an
    // unvalidated document. Both are wiring faults rather than user errors, and a
    // resolution with nowhere to write is not a state worth returning.
    throw new TypeError(
      "resolveConfiguration requires defaults that provide output.reports and output.evidence, " +
        "and a document that has passed structural validation.",
    );
  }

  const paths: ResolvedConfigurationPaths = {
    reportsDirectory,
    evidenceDirectory,
    // Spread conditionally so an absent optional path stays absent rather than
    // becoming an explicit `undefined`, which strict optional-property settings reject.
    ...(cypressConfigFile === undefined ? {} : { cypressConfigFile }),
  };

  const resolved: ResolvedConfiguration = {
    document,
    paths,
    defaultEnvironment,
  };

  // The document is already frozen by the defaulting service and each path was
  // frozen as it was produced; deepening here seals the wrapper that binds them,
  // so no consumer can swap in a path after validation has approved the set.
  return {
    ok: true,
    resolved: deepFreeze(resolved),
    issues: Object.freeze(issues),
  };
}

/* -------------------------------------------------------------------------- */
/* Output directories                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The directories a writer may need to create before it writes.
 *
 * Returns names rather than creating them, so the decision to touch the disk
 * stays with the operation that has something to write. An initialisation command
 * that pre-created these would leave empty directories in a repository that never
 * ran a suite, and would survive a setup that failed halfway.
 */
export function outputDirectories(
  resolved: ResolvedConfiguration,
): readonly string[] {
  return Object.freeze([
    resolved.paths.reportsDirectory.absolute,
    resolved.paths.evidenceDirectory.absolute,
  ]);
}
