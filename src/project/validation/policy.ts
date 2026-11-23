/**
 * What versions QAT will drive.
 *
 * ## Two numbers, two questions
 *
 * `minimumSupportedMajor` equals the configuration-format floor today and is **restated rather than
 * imported**. One is a fact about a file format: `cypress.config.*` arrived in Cypress 10, so an installation
 * older than that cannot read the file that identified the project. The other is a decision about what this
 * tool supports. They coincide now and will not stay coincident, and a single constant serving both would make
 * the next change to either look like a change to the other.
 *
 * `knownGoodMaximumMajor` is a warning boundary, not a limit. Above it the tool has not been written against
 * that major, and a warning serves the user better than a refusal — a refusal would turn every new Cypress
 * release into an outage.
 */
export const CYPRESS_VERSION_POLICY = {
  /** Oldest major that will be driven. Below it, validation refuses. */
  minimumSupportedMajor: 10,
  /** Newest major written against. Above it, validation warns and proceeds. */
  knownGoodMaximumMajor: 13,
} as const;
