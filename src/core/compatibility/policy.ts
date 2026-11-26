/**
 * The single decision point for version compatibility.
 *
 * Every compatibility answer QAT produces — the doctor check, `init`, a future `run` preflight, the package-manager health
 * check — flows through `evaluateVersionRequirement`. There is deliberately no second implementation, because two comparison
 * rules that agree today will disagree after the first policy change, and nobody will notice until a user reports that the
 * doctor and the runner contradict each other.
 *
 * The function is TOTAL and PURE:
 *
 *   • Total — it never throws. Every input, including an empty manifest, a garbled version string or an unreadable policy,
 *     produces a verdict. A command that crashes cannot report the problem it crashed on.
 *   • Pure  — no clock, no filesystem, no environment, no process. The version string and the requirement are the only
 *     inputs, so the entire boundary matrix is testable with literals.
 *
 * Three outcomes, and the third one is not a formality:
 *
 *   satisfied     we read the version and it is inside the supported range
 *   unsatisfied   we read the version and it is outside the supported range
 *   indeterminate we could not answer; reported, never counted as clean
 *
 * Ordering matters and is documented inline at each step: the policy is checked for readability *before* any claim of
 * satisfaction, because "I cannot read the rule" must never resolve to "therefore you pass".
 */

import type {
  CompatibilityVerdict,
  IndeterminateReason,
  IndeterminateVerdict,
  SatisfiedVerdict,
  UnsatisfiedReason,
  UnsatisfiedVerdict,
  VersionRequirement,
} from "./contracts.js";
import {
  classifyDeviation,
  parseRange,
  satisfiesRange,
  type RangeDeviation,
} from "./range.js";
import { parseNodeVersion, type NodeVersion } from "./version.js";

/**
 * Canonical provenance pointer for QAT's own requirement.
 *
 * Exported so tests, documentation and evidence all name the same authority. If this string ever needs to change, it changes
 * in one place.
 */
export const QAT_REQUIREMENT_ORIGIN = "package.json#engines.node";

/**
 * Provenance pointer for a project-level Cypress runtime requirement.
 *
 * Kept separate from QAT's origin so a reader can immediately tell which declaration is being quoted.
 */
export const CYPRESS_REQUIREMENT_ORIGIN = "cypress runtime requirement";

/**
 * Provenance pointers for a package-manager requirement.
 *
 * Two of them because the two authorities are different documents in the same file: an exact pin in `packageManager` and a
 * compatibility range in `engines`. Quoting the wrong one sends the user to edit a field that is not in play.
 */
export const PACKAGE_MANAGER_PIN_ORIGIN = "package.json#packageManager";

export const packageManagerEngineOrigin = (manager: string): string =>
  `package.json#engines.${manager}`;

/**
 * Maps a deviation classification to the reason reported to the user.
 *
 * `satisfies` (rather than a plain annotation) checks two things at once: every deviation kind has an entry, and every entry
 * is a valid `UnsatisfiedReason`. A new deviation kind therefore cannot be added without deciding what a user should be told
 * — and the identity mapping here makes it obvious that the range module and the reporting vocabulary are meant to stay
 * aligned. When they legitimately diverge, this table is the one place to translate.
 */
const DEVIATION_REASON = {
  "below-minimum": "below-minimum",
  "above-maximum": "above-maximum",
  "outside-range": "outside-range",
} as const satisfies Record<RangeDeviation, UnsatisfiedReason>;

/* -------------------------------------------------------------------------- */
/* Evaluation                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Compares one detected version against one requirement.
 *
 * @param requirement the immutable statement of support, produced once by `qatRuntimeRequirement` /
 *   `cypressRuntimeRequirement` / `packageManagerRequirement`
 * @param detectedRaw the version string exactly as reported; parsing is this module's job, not the caller's
 * @returns a frozen verdict. Callers never receive `undefined` or an exception, so no call site needs a fallback that could
 *   disagree with this one.
 */
export function evaluateVersionRequirement(
  requirement: VersionRequirement,
  detectedRaw: string | undefined,
): CompatibilityVerdict {
  // Defensive rather than decorative: the detector is an adapter, and a JS caller or a future non-process implementation
  // could hand us something that is not a string. Reporting "missing" is honest; throwing here would abort the check.
  if (typeof detectedRaw !== "string" || detectedRaw.trim() === "") {
    return indeterminate("runtime-version-missing", requirement, undefined);
  }

  const detected = parseNodeVersion(detectedRaw);
  if (detected === undefined) {
    // A version we cannot parse is not a version we can certify. This is the single most important branch in the file:
    // without it, a mangled value would flow into a comparison and produce an arbitrary answer.
    return indeterminate("runtime-version-unreadable", requirement, undefined);
  }

  const policy = parseRange(requirement.range);
  if (!policy.ok) {
    // Checked BEFORE the satisfaction test. An unreadable range means there is no rule to satisfy, so reporting "supported"
    // would be a fabrication. The same reasoning covers an empty range: the authority declared nothing, and we say so rather
    // than substituting a default.
    return indeterminate("policy-range-unreadable", requirement, detected);
  }

  if (satisfiesRange(policy.expression, detected)) {
    return satisfied(requirement, detected);
  }

  // Pre-releases get their own reason: "you are on an RC" has a different fix from "you are too old", and users cannot act
  // on a generic "not in range". This runs after the satisfaction test because a policy may legitimately name a pre-release
  // it accepts.
  if (detected.prerelease.length > 0) {
    return unsatisfied("pre-release-not-listed", requirement, detected);
  }

  // Zone of the failure, not cause of the failure: this only chooses wording so the remediation can say "too old", "too new"
  // or "this line is not supported". The verdict itself was already decided by `satisfiesRange` above.
  return unsatisfied(
    DEVIATION_REASON[classifyDeviation(policy.expression, detected)],
    requirement,
    detected,
  );
}

/**
 * @deprecated Use {@link evaluateVersionRequirement}.
 *
 * An alias, not a wrapper: both names must resolve to the *same* function, or the "one decision point" invariant quietly
 * becomes two. Kept so the runtime check keeps compiling while the vocabulary widens.
 */
export const evaluateRequirement = evaluateVersionRequirement;

/* -------------------------------------------------------------------------- */
/* Requirement resolution                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Resolves QAT's own supported range from the installed package manifest.
 *
 * The manifest is the ONLY place the range is written. Nothing downstream may restate, default or narrow it: a second copy is
 * a copy that will drift, and the drift surfaces as a support claim nobody tested.
 *
 * `undefined` is a first-class input, not a defensive afterthought. The reader returns it when the manifest is missing or
 * unreadable, and that must produce the same outcome as a manifest that declares no `engines.node`: an empty range, which
 * `evaluateVersionRequirement` reports as an unreadable policy. Degraded but honest — and far better than crashing the one
 * command a user runs *because* their installation is broken. Publication is guarded separately: the contract test and the
 * package verification script both fail when `engines.node` is absent, so the defect is caught before release rather than at
 * a prompt.
 *
 * The parameter is structural so a validated JSON object can be passed directly, and optional so a failed read needs no
 * placeholder object at the call site.
 */
export function qatRuntimeRequirement(
  manifest: { engines?: { node?: string } } | undefined,
): VersionRequirement {
  // One optional chain, because absence of the manifest and absence of the field are the same answer here: nothing was
  // declared. A conditional would have to distinguish two cases that produce identical output.
  const declared = manifest?.engines?.node;

  return Object.freeze({
    source: "qat",
    range: typeof declared === "string" ? declared.trim() : "",
    origin: QAT_REQUIREMENT_ORIGIN,
    // QAT cannot run correctly on an unsupported runtime, so this is blocking when it is reported at all.
    severityWhenUnsatisfied: "error",
  });
}

/**
 * Builds an optional project-level requirement for the runtime the project's Cypress release needs.
 *
 * Returns `undefined` when the project declares nothing — an absence of evidence must not become a fabricated finding. When a
 * declaration exists it is reported as advisory, because a Cypress/Node mismatch is a project decision and QAT should inform
 * rather than block work it can still perform.
 *
 * Resolution of *where* such a declaration comes from (adapter bounds, the installed Cypress manifest, a future capability
 * matrix) happens in the project layer; this function only labels what it is given, which keeps the policy module free of
 * discovery concerns.
 */
export function cypressRuntimeRequirement(
  declared: string | undefined,
): VersionRequirement | undefined {
  if (typeof declared !== "string" || declared.trim() === "") return undefined;

  return Object.freeze({
    source: "cypress",
    range: declared.trim(),
    origin: CYPRESS_REQUIREMENT_ORIGIN,
    // Advisory: reported clearly, but it does not stop QAT from doing its job.
    severityWhenUnsatisfied: "warning",
  });
}

/** Input for the package-manager requirement. */
export interface PackageManagerRequirementInput {
  /**
   * Manager name, used only to label the provenance of the range.
   *
   * Typed as `string`, not as the project layer's manager union, so that this module stays free of any dependency on project
   * vocabulary — the same reason it has no imports from `core/environment` either. The name is not interpreted here; it is
   * printed.
   */
  readonly manager: string;
  /** Exact version pinned in `packageManager`, when the project declares one. */
  readonly declaredVersion?: string;
  /** Compatibility range from `engines.<manager>`, when the project declares one. */
  readonly engineRange?: string;
}

/**
 * Builds the optional requirement for a package-manager executable's version.
 *
 * Precedence is fixed here rather than at the call site: an exact pin is a stricter statement than a range, so it wins when
 * both exist, and the provenance points at the field that actually decided the outcome. Callers keep the losing value in
 * evidence; they must not re-implement this choice, or two checks will quote different authorities for the same project.
 *
 * Advisory (`warning`) because a package-manager mismatch does not prevent QAT from running an already-installed suite — it
 * predicts a confusing install later.
 */
export function packageManagerRequirement(
  input: PackageManagerRequirementInput,
): VersionRequirement | undefined {
  const pinned =
    typeof input.declaredVersion === "string"
      ? input.declaredVersion.trim()
      : "";

  if (pinned !== "") {
    return Object.freeze({
      source: "package-manager",
      range: pinned,
      origin: PACKAGE_MANAGER_PIN_ORIGIN,
      severityWhenUnsatisfied: "warning",
    });
  }

  const range =
    typeof input.engineRange === "string" ? input.engineRange.trim() : "";

  if (range !== "") {
    return Object.freeze({
      source: "package-manager",
      range,
      origin: packageManagerEngineOrigin(input.manager),
      severityWhenUnsatisfied: "warning",
    });
  }

  // Nothing declared: no version comparison is possible, so no requirement is fabricated. The caller reports the absence
  // rather than inventing bounds.
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* Verdict construction                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The three builders below exist so that every verdict is constructed the same way: correct literal types, one `Object.freeze`,
 * no duplication of the `status` / `reason` pairing.
 *
 * The discriminated union in `contracts.ts` is the compile-time guard that a reason belongs to the status it is paired with;
 * `REASON_STATUS` is the runtime guard that aggregation relies on. A unit test asserts the two agree for every verdict this
 * module can produce, which is what stops them drifting apart.
 */

function satisfied(
  requirement: VersionRequirement,
  detected: NodeVersion,
): SatisfiedVerdict {
  return Object.freeze({
    status: "satisfied",
    reason: "within-range",
    requirement,
    detected,
  });
}

function unsatisfied(
  reason: UnsatisfiedReason,
  requirement: VersionRequirement,
  detected: NodeVersion,
): UnsatisfiedVerdict {
  return Object.freeze({
    status: "unsatisfied",
    reason,
    requirement,
    detected,
  });
}

/**
 * Builds an indeterminate verdict, omitting `detected` when there was nothing to report.
 *
 * The conditional spread is load-bearing rather than stylistic. Under `exactOptionalPropertyTypes`, `detected?: NodeVersion`
 * means the property is *absent* — "present and `undefined`" is a different, wider type that the contract deliberately does
 * not accept. Spreading conditionally is what keeps the distinction the field was declared to express: a consumer reading
 * `verdict.detected` still has to handle absence, and no verdict carries a key whose value is a non-answer.
 */
function indeterminate(
  reason: IndeterminateReason,
  requirement: VersionRequirement,
  detected: NodeVersion | undefined,
): IndeterminateVerdict {
  return Object.freeze({
    status: "indeterminate",
    reason,
    requirement,
    ...(detected === undefined ? {} : { detected }),
  });
}
