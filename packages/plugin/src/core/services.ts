/**
 * The sync engine's view of the world. Every service is a Context key, so the
 * engine runs against Obsidian in production and against in-memory fakes in
 * `bun test` (see test/harness.ts).
 *
 * Import Effect by module only (bundle budget, docs/SCOPE.md).
 */
import type { Entry, Op, OpResult } from "@oscf/protocol";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";

// ---------------------------------------------------------------- errors

/** Network or server failure; retried by the caller. */
export class RemoteError extends Data.TaggedError("RemoteError")<{ readonly message: string; readonly status?: number }> {}

/** Local filesystem failure. */
export class VaultError extends Data.TaggedError("VaultError")<{ readonly message: string; readonly path: string }> {}

/** Sealed data could not be opened: wrong key or tampered data. */
export class CodecError extends Data.TaggedError("CodecError")<{ readonly message: string }> {}

// ---------------------------------------------------------------- local vault

export interface FileStat {
  readonly path: string;
  readonly mtime: number;
  readonly size: number;
}

export interface VaultIoShape {
  /** All files the engine may consider (already excluding hidden/internal files). */
  readonly list: Effect.Effect<ReadonlyArray<FileStat>, VaultError>;
  readonly stat: (path: string) => Effect.Effect<FileStat | null, VaultError>;
  readonly read: (path: string) => Effect.Effect<Uint8Array | null, VaultError>;
  /** Create or overwrite, creating parent folders. Returns the new stat. */
  readonly write: (path: string, data: Uint8Array) => Effect.Effect<FileStat, VaultError>;
  readonly remove: (path: string) => Effect.Effect<void, VaultError>;
}

export class VaultIo extends Context.Service<VaultIo, VaultIoShape>()("oscf/VaultIo") {}

// ---------------------------------------------------------------- remote

export interface RemoteShape {
  readonly changes: (since: number) => Effect.Effect<{ entries: ReadonlyArray<Entry>; seq: number; more: boolean }, RemoteError>;
  readonly commit: (ops: ReadonlyArray<Op>) => Effect.Effect<ReadonlyArray<OpResult>, RemoteError>;
  readonly history: (pathId: string) => Effect.Effect<ReadonlyArray<Entry>, RemoteError>;
  readonly deleted: Effect.Effect<ReadonlyArray<Entry>, RemoteError>;
  /** Path ids this one was renamed from, newest first (servers without it: none). */
  readonly movedFrom?: (pathId: string) => Effect.Effect<ReadonlyArray<string>, RemoteError>;
  /** Read the vault meta, or create it when `init` is given and none exists. */
  readonly meta: (init?: string) => Effect.Effect<{ meta: string | null; created: boolean }, RemoteError>;
  /** Compare-and-swap the vault meta (password change). */
  readonly replaceMeta: (expected: string, next: string) => Effect.Effect<{ meta: string | null; replaced: boolean }, RemoteError>;
  readonly putBlob: (hash: string, data: Uint8Array) => Effect.Effect<void, RemoteError>;
  readonly getBlob: (hash: string) => Effect.Effect<Uint8Array, RemoteError>;
}

export class Remote extends Context.Service<Remote, RemoteShape>()("oscf/Remote") {}

// ---------------------------------------------------------------- codec (encryption)

/** What the server must not see, sealed into `Entry.meta`. */
export interface FileMeta {
  readonly path: string;
  /** SHA-256 hex of the plaintext. */
  readonly hash: string;
  readonly size: number;
  readonly mtime: number;
}

export interface CodecShape {
  /** Stable, opaque id for a path (what the server indexes). */
  readonly pathId: (path: string) => Effect.Effect<string>;
  readonly sealMeta: (pathId: string, meta: FileMeta) => Effect.Effect<string>;
  readonly openMeta: (pathId: string, sealed: string) => Effect.Effect<FileMeta, CodecError>;
  /** Encrypt one plaintext chunk into the bytes stored in R2. Deterministic, so identical chunks dedupe. */
  readonly sealChunk: (plain: Uint8Array) => Effect.Effect<Uint8Array>;
  readonly openChunk: (sealed: Uint8Array) => Effect.Effect<Uint8Array, CodecError>;
}

export class Codec extends Context.Service<Codec, CodecShape>()("oscf/Codec") {}

// ---------------------------------------------------------------- local state

/** What this device last agreed with the server, per real path. */
export interface BaseEntry {
  readonly pathId: string;
  readonly version: number;
  /** Plaintext hash. */
  readonly hash: string;
  /** Local stat at sync time: lets the scan skip unchanged files without hashing. */
  readonly size: number;
  readonly mtime: number;
  readonly chunks: ReadonlyArray<string>;
}

export interface SyncState {
  cursor: number;
  base: Record<string, BaseEntry>;
}

export interface LocalStateShape {
  readonly load: Effect.Effect<SyncState>;
  readonly save: (state: SyncState) => Effect.Effect<void>;
}

export class LocalState extends Context.Service<LocalState, LocalStateShape>()("oscf/LocalState") {}
