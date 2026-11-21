#!/usr/bin/env node
/**
 * Copies non-TypeScript assets into dist.
 *
 * The compiler emits JavaScript for .ts files and nothing else. Any runtime
 * asset — workflow templates, JSON schemas — has no counterpart in dist unless
 * it is copied deliberately. Without this step the package builds cleanly,
 * packs cleanly, and fails at runtime the first time a user asks for the
 * missing asset. Nothing in CI would have objected.
 *
 * Assets are listed explicitly rather than globbed: a glob that matches nothing
 * is indistinguishable from a successful build.
 */
import { cp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/** @type {ReadonlyArray<Readonly<{ label: string, source: string, destination: string }>>} */
const ASSETS = [
  {
    label: "CI workflow templates",
    source: "../src/ci/templates",
    destination: "../dist/ci/templates",
  },
];

/** @returns {Promise<void>} */
async function copyAssets() {
  for (const asset of ASSETS) {
    const source = fileURLToPath(new URL(asset.source, import.meta.url));
    const destination = fileURLToPath(
      new URL(asset.destination, import.meta.url),
    );

    // Remove first, so a repeated build cannot retain an asset that was
    // deleted or renamed at its source.
    await rm(destination, { recursive: true, force: true });

    try {
      await cp(source, destination, { recursive: true });
    } catch (error) {
      throw new Error(
        `Failed to copy ${asset.label} from ${asset.source} to ${asset.destination}. ` +
          "If the asset was intentionally removed, delete its entry from ASSETS.",
        { cause: error },
      );
    }

    console.log(
      `copied ${asset.label} → ${asset.destination.replace("../", "")}`,
    );
  }
}

await copyAssets();
