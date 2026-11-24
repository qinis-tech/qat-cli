import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CONFIG_FILE_NAME } from "~/config/contracts.js";
import {
  ConfigurationLocation,
  locateConfiguration,
} from "~/config/discovery/index.js";
import {
  isApplicationError,
  type ApplicationError,
} from "~/core/errors/index.js";

/**
 * Fixtures are real temporary trees.
 *
 * Every question here is "what is at this path", which a fake filesystem would answer according to the same assumption
 * the implementation makes — including the wrong one. The distinction this module exists to preserve, between absence and
 * a filesystem that cannot answer, is only observable against a real filesystem.
 */
let created: string[] = [];

async function makeTree(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "qat-config-"));
  created.push(root);

  for (const [path, contents] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  }

  return root;
}

async function failure(run: Promise<unknown>): Promise<ApplicationError> {
  const caught: unknown = await run.then(
    () => undefined,
    (error: unknown) => error,
  );

  if (!isApplicationError(caught)) {
    throw new Error(
      `Expected an application error, received ${String(caught)}.`,
    );
  }

  return caught;
}

async function snapshot(root: string): Promise<readonly string[]> {
  const paths = (await readdir(root, { recursive: true })).sort();

  return Promise.all(
    paths.map(async (path) => {
      const stats = await stat(join(root, path));
      return `${path}|${String(stats.size)}|${String(stats.mtimeMs)}`;
    }),
  );
}

/**
 * Whether this filesystem resolves a name regardless of case.
 *
 * Probed rather than inferred from the platform, because the platform does not decide it: macOS is usually
 * case-insensitive and can be configured not to be, and Windows can be either per directory. A test that assumed one
 * would fail on somebody's machine for a reason unrelated to the code — and, worse, would pass on a machine where the
 * behaviour it claims to check cannot occur.
 */
async function ignoresCase(directory: string): Promise<boolean> {
  try {
    await stat(join(directory, CONFIG_FILE_NAME));
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  await Promise.all(
    created.map((path) => rm(path, { recursive: true, force: true })),
  );
  created = [];
});

describe("a project with a configuration file", () => {
  it("finds it at the root and returns an absolute path", async () => {
    const root = await makeTree({ [CONFIG_FILE_NAME]: "{}" });

    const result = await locateConfiguration(root);

    expect(result).toStrictEqual({
      kind: ConfigurationLocation.Found,
      path: join(root, CONFIG_FILE_NAME),
    });
  });

  it("reports the file without reading it", async () => {
    // Not valid JSON, and discovery says so regardless: locating and understanding are different failures, and a service
    // that opened the file would have to choose which one to report.
    const root = await makeTree({ [CONFIG_FILE_NAME]: '{ "version": ' });

    await expect(locateConfiguration(root)).resolves.toMatchObject({
      kind: ConfigurationLocation.Found,
    });
  });
});

describe("a project without one", () => {
  it("reports absence rather than failing", async () => {
    // The ordinary case for a project that has never configured anything, so it cannot be exceptional.
    const root = await makeTree({ "package.json": "{}" });

    expect(await locateConfiguration(root)).toStrictEqual({
      kind: ConfigurationLocation.Absent,
      root,
    });
  });

  it("reports absence in an empty directory", async () => {
    const root = await makeTree({});

    await expect(locateConfiguration(root)).resolves.toMatchObject({
      kind: ConfigurationLocation.Absent,
    });
  });

  it("does not look in a parent directory", async () => {
    const parent = await makeTree({ [CONFIG_FILE_NAME]: "{}" });
    const child = join(parent, "packages", "app");
    await mkdir(child, { recursive: true });

    // A configuration one level up belongs to a different project. Reading it would mean a command run in the wrong place
    // silently using somebody else's settings.
    expect(await locateConfiguration(child)).toStrictEqual({
      kind: ConfigurationLocation.Absent,
      root: child,
    });
  });

  it("does not accept the file inside the output directory", async () => {
    const root = await makeTree({ ".qat/qat.config.json": "{}" });

    // One file, at the root: the name is not a pattern to be matched wherever it appears.
    await expect(locateConfiguration(root)).resolves.toMatchObject({
      kind: ConfigurationLocation.Absent,
    });
  });
});

describe("a name occupied by something that is not a file", () => {
  it("reports a directory occupying the name, and says what is there", async () => {
    const root = await makeTree({ "package.json": "{}" });
    await mkdir(join(root, CONFIG_FILE_NAME), { recursive: true });

    const result = await locateConfiguration(root);

    // Reported rather than treated as absence: telling the reader there is no configuration sends them looking for a file
    // they are standing on.
    expect(result).toStrictEqual({
      kind: ConfigurationLocation.NotAFile,
      path: join(root, CONFIG_FILE_NAME),
      occupiedBy: "directory",
    });
  });

  it("reports a symlink to a directory the same way", async () => {
    const root = await makeTree({ "package.json": "{}" });
    const target = join(root, "somewhere-else");
    await mkdir(target, { recursive: true });

    // A junction on Windows: creating a directory link there needs no elevation and resolves identically.
    await symlink(
      target,
      join(root, CONFIG_FILE_NAME),
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(locateConfiguration(root)).resolves.toMatchObject({
      kind: ConfigurationLocation.NotAFile,
      occupiedBy: "directory",
    });
  });

  it.skipIf(process.platform === "win32")(
    "accepts a symlink to a file",
    async () => {
      // A file symlink on Windows needs a privilege the CI runner does not have, so the case is skipped there rather than
      // made to pass with a different mechanism. The behaviour is the same on both: a link to a file is a file.
      const root = await makeTree({ "real.json": "{}" });
      await symlink(join(root, "real.json"), join(root, CONFIG_FILE_NAME));

      await expect(locateConfiguration(root)).resolves.toMatchObject({
        kind: ConfigurationLocation.Found,
      });
    },
  );
});

describe("an unusable project root", () => {
  it("rejects a root that does not exist", async () => {
    const root = await makeTree({});

    const error = await failure(locateConfiguration(join(root, "absent")));

    expect(error.code).toBe("QAT1001");
    expect(error.message).toContain("does not exist");
  });

  it("rejects a root that is a file", async () => {
    const root = await makeTree({ "notes.txt": "" });

    const error = await failure(locateConfiguration(join(root, "notes.txt")));

    // The two are separated because they have different fixes: look at the path you typed, versus look at what you typed
    // it about.
    expect(error.code).toBe("QAT1001");
    expect(error.message).toContain("is not a directory");
  });
});

describe("names that are close but not the canonical one", () => {
  it.each([
    "qat.config.json.bak",
    "qat.config.yaml",
    ".qatrc",
    "config/qat.config.json",
  ])("ignores %s", async (name) => {
    const root = await makeTree({ [name]: "{}" });

    // An exact name in one place, and asserted strictly. A backup beside a deleted file, a format nobody supports and a
    // copy in a subdirectory are the three ways this file gets mistaken for the real one, and each of them has to be
    // absent rather than found.
    expect(await locateConfiguration(root)).toStrictEqual({
      kind: ConfigurationLocation.Absent,
      root,
    });
  });

  it("matches the name case-sensitively, where the filesystem does", async () => {
    const root = await makeTree({ "QAT.CONFIG.JSON": "{}" });

    // The expectation comes from the filesystem rather than from the platform, and the conditional is in the value rather
    // than around the assertion — an `expect` inside an `if` asserts nothing on the other branch, which is how a test
    // passes by not running.
    const expected = (await ignoresCase(root))
      ? ConfigurationLocation.Found
      : ConfigurationLocation.Absent;

    expect((await locateConfiguration(root)).kind).toBe(expected);
  });
});

describe("boundaries", () => {
  it("finds the file in a deeply nested root", async () => {
    const root = await makeTree({ "a/b/c/d/e/qat.config.json": "{}" });

    await expect(
      locateConfiguration(join(root, "a", "b", "c", "d", "e")),
    ).resolves.toMatchObject({
      kind: ConfigurationLocation.Found,
    });
  });

  it("finds the file when the root path contains a space", async () => {
    const root = await makeTree({ "with spaces/qat.config.json": "{}" });

    // The path is built with `join`, not by string concatenation, and nothing here parses it — so a space is a character
    // like any other. Worth pinning because every path bug starts here.
    await expect(
      locateConfiguration(join(root, "with spaces")),
    ).resolves.toMatchObject({
      kind: ConfigurationLocation.Found,
    });
  });
});

describe("non-functional behaviour", () => {
  it("does not modify the project it inspects", async () => {
    const root = await makeTree({
      [CONFIG_FILE_NAME]: "{}",
      "package.json": "{}",
    });
    const before = await snapshot(root);

    await locateConfiguration(root);

    expect(await snapshot(root)).toStrictEqual(before);
  });

  it("is deterministic", async () => {
    const root = await makeTree({ [CONFIG_FILE_NAME]: "{}" });

    expect(await locateConfiguration(root)).toStrictEqual(
      await locateConfiguration(root),
    );
  });

  it("keeps concurrent discoveries independent", async () => {
    const withFile = await makeTree({ [CONFIG_FILE_NAME]: "{}" });
    const without = await makeTree({});

    const [found, absent] = await Promise.all([
      locateConfiguration(withFile),
      locateConfiguration(without),
    ]);

    // A module-level cache would make one of these report the other's root.
    expect(found.kind).toBe(ConfigurationLocation.Found);
    expect(absent.kind).toBe(ConfigurationLocation.Absent);
  });

  it("does not change the process working directory", async () => {
    const before = process.cwd();
    const root = await makeTree({ [CONFIG_FILE_NAME]: "{}" });

    await locateConfiguration(root);

    expect(process.cwd()).toBe(before);
  });
});
