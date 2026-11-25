/**
 * Locating and reading QAT's own package manifest.
 *
 * Separate from `./version.js` because that module answers "what does this version string mean", and this one answers
 * "which package am I part of". They shared a file only by accident of both containing the word *version*.
 *
 * ## Resolved from this module, never from the working directory
 *
 * `process.cwd()` is the *user's* project: `qat doctor` is expected to be run from inside one. Reading
 * `cwd/package.json` would therefore read a stranger's manifest and treat its `engines.node` as the range QAT
 * supports — so a project declaring `>=22` would make QAT claim to support 22, and a project declaring nothing would
 * make it claim to support nothing. A support policy that changes with the directory it is evaluated in is worse than
 * no policy at all.
 *
 * The URL below is relative to this file, which is why it resolves to the manifest that was installed alongside the
 * code — the same one a package manager read when it decided whether to install us at all.
 *
 * ## Why it does not throw
 *
 * A manifest that cannot be read is reported as *no declaration*, not as a crash. The runtime check turns that into a
 * warning on the one command a user runs when their installation is broken; a crash from that command would be the
 * least helpful possible outcome. Publication is guarded separately — a contract test and the package verification
 * script both fail when `engines.node` is absent — so the defect is caught before release rather than at a prompt.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The slice of the manifest this project reads. Fields nothing consumes are not declared. */
export interface PackageManifest {
  readonly engines?: {
    readonly node?: string;
  };
}

/**
 * This file's manifest, three levels up: `shared/utils/` → package root.
 *
 * The depth is an assumption about the build layout (`src/` and `dist/` both mirroring `shared/utils/`), and it is the
 * only assumption in this module. If the output ever flattens, this resolves one level too high and the contract test
 * — which asserts the read succeeds and that `engines.node` is present — fails immediately rather than silently
 * reporting "no declared range" forever.
 *
 * CommonJS build? Replace `import.meta.url` with `__dirname` and drop the `fileURLToPath` call. One line, same depth.
 */
const MANIFEST_URL = new URL("../../../package.json", import.meta.url);

let manifest: PackageManifest | undefined;
let loaded = false;

/**
 * Returns QAT's own manifest, or `undefined` when it could not be read or could not be understood.
 *
 * Read once and memoised. The manifest of the running installation cannot change while the process lives, and a
 * second read would be a second answer to "which package are we" — the same reasoning that keeps the supported range
 * resolved once at composition.
 */
export function readOwnManifest(): PackageManifest | undefined {
  if (!loaded) {
    loaded = true;
    manifest = loadManifest();
  }

  return manifest;
}

function loadManifest(): PackageManifest | undefined {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(fileURLToPath(MANIFEST_URL), "utf8"),
    );
    return isPackageManifest(parsed) ? parsed : undefined;
  } catch {
    // Missing, unreadable or not JSON. All three mean the same thing to every caller — nothing was declared — and the
    // difference between them is a packaging defect that the release checks report, not something a runtime message
    // should try to explain.
    return undefined;
  }
}

/**
 * Narrows an unknown value to the shape the rest of the project expects.
 *
 * Structural and shallow on purpose: this project reads one field, and validating the whole manifest here would
 * duplicate a schema that npm already owns.
 */
function isPackageManifest(value: unknown): value is PackageManifest {
  if (typeof value !== "object" || value === null) return false;

  const engines = (value as { engines?: unknown }).engines;
  if (engines === undefined) return true;
  if (typeof engines !== "object" || engines === null) return false;

  const node = (engines as { node?: unknown }).node;
  return node === undefined || typeof node === "string";
}
