/**
 * Sync engine: reconciles three views of every path.
 *
 *   local  – bytes on this device
 *   base   – what this device last agreed with the server (version + plaintext hash)
 *   remote – the server's change log
 *
 *   local == base, remote moved   -> pull
 *   local moved,   remote == base -> push (compare-and-swap on the base version)
 *   both moved                    -> merge (if a merger accepts) or keep both:
 *                                    remote wins the path, local is saved as a conflict copy
 *
 * A sync is: pull every change since our cursor, then push local changes
 * (only `dirty` paths, or everything on a full scan). Syncs never overlap.
 * Offline edits and edits made while Obsidian was closed are just local
 * changes found by the next scan, so they converge like any other.
 */
import { CHUNK_SIZE, type Entry, MAX_OPS_PER_COMMIT, type Op } from "@oscf/protocol";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

import { concat, sha256, split } from "./bytes.ts";
import {
  type BaseEntry,
  Codec,
  type CodecError,
  type FileMeta,
  type FileStat,
  LocalState,
  Remote,
  type RemoteError,
  type SyncState,
  VaultIo,
  type VaultError,
} from "./services.ts";

export interface MergeInput {
  readonly path: string;
  /** Last synced content, if still available. */
  readonly base: Uint8Array | null;
  readonly ours: Uint8Array;
  readonly theirs: Uint8Array;
}

export interface EngineOptions {
  readonly device: string;
  /** Selective sync and internal exclusions. Excluded paths are ignored in both directions. */
  readonly isSyncable: (path: string) => boolean;
  /** Returns merged bytes, or null to fall back to a conflict copy. */
  readonly merge?: (input: MergeInput) => Uint8Array | null;
  readonly log?: (message: string) => void;
  /** Called after the engine writes or deletes a local file. */
  readonly onLocalWrite?: (path: string) => void;
}

export type SyncError = RemoteError | VaultError | CodecError;

export interface SyncReport {
  pulled: number;
  pushed: number;
  conflicts: number;
  merged: number;
}

interface LocalChange {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly hash: string;
  readonly stat: FileStat;
  readonly base: BaseEntry | undefined;
}

export const conflictPath = (path: string, device: string, now = new Date()) => {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  const [stem, ext] = dot > slash + 1 ? [path.slice(0, dot), path.slice(dot)] : [path, ""];
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `${stem} (conflict ${device} ${stamp})${ext}`;
};

export const makeEngine = (options: EngineOptions) =>
  Effect.gen(function* () {
    const vault = yield* VaultIo;
    const remote = yield* Remote;
    const codec = yield* Codec;
    const store = yield* LocalState;
    const state: SyncState = yield* store.load;
    const lock = yield* Semaphore.make(1);
    const log = options.log ?? (() => {});

    const save = store.save(state);

    const setBase = (path: string, entry: Entry, meta: FileMeta, stat: FileStat | null) => {
      state.base[path] = {
        pathId: entry.path,
        version: entry.version,
        hash: meta.hash,
        size: stat?.size ?? meta.size,
        mtime: stat?.mtime ?? meta.mtime,
        chunks: entry.chunks,
      };
    };

    // ---------------------------------------------------------------- content

    const download = (chunks: ReadonlyArray<string>) =>
      Effect.forEach(chunks, (hash) => remote.getBlob(hash).pipe(Effect.flatMap(codec.openChunk)), {
        concurrency: 4,
      }).pipe(Effect.map(concat));

    /** Seal and upload a file's chunks, skipping ones the server already has from the base version. */
    const upload = (bytes: Uint8Array, known: ReadonlyArray<string>) =>
      Effect.forEach(
        split(bytes, CHUNK_SIZE),
        (chunk) =>
          Effect.gen(function* () {
            const sealed = yield* codec.sealChunk(chunk);
            const hash = yield* sha256(sealed);
            if (!known.includes(hash)) yield* remote.putBlob(hash, sealed);
            return hash;
          }),
        { concurrency: 4 },
      );

    const readLocal = (path: string) =>
      Effect.gen(function* () {
        const stat = yield* vault.stat(path);
        if (stat === null) return null;
        const bytes = yield* vault.read(path);
        if (bytes === null) return null;
        return { stat, bytes, hash: yield* sha256(bytes) };
      });

    const writeLocal = (path: string, bytes: Uint8Array) =>
      vault.write(path, bytes).pipe(Effect.tap(() => Effect.sync(() => options.onLocalWrite?.(path))));

    const removeLocal = (path: string) =>
      vault.remove(path).pipe(Effect.tap(() => Effect.sync(() => options.onLocalWrite?.(path))));

    /** Remote version wins the path; ours survives as a conflict copy (or both merge). */
    const resolveConflict = (path: string, base: BaseEntry | undefined, ours: Uint8Array, entry: Entry, meta: FileMeta) =>
      Effect.gen(function* () {
        const theirs = yield* download(entry.chunks);
        const baseBytes = base ? yield* download(base.chunks).pipe(Effect.orElseSucceed(() => null)) : null;
        const merged = options.merge?.({ path, base: baseBytes, ours, theirs }) ?? null;
        if (merged !== null) {
          // The merge includes both sides: adopt the remote version as base, push the merge on top.
          const stat = yield* writeLocal(path, merged);
          setBase(path, entry, meta, null);
          state.base[path] = { ...state.base[path]!, size: -1, mtime: stat.mtime };
          log(`merged concurrent edits in ${path}`);
          return "merged" as const;
        }
        const copy = conflictPath(path, options.device);
        yield* writeLocal(copy, ours);
        const stat = yield* writeLocal(path, theirs);
        setBase(path, entry, meta, stat);
        log(`conflict on ${path}; kept local copy at ${copy}`);
        return "conflict" as const;
      });

    // ---------------------------------------------------------------- pull

    const applyRemote = (entry: Entry, report: SyncReport) =>
      Effect.gen(function* () {
        const meta = yield* codec.openMeta(entry.path, entry.meta);
        const path = meta.path;
        if (!options.isSyncable(path)) return;
        const base = state.base[path];
        if (base && base.pathId === entry.path && base.version === entry.version) return;

        const local = yield* readLocal(path);
        const localUnchanged = local === null ? base === undefined : base !== undefined && local.hash === base.hash;

        if (entry.deleted) {
          if (local === null) delete state.base[path];
          else if (localUnchanged) {
            yield* removeLocal(path);
            delete state.base[path];
            report.pulled++;
          } else {
            // Edited here, deleted there: the edit wins; the next push recreates the file.
            delete state.base[path];
          }
          return;
        }

        if (local !== null && local.hash === meta.hash) return setBase(path, entry, meta, local.stat);

        if (local === null || localUnchanged) {
          const stat = yield* writeLocal(path, yield* download(entry.chunks));
          setBase(path, entry, meta, stat);
          report.pulled++;
          return;
        }

        const outcome = yield* resolveConflict(path, base, local.bytes, entry, meta);
        report[outcome === "merged" ? "merged" : "conflicts"]++;
      });

    const pull = (report: SyncReport) =>
      Effect.gen(function* () {
        for (;;) {
          const page = yield* remote.changes(state.cursor);
          for (const entry of page.entries) yield* applyRemote(entry, report);
          state.cursor = page.seq;
          yield* save;
          if (!page.more) return;
        }
      });

    // ---------------------------------------------------------------- push

    /** Local changes for `paths` (or every file and base entry). */
    const scan = (paths: ReadonlySet<string> | undefined) =>
      Effect.gen(function* () {
        const candidates = new Set<string>(paths ?? []);
        if (paths === undefined) {
          for (const file of yield* vault.list) candidates.add(file.path);
          for (const path of Object.keys(state.base)) candidates.add(path);
        }
        const changed: LocalChange[] = [];
        const missing: string[] = [];
        for (const path of candidates) {
          if (!options.isSyncable(path)) continue;
          const base = state.base[path];
          const stat = yield* vault.stat(path);
          if (stat === null) {
            if (base) missing.push(path);
            continue;
          }
          if (base && stat.mtime === base.mtime && stat.size === base.size) continue;
          const bytes = yield* vault.read(path);
          if (bytes === null) continue;
          const hash = yield* sha256(bytes);
          if (base && hash === base.hash) {
            state.base[path] = { ...base, mtime: stat.mtime, size: stat.size };
            continue;
          }
          changed.push({ path, bytes, hash, stat, base });
        }
        return { changed, missing };
      });

    const metaFor = (change: LocalChange): FileMeta => ({
      path: change.path,
      hash: change.hash,
      size: change.stat.size,
      mtime: change.stat.mtime,
    });

    const putOp = (change: LocalChange, baseVersion: number | null) =>
      Effect.gen(function* () {
        const pathId = yield* codec.pathId(change.path);
        const chunks = yield* upload(change.bytes, change.base?.chunks ?? []);
        const op: Op = {
          op: "put",
          path: pathId,
          baseVersion,
          chunks,
          meta: yield* codec.sealMeta(pathId, metaFor(change)),
          device: options.device,
        };
        return op;
      });

    type Pending =
      | { kind: "put"; change: LocalChange; op: Op }
      | { kind: "remove"; path: string; base: BaseEntry; op: Op }
      | { kind: "rename"; from: string; change: LocalChange; base: BaseEntry; op: Op };

    const commitAll = (pending: Pending[], report: SyncReport) =>
      Effect.gen(function* () {
        const retry: LocalChange[] = [];
        for (let i = 0; i < pending.length; i += MAX_OPS_PER_COMMIT) {
          const batch = pending.slice(i, i + MAX_OPS_PER_COMMIT);
          const results = yield* remote.commit(batch.map((p) => p.op));
          for (const [index, item] of batch.entries()) {
            const result = results[index]!;
            if (item.kind === "put") {
              const { change } = item;
              if (result.ok) {
                setBase(change.path, result.entries[0]!, metaFor(change), change.stat);
                report.pushed++;
                continue;
              }
              const current = result.current;
              if (current === null || current.deleted) {
                // Deleted (or never existed) remotely: our version becomes a new file.
                if (change.base !== undefined || item.op.op === "put" && item.op.baseVersion !== null) {
                  delete state.base[change.path];
                  retry.push({ ...change, base: undefined });
                }
                continue;
              }
              const meta = yield* codec.openMeta(current.path, current.meta);
              if (meta.hash === change.hash) {
                // Our own earlier write (a retried commit): already done.
                setBase(change.path, current, meta, change.stat);
                continue;
              }
              const outcome = yield* resolveConflict(change.path, change.base, change.bytes, current, meta);
              report[outcome === "merged" ? "merged" : "conflicts"]++;
            } else if (item.kind === "remove") {
              if (result.ok || result.current === null || result.current.deleted) {
                delete state.base[item.path];
                if (result.ok) report.pushed++;
                continue;
              }
              // Edited remotely while we deleted it: the edit wins, restore it.
              const meta = yield* codec.openMeta(result.current.path, result.current.meta);
              const stat = yield* writeLocal(item.path, yield* download(result.current.chunks));
              setBase(item.path, result.current, meta, stat);
              log(`${item.path} was edited elsewhere; restored instead of deleting`);
            } else {
              if (result.ok) {
                delete state.base[item.from];
                setBase(item.change.path, result.entries[1]!, metaFor(item.change), item.change.stat);
                report.pushed++;
                continue;
              }
              // Fall back to delete + create.
              const removeOp: Op = { op: "remove", path: item.base.pathId, baseVersion: item.base.version, device: options.device };
              const [removed] = yield* remote.commit([removeOp]);
              if (removed?.ok || removed?.current?.deleted) delete state.base[item.from];
              retry.push(item.change);
            }
          }
          yield* save;
        }
        return retry;
      });

    const push = (paths: ReadonlySet<string> | undefined, report: SyncReport) =>
      Effect.gen(function* () {
        let { changed, missing } = yield* scan(paths);

        // Offline renames: a vanished path and a new path with identical content.
        const renames: Array<{ from: string; change: LocalChange; base: BaseEntry }> = [];
        for (const from of [...missing]) {
          const base = state.base[from]!;
          const matches = changed.filter((c) => c.base === undefined && c.hash === base.hash);
          if (matches.length !== 1) continue;
          const change = matches[0]!;
          renames.push({ from, change, base });
          missing = missing.filter((p) => p !== from);
          changed = changed.filter((c) => c !== change);
        }

        const pending: Pending[] = [];
        for (const { from, change, base } of renames) {
          const to = yield* codec.pathId(change.path);
          const op: Op = {
            op: "rename",
            from: base.pathId,
            to,
            baseVersion: base.version,
            meta: yield* codec.sealMeta(to, metaFor(change)),
            device: options.device,
          };
          pending.push({ kind: "rename", from, change: { ...change, base: { ...base, pathId: to } }, base, op });
        }
        for (const path of missing) {
          const base = state.base[path]!;
          pending.push({
            kind: "remove",
            path,
            base,
            op: { op: "remove", path: base.pathId, baseVersion: base.version, device: options.device },
          });
        }
        for (const change of changed)
          pending.push({ kind: "put", change, op: yield* putOp(change, change.base?.version ?? null) });

        let retry = yield* commitAll(pending, report);
        // One retry round for writes whose remote counterpart was deleted meanwhile.
        if (retry.length > 0) {
          const again: Pending[] = [];
          for (const change of retry) again.push({ kind: "put", change, op: yield* putOp(change, null) });
          retry = yield* commitAll(again, report);
          if (retry.length > 0) log(`${retry.length} file(s) still conflicting; will retry next sync`);
        }
      });

    // ---------------------------------------------------------------- public

    /**
     * Pull remote changes (unless `pull: false`), then push local changes for
     * `dirty` paths, or for the whole vault when omitted. A local-only sync
     * with nothing changed makes no network request at all.
     */
    const sync = (dirty?: ReadonlySet<string>, options: { readonly pull?: boolean } = {}) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const report: SyncReport = { pulled: 0, pushed: 0, conflicts: 0, merged: 0 };
          if (options.pull !== false) yield* pull(report);
          yield* push(dirty, report);
          // Merged files were rewritten locally; push them on top of the remote version.
          const merged = Object.entries(state.base).filter(([, b]) => b.size === -1).map(([p]) => p);
          if (merged.length > 0) yield* push(new Set(merged), report);
          yield* save;
          return report;
        }),
      );

    /**
     * Which of `paths` may have changed since the last sync, judged by stat
     * only (no hashing, no network). Cheap enough to poll.
     */
    const changedLocally = (paths: Iterable<string>) =>
      Effect.gen(function* () {
        const out: string[] = [];
        for (const path of new Set(paths)) {
          if (!options.isSyncable(path)) continue;
          const base = state.base[path];
          const stat = yield* vault.stat(path);
          if (stat === null ? base !== undefined : base === undefined || stat.mtime !== base.mtime || stat.size !== base.size)
            out.push(path);
        }
        return out;
      });

    /** Forget the cursor so the next sync re-reads the whole index (e.g. after changing selective sync). */
    const resetCursor = Effect.sync(() => {
      state.cursor = 0;
    }).pipe(Effect.andThen(save));

    return {
      sync,
      changedLocally,
      resetCursor,
      download,
      state: state as Readonly<SyncState>,
    };
  });

export type Engine = Effect.Success<ReturnType<typeof makeEngine>>;
