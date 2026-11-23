/**
 * Public surface of project discovery.
 *
 * No exported singleton and no cached context: a context is a value produced by a call and passed to whatever needs
 * it. A module-level cache would make the result depend on what ran before it, which is the opposite of the
 * determinism this module exists to provide.
 *
 * ## What is exported, and what is not
 *
 * **Lookup tables stay internal.** `SPEC_DIRECTORIES`, `SUPPORT_FILES` and the lockfile order encode *how* a
 * question is answered. Exporting one would make it look like something a caller may depend on, and the first caller
 * to read it would re-implement the scan it drives, with its own idea of the order.
 *
 * **Rule tables are exported.** `LEGACY_CONFIG_FILES` and `DetectionVerdict` describe *what the tool recognises*, not
 * how it looks. A consumer that wants to say "this tool reads `cypress.config.*`" should reach for the list rather
 * than restate it. The distinction is the one worth applying when adding a new constant here.
 *
 * **The contracts are not re-exported.** `ProjectDiagnosis`, `DiagnosticCode`, `DiagnosticSeverity`, the statuses and
 * `hasBlockingErrors` are declared in `core/application/diagnostics.ts`, and a consumer imports them from there.
 * Re-exporting them would give those names a second route, and the second route is the one that goes stale: a command
 * importing `DiagnosticCode` from an implementation barrel appears to depend on the implementation, and breaks the day
 * the contract moves — having looked correct in review.
 *
 * The same rule holds for the domain types these signatures mention. `ProjectInfo` is exported from `core/domain`, and
 * nothing here re-exports it.
 */

/** The shape a caller passes to `discoverProject`. Everything else in `contracts.ts` is internal. */
export type { ProjectDiscoveryOptions } from "./contracts.js";

export { discoverProject } from "./discovery.js";

/**
 * Package metadata, as two independent facts.
 *
 * `readManifest` and `findDeclaration` are exported because they are cheap, pure and independently useful — a
 * diagnostic that only wants to describe a manifest should not have to perform an install lookup to do it.
 * `findInstalledPackage` is not exported: its behaviour is a property of the directory tree rather than of its
 * arguments, so it is exercised through `discoverPackages`, which is the call every consumer actually makes.
 */
export {
  discoverPackages,
  findDeclaration,
  readManifest,
  type InstalledPackage,
  type PackageDiscovery,
  type PackageDiscoveryOptions,
  type ProjectManifest,
} from "./package-discovery/index.js";

/**
 * Configuration discovery and the verdict it produces.
 *
 * `detectCypress` is exported alongside `discoverPackages` because the two are the same kind of thing: an engine that
 * answers one question and returns evidence. A consumer that wants the evidence without the validation on top of it —
 * a future `qat init`, a test of one rule in isolation — asks this rather than reimplementing a scan.
 */
export {
  detectCypress,
  DetectionVerdict,
  LEGACY_CONFIG_FILES,
  type CypressDetection,
  type CypressLayout,
  type DetectedProject,
  type DetectionOptions,
  type UndetectedProject,
} from "./cypress-detection/index.js";

/**
 * The diagnosis, built from the evidence above.
 *
 * `diagnoseProject` is what a command binds to the discovery port. The catalogue and its constant are exported for the
 * same reason the verdict table is: a consumer explaining a code, or saying why a version is incompatible, should
 * reach for one definition rather than restate it.
 */
export {
  diagnoseProject,
  GUIDANCE,
  MINIMUM_CYPRESS_MAJOR,
  type DiagnosticFacts,
  type DiagnosticOptions,
} from "./diagnostics/index.js";

export { resolveWorkingDirectory } from "./working-directory.js";
