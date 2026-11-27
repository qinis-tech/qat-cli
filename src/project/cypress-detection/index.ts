/**
 * Public surface of Cypress detection.
 *
 * `detectCypress` and the result types are exported. The three steps behind it are
 * not — the existence probes, the layout reader, and the configuration scan. They
 * are the implementation of one question, and a caller reaching for any of them
 * wants a slightly different question answered, which it should ask in its own
 * module.
 *
 * ## Two name lists are the exception, and the exception is the rule
 *
 * `LEGACY_CONFIG_FILES` and `MISPLACED_CONFIG_FILES` are exported, and
 * `findConfigurations` — the function that scans using them — is not. The
 * distinction is the same one the project barrel draws between a lookup and a rule:
 *
 * - A **lookup** encodes *how* a question is answered: an order, a directory
 *   listing, a climb. Exporting one invites a second implementation with its own
 *   idea of the order.
 * - A **rule table** encodes *what the tool recognises*: this is a configuration
 *   file, that one is unusable, those are the supported names in the wrong place. A
 *   consumer that has to name one of them should read it from here rather than
 *   restate it, and a test that has to prove two lists cannot drift needs both.
 *
 * `MISPLACED_CONFIG_FILES` is additionally exported so the derivation it encodes is
 * testable: it is computed from `CYPRESS_CONFIG_FILES`, and no assertion inside this
 * directory can prove that from the outside.
 *
 * ## What is said below is as deliberate as what is above
 *
 * `CYPRESS_CONFIG_FILES` — the list the two exported tables are built from — stays
 * private. Nothing outside this module has yet needed to know the supported names as
 * a set; consumers need to know *which are legacy* and *which are misplaced*, and
 * those are the questions the exported tables answer. It is exported the day a second
 * consumer needs it, not before: a speculative export is a compatibility obligation
 * nobody asked for.
 *
 * `findConfigurations` stays private for the same reason `detectCypress` exists:
 * scanning is one moment inside one question, and a caller that scans on its own has
 * to re-decide the climb, the order and the exclusions that detection already decided
 * correctly.
 *
 * ## Sibling modules may import `contracts.js` directly
 *
 * The barrel is the surface for code *outside* `src/project/**`. A module in the same
 * layer that needs a type — the configuration health checks, for instance — imports
 * `./contracts.js` rather than routing through this file, because a barrel between
 * siblings adds a hop without adding a decision. What the barrel does control is what
 * everything else is allowed to see, and that list is below.
 *
 * ## Finding what you need
 *
 * | Asking | Read |
 * | --- | --- |
 * | "Is this a Cypress project QAT can drive?" | `detectCypress` |
 * | "What can the result be?" | `DetectionVerdict` |
 * | "What does the result carry?" | `CypressDetection`, `DetectionEvidence`, `CypressLayout` |
 * | "I have evidence and no verdict yet" | `DetectionEvidence` |
 * | "Is this filename legacy?" | `LEGACY_CONFIG_FILES` |
 * | "Is this file in the wrong place?" | `MISPLACED_CONFIG_FILES` |
 * | "How deep may the climb go?" | `DetectionOptions` |
 */

// Rule tables — what the tool recognises. Read these instead of restating the names.
export {
  LEGACY_CONFIG_FILES,
  MISPLACED_CONFIG_FILES,
} from "./configuration.js";

// Vocabulary — the result a caller destructures, so the fields are named once, here.
//
// `DetectionEvidence` is exported alongside the two project shapes because it is the
// part of them a consumer can hold on its own: evidence without a classification is a
// legitimate intermediate state for a gatherer that reports what it saw before
// deciding what it means. `DetectionVerdict` is a const object as well as a type, so a
// consumer can switch on members instead of on string literals that drift.
export {
  DetectionVerdict,
  type CypressDetection,
  type CypressLayout,
  type DetectedProject,
  type DetectionEvidence,
  type DetectionOptions,
  type UndetectedProject,
} from "./contracts.js";

// Entry point — the one question, asked once.
export { detectCypress } from "./detect.js";
