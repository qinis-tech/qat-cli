/**
 * Unit tests for project-local Cypress resolution.
 *
 * The filesystem and Node's resolver are both injected, so every case here is a map of paths to contents — no
 * `node_modules` tree, no symlinks on disk, no platform assumptions. That matters more than usual for this module: it
 * is the only place that decides whether a resolved package belongs to the project, and a test that needed a real
 * filesystem to prove containment would only ever prove it on one machine.
 *
 * The grouping follows the order of judgement in the implementation, because that order is the behaviour: can it be
 * resolved → is it ours → can it be read → what version does it declare.
 */

import path from "node:path";

import { describe, expect, it } from "vitest";

import type {
  ModulePathResolver,
  ResolutionFileSystem,
  ResolveCypressPackageOptions,
} from "../../../../src/project/cypress-health/resolution.js";
import {
  createNodeCypressResolver,
  isWithin,
  resolveCypressPackage,
} from "../../../../src/project/cypress-health/resolution.js";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const PROJECT_ROOT = path.resolve("/work/project");
const PROJECT_MANIFEST = path.join(PROJECT_ROOT, "package.json");
const PACKAGE_DIR = path.join(PROJECT_ROOT, "node_modules", "cypress");
const PACKAGE_MANIFEST = path.join(PACKAGE_DIR, "package.json");

const ANCESTOR_ROOT = path.dirname(PROJECT_ROOT);
const HOISTED_PACKAGE_DIR = path.join(ANCESTOR_ROOT, "node_modules", "cypress");

const OUTSIDE_PACKAGE_DIR = path.resolve("/elsewhere/cypress");
const QAT_INSTALLATION_ROOT = path.resolve("/usr/local/lib/node_modules/qat");

/** A readable Cypress manifest: the shape every successful case starts from. */
const CYPRESS_MANIFEST = JSON.stringify({
  name: "cypress",
  version: "13.6.0",
  main: "index.js",
  bin: { cypress: "bin/cypress" },
});

/** A promise that rejects with a system-style error, so a fake can refuse without being `async`. */
function rejection(code: string, target: string): Promise<never> {
  const error: NodeJS.ErrnoException = new Error(`${code}: ${target}`);
  error.code = code;

  return Promise.reject(error);
}

interface FakeFileSystem {
  readonly fileSystem: ResolutionFileSystem;
  readonly realpathCalls: string[];
  readonly readFileCalls: readonly { target: string; encoding: string }[];
}

/**
 * A filesystem fake over two maps.
 *
 * The members are deliberately **not** `async`: they contain no `await`, and an `async` function that only returns a
 * value promises work it never performs — the same objection this codebase raises against async ports that do no I/O.
 * Returning an explicit `Promise.resolve` / `Promise.reject` says exactly what happens.
 */
function createFakeFileSystem(
  options: {
    readonly files?: Readonly<Record<string, string>>;
    readonly realpaths?: Readonly<Record<string, string>>;
    readonly missingRealpath?: readonly string[];
  } = {},
): FakeFileSystem {
  const realpathCalls: string[] = [];
  const readFileCalls: { target: string; encoding: string }[] = [];

  return {
    realpathCalls,
    readFileCalls,
    fileSystem: {
      realpath: (target) => {
        realpathCalls.push(target);

        if (options.missingRealpath?.includes(target) === true) {
          return rejection("ENOENT", target);
        }

        return Promise.resolve(options.realpaths?.[target] ?? target);
      },

      readFile: (target, encoding) => {
        readFileCalls.push({ target, encoding });

        const contents = options.files?.[target];

        return contents === undefined
          ? rejection("ENOENT", target)
          : Promise.resolve(contents);
      },
    },
  };
}

interface ResolveOptions {
  readonly projectRoot?: string;
  /**
   * Where the injected resolver says the package directory is.
   *
   * Omitted means "the normal project-local install"; `null` means "the module cannot be found". A nullable value
   * rather than an optional boolean, because "not found" is an answer the resolver gives, not a mode the test is in.
   */
  readonly packageDirectory?: string | null;
  readonly files?: Readonly<Record<string, string>>;
  readonly realpaths?: Readonly<Record<string, string>>;
  readonly missingRealpath?: readonly string[];
  readonly ownInstallationRoot?: string;
}

/**
 * Runs one resolution with a plausible default and returns both the result and what the seams saw.
 *
 * The recorded calls are asserted where they matter and ignored elsewhere, which keeps the behavioural cases readable
 * while still letting "is the anchor right" and "was anything read twice" be answered.
 */
async function resolve(options: ResolveOptions = {}) {
  const packageDirectory =
    options.packageDirectory === undefined
      ? PACKAGE_DIR
      : options.packageDirectory;
  const manifestPath =
    packageDirectory === null
      ? null
      : path.join(packageDirectory, "package.json");

  // Default to a readable manifest at whichever directory the resolver is about to report, so a test that only cares
  // about containment or version does not have to repeat the same JSON.
  const files =
    options.files ??
    (manifestPath === null ? {} : { [manifestPath]: CYPRESS_MANIFEST });

  const { fileSystem, realpathCalls, readFileCalls } = createFakeFileSystem({
    files,
    ...(options.realpaths === undefined
      ? {}
      : { realpaths: options.realpaths }),
    ...(options.missingRealpath === undefined
      ? {}
      : { missingRealpath: options.missingRealpath }),
  });

  const resolverCalls: { anchorFile: string; specifier: string }[] = [];
  const resolveModule: ModulePathResolver = (anchorFile, specifier) => {
    resolverCalls.push({ anchorFile, specifier });

    return manifestPath ?? undefined;
  };

  const result = await resolveCypressPackage({
    projectRoot: options.projectRoot ?? PROJECT_ROOT,
    fileSystem,
    resolveModule,
    ...(options.ownInstallationRoot === undefined
      ? {}
      : { ownInstallationRoot: options.ownInstallationRoot }),
  });

  return { result, realpathCalls, readFileCalls, resolverCalls };
}

/* -------------------------------------------------------------------------- */
/* Resolution                                                                 */
/* -------------------------------------------------------------------------- */

describe("resolveCypressPackage — resolving the project’s own installation", () => {
  it("resolves a project-local package and reports its version", async () => {
    const { result } = await resolve();

    expect(result.outcome).toBe("resolved");
    expect(result.packageDirectory).toBe(PACKAGE_DIR);
    expect(result.version).toBe("13.6.0");
    expect(result.failure).toBeNull();
    expect(result.hoistedFrom).toBeNull();
  });

  it("anchors resolution at the project root’s manifest", async () => {
    // The anchor is the whole safety story: resolving from QAT's own file would find QAT's dependencies and declare
    // every project healthy.
    const { resolverCalls } = await resolve();

    expect(resolverCalls).toStrictEqual([
      { anchorFile: PROJECT_MANIFEST, specifier: "cypress/package.json" },
    ]);
  });

  it("reports the real directory, not the resolved string", async () => {
    // pnpm installs through a symlink; a report that named the link would send a reader to a directory that does not
    // contain what the finding describes.
    const realDirectory = path.join(
      PROJECT_ROOT,
      "node_modules",
      ".pnpm",
      "cypress@13.6.0",
      "node_modules",
      "cypress",
    );

    const { result } = await resolve({
      realpaths: { [PACKAGE_DIR]: realDirectory },
      files: { [path.join(realDirectory, "package.json")]: CYPRESS_MANIFEST },
    });

    expect(result.outcome).toBe("resolved");
    expect(result.packageDirectory).toBe(realDirectory);
  });

  it("normalises a relative project root before anchoring", async () => {
    const { resolverCalls } = await resolve({
      projectRoot: "/work/./project/",
    });

    expect(resolverCalls[0]?.anchorFile).toBe(PROJECT_MANIFEST);
  });
});

/* -------------------------------------------------------------------------- */
/* Containment                                                                */
/* -------------------------------------------------------------------------- */

describe("resolveCypressPackage — containment", () => {
  it("accepts a package hoisted into an ancestor’s node_modules", async () => {
    // Workspace hoisting is legitimate and must not be reported as "Cypress is missing".
    const { result } = await resolve({ packageDirectory: HOISTED_PACKAGE_DIR });

    expect(result.outcome).toBe("resolved");
    expect(result.hoistedFrom).toBe(ANCESTOR_ROOT);
  });

  it("rejects a package that is neither in the project nor on its ancestor chain", async () => {
    const { result } = await resolve({ packageDirectory: OUTSIDE_PACKAGE_DIR });

    expect(result.outcome).toBe("not-installed");
    expect(result.failure).toBe("rejected-outside-project");
    expect(result.packageDirectory).toBeNull();
    expect(result.hoistedFrom).toBeNull();
  });

  it("rejects a package inside QAT’s own installation even on the ancestor chain", async () => {
    // Belt and braces: a project nested inside QAT's directory must never inherit QAT's Cypress. Without the explicit
    // guard the ancestor rule would happily accept it, because it *is* an ancestor's node_modules.
    const nestedProject = path.join(QAT_INSTALLATION_ROOT, "examples", "app");

    const { result } = await resolve({
      projectRoot: nestedProject,
      packageDirectory: path.join(
        QAT_INSTALLATION_ROOT,
        "node_modules",
        "cypress",
      ),
      ownInstallationRoot: QAT_INSTALLATION_ROOT,
    });

    expect(result.outcome).toBe("not-installed");
    expect(result.failure).toBe("rejected-outside-project");
  });

  it("judges containment on the real path, so a symlink cannot escape", async () => {
    // Resolution points inside the project; the link points somewhere else entirely. Judging containment before
    // realpath would make the guard decorative.
    const { result } = await resolve({
      realpaths: { [PACKAGE_DIR]: OUTSIDE_PACKAGE_DIR },
    });

    expect(result.outcome).toBe("not-installed");
    expect(result.failure).toBe("rejected-outside-project");
  });
});

/* -------------------------------------------------------------------------- */
/* Not installed, not usable                                                  */
/* -------------------------------------------------------------------------- */

describe("resolveCypressPackage — nothing usable to resolve to", () => {
  it("reports not-resolvable when the module cannot be found", async () => {
    const { result } = await resolve({ packageDirectory: null });

    expect(result.outcome).toBe("not-installed");
    expect(result.failure).toBe("not-resolvable");
    expect(result.packageDirectory).toBeNull();
  });

  it("reports not-resolvable when the directory vanished after resolution", async () => {
    // A concurrent install, a pruned store or a broken symlink: resolution succeeded on paper, the package is gone.
    const { result } = await resolve({ missingRealpath: [PACKAGE_DIR] });

    expect(result.outcome).toBe("not-installed");
    expect(result.failure).toBe("not-resolvable");
  });

  const unreadableManifests: readonly [string, string][] = [
    ["not JSON at all", '{ "name": "cypress", "version": '],
    ["an array", '["cypress"]'],
    ["the null literal", "null"],
    ["a bare string", '"cypress"'],
    ["a number", "42"],
  ];

  it.each(unreadableManifests)(
    "reports unreadable-package-manifest when the manifest is %s",
    async (_label, contents) => {
      const { result } = await resolve({
        files: { [PACKAGE_MANIFEST]: contents },
      });

      expect(result.outcome).toBe("not-installed");
      expect(result.failure).toBe("unreadable-package-manifest");
      // The directory is still reported: the reader needs to know which installation is damaged in order to remove it.
      expect(result.packageDirectory).toBe(PACKAGE_DIR);
    },
  );

  it("reports unreadable-package-manifest when the manifest cannot be read at all", async () => {
    const { result } = await resolve({ files: {} });

    expect(result.failure).toBe("unreadable-package-manifest");
  });

  it("refuses a manifest larger than the documented cap", async () => {
    // A multi-megabyte "manifest" is a mistake or an attempt to make a health check allocate unbounded memory.
    const { result } = await resolve({
      files: { [PACKAGE_MANIFEST]: "x".repeat(1024 * 1024 + 1) },
    });

    expect(result.outcome).toBe("not-installed");
    expect(result.failure).toBe("unreadable-package-manifest");
  });

  it("never throws, whatever the filesystem does", async () => {
    const throwingFileSystem: ResolutionFileSystem = {
      realpath: () => rejection("EACCES", PACKAGE_DIR),
      readFile: () => rejection("EIO", PACKAGE_MANIFEST),
    };

    await expect(
      resolveCypressPackage({
        projectRoot: PROJECT_ROOT,
        fileSystem: throwingFileSystem,
        resolveModule: () => PACKAGE_MANIFEST,
      }),
    ).resolves.toMatchObject({ outcome: "not-installed" });
  });
});

/* -------------------------------------------------------------------------- */
/* Version                                                                    */
/* -------------------------------------------------------------------------- */

describe("resolveCypressPackage — version extraction", () => {
  const unversionedManifests: readonly [string, Record<string, unknown>][] = [
    ["missing", { name: "cypress" }],
    ["not a string", { name: "cypress", version: 13.6 }],
    ["blank", { name: "cypress", version: "   " }],
    ["null", { name: "cypress", version: null }],
  ];

  it.each(unversionedManifests)(
    "reports a readable package with no version when it is %s",
    async (_label, manifest) => {
      // "Installed but unversioned" is a real state, and reporting it as `version: null` lets the compatibility check
      // say "unknown" instead of inventing `0.0.0` and blaming the user for it.
      const { result } = await resolve({
        files: { [PACKAGE_MANIFEST]: JSON.stringify(manifest) },
      });

      expect(result.outcome).toBe("resolved");
      expect(result.version).toBeNull();
      expect(result.failure).toBeNull();
    },
  );

  it("trims whitespace around a version", async () => {
    const { result } = await resolve({
      files: {
        [PACKAGE_MANIFEST]: JSON.stringify({
          name: "cypress",
          version: " 13.6.0\n",
        }),
      },
    });

    expect(result.version).toBe("13.6.0");
  });

  it.each(["13.6.0+build.7", "14.0.0-rc.1", "11.2.0"])(
    "records %s verbatim",
    async (version) => {
      // Parsing is the version engine's job. A resolver that normalised would be a second opinion about what a version
      // looks like, and the two would eventually disagree about a pre-release suffix.
      const { result } = await resolve({
        files: {
          [PACKAGE_MANIFEST]: JSON.stringify({ name: "cypress", version }),
        },
      });

      expect(result.version).toBe(version);
    },
  );
});

/* -------------------------------------------------------------------------- */
/* Contract                                                                   */
/* -------------------------------------------------------------------------- */

describe("resolveCypressPackage — contract", () => {
  it("returns a frozen result", async () => {
    const { result } = await resolve();

    expect(Object.isFrozen(result)).toBe(true);
  });

  it("does not mutate the options it was given", async () => {
    const { fileSystem } = createFakeFileSystem({
      files: { [PACKAGE_MANIFEST]: CYPRESS_MANIFEST },
    });
    const options: ResolveCypressPackageOptions = Object.freeze({
      projectRoot: PROJECT_ROOT,
      fileSystem,
      resolveModule: () => PACKAGE_MANIFEST,
    });

    await expect(resolveCypressPackage(options)).resolves.toMatchObject({
      outcome: "resolved",
    });
  });

  it("reads only the Cypress manifest, once", async () => {
    const { readFileCalls } = await resolve();

    expect(readFileCalls).toStrictEqual([
      { target: PACKAGE_MANIFEST, encoding: "utf8" },
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* isWithin                                                                   */
/* -------------------------------------------------------------------------- */

describe("isWithin", () => {
  const APP = path.resolve("/work/app");

  it("treats a path as within itself", () => {
    expect(isWithin(APP, APP)).toBe(true);
  });

  it("accepts a descendant", () => {
    expect(isWithin(path.join(APP, "node_modules", "cypress"), APP)).toBe(true);
  });

  it("rejects a sibling that merely shares a prefix", () => {
    // `path.relative` rather than `startsWith`, so `/work/app-evil` is not mistaken for living inside `/work/app`.
    expect(isWithin(path.resolve("/work/app-evil"), APP)).toBe(false);
  });

  it("rejects a parent", () => {
    expect(isWithin(path.resolve("/work"), APP)).toBe(false);
  });

  it("resolves traversal segments before comparing", () => {
    expect(isWithin(path.join(APP, "..", "other"), APP)).toBe(false);
    expect(isWithin(path.join(APP, "node_modules", "..", "cypress"), APP)).toBe(
      true,
    );
  });

  it("compares case-insensitively on Windows and case-sensitively elsewhere", () => {
    // The same directory can arrive spelled two ways through different environment sources on Windows; on POSIX the
    // two spellings are different directories, and pretending otherwise would accept the wrong one.
    const upper = path.resolve("/Work/App/Node_Modules");

    expect(isWithin(upper, APP, "win32")).toBe(true);
    expect(isWithin(upper, APP, "linux")).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Factory                                                                    */
/* -------------------------------------------------------------------------- */

describe("createNodeCypressResolver", () => {
  it("forwards the project root to each call and keeps the injected seams", async () => {
    const calls: string[] = [];
    const projectRoot = path.resolve("/work/other-project");
    const manifest = path.join(
      projectRoot,
      "node_modules",
      "cypress",
      "package.json",
    );

    const resolver = createNodeCypressResolver({
      fileSystem: createFakeFileSystem({
        files: { [manifest]: CYPRESS_MANIFEST },
      }).fileSystem,
      resolveModule: (anchorFile) => {
        calls.push(anchorFile);

        return manifest;
      },
    });

    const result = await resolver.resolve(projectRoot);

    expect(result.outcome).toBe("resolved");
    expect(calls).toStrictEqual([path.join(projectRoot, "package.json")]);
  });

  it("holds no state between two projects", async () => {
    // A memoised resolver would make a report depend on which project was inspected first.
    const secondRoot = path.resolve("/work/second");
    const secondManifest = path.join(
      secondRoot,
      "node_modules",
      "cypress",
      "package.json",
    );

    const resolver = createNodeCypressResolver({
      fileSystem: createFakeFileSystem({
        files: {
          [PACKAGE_MANIFEST]: CYPRESS_MANIFEST,
          [secondManifest]: JSON.stringify({
            name: "cypress",
            version: "12.17.4",
          }),
        },
      }).fileSystem,
      resolveModule: (anchorFile) =>
        anchorFile.startsWith(secondRoot) ? secondManifest : PACKAGE_MANIFEST,
    });

    await expect(resolver.resolve(secondRoot)).resolves.toMatchObject({
      version: "12.17.4",
    });
    await expect(resolver.resolve(PROJECT_ROOT)).resolves.toMatchObject({
      version: "13.6.0",
    });
  });
});
