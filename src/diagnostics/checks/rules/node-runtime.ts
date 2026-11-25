/**
 * Runtime checks: is this interpreter supported?
 *
 * Two checks, never merged:
 *
 *   runtime.node-version       the runtime QAT itself requires       → blocking
 *   cypress.runtime-supported  an extra runtime bound the project's
 *                              framework release declares            → advisory
 *
 * They are reported separately because they have different owners and different urgency. A single merged line
 * ("unsupported version") tells a reader that something is wrong without telling them whose requirement failed, which
 * turns a two-minute fix into a support conversation.
 *
 * ## These are data, not services
 *
 * A check is a `CheckDefinition`: an identifier, some prose about what it does, the evidence groups it reads, and an
 * `evaluate` that is a pure function of the facts it is handed. No constructor, no injected dependency bag, no clock,
 * no `process`, no manifest read. Everything the comparison needs arrives as evidence, which is what lets the whole
 * boundary matrix — supported, below the floor, above the ceiling, in a gap, pre-release, version unreadable, policy
 * unreadable — be driven from literals in a unit test.
 *
 * ## What this file deliberately does not do
 *
 *   • It states no supported range. `facts.runtime.required.range` is passed through verbatim to the comparison and
 *     quoted verbatim by the guidance entry. A second copy anywhere in this file is a copy that drifts.
 *   • It writes no prose. Every reader-facing sentence comes from `healthFinding`, so one condition cannot acquire two
 *     descriptions, and a phrasing change is a change in one file that is meant to hold phrasing.
 *   • It decides no weight. Severity is declared once, on the definition, rather than chosen at the point of failure.
 *   • It never reports a pass it cannot justify. A version it could not read becomes a `warn`, because "I could not
 *     check" and "I checked and it is fine" are not the same answer.
 *
 * ## Two imports, two layers
 *
 * Identity and weight come from the application vocabulary (`CheckId`, `CheckCategory`, `CheckSeverity`, `HealthCode`);
 * the shape of a definition and the shape of a verdict come from this layer's own `contracts.ts`. Reaching across that
 * line is how a rule ends up inventing an identifier the catalogue has never heard of.
 */
import {
  CheckCategory,
  CheckId,
  CheckSeverity,
  HealthCode,
} from "../../../core/application/checks.js";
import {
  evaluateRequirement,
  type CompatibilityVerdict,
  type RuntimeRequirement,
  type RuntimeRequirementSource,
  type UnsatisfiedSeverity,
} from "../../../core/compatibility/index.js";
import {
  FactGroup,
  PASS,
  present,
  requireFact,
  type CheckDefinition,
  type CheckFacts,
  type CheckVerdict,
  type RuntimeRequirementFact,
} from "../contracts.js";
import { healthFinding } from "../guidance.js";

/* -------------------------------------------------------------------------- */
/* Identity                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The identifiers these definitions claim.
 *
 * Taken from the `CheckId` object rather than written as literals: an identifier is permanent, it is quoted in
 * documentation and in bug reports, and it is the mandatory prefix of every scenario that verifies the check. A
 * literal copy here would compile even when it named a check that no longer exists — which is exactly what happened
 * when these were spelled `"node-runtime"` and `"framework-runtime"`: neither is a member of the union, and the
 * catalogue had never heard of them.
 */
const NODE_RUNTIME = CheckId.NodeVersion;
const FRAMEWORK_RUNTIME = CheckId.CypressRuntimeSupported;

/* -------------------------------------------------------------------------- */
/* Translation                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Turns a gathered requirement into the shape the comparison expects.
 *
 * The two vocabularies differ in one field, and this is where the difference is settled. Core's requirement carries
 * the approved consequence of failing it; this layer declares that consequence once, on the definition. Translating
 * here — rather than inventing a severity at the call site — keeps the two in step: change a check's declared weight
 * and the requirement it builds changes with it, instead of a detail somewhere disagreeing with the catalogue.
 *
 * A check declared `error` blocks; anything else is advisory. There is no third option because the comparison has no
 * third answer, and an "informational failure" would be neither reported nor blocking, which is the worst of both.
 */
function requirementFrom(
  fact: RuntimeRequirementFact,
  source: RuntimeRequirementSource,
  severity: CheckSeverity,
): RuntimeRequirement {
  const unsatisfied: UnsatisfiedSeverity =
    severity === CheckSeverity.Error ? "error" : "warning";

  return {
    source,
    range: fact.range,
    origin: fact.origin,
    severityWhenUnsatisfied: unsatisfied,
  };
}

/**
 * Compatibility verdict → check verdict.
 *
 * The single translation point between the two outcome vocabularies, shared by both checks so they cannot disagree
 * about what a mismatch means. Exhaustive by construction: no `default`, so a new compatibility status fails to
 * compile here rather than silently falling into whichever branch was written last.
 *
 * ## Three outcomes, three reasons
 *
 * - `satisfied` → nothing to report.
 * - `unsatisfied` → a **mismatch that was measured**. It becomes `fail` only for an `error`-severity check, because
 *   `CheckStatus.Failed` is reserved for those and the catalogue test holds every entry to that invariant. An advisory
 *   mismatch is a `warn`: a real finding that must not refuse a run.
 * - `indeterminate` → the question could not be answered. Always `warn`, never `pass` (silence must not read as
 *   consent) and never `fail` (an unanswered question must not block work we can still perform).
 */
function toVerdict(
  verdict: CompatibilityVerdict,
  facts: CheckFacts,
  severity: CheckSeverity,
  codes: { readonly unsupported: HealthCode; readonly unknown: HealthCode },
): CheckVerdict {
  switch (verdict.status) {
    case "satisfied":
      return PASS;

    case "unsatisfied":
      return {
        verdict: severity === CheckSeverity.Error ? "fail" : "warn",
        finding: healthFinding(codes.unsupported, facts),
      };

    case "indeterminate":
      return { verdict: "warn", finding: healthFinding(codes.unknown, facts) };
  }
}

/* -------------------------------------------------------------------------- */
/* QAT's own runtime requirement                                              */
/* -------------------------------------------------------------------------- */

/**
 * Is the running Node.js release one QAT supports?
 *
 * First in the catalogue, because nothing else QAT reports can be trusted on a runtime it was never tested against —
 * and because it is the one finding a reader can act on before they read another line.
 */
export const nodeRuntimeCheck: CheckDefinition = {
  id: NODE_RUNTIME,
  category: CheckCategory.Runtime,
  title: "Supported Node.js version",
  purpose:
    "Prevent QAT from reporting on a runtime it has not been tested against.",
  procedure:
    "Compares the running Node.js version with the range QAT declares in its own package manifest.",

  // Only the runtime group. The requirement lives inside it rather than in a group of its own because the version and
  // the range are answered by the same question — "what is the runtime situation here?" — and no other check will ever
  // read the second half of it.
  requires: [FactGroup.Runtime],

  severity: CheckSeverity.Error,

  /**
   * Prefixed by the check's own identifier, joined with a **dot**.
   *
   * The separator is not cosmetic. Three artefacts have to agree on it — this list, the fixture keys in the behaviour
   * suite, and the scenario table in the architecture note — and a colon here compiles, reads correctly in isolation,
   * and fails only when another file joins the identifier and the case name. The prefix is built from the identifier
   * rather than typed out, so a renamed check cannot leave a scenario list claiming to belong to a check that is gone.
   */
  scenarios: [
    `${NODE_RUNTIME}.supported`,
    `${NODE_RUNTIME}.below-floor`,
    `${NODE_RUNTIME}.above-ceiling`,
    `${NODE_RUNTIME}.between-lines`,
    `${NODE_RUNTIME}.pre-release`,
    `${NODE_RUNTIME}.version-unreadable`,
    `${NODE_RUNTIME}.policy-unreadable`,
  ],

  evaluate(facts) {
    // The runner guarantees the group because it is declared in `requires`; `present` turns a disagreement between
    // this file and the runner into a loud defect rather than a finding in a user's terminal.
    const runtime = present(facts.runtime);

    // The group is present, but the *requirement* inside it is what this check exists to compare against. Reading it
    // through `requireFact` means a gatherer that supplies a version and forgets the range gets a sentence naming the
    // omission, instead of `Cannot read properties of undefined` from inside the translation helper.
    const required = requireFact(runtime.required, "RuntimeFacts.required");

    const verdict = evaluateRequirement(
      requirementFrom(required, "qat", CheckSeverity.Error),
      // Passed through as reported. Parsing happens once, inside the comparison, so there is exactly one opinion about
      // what a version is — and `undefined` (the host reported nothing) is a value the comparison already handles.
      runtime.nodeVersion,
    );

    return toVerdict(verdict, facts, CheckSeverity.Error, {
      unsupported: HealthCode.RuntimeUnsupported,
      unknown: HealthCode.RuntimeUnknown,
    });
  },
};

/* -------------------------------------------------------------------------- */
/* The framework's runtime requirement                                        */
/* -------------------------------------------------------------------------- */

/**
 * Does the running Node.js release also satisfy what the project's framework declares?
 *
 * Separate from the check above for one reason: the remedies are different. Moving QAT is our problem; moving the
 * project's framework, or the Node version the project builds against, is the project's. Merging them would name a
 * problem without naming whose it is.
 *
 * No `precondition` on the check above, and that is a decision rather than an omission. A precondition exists so a
 * *consequence* is not reported as a second, separate problem. This is not a consequence — a framework bound can be
 * violated on a runtime QAT supports perfectly well, and suppressing the advisory in that case would hide the only
 * finding the reader needs. Declaration order still puts QAT's requirement first, so a reader meets the blocking
 * problem before the advisory one.
 */
export const frameworkRuntimeCheck: CheckDefinition = {
  id: FRAMEWORK_RUNTIME,
  category: CheckCategory.Runtime,
  title: "Node.js version required by the framework",
  purpose:
    "Surface a runtime mismatch declared by the project's framework release before it fails a test run.",
  procedure:
    "Compares the running Node.js version with the range the project's framework release declares.",
  requires: [FactGroup.Runtime],

  // Advisory: reported clearly, and it does not stop work QAT can still perform. Making it blocking would let a
  // dependency's metadata veto a run over a bound QAT neither controls nor verifies.
  severity: CheckSeverity.Warning,

  // Same separator contract as the check above: `<id>.<case>`, never a colon.
  scenarios: [
    `${FRAMEWORK_RUNTIME}.satisfied`,
    `${FRAMEWORK_RUNTIME}.unsatisfied`,
    `${FRAMEWORK_RUNTIME}.not-declared`,
    `${FRAMEWORK_RUNTIME}.version-unreadable`,
  ],

  evaluate(facts) {
    const runtime = present(facts.runtime);
    const declared = runtime.frameworkRequired;

    // Nothing declared means nothing to violate. Reporting a pass is honest here — the requirement genuinely does not
    // exist — whereas reporting a warning would fabricate an advisory from an absence, which is the failure mode that
    // teaches people to ignore advisories.
    if (declared === undefined) return PASS;

    const verdict = evaluateRequirement(
      // `source` is the requirement's owner, and there are two: QAT and the project's framework. `"framework"` was
      // never a member of that union, so the value would have been accepted by nothing but a wide string in a
      // hand-written type — which is what a literal written at the call site tends to become.
      requirementFrom(declared, "cypress", CheckSeverity.Warning),
      runtime.nodeVersion,
    );

    // One code for both the mismatch and the unreadable case: the advisory's guidance entry already speaks to both,
    // because for this requirement they lead the reader to the same place — check what the framework actually
    // requires. Both land as `warn`, since this check is advisory; the finding's wording distinguishes how much is
    // known, not the verdict.
    return toVerdict(verdict, facts, CheckSeverity.Warning, {
      unsupported: HealthCode.FrameworkRuntimeUnsupported,
      unknown: HealthCode.FrameworkRuntimeUnsupported,
    });
  },
};

/**
 * Both runtime checks, in report order.
 *
 * Exported as a list so the catalogue can spread it rather than naming each definition: adding a third runtime
 * requirement then touches this file only, and the ordering rule — blocking problem first, advisory second — is
 * declared where the checks are, not repeated at the registration site.
 */
export const RUNTIME_CHECKS: readonly CheckDefinition[] = [
  nodeRuntimeCheck,
  frameworkRuntimeCheck,
];
