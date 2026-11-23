/**
 * The requirements, as data.
 *
 * A table rather than a chain of conditions for the same reason commands are data: a list can be enumerated, counted
 * and reported, and "every requirement has a test" becomes a statement about a collection rather than a claim about a
 * function's branches.
 *
 * The first entry is the load-bearing one. It carries forward everything detection already reported, which means a new
 * detection condition gates execution without anyone writing a rule for it — this layer cannot forget to consult a
 * condition it has never heard of.
 *
 * ## Two entries decline to speak
 *
 * A requirement exists to add a condition detection has no opinion about. Where detection already reports the same
 * fact, the requirement returns nothing rather than restating it: one condition, one code, one sentence. That is why
 * the layout requirement checks whether a usable configuration exists before judging the specs, and why the version
 * requirement defers when the configuration format already contradicts the installation.
 *
 * The guard is not defensive coding. Without it the tool says the same thing twice — `QAT-D006` and `QAT-V005` on one
 * project, or a note about spec patterns on a directory that has no Cypress project at all — and a reader who meets a
 * duplicated finding learns to skim the list.
 */
import { CompatibilityStatus } from "../../core/application/diagnostics.js";
import {
  ValidationCode,
  ValidationRequirementId,
  type ValidationRequirementId as RequirementId,
} from "../../core/application/validation.js";
import { majorOf } from "../../shared/utils/version.js";

import type { ValidationRequirement } from "./contracts.js";
import { ConfigurationPlacement, SpecsShape } from "./layout-policy.js";
import { CYPRESS_VERSION_POLICY } from "./policy.js";

/**
 * The table, keyed by identifier so a missing entry does not compile.
 *
 * Typed as a `Record` before being flattened into a list: the keys guarantee every identifier has exactly one
 * requirement, and the list preserves declaration order for a report. With a plain array, a requirement could be
 * deleted and the only symptom would be a check that silently stopped running.
 */
const BY_ID: Readonly<
  Record<RequirementId, Omit<ValidationRequirement, "id">>
> = {
  [ValidationRequirementId.ProjectRecognised]: {
    summary: "Every condition detection reported has been considered",
    // Forwarded, never re-derived and never re-worded: the diagnosis owns the prose for its own codes.
    evaluate: ({ diagnosis }) => ({ findings: diagnosis.findings }),
  },

  [ValidationRequirementId.ConfigurationLocated]: {
    summary: "The configuration sits where Cypress loads it from",
    // Fires only in the two states that mean "no usable configuration at the root", so it needs no guard of its own:
    // the placement classifier has already established that neither a file nor a working layout exists.
    evaluate: ({ layout }) =>
      layout.configuration === ConfigurationPlacement.Misplaced ||
      layout.configuration === ConfigurationPlacement.NameOccupied
        ? { codes: [ValidationCode.ConfigurationMisplaced] }
        : {},
  },

  [ValidationRequirementId.LayoutSupported]: {
    summary: "A spec location exists that QAT can drive",
    evaluate: ({ layout }) => {
      // Only a project with a usable configuration can have a layout problem. Without one, detection has already said
      // why nothing can run — absent, incomplete, ambiguous, or a format it cannot read — and adding "no spec location
      // is recognisable" would describe a custom `specPattern` to somebody who has not written one.
      //
      // The same reasoning as the diagnosis refusing to report a missing dependency for a project it never detected.
      if (layout.configuration !== ConfigurationPlacement.AtRoot) return {};

      return layout.specs === SpecsShape.ComponentOnly ||
        layout.specs === SpecsShape.Unknown
        ? { codes: [ValidationCode.LayoutUnsupported] }
        : {};
    },
  },

  [ValidationRequirementId.VersionSupported]: {
    summary: "The installed major is within the range QAT will drive",
    evaluate: ({ diagnosis }) => {
      const version = diagnosis.framework.installation?.version;

      // No installation is not a version problem — detection already reported the dependency, and reporting it twice in
      // different words is how a reader learns to skim. An unparseable version is not a version problem either: no
      // policy can judge a string that is not a version.
      if (version === undefined) return {};

      // Detection already reports a version that cannot read the configuration format, and its threshold is the floor
      // this policy currently shares. Deferring there keeps one condition on one code, and leaves this requirement
      // responsible for the part of the range above the format floor — the part detection has no opinion about, and the
      // part that starts to matter the day the supported floor moves above it.
      if (diagnosis.compatibility === CompatibilityStatus.Incompatible)
        return {};

      const major = majorOf(version);

      if (major === undefined) return {};
      if (major < CYPRESS_VERSION_POLICY.minimumSupportedMajor) {
        return { codes: [ValidationCode.VersionBelowSupported] };
      }
      if (major > CYPRESS_VERSION_POLICY.knownGoodMaximumMajor) {
        return { codes: [ValidationCode.VersionAboveKnownGood] };
      }

      return {};
    },
  },

  [ValidationRequirementId.BinaryAvailable]: {
    summary: "No verification has found the framework executable unusable",
    evaluate: ({ diagnosis }) =>
      // Only an explicit `false`. `undefined` means nothing has looked, and treating "nobody checked" as "checked and
      // broken" would manufacture a failure out of the absence of evidence.
      //
      // No guard on the configuration, unlike the layout requirement: only a verification can set this field, and a
      // verification runs against a project it has already established is runnable. A guard here would protect against
      // a state the producer cannot reach.
      diagnosis.framework.binaryAvailable === false
        ? { codes: [ValidationCode.BinaryUnavailable] }
        : {},
  },

  [ValidationRequirementId.RootUnambiguous]: {
    summary:
      "The root is a project, not a container that also happens to be one",
    evaluate: ({ diagnosis, layout }) =>
      diagnosis.identity.declaredWorkspaces.length > 0 &&
      layout.configuration === ConfigurationPlacement.AtRoot
        ? { codes: [ValidationCode.RootAmbiguous] }
        : {},
  },
};

/**
 * Every requirement, in declaration order.
 *
 * One cast, and it is where the key type is restored: `Object.entries` types its keys as `string`, so the rows would
 * otherwise be `[string, …]`. The `Record` annotation on `BY_ID` is what makes the cast safe — every key is a member
 * of the union by construction, and a missing member does not compile.
 */
export const REQUIREMENTS: readonly ValidationRequirement[] = (
  Object.entries(BY_ID) as readonly (readonly [
    RequirementId,
    Omit<ValidationRequirement, "id">,
  ])[]
).map(([id, requirement]) => ({ id, ...requirement }));
