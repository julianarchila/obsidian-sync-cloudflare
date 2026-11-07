/**
 * Filesystem implementations of the engine's services: the vault is a plain
 * folder, and the sync state lives in `<dir>/.homebase/state.json`.
 */
import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as nodePath from "node:path";

import * as Effect from "effect/Effect";

import {
  type FileStat,
  type LocalStateShape,
  type SyncState,
  VaultError,
  type VaultIoShape,
} from "../../plugin/src/core/services.ts";
import { isSafePath } from "../../plugin/src/core/plain-codec.ts";

export const STATE_DIR = ".homebase";

const IGNORED_DIRS = new Set([STATE_DIR, ".obsidian", ".git", "node_modules", ".trash"]);
const TEMP_MARK = ".homebase-tmp-";

/** Paths the CLI never syncs: internal state, app config, VCS, editor temp files. */
export const isIgnored = (path: string) => {
  const parts = path.split("/");
  if (parts.some((part) => IGNORED_DIRS.has(part))) return true;
  const name = parts.at(-1) ?? "";
  return (
    name === ".DS_Store" ||
    name === "4913" ||
    name.endsWith(".swp") ||
    name.endsWith(".swx") ||
    name.endsWith("~") ||
    name.startsWith(".#") ||
    name.includes(TEMP_MARK)
  );
};

const vaultError = (path: string) => (error: unknown) =>
  new VaultError({ path, message: error instanceof Error ? error.message : String(error) });

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";

/** Write via a temp file in the same folder, then rename: readers never see a half-written file. */
export const writeAtomic = async (target: string, data: Uint8Array | string) => {
  await fs.mkdir(nodePath.dirname(target), { recursive: true });
  const temp = nodePath.join(nodePath.dirname(target), `.${nodePath.basename(target)}${TEMP_MARK}${randomBytes(4).toString("hex")}`);
  await fs.writeFile(temp, data);
  await fs.rename(temp, target);
};

const toStat = (path: string, stat: { mtimeMs: number; size: number }): FileStat => ({
  path,
  mtime: Math.floor(stat.mtimeMs),
  size: stat.size,
});

export const fsVaultIo = (root: string): VaultIoShape => {
  const base = nodePath.resolve(root);
  /** Absolute path inside the vault; anything that would escape it is refused. */
  const abs = (path: string) => {
    if (!isSafePath(path)) throw new Error(`Unsafe path: ${JSON.stringify(path)}`);
    const resolved = nodePath.resolve(base, ...path.split("/"));
    if (!resolved.startsWith(base + nodePath.sep)) throw new Error(`Path escapes the vault: ${JSON.stringify(path)}`);
    return resolved;
  };

  const stat = async (path: string) => {
    try {
      const s = await fs.stat(abs(path));
      return s.isFile() ? toStat(path, s) : null;
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  };

  const walk = async (dir: string, prefix: string, out: FileStat[]) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (isIgnored(rel)) continue;
      if (entry.isDirectory()) await walk(nodePath.join(dir, entry.name), rel, out);
      else if (entry.isFile()) {
        const s = await stat(rel);
        if (s) out.push(s);
      }
    }
    return out;
  };

  /** Remove now-empty parent folders up to the root (a deleted note shouldn't leave its folder behind). */
  const pruneEmpty = async (path: string) => {
    let dir = nodePath.dirname(abs(path));
    while (dir.startsWith(root) && nodePath.resolve(dir) !== nodePath.resolve(root)) {
      try {
        await fs.rmdir(dir);
      } catch {
        return;
      }
      dir = nodePath.dirname(dir);
    }
  };

  return {
    list: Effect.tryPromise({ try: () => walk(root, "", []), catch: vaultError(root) }),
    stat: (path) => Effect.tryPromise({ try: () => stat(path), catch: vaultError(path) }),
    read: (path) =>
      Effect.tryPromise({
        try: async () => {
          try {
            return new Uint8Array(await fs.readFile(abs(path)));
          } catch (error) {
            if (isMissing(error)) return null;
            throw error;
          }
        },
        catch: vaultError(path),
      }),
    write: (path, data) =>
      Effect.tryPromise({
        try: async () => {
          await writeAtomic(abs(path), data);
          return toStat(path, await fs.stat(abs(path)));
        },
        catch: vaultError(path),
      }),
    remove: (path) =>
      Effect.tryPromise({
        try: async () => {
          await fs.rm(abs(path), { force: true });
          await pruneEmpty(path);
        },
        catch: vaultError(path),
      }),
  };
};

export const fsLocalState = (root: string): LocalStateShape => {
  const file = nodePath.join(root, STATE_DIR, "state.json");
  return {
    load: Effect.promise(async () => {
      try {
        return JSON.parse(await fs.readFile(file, "utf8")) as SyncState;
      } catch {
        return { cursor: 0, base: {} };
      }
    }),
    save: (state) => Effect.promise(() => writeAtomic(file, JSON.stringify(state))),
  };
};
