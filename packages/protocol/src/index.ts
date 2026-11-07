/**
 * Wire contract between the Cloudflare server and the Obsidian plugin.
 *
 * The server only sees opaque values: `path` is a path id (an HMAC of the real
 * path once end-to-end encryption is on), `meta` is a sealed blob the client
 * understands, and `chunks` are content-addressed R2 keys (hashes of ciphertext).
 *
 * Import Effect by module (never the `effect` barrel) so the plugin bundle
 * stays small. See docs/SCOPE.md.
 */
import * as Schema from "effect/Schema";

/** Vault ids appear in URLs and R2 keys, so keep them boring. */
export const VaultId = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,62}$/));

/** Lowercase hex SHA-256: blob keys in R2. */
export const BlobHash = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
const isBlobHash = Schema.is(BlobHash);
export const isValidBlobHash = (value: string) => isBlobHash(value);

const Version = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

/** Opaque path id: what the server indexes. */
export const PathId = Schema.String.check(Schema.isMaxLength(512));

/** One row of the change log: a single version of a single path. */
export const Entry = Schema.Struct({
  seq: Schema.Int,
  path: PathId,
  version: Version,
  /** Tombstone. Deleted files keep their entry so offline devices learn about the delete. */
  deleted: Schema.Boolean,
  /** Content chunks (R2 keys), in order. Empty for tombstones. */
  chunks: Schema.Array(BlobHash),
  /** Client-sealed metadata: real path, plaintext hash, size, mtime. */
  meta: Schema.String,
  device: Schema.String,
  createdAt: Schema.Number,
  /** Set on the tombstone a rename leaves behind: where the file went. */
  movedTo: Schema.optionalKey(PathId),
});
export type Entry = typeof Entry.Type;

// ---------------------------------------------------------------- commits

export const PutOp = Schema.Struct({
  op: Schema.Literal("put"),
  path: PathId,
  /** `null` means "I believe this path does not exist (or is deleted)". */
  baseVersion: Schema.NullOr(Version),
  chunks: Schema.Array(BlobHash),
  meta: Schema.String,
  device: Schema.String,
});

export const RemoveOp = Schema.Struct({
  op: Schema.Literal("remove"),
  path: PathId,
  baseVersion: Version,
  device: Schema.String,
});

export const RenameOp = Schema.Struct({
  op: Schema.Literal("rename"),
  from: PathId,
  to: PathId,
  baseVersion: Version,
  /** Sealed metadata for the new path (it is bound to the path id). */
  meta: Schema.String,
  device: Schema.String,
});

export const Op = Schema.Union([PutOp, RemoveOp, RenameOp]);
export type Op = typeof Op.Type;
export type PutOp = typeof PutOp.Type;
export type RemoveOp = typeof RemoveOp.Type;
export type RenameOp = typeof RenameOp.Type;

export const MAX_OPS_PER_COMMIT = 200;

export const CommitRequest = Schema.Struct({
  ops: Schema.Array(Op).check(Schema.isMaxLength(MAX_OPS_PER_COMMIT)),
});
export type CommitRequest = typeof CommitRequest.Type;

/**
 * Per-op outcome. On a conflict the server returns its current entry for the
 * contested path (`null` if the path never existed); the client resolves and
 * may retry. For renames, the entries are `[from, to]`.
 */
export const OpResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), entries: Schema.Array(Entry) }),
  Schema.Struct({ ok: Schema.Literal(false), path: PathId, current: Schema.NullOr(Entry) }),
]);
export type OpResult = typeof OpResult.Type;

export const CommitResponse = Schema.Struct({ results: Schema.Array(OpResult), seq: Schema.Int });
export type CommitResponse = typeof CommitResponse.Type;

// ---------------------------------------------------------------- reads

export const ChangesResponse = Schema.Struct({
  /** Latest version of each path changed after `since`, ordered by seq. */
  entries: Schema.Array(Entry),
  /** Cursor to continue from. */
  seq: Schema.Int,
  more: Schema.Boolean,
});
export type ChangesResponse = typeof ChangesResponse.Type;

export const EntriesResponse = Schema.Struct({ entries: Schema.Array(Entry) });
export type EntriesResponse = typeof EntriesResponse.Type;

/** Vault-level settings stored once, e.g. key-derivation parameters (opaque JSON). */
export const VaultMetaResponse = Schema.Struct({ meta: Schema.NullOr(Schema.String), created: Schema.Boolean });
export type VaultMetaResponse = typeof VaultMetaResponse.Type;

export const ReplaceMetaResponse = Schema.Struct({ meta: Schema.NullOr(Schema.String), replaced: Schema.Boolean });
export type ReplaceMetaResponse = typeof ReplaceMetaResponse.Type;

export const PruneResponse = Schema.Struct({ prunedVersions: Schema.Int, deletedBlobs: Schema.Int });
export type PruneResponse = typeof PruneResponse.Type;

/** Server -> client push over WebSocket: "the log advanced to `seq`". */
export const ServerMessage = Schema.Struct({ type: Schema.Literal("seq"), seq: Schema.Int });
export type ServerMessage = typeof ServerMessage.Type;

// ---------------------------------------------------------------- routes

export const CHUNK_SIZE = 8 * 1024 * 1024;
/** Upper bound for a single blob request (a padded, encrypted chunk). */
export const MAX_BLOB_BYTES = CHUNK_SIZE + 64 * 1024;

export const routes = {
  changes: (vault: string, since: number, limit = 1000) => `/v1/vaults/${vault}/changes?since=${since}&limit=${limit}`,
  commit: (vault: string) => `/v1/vaults/${vault}/commit`,
  history: (vault: string, path: string) => `/v1/vaults/${vault}/history?path=${encodeURIComponent(path)}`,
  deleted: (vault: string) => `/v1/vaults/${vault}/deleted`,
  meta: (vault: string) => `/v1/vaults/${vault}/meta`,
  replaceMeta: (vault: string) => `/v1/vaults/${vault}/meta/replace`,
  socket: (vault: string) => `/v1/vaults/${vault}/socket`,
  prune: (vault: string, days: number) => `/v1/vaults/${vault}/prune?days=${days}`,
  blob: (vault: string, hash: string) => `/v1/vaults/${vault}/blobs/${hash}`,
} as const;
