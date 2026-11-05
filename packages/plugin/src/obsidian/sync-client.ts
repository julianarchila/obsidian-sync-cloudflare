/**
 * Runs the engine inside Obsidian: debounces local changes, listens for
 * server pushes over a WebSocket, reconnects with backoff, and rescans
 * periodically. Syncs never overlap (the engine holds a lock).
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { type Engine, type EngineOptions, makeEngine, type SyncReport } from "../core/engine.ts";
import { makeHttpRemote, socketUrl } from "../core/http-remote.ts";
import { Codec, type CodecShape, LocalState, Remote, VaultIo, type LocalStateShape, type VaultIoShape } from "../core/services.ts";
import { obsidianHttp } from "./adapters.ts";

export interface SyncClientOptions {
  readonly serverUrl: string;
  readonly vaultId: string;
  readonly token: string;
  readonly vaultIo: VaultIoShape;
  readonly localState: LocalStateShape;
  readonly codec: CodecShape;
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
/** Keep-alive: answered by the Durable Object's auto-response, without waking it. */
const PING_MS = 60_000;
const PONG_TIMEOUT_MS = 15_000;

/**
 * Idle cost is zero: with the socket open, the server announces every new
 * `seq`, so we only ask for changes when one is newer than our cursor (or
 * when the socket was down). Local scans touch the network only to push
 * real changes.
 */
export class SyncClient {
  engine: Engine | undefined;
  private layer: Layer.Layer<VaultIo | Remote | Codec | LocalState> | undefined;
  private socket: WebSocket | undefined;
  private stopped = false;
  private dirty = new Set<string>();
  private debounce: number | undefined;
  private reconnect: number | undefined;
  private rescan: number | undefined;
  private ping: number | undefined;
  private pongDeadline: number | undefined;
  private backoff = 2000;
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
      Layer.succeed(Codec, this.o.codec),
      Layer.succeed(LocalState, this.o.localState),
    ));
    this.engine = await Effect.runPromise(makeEngine(this.o.engine).pipe(Effect.provide(layer)));
    if (this.o.resetCursor) await Effect.runPromise(this.engine.resetCursor);
    this.connect();
    this.rescan = window.setInterval(() => this.schedule(true, false), RESCAN_MS);
  }

  /** Run an effect with this vault's services (history, recovery). */
  withServices<A, E>(effect: Effect.Effect<A, E, VaultIo | Remote | Codec | LocalState>): Promise<A> {
    if (!this.layer) return Promise.reject(new Error("Not connected"));
    return Effect.runPromise(effect.pipe(Effect.provide(this.layer)));
  }

  stop() {
    this.stopped = true;
    window.clearTimeout(this.debounce);
    window.clearTimeout(this.reconnect);
    window.clearInterval(this.rescan);
    window.clearInterval(this.ping);
    window.clearTimeout(this.pongDeadline);
    this.socket?.close();
  }

  private get online() {
    return this.socket?.readyState === WebSocket.OPEN;
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
      const report = await Effect.runPromise(this.engine.sync(dirty, { pull }));
      this.o.onReport?.(report);
      this.o.onStatus(this.socket?.readyState === WebSocket.OPEN ? "synced" : "offline");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.o.onStatus("offline");
      this.o.onError?.(message);
      // Keep the paths for the next attempt.
      if (dirty) for (const p of dirty) this.dirty.add(p);
    }
  }

  private connect() {
    if (this.stopped) return;
    this.o.onStatus("connecting");
    const socket = new WebSocket(socketUrl(this.o));
    this.socket = socket;
    socket.onopen = () => {
      this.backoff = 2000;
      // Push whatever changed while we were away, and catch up.
      this.schedule(true, true);
      window.clearInterval(this.ping);
      this.ping = window.setInterval(() => {
        if (socket.readyState !== WebSocket.OPEN) return;
        socket.send("ping");
        window.clearTimeout(this.pongDeadline);
        // No pong: the connection is dead (sleep, network change). Reconnect.
        this.pongDeadline = window.setTimeout(() => socket.close(), PONG_TIMEOUT_MS);
      }, PING_MS);
    };
    socket.onmessage = (event) => {
      if (event.data === "pong") return window.clearTimeout(this.pongDeadline);
      try {
        const message = JSON.parse(String(event.data)) as { type?: string; seq?: number };
        if (message.type !== "seq") return;
        this.remoteSeq = Math.max(this.remoteSeq, message.seq ?? 0);
        if (this.remoteSeq > (this.engine?.state.cursor ?? 0)) this.schedule(false, true);
      } catch {
        // ignore
      }
    };
    socket.onclose = () => {
      window.clearInterval(this.ping);
      window.clearTimeout(this.pongDeadline);
      if (this.socket !== socket || this.stopped) return;
      this.o.onStatus("offline");
      this.reconnect = window.setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 60_000);
    };
    socket.onerror = () => socket.close();
  }
}
