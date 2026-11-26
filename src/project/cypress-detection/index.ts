/**
 * Public surface of Cypress detection.
 *
 * `detectCypress` and the result types are exported. The three steps behind it are not — the existence probes, the
 * layout reader, and the configuration scan. They are the implementation of one question, and a caller reaching for any
 * of them wants a slightly different question answered, which it should ask in its own module.
 *
 * ## Two name lists are the exception, and the exception is the rule
 *
 * `LEGACY_CONFIG_FILES` and `MISPLACED_CONFIG_FILES` are exported, and `findConfigurations` — the function that scans
 * using them — is not. The distinction is the same one the project barrel draws between a lookup and a rule:
 *
 * - A **lookup** encodes *how* a question is answered: an order, a directory listing, a climb. Exporting one invites a
 *   second implementation with its own idea of the order.
 * - A **rule table** encodes *what the tool recognises*: this is a configuration file, that one is unusable, those are
 *   the supported names in the wrong place. A consumer that has to name one of them should read it from here rather than
 *   restate it, and a test that has to prove two lists cannot drift needs both.
 *
 * `MISPLACED_CONFIG_FILES` is additionally exported so the derivation it encodes is testable: it is computed from
 * `CYPRESS_CONFIG_FILES`, and no assertion inside this directory can prove that from the outside.
 *
 * ## What is said below is as deliberate as what is above
 *
 * `CYPRESS_CONFIG_FILES` — the list the two exported tables are built from — stays private. Nothing outside this module
 * has yet needed to know the supported names as a set; consumers need to know *which are legacy* and *which are
 * misplaced*, and those are the questions the exported tables answer. It is exported the day a second consumer needs it,
 * not before: a speculative export is a compatibility obligation nobody asked for.
 *
 * `findConfigurations` stays private for the same reason `detectCypress` exists: scanning is one moment inside one
 * question, and a caller that scans on its own has to re-decide the climb, the order and the exclusions that detection
 * already decided correctly.
 */

// Rule tables — what the tool recognises. Read these instead of restating the names.
export {
  LEGACY_CONFIG_FILES,
  MISPLACED_CONFIG_FILES,
} from "./configuration.js";

// Vocabulary — the result a caller destructures, so the fields are named once, here.
export {
  DetectionVerdict,
  type CypressDetection,
  type CypressLayout,
  type DetectedProject,
  type DetectionOptions,
  type UndetectedProject,
} from "./contracts.js";

// Entry point — the one question, asked once.
export { detectCypress } from "./detect.js";
