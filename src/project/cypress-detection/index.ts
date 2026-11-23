/**
 * Public surface of Cypress detection.
 *
 * `detectCypress` and the result types are exported. The three steps behind it are not — the existence probes, the
 * layout reader, and the configuration scan. They are the implementation of one question, and a caller reaching for
 * any of them wants a slightly different question answered, which it should ask in its own module.
 *
 * ## Two name lists are the exception, and the exception is the rule
 *
 * `LEGACY_CONFIG_FILES` and `MISPLACED_CONFIG_FILES` are exported, and `findConfigurations` — the function that
 * scans using them — is not. The distinction is the same one the project barrel draws between a lookup and a rule:
 *
 * - A **lookup** encodes *how* a question is answered: an order, a directory listing, a climb. Exporting one invites
 *   a second implementation with its own idea of the order.
 * - A **rule table** encodes *what the tool recognises*: this is a configuration file, that one is unusable, those are
 *   the supported names in the wrong place. A consumer that has to name one of them should read it from here rather
 *   than restate it, and a test that has to prove two lists cannot drift needs both.
 *
 * `MISPLACED_CONFIG_FILES` is additionally exported so the derivation it encodes is testable: it is computed from
 * `CYPRESS_CONFIG_FILES`, and no assertion inside this directory can prove that from the outside.
 */
export {
  LEGACY_CONFIG_FILES,
  MISPLACED_CONFIG_FILES,
} from "./configuration.js";
export {
  DetectionVerdict,
  type CypressDetection,
  type CypressLayout,
  type DetectedProject,
  type DetectionOptions,
  type UndetectedProject,
} from "./contracts.js";
export { detectCypress } from "./detect.js";
