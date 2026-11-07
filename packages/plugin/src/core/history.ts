/**
 * Version history and recovery (M4), on top of the change log: every accepted
 * version is a row, so history is just "rows for this path id". Restoring
 * writes the old content locally; the normal sync then commits it as a new
 * version (history is never rewritten).
 */
import type { Entry } from "@oscf/protocol";
import * as Effect from "effect/Effect";

import { concat } from "./bytes.ts";
import { decodeMeta } from "./file-meta.ts";
import { Remote, VaultIo } from "./services.ts";

export interface VersionInfo {
  readonly path: string;
  readonly version: number;
  readonly deleted: boolean;
  readonly device: string;
  /** When the server accepted this version. */
  readonly createdAt: number;
  readonly size: number;
  readonly mtime: number;
  readonly entry: Entry;
}

const describe = (entry: Entry) =>
  Effect.gen(function* () {
    const meta = yield* decodeMeta(entry.path, entry.meta);
    return {
      path: meta.path,
      version: entry.version,
      deleted: entry.deleted,
      device: entry.device,
      createdAt: entry.createdAt,
      size: meta.size,
      mtime: meta.mtime,
      entry,
    } satisfies VersionInfo;
  });

/** All retained versions of a file, newest first, following it back through renames. */
export const fileHistory = (path: string) =>
  Effect.gen(function* () {
    const remote = yield* Remote;
    const entries: Entry[] = [];
    const seen = new Set<string>();
    let pathId: string | undefined = path;
    while (pathId !== undefined && !seen.has(pathId) && seen.size < 20) {
      seen.add(pathId);
      entries.push(...(yield* remote.history(pathId)));
      pathId = remote.movedFrom ? (yield* remote.movedFrom(pathId))[0] : undefined;
    }
    return yield* Effect.forEach(entries, describe);
  });

/** Content of one version. */
export const readVersion = (info: Pick<VersionInfo, "entry">) =>
  Effect.gen(function* () {
    const remote = yield* Remote;
    const chunks = yield* Effect.forEach(info.entry.chunks, (hash) => remote.getBlob(hash), { concurrency: 4 });
    return concat(chunks);
  });

/** Bring an old version back as the current content of `target` (synced as a new version). */
export const restoreVersion = (info: VersionInfo, target: string = info.path) =>
  Effect.gen(function* () {
    if (info.deleted) return yield* Effect.die(new Error("Cannot restore a deletion"));
    const vault = yield* VaultIo;
    yield* vault.write(target, yield* readVersion(info));
    return target;
  });

export interface DeletedFile {
  readonly path: string;
  readonly deletedAt: number;
  readonly device: string;
}

/** Files deleted on any device that are not present here, newest first. */
export const deletedFiles = Effect.gen(function* () {
  const remote = yield* Remote;
  const vault = yield* VaultIo;
  const out: DeletedFile[] = [];
  for (const entry of yield* remote.deleted) {
    const info = yield* describe(entry).pipe(Effect.option);
    if (info._tag === "None") continue;
    if ((yield* vault.stat(info.value.path)) !== null) continue;
    out.push({ path: info.value.path, deletedAt: entry.createdAt, device: entry.device });
  }
  return out;
});

/** Restore the last content a deleted file had before its deletion. */
export const restoreDeleted = (path: string) =>
  Effect.gen(function* () {
    const versions = yield* fileHistory(path);
    const last = versions.find((v) => !v.deleted);
    if (!last) return yield* Effect.fail(new Error(`No retained content for ${path}`));
    return yield* restoreVersion(last, path);
  });
