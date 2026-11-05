/**
 * Headless test rig: a real `VaultStore` (bun:sqlite) behind an in-memory
 * `Remote`, plus in-memory devices. Each device runs the real engine.
 */
import { Database } from "bun:sqlite";

import { bunSql } from "../../server/src/sql-bun.ts";
import { VaultStore } from "../../server/src/store.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { decodeText, encodeText, sha256 } from "../src/core/bytes.ts";
import { type EngineOptions, makeEngine } from "../src/core/engine.ts";
import { plainCodec } from "../src/core/plain-codec.ts";
import {
  Codec,
  type CodecShape,
  type FileStat,
  LocalState,
  Remote,
  RemoteError,
  type RemoteShape,
  type SyncState,
  VaultIo,
} from "../src/core/services.ts";

export class Server {
  readonly store = new VaultStore(bunSql(new Database(":memory:")));
  readonly blobs = new Map<string, Uint8Array>();
  online = true;
  /** Every remote call made by any device (to assert idle behaviour). */
  requests = 0;

  remote(): RemoteShape {
    const raw = this.rawRemote();
    const count = <A extends unknown[], R>(f: (...a: A) => R) => (...a: A): R => {
      this.requests++;
      return f(...a);
    };
    return {
      changes: count(raw.changes),
      commit: count(raw.commit),
      history: count(raw.history),
      get deleted() {
        return raw.deleted;
      },
      meta: count(raw.meta),
      replaceMeta: count(raw.replaceMeta),
      putBlob: count(raw.putBlob),
      getBlob: count(raw.getBlob),
    };
  }

  private rawRemote(): RemoteShape {
    const guard = <A>(f: () => A) =>
      this.online ? Effect.sync(f) : Effect.fail(new RemoteError({ message: "offline" }));
    return {
      changes: (since) => guard(() => this.store.changes(since, 50)),
      commit: (ops) => guard(() => this.store.commit(ops)),
      history: (pathId) => guard(() => this.store.history(pathId)),
      deleted: guard(() => this.store.deleted()),
      meta: (init) => guard(() => this.store.meta(init)),
      replaceMeta: (expected, next) => guard(() => this.store.replaceMeta(expected, next)),
      putBlob: (hash, data) =>
        this.online
          ? sha256(data).pipe(
              Effect.flatMap((actual) =>
                actual === hash
                  ? Effect.sync(() => void this.blobs.set(hash, data.slice()))
                  : Effect.fail(new RemoteError({ message: "hash mismatch", status: 422 })),
              ),
            )
          : Effect.fail(new RemoteError({ message: "offline" })),
      getBlob: (hash) => {
        const blob = this.blobs.get(hash);
        if (!this.online) return Effect.fail(new RemoteError({ message: "offline" }));
        return blob ? Effect.succeed(blob.slice()) : Effect.fail(new RemoteError({ message: "missing", status: 404 }));
      },
    };
  }
}

let clock = 1_000_000;
const tick = () => (clock += 1000);

export class Device {
  readonly files = new Map<string, { data: Uint8Array; mtime: number }>();
  state: SyncState = { cursor: 0, base: {} };
  engine!: Effect.Success<ReturnType<typeof makeEngine>>;

  readonly remote: RemoteShape;

  constructor(
    readonly name: string,
    remote: Server | RemoteShape,
    readonly options: Partial<EngineOptions> = {},
    readonly codec: CodecShape = plainCodec,
  ) {
    this.remote = remote instanceof Server ? remote.remote() : remote;
  }

  private layer() {
    const files = this.files;
    const stat = (path: string): FileStat | null => {
      const f = files.get(path);
      return f ? { path, mtime: f.mtime, size: f.data.byteLength } : null;
    };
    return Layer.mergeAll(
      Layer.succeed(VaultIo, {
        list: Effect.sync(() => [...files.keys()].map((p) => stat(p)!)),
        stat: (path) => Effect.sync(() => stat(path)),
        read: (path) => Effect.sync(() => files.get(path)?.data.slice() ?? null),
        write: (path, data) =>
          Effect.sync(() => {
            files.set(path, { data: data.slice(), mtime: tick() });
            return stat(path)!;
          }),
        remove: (path) => Effect.sync(() => void files.delete(path)),
      }),
      Layer.succeed(Remote, this.remote),
      Layer.succeed(Codec, this.codec),
      Layer.succeed(LocalState, {
        load: Effect.sync(() => this.state),
        save: (s) => Effect.sync(() => void (this.state = structuredClone(s))),
      }),
    );
  }

  async start() {
    this.engine = await Effect.runPromise(
      makeEngine({ device: this.name, isSyncable: () => true, ...this.options }).pipe(Effect.provide(this.layer())),
    );
    return this;
  }

  sync(dirty?: Iterable<string>) {
    return Effect.runPromise(this.engine.sync(dirty ? new Set(dirty) : undefined));
  }

  write(path: string, text: string | Uint8Array) {
    this.files.set(path, { data: typeof text === "string" ? encodeText(text) : text, mtime: tick() });
  }

  read(path: string) {
    const f = this.files.get(path);
    return f ? decodeText(f.data) : undefined;
  }

  remove(path: string) {
    this.files.delete(path);
  }

  rename(from: string, to: string) {
    const f = this.files.get(from)!;
    this.files.delete(from);
    this.files.set(to, { ...f, mtime: tick() });
  }

  /** Sorted `path => text` view, for convergence assertions. */
  snapshot() {
    return Object.fromEntries([...this.files.keys()].sort().map((p) => [p, this.read(p)]));
  }
}

export const setup = async (n = 2, options: Partial<EngineOptions> = {}, codec?: () => CodecShape) => {
  const server = new Server();
  const devices = await Promise.all(
    Array.from({ length: n }, (_, i) => new Device(`dev${i + 1}`, server, options, codec?.()).start()),
  );
  return { server, devices };
};
