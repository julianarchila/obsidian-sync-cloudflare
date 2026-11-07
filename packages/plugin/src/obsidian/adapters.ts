/**
 * Obsidian implementations of the engine's services.
 */
import { type App, normalizePath, requestUrl, TFile } from "obsidian";
import * as Effect from "effect/Effect";

import type { HttpFn } from "../core/http-remote.ts";
import { type FileStat, type LocalStateShape, type SyncState, VaultError, type VaultIoShape } from "../core/services.ts";

const vaultError = (path: string) => (error: unknown) =>
  new VaultError({ path, message: error instanceof Error ? error.message : String(error) });

const toBuffer = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer as ArrayBuffer;

/** Regular vault files through the Vault API (keeps Obsidian's cache and events consistent). */
export const obsidianVaultIo = (app: App): VaultIoShape => {
  const { vault } = app;
  const file = (path: string) => {
    const f = vault.getAbstractFileByPath(normalizePath(path));
    return f instanceof TFile ? f : null;
  };
  const statOf = (f: TFile): FileStat => ({ path: f.path, mtime: f.stat.mtime, size: f.stat.size });

  const ensureFolder = async (path: string) => {
    const parts = path.split("/").slice(0, -1);
    for (let i = 1; i <= parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      if (!vault.getAbstractFileByPath(dir)) await vault.createFolder(dir).catch(() => {});
    }
  };

  return {
    list: Effect.sync(() => vault.getFiles().map(statOf)),
    stat: (path) => Effect.sync(() => {
      const f = file(path);
      return f ? statOf(f) : null;
    }),
    read: (path) =>
      Effect.tryPromise({
        try: async () => {
          const f = file(path);
          return f ? new Uint8Array(await vault.readBinary(f)) : null;
        },
        catch: vaultError(path),
      }),
    write: (path, data) =>
      Effect.tryPromise({
        try: async () => {
          const existing = file(path);
          if (existing) await vault.modifyBinary(existing, toBuffer(data));
          else {
            await ensureFolder(path);
            await vault.createBinary(normalizePath(path), toBuffer(data));
          }
          const written = file(path);
          return written ? statOf(written) : { path, mtime: Date.now(), size: data.byteLength };
        },
        catch: vaultError(path),
      }),
    remove: (path) =>
      Effect.tryPromise({
        try: async () => {
          const f = file(path);
          if (f) await app.fileManager.trashFile(f);
        },
        catch: vaultError(path),
      }),
  };
};

/**
 * Files under the config dir (`.obsidian`) through the DataAdapter: the Vault
 * API does not see them. `list` returns every file below the dir; the engine's
 * `isSyncable` decides what actually syncs.
 */
export const obsidianConfigIo = (app: App, configDir: string): VaultIoShape => {
  const adapter = app.vault.adapter;
  const statOf = async (path: string): Promise<FileStat | null> => {
    const s = await adapter.stat(path);
    return s && s.type === "file" ? { path, mtime: s.mtime, size: s.size } : null;
  };
  const listAll = async (dir: string): Promise<string[]> => {
    if (!(await adapter.exists(dir))) return [];
    const { files, folders } = await adapter.list(dir);
    const nested = await Promise.all(folders.map(listAll));
    return [...files, ...nested.flat()];
  };
  const mkdirs = async (path: string) => {
    const parts = path.split("/").slice(0, -1);
    for (let i = 1; i <= parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
    }
  };
  return {
    list: Effect.tryPromise({
      try: async () => (await Promise.all((await listAll(configDir)).map(statOf))).filter((s): s is FileStat => s !== null),
      catch: vaultError(configDir),
    }),
    stat: (path) => Effect.tryPromise({ try: () => statOf(path), catch: vaultError(path) }),
    read: (path) =>
      Effect.tryPromise({
        try: async () => ((await adapter.exists(path)) ? new Uint8Array(await adapter.readBinary(path)) : null),
        catch: vaultError(path),
      }),
    write: (path, data) =>
      Effect.tryPromise({
        try: async () => {
          await mkdirs(path);
          await adapter.writeBinary(path, toBuffer(data));
          return (await statOf(path)) ?? { path, mtime: Date.now(), size: data.byteLength };
        },
        catch: vaultError(path),
      }),
    remove: (path) =>
      Effect.tryPromise({
        try: async () => {
          if (await adapter.exists(path)) await adapter.remove(path);
        },
        catch: vaultError(path),
      }),
  };
};

/** Route config-dir paths to the adapter, everything else to the Vault API. */
export const combinedVaultIo = (vault: VaultIoShape, config: VaultIoShape, configDir: string): VaultIoShape => {
  const pick = (path: string) => (path.startsWith(`${configDir}/`) ? config : vault);
  return {
    list: Effect.all([vault.list, config.list]).pipe(Effect.map(([a, b]) => [...a, ...b])),
    stat: (path) => pick(path).stat(path),
    read: (path) => pick(path).read(path),
    write: (path, data) => pick(path).write(path, data),
    remove: (path) => pick(path).remove(path),
  };
};

/** Sync state in its own file next to the plugin (kept out of data.json, which Obsidian rewrites often). */
export const obsidianLocalState = (app: App, file: string): LocalStateShape => ({
  load: Effect.promise(async () => {
    try {
      const parsed = JSON.parse(await app.vault.adapter.read(file)) as SyncState;
      return { cursor: parsed.cursor ?? 0, base: parsed.base ?? {}, vault: parsed.vault };
    } catch {
      return { cursor: 0, base: {} };
    }
  }),
  save: (state) =>
    Effect.promise(async () => {
      const tmp = `${file}.tmp`;
      await app.vault.adapter.write(tmp, JSON.stringify(state));
      if (await app.vault.adapter.exists(file)) await app.vault.adapter.remove(file);
      await app.vault.adapter.rename(tmp, file);
    }),
});

/** HTTP through Obsidian's `requestUrl`: no CORS restrictions on desktop or mobile. */
export const obsidianHttp: HttpFn = async ({ method, url, headers, body }) => {
  const response = await requestUrl({
    url,
    method,
    headers,
    body: body instanceof Uint8Array ? toBuffer(body) : body,
    throw: false,
  });
  return { status: response.status, body: new Uint8Array(response.arrayBuffer) };
};
