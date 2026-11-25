import { link, open, readFile, rename, unlink } from "node:fs/promises";

/** The handle operations the writer needs, narrowed so a test can supply a failing one. */
export interface WritableHandle {
  writeFile(data: string, encoding: "utf8"): Promise<void>;
  /** Durability before the file becomes visible under its final name. */
  sync(): Promise<void>;
  close(): Promise<void>;
}

/**
 * The filesystem operations the safe writer performs.
 *
 * Six methods, because the guarantee is made of six steps and every one of them has a failure mode worth testing: a disk
 * that fills between the write and the sync, a link that finds the target occupied, a rename that crosses a filesystem
 * boundary. An I/O port is the only way to reach those in a unit test without a container full of contrived mounts.
 */
export interface SafeWriteIo {
  /** Open a file that must not already exist. `wx` is the flag that promises it. */
  readonly openNew: (path: string) => Promise<WritableHandle>;
  readonly link: (existing: string, target: string) => Promise<void>;
  readonly rename: (from: string, to: string) => Promise<void>;
  readonly remove: (path: string) => Promise<void>;
  readonly read: (path: string) => Promise<string>;
}

export const nodeSafeWriteIo: SafeWriteIo = {
  openNew: (path) => open(path, "wx"),
  link: async (existing, target) => link(existing, target),
  rename: async (from, to) => rename(from, to),
  remove: async (path) => unlink(path),
  read: async (path) => readFile(path, "utf8"),
};
