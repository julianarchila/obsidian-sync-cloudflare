/**
 * Server-side access to one vault's files, for the MCP endpoint.
 *
 * The Worker acts as one more device: it reads chunks from R2, uploads new
 * ones and commits through the Durable Object with the same compare-and-swap
 * as the plugin, so connected devices are notified and pull the change.
 * Requires the plain (unencrypted) vault format.
 */
import { CHUNK_SIZE, type Entry, type Op, type OpResult } from "@oscf/protocol";

export const PLAIN_FORMAT = "plain-v1";

export interface FileMeta {
  readonly path: string;
  readonly hash: string;
  readonly size: number;
  readonly mtime: number;
}

export interface FileInfo extends FileMeta {
  readonly entry: Entry;
}

export interface VaultBackend {
  /** Call a Durable Object route (`/changes`, `/commit`, ...). */
  readonly call: (route: string, init?: { method?: string; body?: string }) => Promise<Response>;
  readonly getBlob: (hash: string) => Promise<Uint8Array | null>;
  readonly hasBlob: (hash: string) => Promise<boolean>;
  readonly putBlob: (hash: string, bytes: Uint8Array) => Promise<void>;
}

export class VaultOpsError extends Error {}
export class VaultNotFound extends VaultOpsError {}

const TEXT_EXT = /\.(md|txt|canvas|base|json|csv)$/i;
const INDEX_EXT = /\.(md|txt)$/i;
/** Larger notes are not indexed (memory). */
const MAX_INDEX_BYTES = 2 * 1024 * 1024;

export const isTextPath = (path: string) => TEXT_EXT.test(path);

const hex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
export const sha256 = async (bytes: Uint8Array) =>
  hex(await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer));

export const encode = (text: string) => new TextEncoder().encode(text);
export const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

export const parseMeta = (meta: string): FileMeta | null => {
  try {
    const parsed = JSON.parse(meta) as Partial<FileMeta>;
    return typeof parsed.path === "string" ? (parsed as FileMeta) : null;
  } catch {
    return null;
  }
};

const info = (entry: Entry): FileInfo | null => {
  const meta = parseMeta(entry.meta);
  return meta ? { ...meta, entry } : null;
};

export type PutResult = { ok: true; file: FileInfo } | { ok: false; current: FileInfo | null };

export const makeVaultOps = (backend: VaultBackend, device: string) => {
  const json = async <A>(route: string, init?: { method?: string; body?: string }): Promise<A> => {
    const response = await backend.call(route, init);
    if (!response.ok) throw new VaultOpsError(`vault ${route}: ${response.status} ${await response.text()}`);
    return (await response.json()) as A;
  };

  /** Check the vault exists and is plain. MCP never creates vaults (a typo would look like an empty vault). */
  const ensurePlain = async () => {
    const { meta } = await json<{ meta: string | null }>("/meta");
    if (meta === null) throw new VaultNotFound("This vault does not exist yet. Check the vault id in the MCP URL (it must match your devices).");
    let format: unknown;
    try {
      format = (JSON.parse(meta) as { format?: unknown }).format;
    } catch {
      format = null;
    }
    if (format !== PLAIN_FORMAT)
      throw new VaultOpsError("This vault uses end-to-end encryption, so the server cannot read it.");
  };

  /** Every live file (latest version per path). */
  const files = async (): Promise<FileInfo[]> => {
    const out: FileInfo[] = [];
    let since = 0;
    for (;;) {
      const page = await json<{ entries: Entry[]; seq: number; more: boolean }>(`/changes?since=${since}&limit=5000`);
      for (const entry of page.entries) {
        if (entry.deleted) continue;
        const file = info(entry);
        if (file) out.push(file);
      }
      if (!page.more) break;
      since = page.seq;
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  };

  /** All retained versions of a path, newest first (including tombstones). */
  const history = async (path: string): Promise<FileInfo[]> => {
    const { entries } = await json<{ entries: Entry[] }>(`/history?path=${encodeURIComponent(path)}`);
    return entries.map(info).filter((f): f is FileInfo => f !== null);
  };

  /** Latest version, or null if the path never existed. May be a tombstone. */
  const head = async (path: string) => (await history(path))[0] ?? null;

  const current = async (path: string) => {
    const file = await head(path);
    return file && !file.entry.deleted ? file : null;
  };

  const content = async (file: FileInfo): Promise<Uint8Array> => {
    const parts = await Promise.all(
      file.entry.chunks.map(async (hash) => {
        const bytes = await backend.getBlob(hash);
        if (bytes === null) throw new VaultOpsError(`missing blob for ${file.path}`);
        return bytes;
      }),
    );
    const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.byteLength;
    }
    return out;
  };

  const text = async (file: FileInfo) => decode(await content(file));

  const commit = async (op: Op): Promise<OpResult> => {
    const { results } = await json<{ results: OpResult[] }>("/commit", {
      method: "POST",
      body: JSON.stringify({ ops: [op] }),
    });
    return results[0]!;
  };

  const sealMeta = (meta: FileMeta) => JSON.stringify(meta);

  const toResult = (result: OpResult, index = 0): PutResult => {
    if (result.ok) return { ok: true, file: info(result.entries[index]!)! };
    const current = result.current && !result.current.deleted ? info(result.current) : null;
    return { ok: false, current };
  };

  /** Write a new version. `baseVersion` null means "create" (path absent or deleted). */
  const put = async (path: string, bytes: Uint8Array, baseVersion: number | null): Promise<PutResult> => {
    const chunks: string[] = [];
    for (let i = 0; i < Math.max(bytes.byteLength, 1); i += CHUNK_SIZE) {
      const chunk = bytes.subarray(i, i + CHUNK_SIZE);
      const hash = await sha256(chunk);
      if (!(await backend.hasBlob(hash))) await backend.putBlob(hash, chunk);
      chunks.push(hash);
    }
    const meta = { path, hash: await sha256(bytes), size: bytes.byteLength, mtime: Date.now() };
    const result = toResult(
      await commit({ op: "put", path, baseVersion, chunks, meta: sealMeta(meta), device }),
    );
    if (result.ok) await indexNow(result.file, isIndexable(path) ? decode(bytes) : null);
    return result;
  };

  const remove = async (path: string, baseVersion: number) => toResult(await commit({ op: "remove", path, baseVersion, device }));

  const rename = async (from: FileInfo, to: string) => {
    const meta = { path: to, hash: from.hash, size: from.size, mtime: Date.now() };
    return toResult(
      await commit({ op: "rename", from: from.path, to, baseVersion: from.entry.version, meta: sealMeta(meta), device }),
      1,
    );
  };

  const movedFrom = async (path: string) =>
    (await json<{ paths: string[] }>(`/moved-from?path=${encodeURIComponent(path)}`)).paths;

  const recent = async (limit: number, since = 0) => {
    const { entries } = await json<{ entries: Entry[] }>(`/recent?limit=${limit}&since=${since}`);
    return entries.map(info).filter((f): f is FileInfo => f !== null);
  };

  const deleted = async () => {
    const { entries } = await json<{ entries: Entry[] }>("/deleted");
    return entries.map(info).filter((f): f is FileInfo => f !== null);
  };

  // ---------------------------------------------------------------- search

  const isIndexable = (path: string) => INDEX_EXT.test(path);

  const indexNow = async (file: FileInfo, body: string | null) => {
    await json("/index", {
      method: "POST",
      body: JSON.stringify({ docs: [{ pathId: file.entry.path, seq: file.entry.seq, path: file.path, text: body }] }),
    });
  };

  /** Index what devices wrote since the last search, up to `budget` documents. Returns the backlog left. */
  const catchUpIndex = async (budget: number) => {
    let left = budget;
    for (;;) {
      const { docs, backlog } = await json<{
        docs: Array<{ pathId: string; seq: number; deleted: boolean; chunks: string[]; meta: string }>;
        backlog: number;
      }>(`/index/pending?limit=${Math.min(left, 20)}`);
      if (docs.length === 0 || left <= 0) return backlog;
      // Sequential (Worker subrequest and memory limits); a broken document is
      // indexed as empty instead of blocking every later search.
      const indexed: Array<{ pathId: string; seq: number; path: string | null; text: string | null }> = [];
      for (const doc of docs) {
        const meta = parseMeta(doc.meta);
        let body: string | null = null;
        if (!doc.deleted && meta && isIndexable(meta.path) && meta.size <= MAX_INDEX_BYTES) {
          try {
            body = await text({ ...meta, entry: { chunks: doc.chunks } as unknown as Entry });
          } catch {
            body = null;
          }
        }
        indexed.push({ pathId: doc.pathId, seq: doc.seq, path: body === null ? null : meta!.path, text: body });
      }
      const result = await json<{ backlog: number }>("/index", { method: "POST", body: JSON.stringify({ docs: indexed }) });
      left -= docs.length;
      if (result.backlog === 0) return 0;
    }
  };

  const search = async (query: string, limit: number) =>
    json<{ hits: Array<{ path: string; snippet: string }>; backlog: number }>(
      `/search?q=${encodeURIComponent(query)}&limit=${limit}`,
    );

  return {
    ensurePlain,
    files,
    history,
    head,
    current,
    content,
    text,
    put,
    remove,
    rename,
    movedFrom,
    recent,
    deleted,
    catchUpIndex,
    search,
  };
};

export type VaultOps = ReturnType<typeof makeVaultOps>;
