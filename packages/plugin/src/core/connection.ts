/**
 * The live WebSocket to the vault's Durable Object: connect, keep-alive,
 * reconnect with backoff, and notice when this device slept or came back
 * online. No Obsidian imports, so it is tested with a fake socket and clock.
 *
 * A socket can look open after the machine slept while the server already
 * dropped it, and closing a dead socket may not fire `close` for a long time.
 * So a missing pong, a clock jump (wake from sleep) or a failed probe drop
 * the socket immediately and reconnect; every new connection catches up
 * (`onOpen`). Probes are pings, answered by the Durable Object's
 * auto-response without waking it, so idle stays free.
 */

export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
}

export interface Timers {
  now(): number;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number | undefined): void;
  setInterval(fn: () => void, ms: number): number;
  clearInterval(id: number | undefined): void;
}

export type ConnectionState = "connecting" | "open" | "offline";

export interface ConnectionOptions {
  readonly open: () => SocketLike;
  readonly timers: Timers;
  /** Connected (first time or again): catch up with whatever changed meanwhile. */
  readonly onOpen: () => void;
  /** The server announced its latest `seq`. */
  readonly onSeq: (seq: number) => void;
  readonly onState: (state: ConnectionState) => void;
  readonly log?: (message: string) => void;
}

const OPEN = 1;
/** Keep-alive interval and how long to wait for its pong. */
export const PING_MS = 60_000;
export const PONG_TIMEOUT_MS = 15_000;
/** A probe (after wake, back online, app shown) expects a fast answer. */
export const PROBE_TIMEOUT_MS = 5_000;
/** The wake detector ticks this often... */
export const TICK_MS = 10_000;
/** ...and a tick this late means the timers were frozen (sleep, app suspended). */
export const WAKE_GAP_MS = 30_000;
const BACKOFF_MIN_MS = 2_000;
const BACKOFF_MAX_MS = 60_000;

export class Connection {
  private socket: SocketLike | undefined;
  private stopped = false;
  private backoff = BACKOFF_MIN_MS;
  private retry: number | undefined;
  private ping: number | undefined;
  private deadline: number | undefined;
  private deadlineAt = 0;
  private tick: number | undefined;
  private lastTick = 0;

  constructor(private readonly o: ConnectionOptions) {}

  get open() {
    return this.socket?.readyState === OPEN;
  }

  start() {
    this.stopped = false;
    this.lastTick = this.o.timers.now();
    this.tick = this.o.timers.setInterval(() => this.onTick(), TICK_MS);
    this.connect();
  }

  stop() {
    this.stopped = true;
    const t = this.o.timers;
    t.clearInterval(this.tick);
    t.clearTimeout(this.retry);
    this.drop();
  }

  /**
   * Is the connection still alive? Called after a wake, when the network comes
   * back or the app is shown again. Reconnects now if it is down (skipping the
   * backoff), otherwise pings and reconnects if no pong arrives quickly.
   */
  check(reason: string) {
    if (this.stopped) return;
    if (!this.open) {
      if (this.socket?.readyState === 0) return; // already connecting
      this.o.log?.(`${reason}: reconnecting`);
      this.backoff = BACKOFF_MIN_MS;
      this.connect();
      return;
    }
    this.sendPing(PROBE_TIMEOUT_MS, reason);
  }

  private onTick() {
    const now = this.o.timers.now();
    const gap = now - this.lastTick;
    this.lastTick = now;
    if (gap > TICK_MS + WAKE_GAP_MS) this.check(`woke up after ${Math.round(gap / 1000)}s`);
  }

  private connect() {
    if (this.stopped) return;
    const t = this.o.timers;
    t.clearTimeout(this.retry);
    this.drop();
    this.o.onState("connecting");
    const socket = this.o.open();
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.backoff = BACKOFF_MIN_MS;
      this.o.onState("open");
      this.o.onOpen();
      this.ping = t.setInterval(() => this.sendPing(PONG_TIMEOUT_MS, "keep-alive"), PING_MS);
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      // Anything from the server proves the connection is alive.
      this.clearDeadline();
      if (event.data === "pong") return;
      try {
        const message = JSON.parse(String(event.data)) as { type?: string; seq?: number };
        if (message.type === "seq") this.o.onSeq(message.seq ?? 0);
      } catch {
        // ignore
      }
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.down();
    };
    socket.onerror = () => {
      if (this.socket !== socket) return;
      this.down();
    };
  }

  private sendPing(timeoutMs: number, reason: string) {
    const socket = this.socket;
    if (!socket || socket.readyState !== OPEN) return;
    const t = this.o.timers;
    try {
      socket.send("ping");
    } catch {
      return this.down();
    }
    // A pending, sooner deadline (a probe) wins over a later one (keep-alive).
    const at = t.now() + timeoutMs;
    if (this.deadline !== undefined && this.deadlineAt <= at) return;
    this.clearDeadline();
    this.deadlineAt = at;
    this.deadline = t.setTimeout(() => {
      this.deadline = undefined;
      if (this.socket !== socket) return;
      this.o.log?.(`${reason}: no answer from the server, reconnecting`);
      // Don't wait for `close`: on a dead connection it can take minutes.
      this.backoff = BACKOFF_MIN_MS;
      this.connect();
    }, timeoutMs);
  }

  /** The socket is gone: retry with backoff. */
  private down() {
    this.drop();
    if (this.stopped) return;
    this.o.onState("offline");
    const t = this.o.timers;
    t.clearTimeout(this.retry);
    this.retry = t.setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
  }

  private clearDeadline() {
    this.o.timers.clearTimeout(this.deadline);
    this.deadline = undefined;
  }

  /** Forget the current socket without reacting to its events. */
  private drop() {
    this.o.timers.clearInterval(this.ping);
    this.clearDeadline();
    const socket = this.socket;
    this.socket = undefined;
    if (!socket) return;
    socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
    try {
      socket.close();
    } catch {
      // already closed
    }
  }
}
