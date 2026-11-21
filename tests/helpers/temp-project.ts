import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export interface TempProject {
  /** Absolute path to the throwaway project root. */
  readonly root: string;
  /** Writes a file, creating parent directories as needed. */
  write(relativePath: string, contents: string): Promise<void>;
}

/**
 * Creates an isolated temporary project, runs the callback against it, and
 * removes it afterwards even if the callback throws.
 *
 * Integration tests must never operate on the repository itself: a test that
 * writes into the working tree leaves artefacts behind on failure and cannot run
 * concurrently with another test.
 */
export async function withTempProject(
  run: (project: TempProject) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'qat-test-'));

  const write = async (relativePath: string, contents: string): Promise<void> => {
    const target = join(root, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents, 'utf8');
  };

  try {
    await run({ root, write });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}