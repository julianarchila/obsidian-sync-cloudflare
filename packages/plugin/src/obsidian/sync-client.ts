/**
 * Runs the engine inside Obsidian: debounces local changes, listens for
 * server pushes over a WebSocket (`Connection`: reconnects with backoff and
 * after sleep), and rescans periodically. Syncs never overlap (the engine
 * holds a lock).
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { Connection, type Timers } from "../core/connection.ts";
import { type Engine, type EngineOptions, makeEngine, type SyncReport } from "../core/engine.ts";
import { makeHttpRemote, socketUrl } from "../core/http-remote.ts";
import { LocalState, Remote, VaultIo, type LocalStateShape, type VaultIoShape } from "../core/services.ts";
import { obsidianHttp } from "./adapters.ts";

export interface SyncClientOptions {
  readonly serverUrl: string;
  readonly vaultId: string;
  readonly token: string;
  readonly vaultIo: VaultIoShape;
  readonly localState: LocalStateShape;
  readonly engine: EngineOptions;
  /** Re-read the whole index before the first sync (selective-sync settings changed). */
  readonly resetCursor?: boolean;
  readonly onStatus: (status: string) => void;
  readonly onReport?: (report: SyncReport) => void;
  readonly onError?: (message: string) => void;
}

const DEBOUNCE_MS = 1500;
/** Local-only safety rescan (no network unless something changed). */
const RESCAN_MS = 5 * 60 * 1000;

const timers: Timers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (id) => window.clearTimeout(id),
  setInterval: (fn, ms) => window.setInterval(fn, ms),
  clearInterval: (id) => window.clearInterval(id),
};

/**
 * Idle cost is zero: with the socket open, the server announces every new
 * `seq`, so we only ask for changes when one is newer than our cursor (or
 * when the socket was down). Local scans touch the network only to push
 * real changes.
 */
export class SyncClient {
  engine: Engine | undefined;
  private layer: Layer.Layer<VaultIo | Remote | LocalState> | undefined;
  private connection: Connection | undefined;
  private stopped = false;
  private dirty = new Set<string>();
  private debounce: number | undefined;
  private rescan: number | undefined;
  /** Latest seq announced by the server over the socket. */
  private remoteSeq = 0;
  private running: Promise<void> | undefined;
  private queued: { full: boolean; pull: boolean; dirty: Set<string> } | undefined;

  constructor(private readonly o: SyncClientOptions) {}

  async start() {
    const remote = makeHttpRemote({ ...this.o, http: obsidianHttp });
    const layer = (this.layer = Layer.mergeAll(
      Layer.succeed(VaultIo, this.o.vaultIo),
      Layer.succeed(Remote, remote),
      Layer.succeed(LocalState, this.o.localState),
    ));
    this.engine = await Effect.runPromise(makeEngine(this.o.engine).pipe(Effect.provide(layer)));
    if (this.o.resetCursor) await Effect.runPromise(this.engine.resetCursor);
    this.connection = new Connection({
      open: () => new WebSocket(socketUrl(this.o)),
      timers,
      // Push whatever changed while we were away, and catch up.
      onOpen: () => this.schedule(true, true),
      onSeq: (seq) => {
        this.remoteSeq = Math.max(this.remoteSeq, seq);
        if (this.remoteSeq > (this.engine?.state.cursor ?? 0)) this.schedule(false, true);
      },
      onState: (state) => {
        if (state !== "open") this.o.onStatus(state);
      },
      log: (message) => console.log(`[homebase] ${message}`),
    });
    this.connection.start();
    window.addEventListener("online", this.onOnline);
    document.addEventListener("visibilitychange", this.onVisible);
    this.rescan = window.setInterval(() => this.schedule(true, false), RESCAN_MS);
  }

  private readonly onOnline = () => this.connection?.check("back online");
  /** Mobile apps are suspended in the background: check the socket when shown again. */
  private readonly onVisible = () => {
    if (document.visibilityState === "visible") this.connection?.check("app shown");
  };

  /** Run an effect with this vault's services (history, recovery). */
  withServices<A, E>(effect: Effect.Effect<A, E, VaultIo | Remote | LocalState>): Promise<A> {
    if (!this.layer) return Promise.reject(new Error("Not connected"));
    return Effect.runPromise(effect.pipe(Effect.provide(this.layer)));
  }

  stop() {
    this.stopped = true;
    window.clearTimeout(this.debounce);
    window.clearInterval(this.rescan);
    window.removeEventListener("online", this.onOnline);
    document.removeEventListener("visibilitychange", this.onVisible);
    this.connection?.stop();
  }

  private get online() {
    return this.connection?.open ?? false;
  }

  /** Is there anything on the server we haven't pulled? */
  private get behind() {
    return !this.online || this.remoteSeq > (this.engine?.state.cursor ?? 0);
  }

  /** A local file changed (create/modify/delete/rename). */
  markDirty(...paths: string[]) {
    for (const path of paths) this.dirty.add(path);
    window.clearTimeout(this.debounce);
    this.debounce = window.setTimeout(() => this.schedule(false, this.behind), DEBOUNCE_MS);
  }

  /** Full sync: pull, then scan the whole vault. */
  fullSync() {
    this.schedule(true, true);
    return this.running ?? Promise.resolve();
  }

  private schedule(full: boolean, pull: boolean) {
    const dirty = this.dirty;
    this.dirty = new Set();
    if (this.running) {
      this.queued ??= { full: false, pull: false, dirty: new Set() };
      this.queued.full ||= full;
      this.queued.pull ||= pull;
      for (const p of dirty) this.queued.dirty.add(p);
      return;
    }
    this.running = this.run(full ? undefined : dirty, pull).finally(() => {
      this.running = undefined;
      const next = this.queued;
      this.queued = undefined;
      if (next && !this.stopped) {
        for (const p of next.dirty) this.dirty.add(p);
        this.schedule(next.full, next.pull || this.behind);
      }
    });
  }

  private async run(dirty: Set<string> | undefined, pull: boolean) {
    if (!this.engine || this.stopped) return;
    // Nothing to pull and nothing dirty: a periodic scan stays local and silent.
    const quiet = !pull && dirty === undefined;
    if (!quiet) this.o.onStatus("syncing");
    try {
      // Edits made while a long pull runs are handed to the engine between large downloads.
      const takeDirty = () => {
        const taken = this.dirty;
        this.dirty = new Set();
        return taken;
      };
      const report = await Effect.runPromise(this.engine.sync(dirty, { pull, takeDirty }));
      this.o.onReport?.(report);
      this.o.onStatus(this.online ? "synced" : "offline");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.o.onStatus("offline");
      this.o.onError?.(message);
      // Keep the paths for the next attempt.
      if (dirty) for (const p of dirty) this.dirty.add(p);
    }
  }
}
