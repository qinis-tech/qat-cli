/**
 * The initialisation module's published surface.
 *
 * Three concerns, and each is exported for a different consumer:
 *
 * | Export | Consumer | Why it is public |
 * | --- | --- | --- |
 * | `createInitialisationService` | The composition root | The only place that names an implementation |
 * | `InitialisationDependencies` | The composition root | The four operations the workflow needs, so the assembly can supply them and a test can stub them |
 * | `generateDefaultConfiguration`, `serialiseConfiguration` | Tests, and any future scaffold command | The document a new project receives is a decision worth asserting on directly, not only through a file it produced |
 * | `unusableProjectFindings`, `INSTALLATION_ONLY` | Tests | The policy is small enough to be read in one screen and important enough that each entry is defended by a case |
 *
 * ## What is deliberately withheld
 *
 * The workflow's internal helpers stay private: `describedBy`, which turns a failed load into findings, and the ordering
 * of the nine steps themselves. Both are the implementation's business, and a caller that could reach them would be able
 * to reproduce half the workflow and report a result that never happened.
 *
 * ## Nobody in the CLI imports this file
 *
 * A command talks to `Application.initialisation`, whose type is declared in `core/application/initialisation.ts`. That is
 * the point of the port: this module could be deleted and replaced without a single handler changing, and importing it
 * from `src/cli` would quietly undo that.
 *
 * ## Nothing in the module imports this file
 *
 * A submodule that reached back through `./index.js` would create a cycle through its siblings. Imports run downward:
 * `initialise.ts` imports `generate.ts` and `policy.ts`; neither imports it back.
 */

/* -------------------------------------------------------------------------- */
/* The workflow                                                               */
/* -------------------------------------------------------------------------- */

export {
  createInitialisationService,
  type InitialisationDependencies,
} from "./initialise.js";

/* -------------------------------------------------------------------------- */
/* The generated document                                                     */
/* -------------------------------------------------------------------------- */

export {
  generateDefaultConfiguration,
  serialiseConfiguration,
} from "./generate.js";

/* -------------------------------------------------------------------------- */
/* What stops initialisation                                                  */
/* -------------------------------------------------------------------------- */

export { INSTALLATION_ONLY, unusableProjectFindings } from "./policy.js";
