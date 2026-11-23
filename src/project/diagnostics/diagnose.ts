/**
 * Building a diagnosis from what the engine found.
 *
 * One call to the detection engine, one pass over the codes that apply, one lookup each in the catalogue. No
 * rendering: what a caller does with the findings is the caller's decision, which is what makes the result usable by
 * a report generator as well as by a terminal.
 *
 * ## The one condition detection refuses to classify
 *
 * Detection throws when a manifest cannot be read, on the grounds that a broken file is a fault rather than an
 * answer. A diagnosis exists to report faults, so it catches that single case and carries it as a blocking finding.
 * Everything else propagates, because a permission failure or a failing disk says nothing about the project.
 */
import { basename } from "node:path";

import {
  CompatibilityStatus,
  DetectionStatus,
  DiagnosticCode,
  PackageMetadataStatus,
  type DiagnosticFinding,
  type FrameworkEvidence,
  type ProjectDiagnosis,
  type ProjectIdentity,
} from "../../core/application/diagnostics.js";
import { Framework, InstallationSource } from "../../core/domain/index.js";
import {
  ErrorCode,
  isApplicationError,
  toApplicationError,
  type ApplicationError,
} from "../../core/errors/index.js";
import { toPortableRelativePath } from "../../core/filesystem/index.js";
import { DEFAULT_MAX_PARENT_DEPTH } from "../contracts.js";
import {
  detectCypress,
  DetectionVerdict,
  type CypressDetection,
} from "../cypress-detection/index.js";

import {
  GUIDANCE,
  MINIMUM_CYPRESS_MAJOR,
  majorOf,
  type DiagnosticFacts,
} from "./catalogue.js";

export interface DiagnosticOptions {
  /** How far to climb for a hoisted install. Carried through to the engine unchanged. */
  readonly maxDepth?: number;
}

/**
 * Reports what a directory is, and what is wrong with it, as a value.
 *
 * Never throws for an unfavourable answer: absence, ambiguity, an unusable configuration format and an unreadable
 * manifest all come back as findings. It throws only when something outside the project failed — a permission error,
 * a failing disk — because that is not a statement about the project and this layer has nothing to say about it.
 */
export async function diagnoseProject(
  root: string,
  options: DiagnosticOptions = {},
): Promise<ProjectDiagnosis> {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_PARENT_DEPTH;

  let detection: CypressDetection;

  try {
    detection = await detectCypress(root, { maxDepth });
  } catch (error) {
    return unreadableDiagnosis(root, error);
  }

  const facts = factsOf(detection);

  return {
    identity: identityOf(detection),
    framework: frameworkOf(detection),
    detection: statusOf(detection),
    compatibility: compatibilityOf(detection),
    findings: findingsFor(detection, facts),
  };
}

/**
 * The diagnosis for a project whose metadata cannot be read.
 *
 * The path comes from the thrown error's context rather than being assumed to be `package.json`: the same failure can
 * come from an installed package's manifest, and pointing at the wrong file is worse than pointing at none.
 */
function unreadableDiagnosis(root: string, error: unknown): ProjectDiagnosis {
  // Anything that is not an unreadable manifest is an environment failure, not a condition of the project. Normalised
  // rather than rethrown as-is, so what leaves here is always an application error — the port promises that, and a
  // bare string from a disk library would break the caller's catch.
  if (
    !isApplicationError(error) ||
    error.code !== ErrorCode.filesystemInvalidJson
  ) {
    throw toApplicationError(error);
  }

  const path = relativePathOf(root, error);

  // The catalogue entry for an unreadable manifest reads no facts — detection stopped before it could gather any. The
  // empty shape is passed for the type, not for the content.
  const unreadable = finding(
    DiagnosticCode.ManifestUnreadable,
    emptyFacts(root),
  );

  return {
    identity: {
      root,
      // No readable manifest, so there is no declared name. The directory name is the honest fallback, and the
      // `unreadable` status is what stops a consumer treating it as a declared one.
      name: basename(root),
      packageMetadata: PackageMetadataStatus.Unreadable,
    },
    framework: {
      configurationsFound: [],
      unsupportedConfigurations: [],
      binaryAvailable: undefined,
    },
    // Nothing is identifiable about a project whose description cannot be read, so the status says so rather than
    // saying `not-detected`, which would claim the directory was examined.
    detection: DetectionStatus.Invalid,
    compatibility: CompatibilityStatus.Undetermined,
    findings: [path === undefined ? unreadable : { ...unreadable, path }],
  };
}

/** The failing file, relative to the root, when the error recorded one. */
function relativePathOf(
  root: string,
  error: ApplicationError,
): string | undefined {
  const path = error.context["path"];

  return typeof path === "string"
    ? toPortableRelativePath(root, path)
    : undefined;
}

/**
 * Facts with nothing in them.
 *
 * Only for the unreadable-manifest path, where there is genuinely nothing to describe. Used rather than duplicating
 * the entry's text, so the wording still lives in one place.
 */
function emptyFacts(root: string): DiagnosticFacts {
  return {
    root,
    workspaces: [],
    configurations: [],
    unsupportedConfigurations: [],
    hasCypressDirectory: false,
  };
}

function factsOf(detection: CypressDetection): DiagnosticFacts {
  const { packages, layout } = detection;
  const { declaration, installation } = packages;

  return {
    root: detection.root,
    workspaces: packages.manifest?.workspaces ?? [],
    ...(declaration === undefined ? {} : { declaration }),
    ...(installation === undefined
      ? {}
      : { installationVersion: installation.version }),
    configurations: detection.configurations,
    unsupportedConfigurations: detection.unsupportedConfigurations,
    hasCypressDirectory: layout.hasCypressDirectory,
  };
}

/**
 * The codes that apply, in the order they should be read.
 *
 * Blocking findings first, so the first error is the most fundamental problem rather than whichever check happened to
 * run first, and warnings last, so a reader printing the list meets the reason the command stopped before the remarks
 * about it.
 */
function findingsFor(
  detection: CypressDetection,
  facts: DiagnosticFacts,
): readonly DiagnosticFinding[] {
  const codes: DiagnosticCode[] = [];

  switch (detection.verdict) {
    case DetectionVerdict.Ambiguous:
      codes.push(DiagnosticCode.ConfigurationAmbiguous);
      break;

    case DetectionVerdict.Unsupported:
      codes.push(DiagnosticCode.ConfigurationUnsupported);
      break;

    case DetectionVerdict.Incomplete:
      codes.push(DiagnosticCode.ConfigurationMissing);
      break;

    case DetectionVerdict.Absent:
      codes.push(DiagnosticCode.FrameworkNotDetected);
      break;

    case DetectionVerdict.Detected:
      // Only a project with a configuration can be missing a dependency or hold an incompatible version. Without one,
      // the finding above has already said everything useful, and naming a second consequence would obscure the cause.
      if (detection.packages.installation === undefined) {
        codes.push(DiagnosticCode.DependencyNotInstalled);
      } else if (isIncompatible(detection)) {
        codes.push(DiagnosticCode.VersionIncompatible);
      }
      break;
  }

  const manifest = detection.packages.manifest;

  if (manifest === undefined) {
    codes.push(DiagnosticCode.ManifestMissing);
  } else if (manifest.name === undefined || manifest.version === undefined) {
    codes.push(DiagnosticCode.ManifestIncomplete);
  }

  if (isUndeclaredLocalInstall(detection)) {
    codes.push(DiagnosticCode.DependencyUndeclared);
  }

  return codes.map((code) => finding(code, facts));
}

/**
 * Turns a code into a finding by asking the catalogue.
 *
 * Severity, explanation and remedy all come from one entry, so they cannot disagree with each other — and a finding
 * carries the rendered text, so a consumer needs no access to the catalogue to read it.
 */
function finding(
  code: DiagnosticCode,
  facts: DiagnosticFacts,
): DiagnosticFinding {
  const guidance = GUIDANCE[code];
  const text = guidance.describe(facts);

  return {
    code,
    severity: guidance.severity,
    explanation: text.explanation,
    ...(text.remediation === undefined
      ? {}
      : { remediation: text.remediation }),
    ...(text.path === undefined ? {} : { path: text.path }),
  };
}

/**
 * Whether an installed version cannot read the configuration that is present.
 *
 * Only that comparison. Whether a version at or above the minimum is *supported* needs a policy that does not exist,
 * and claiming otherwise would be a stronger promise than the project can currently keep.
 */
function isIncompatible(detection: CypressDetection): boolean {
  const version = detection.packages.installation?.version;

  if (version === undefined || detection.configurations.length === 0)
    return false;

  const major = majorOf(version);

  return major !== undefined && major < MINIMUM_CYPRESS_MAJOR;
}

/**
 * Whether the framework is installed in the project itself without being declared by it.
 *
 * A hoisted workspace install is the normal shape for a monorepo member and produces no warning — `installation.source`
 * already says what is going on, and warning about the expected case would make the noisiest warning the most common
 * one. An install *inside this project* that the project does not declare is different: somebody put it there by hand,
 * and the next clean install removes it.
 *
 * A project with no manifest at all is excluded: `ManifestMissing` already reports that, and "package.json does not
 * declare it" is a statement about a file that is not there.
 */
function isUndeclaredLocalInstall(detection: CypressDetection): boolean {
  const { declaration, installation, manifest } = detection.packages;

  if (manifest === undefined) return false;

  return (
    declaration === undefined &&
    installation?.source === InstallationSource.Project
  );
}

/**
 * The four-status summary.
 *
 * `incomplete` and `absent` share `not-detected`, because a consumer needs to know what to do next rather than how the
 * engine arrived: both mean there is no configuration to run. Which of the two it was is a diagnostic, and the
 * diagnostics distinguish them.
 */
function statusOf(detection: CypressDetection): DetectionStatus {
  switch (detection.verdict) {
    case DetectionVerdict.Detected:
      return DetectionStatus.Detected;
    case DetectionVerdict.Ambiguous:
      return DetectionStatus.Ambiguous;
    case DetectionVerdict.Unsupported:
      return DetectionStatus.Invalid;
    case DetectionVerdict.Absent:
    case DetectionVerdict.Incomplete:
      return DetectionStatus.NotDetected;
  }
}

function compatibilityOf(detection: CypressDetection): CompatibilityStatus {
  // Nothing to compare: an uninstalled package cannot contradict a format, and without a configuration there is no
  // format in use.
  if (
    detection.packages.installation === undefined ||
    detection.configurations.length === 0
  ) {
    return CompatibilityStatus.Undetermined;
  }

  return isIncompatible(detection)
    ? CompatibilityStatus.Incompatible
    : CompatibilityStatus.Consistent;
}

/**
 * Who the project is.
 *
 * Three states rather than a guess, because the manifest's completeness decides whether the name is declared or
 * assumed — and a consumer printing "project: demo" should be able to tell which of those it is reading.
 */
function identityOf(detection: CypressDetection): ProjectIdentity {
  const manifest = detection.packages.manifest;

  if (manifest === undefined) {
    return {
      root: detection.root,
      name: basename(detection.root),
      packageMetadata: PackageMetadataStatus.Absent,
    };
  }

  if (manifest.name === undefined || manifest.version === undefined) {
    return {
      root: detection.root,
      name: basename(detection.root),
      packageMetadata: PackageMetadataStatus.Incomplete,
    };
  }

  return {
    root: detection.root,
    name: manifest.name,
    packageMetadata: PackageMetadataStatus.Present,
  };
}

/**
 * What was established about the framework.
 *
 * Declaration and installation are mapped independently, so a consumer can tell a hoisted install from a declared one
 * without inferring it from the absence of the other.
 */
function frameworkOf(detection: CypressDetection): FrameworkEvidence {
  const { declaration, installation } = detection.packages;
  const [configuration] = detection.configurations;

  return {
    ...(declaration === undefined ? {} : { declaration }),
    ...(installation === undefined
      ? {}
      : {
          installation: {
            framework: Framework.Cypress,
            version: installation.version,
            source: installation.source,
          },
        }),
    ...(configuration === undefined ? {} : { configuration }),
    configurationsFound: detection.configurations,
    unsupportedConfigurations: detection.unsupportedConfigurations,
    // Passive detection never runs the framework, so nothing has verified this. `undefined` is not `false`: it means
    // nobody looked, and a separate verification operation is what would fill it in.
    binaryAvailable: undefined,
  };
}
