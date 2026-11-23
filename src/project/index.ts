/**
 * Public surface of project discovery.
 *
 * No exported singleton and no cached context: a context is a value produced by a call and passed to whatever
 * needs it. A module-level cache would make the result depend on what ran before it, which is the opposite of
 * the determinism this module exists to provide.
 *
 * The surface is deliberately narrow. This is an implementation layer — reached from the composition root and
 * from tests, never from the CLI — so its internal tables stay behind the functions that use them. Exporting
 * `SPEC_DIRECTORIES` or `LOCKFILES` here would make every constant look like something a caller may depend on,
 * and the first caller to read one would re-implement the lookup it encodes, with its own idea of the order.
 */

/** The shape a caller passes to `discoverProject`. Everything else in `contracts.ts` is internal. */
export type { ProjectDiscoveryOptions } from "./contracts.js";

export { discoverProject } from "./discovery.js";

/**
 * Package metadata, as two independent facts.
 *
 * `readManifest` and `findDeclaration` are exported because they are cheap, pure and independently useful —
 * a diagnostic that only wants to describe a manifest should not have to perform an install lookup to do it.
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

export { resolveWorkingDirectory } from "./working-directory.js";
