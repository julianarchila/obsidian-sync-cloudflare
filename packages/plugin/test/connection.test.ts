import { describe, expect, test } from "bun:test";

import { Connection, type ConnectionState, PING_MS, PONG_TIMEOUT_MS, PROBE_TIMEOUT_MS, type SocketLike, TICK_MS, type Timers } from "../src/core/connection.ts";

/** Timers on a fake clock. `freeze` models sleep: time jumps, each due timer then fires once. */
class FakeClock implements Timers {
  t = 0;
  private nextId = 1;
  private timers = new Map<number, { at: number; fn: () => void; every?: number }>();
  now = () => this.t;
  setTimeout = (fn: () => void, ms: number) => this.add(fn, ms);
  setInterval = (fn: () => void, ms: number) => this.add(fn, ms, ms);
  clearTimeout = (id: number | undefined) => void (id !== undefined && this.timers.delete(id));
  clearInterval = (id: number | undefined) => void (id !== undefined && this.timers.delete(id));
  private add(fn: () => void, ms: number, every?: number) {
    const id = this.nextId++;
    this.timers.set(id, { at: this.t + ms, fn, every });
    return id;
  }
  private fireDue(limit: number) {
    for (;;) {
      const due = [...this.timers.entries()].filter(([, x]) => x.at <= limit).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) return;
      const [id, timer] = due;
      this.t = Math.max(this.t, timer.at);
      if (timer.every) timer.at = this.t + timer.every;
      else this.timers.delete(id);
      timer.fn();
    }
  }
  /** Run normally for `ms`. */
  advance(ms: number) {
    const end = this.t + ms;
    this.fireDue(end);
    this.t = end;
  }
  /** The machine sleeps for `ms`: no timer runs, then every overdue timer fires once. */
  freeze(ms: number) {
    this.t += ms;
    for (const timer of this.timers.values()) if (timer.at < this.t) timer.at = this.t;
    this.fireDue(this.t);
  }
}

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: string[] = [];
  closed = false;
  /** A dead connection (after sleep) still looks open but nothing comes back. */
  dead = false;
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  accept() {
    this.readyState = 1;
    this.onopen?.({} as Event);
  }
  receive(data: string) {
    this.onmessage?.({ data } as MessageEvent);
  }
  fail() {
    this.readyState = 3;
    this.onclose?.({} as CloseEvent);
  }
}

const setup = (autoAccept = true) => {
  const clock = new FakeClock();
  const sockets: FakeSocket[] = [];
  const states: ConnectionState[] = [];
  let opens = 0;
  const seqs: number[] = [];
  const connection = new Connection({
    timers: clock,
    open: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      // The server answers pings with pongs, unless the connection is dead.
      const send = socket.send.bind(socket);
      socket.send = (data) => {
        send(data);
        if (data === "ping" && !socket.dead) queueMicrotask(() => socket.receive("pong"));
      };
      if (autoAccept) queueMicrotask(() => socket.accept());
      return socket;
    },
    onOpen: () => opens++,
    onSeq: (seq) => seqs.push(seq),
    onState: (state) => states.push(state),
  });
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const last = () => sockets[sockets.length - 1]!;
  return { clock, sockets, states, seqs, connection, flush, last, opens: () => opens };
};

describe("connection", () => {
  test("connects, catches up on open and forwards seq announcements", async () => {
    const h = setup();
    h.connection.start();
    await h.flush();
    expect(h.opens()).toBe(1);
    expect(h.connection.open).toBe(true);
    h.last().receive(JSON.stringify({ type: "seq", seq: 42 }));
    expect(h.seqs).toEqual([42]);
  });

  test("idle with a healthy socket: only keep-alive pings, no reconnects", async () => {
    const h = setup();
    h.connection.start();
    await h.flush();
    for (let i = 0; i < 60; i++) {
      h.clock.advance(TICK_MS);
      await h.flush();
    }
    expect(h.sockets.length).toBe(1);
    expect(h.opens()).toBe(1);
    expect(h.last().sent.every((m) => m === "ping")).toBe(true);
    expect(h.last().sent.length).toBe((60 * TICK_MS) / PING_MS);
  });

  test("wake from sleep: a dead socket that still looks open is replaced right away, and catches up", async () => {
    const h = setup();
    h.connection.start();
    await h.flush();
    // The lid closes for 20 minutes; meanwhile the server drops the connection.
    h.last().dead = true;
    h.clock.freeze(20 * 60_000);
    await h.flush();
    // The clock jump triggers a probe; no pong within the probe timeout -> new socket.
    h.clock.advance(PROBE_TIMEOUT_MS);
    await h.flush();
    expect(h.sockets.length).toBe(2);
    expect(h.sockets[0]!.closed).toBe(true);
    expect(h.opens()).toBe(2); // the new connection pulls what changed while asleep
    expect(h.connection.open).toBe(true);
  });

  test("wake from sleep with a socket that survived: one ping, no reconnect", async () => {
    const h = setup();
    h.connection.start();
    await h.flush();
    h.clock.freeze(5 * 60_000);
    await h.flush();
    h.clock.advance(PROBE_TIMEOUT_MS + 1000);
    await h.flush();
    expect(h.sockets.length).toBe(1);
    expect(h.opens()).toBe(1);
  });

  test("a missing keep-alive pong reconnects without waiting for close", async () => {
    const h = setup();
    h.connection.start();
    await h.flush();
    h.last().dead = true;
    h.clock.advance(PING_MS + PONG_TIMEOUT_MS);
    await h.flush();
    expect(h.sockets.length).toBe(2);
    expect(h.opens()).toBe(2);
  });

  test("closed socket retries with backoff; back online retries at once", async () => {
    const h = setup(false);
    h.connection.start();
    h.last().fail();
    expect(h.states.at(-1)).toBe("offline");
    h.clock.advance(1999);
    expect(h.sockets.length).toBe(1);
    h.clock.advance(1);
    expect(h.sockets.length).toBe(2);
    h.last().fail(); // next retry in 4 s
    h.clock.advance(1000);
    expect(h.sockets.length).toBe(2);
    h.connection.check("back online");
    expect(h.sockets.length).toBe(3);
    h.last().accept();
    expect(h.opens()).toBe(1);
  });

  test("stop closes the socket and never reconnects", async () => {
    const h = setup();
    h.connection.start();
    await h.flush();
    h.connection.stop();
    expect(h.sockets[0]!.closed).toBe(true);
    h.clock.advance(10 * 60_000);
    h.connection.check("back online");
    expect(h.sockets.length).toBe(1);
  });
});
