/**
 * `homebase watch`: keep a folder in sync continuously.
 *
 * Same scheduling as the plugin's SyncClient (no overlapping syncs, queued
 * runs, pull only when the server announced a newer seq), with fs.watch
 * instead of vault events and process signals instead of window events.
 */
import { watch as fsWatch, type FSWatcher } from "node:fs";
import * as nodePath from "node:path";

import * as Effect from "effect/Effect";

import { Connection, type SocketLike, type Timers } from "../../plugin/src/core/connection.ts";
import { socketUrl } from "../../plugin/src/core/http-remote.ts";
import { STATE_DIR } from "./fs-vault.ts";
import { IGNORE_FILE } from "./ignore.ts";
import { log, openVault, writeStatus } from "./vault.ts";

const DEBOUNCE_MS = 1000;
/** Local-only safety rescan (no network unless something changed). */
const RESCAN_MS = 5 * 60 * 1000;
/** Without file events (watch limit reached), rescan this often instead. */
const POLL_MS = 10 * 1000;
/** After a failed sync, retry with backoff (on top of the socket's own reconnects). */
const RETRY_MIN_MS = 5 * 1000;
const RETRY_MAX_MS = 5 * 60 * 1000;

const timers: Timers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
  clearTimeout: (id) => clearTimeout(id),
  setInterval: (fn, ms) => setInterval(fn, ms) as unknown as number,
  clearInterval: (id) => clearInterval(id),
};

export const watch = async (root: string) => {
  const vault = await openVault(root);
  const { engine, config, token } = vault;

  let stopped = false;
  let dirty = new Set<string>();
  /** A folder changed: only a full scan finds every file inside it. */
  let needFull = false;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let remoteSeq = 0;
  let running: Promise<void> | undefined;
  let queued: { full: boolean; pull: boolean; dirty: Set<string> } | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let retryDelay = RETRY_MIN_MS;

  const connection = new Connection({
    open: () => new WebSocket(socketUrl({ serverUrl: config.url, vaultId: config.vault, token })) as unknown as SocketLike,
    timers,
    onOpen: () => schedule(true, true),
    onSeq: (seq) => {
      remoteSeq = Math.max(remoteSeq, seq);
      if (remoteSeq > engine.state.cursor) schedule(false, true);
    },
    onState: (state) => log(`connection ${state}`),
    log,
  });

  const behind = () => !connection.open || remoteSeq > engine.state.cursor;

  const run = async (paths: Set<string> | undefined, pull: boolean) => {
    if (stopped) return;
    try {
      const takeDirty = () => {
        const taken = dirty;
        dirty = new Set();
        return taken;
      };
      const report = await Effect.runPromise(engine.sync(paths, { pull, takeDirty }));
      const total = report.pulled + report.pushed + report.conflicts + report.merged + report.skipped;
      if (total > 0)
        log(
          `synced: ${report.pulled} pulled, ${report.pushed} pushed, ${report.merged} merged, ${report.conflicts} conflicts, ${report.skipped} skipped`,
        );
      await writeStatus(root, { at: Date.now(), ok: true });
      retryDelay = RETRY_MIN_MS;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`sync failed: ${message} (retrying in ${Math.round(retryDelay / 1000)} s)`);
      await writeStatus(root, { at: Date.now(), ok: false, error: message });
      if (paths) for (const p of paths) dirty.add(p);
      // Don't wait for the next file event or the 5-minute rescan.
      clearTimeout(retry);
      retry = setTimeout(() => schedule(true, true), retryDelay);
      retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
    }
  };

  const schedule = (full: boolean, pull: boolean) => {
    const paths = dirty;
    dirty = new Set();
    if (needFull) {
      full = true;
      needFull = false;
    }
    if (running) {
      queued ??= { full: false, pull: false, dirty: new Set() };
      queued.full ||= full;
      queued.pull ||= pull;
      for (const p of paths) queued.dirty.add(p);
      return;
    }
    running = run(full ? undefined : paths, pull).finally(() => {
      running = undefined;
      const next = queued;
      queued = undefined;
      if (next && !stopped) {
        for (const p of next.dirty) dirty.add(p);
        schedule(next.full, next.pull || behind());
      }
    });
  };

  /**
   * File events are only a hint that something changed. Bun's recursive
   * fs.watch on macOS coalesces bursts (200 writes or deletes in a folder
   * report 3-4 paths), so any event triggers a full scan. The scan is
   * stat-only for unchanged files and makes no request unless something changed.
   */
  const onEvent = (path: string | null) => {
    // Only our own state writes are skipped. Bun on macOS coalesces bursts and may
    // report just one (possibly ignored, e.g. a temp file) path for many changes,
    // so any other event triggers a full stat-only scan.
    if (path !== null && (path === STATE_DIR || path.startsWith(`${STATE_DIR}/`))) return;
    if (path === IGNORE_FILE)
      void vault.reloadIgnore().then(() => log(`reloaded ${IGNORE_FILE}`), (e: Error) => log(`${IGNORE_FILE}: ${e.message}`));
    needFull = true;
    clearTimeout(debounce);
    debounce = setTimeout(() => schedule(false, behind()), DEBOUNCE_MS);
  };

  /**
   * Without file events (e.g. Linux's inotify watch limit, ENOSPC), keep syncing by
   * polling: a full scan is stat-only and makes no request unless something changed.
   */
  let poll: ReturnType<typeof setInterval> | undefined;
  const fallBackToPolling = (error: NodeJS.ErrnoException) => {
    if (poll !== undefined) return;
    const limit =
      error.code === "ENOSPC"
        ? " The inotify watch limit was reached; raise it with `sudo sysctl fs.inotify.max_user_watches=524288` (and in /etc/sysctl.d/) for instant updates."
        : "";
    log(`can't watch the folder for changes (${error.code ?? error.message}).${limit} Scanning every ${POLL_MS / 1000} s instead.`);
    poll = setInterval(() => schedule(true, false), POLL_MS);
  };

  let watcher: FSWatcher | undefined;
  try {
    watcher = fsWatch(root, { recursive: true }, (_event, filename) =>
      onEvent(filename ? String(filename).split(nodePath.sep).join("/") : null),
    );
    watcher.on("error", (error) => {
      watcher?.close();
      fallBackToPolling(error as NodeJS.ErrnoException);
    });
  } catch (error) {
    fallBackToPolling(error as NodeJS.ErrnoException);
  }

  log(`watching ${root} (vault ${config.vault} on ${config.url}, device ${config.device})`);
  connection.start();
  const rescan = setInterval(() => schedule(true, false), RESCAN_MS);

  await new Promise<void>((resolve) => {
    const shutdown = async (signal: string) => {
      if (stopped) return;
      log(`${signal}: stopping`);
      clearTimeout(debounce);
      // Push pending local edits before leaving.
      // The last edits may not have produced an event yet: always scan once.
      schedule(true, false);
      while (running) await running;
      stopped = true;
      clearInterval(rescan);
      clearInterval(poll);
      clearTimeout(retry);
      watcher?.close();
      connection.stop();
      resolve();
    };
    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
  });
};
