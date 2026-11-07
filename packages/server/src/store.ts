/**
 * Vault change log: one SQLite row per accepted file version.
 *
 * Pure logic over a tiny synchronous SQL interface, so it runs unchanged on a
 * Durable Object's SQLite (`ctx.storage.sql`) and on `bun:sqlite` in tests.
 *
 *   versions   append-only log, `seq` is the global cursor
 *   head       latest seq per path (current state)
 *   chunk_refs reference counts for R2 blobs, for garbage collection
 *   kv         vault-level settings (e.g. key-derivation parameters)
 */
import type { Entry, Op, OpResult } from "@oscf/protocol";

export interface Sql {
  all<T = Record<string, unknown>>(query: string, ...params: unknown[]): T[];
  run(query: string, ...params: unknown[]): void;
  transaction<A>(f: () => A): A;
}

interface Row {
  seq: number;
  path: string;
  version: number;
  deleted: number;
  chunks: string;
  meta: string;
  device: string;
  created_at: number;
  moved_to: string | null;
}

const toEntry = (row: Row): Entry => ({
  seq: row.seq,
  path: row.path,
  version: row.version,
  deleted: row.deleted === 1,
  chunks: JSON.parse(row.chunks) as string[],
  meta: row.meta,
  device: row.device,
  createdAt: row.created_at,
  ...(row.moved_to ? { movedTo: row.moved_to } : {}),
});

const SELECT = "SELECT v.seq, v.path, v.version, v.deleted, v.chunks, v.meta, v.device, v.created_at, v.moved_to FROM versions v";

export class VaultStore {
  constructor(
    private readonly sql: Sql,
    private readonly now: () => number = Date.now,
  ) {
    sql.run(`CREATE TABLE IF NOT EXISTS versions (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL,
      version INTEGER NOT NULL,
      deleted INTEGER NOT NULL,
      chunks TEXT NOT NULL,
      meta TEXT NOT NULL,
      device TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`);
    // Added after the first release: tombstones left by renames point to the new path.
    if (!sql.all<{ name: string }>("PRAGMA table_info(versions)").some((c) => c.name === "moved_to"))
      sql.run("ALTER TABLE versions ADD COLUMN moved_to TEXT");
    sql.run("CREATE UNIQUE INDEX IF NOT EXISTS versions_path_version ON versions(path, version)");
    sql.run("CREATE TABLE IF NOT EXISTS head (path TEXT PRIMARY KEY, seq INTEGER NOT NULL)");
    sql.run("CREATE INDEX IF NOT EXISTS head_seq ON head(seq)");
    sql.run("CREATE TABLE IF NOT EXISTS chunk_refs (hash TEXT PRIMARY KEY, refs INTEGER NOT NULL)");
    sql.run("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
  }

  /** Latest seq in the log (0 when empty). */
  seq(): number {
    return this.sql.all<{ s: number | null }>("SELECT MAX(seq) AS s FROM versions")[0]?.s ?? 0;
  }

  current(path: string): Entry | null {
    const row = this.sql.all<Row>(`${SELECT} JOIN head h ON h.seq = v.seq WHERE h.path = ?`, path)[0];
    return row ? toEntry(row) : null;
  }

  /** Latest version of every path changed after `since`, in seq order. */
  changes(since: number, limit: number) {
    const rows = this.sql.all<Row>(
      `${SELECT} JOIN head h ON h.seq = v.seq WHERE h.seq > ? ORDER BY h.seq LIMIT ?`,
      since,
      limit + 1,
    );
    const more = rows.length > limit;
    const entries = rows.slice(0, limit).map(toEntry);
    const last = entries.at(-1);
    return { entries, seq: more && last ? last.seq : Math.max(since, this.seq()), more };
  }

  history(path: string): Entry[] {
    return this.sql.all<Row>(`${SELECT} WHERE v.path = ? ORDER BY v.version DESC`, path).map(toEntry);
  }

  /** Paths this one was renamed from (most recent first). */
  movedFrom(path: string): string[] {
    return this.sql
      .all<{ path: string }>("SELECT path FROM versions WHERE moved_to = ? ORDER BY seq DESC", path)
      .map((r) => r.path);
  }

  /** Newest versions first (every version, not just heads), optionally only after `since`. */
  recent(limit: number, since = 0): Entry[] {
    return this.sql.all<Row>(`${SELECT} WHERE v.seq > ? ORDER BY v.seq DESC LIMIT ?`, since, limit).map(toEntry);
  }

  deleted(): Entry[] {
    return this.sql
      .all<Row>(`${SELECT} JOIN head h ON h.seq = v.seq WHERE v.deleted = 1 AND v.moved_to IS NULL ORDER BY v.seq DESC LIMIT 1000`)
      .map(toEntry);
  }

  /** Read the vault meta, or set it if absent (first device wins). */
  meta(init?: string): { meta: string | null; created: boolean } {
    return this.sql.transaction(() => {
      const existing = this.sql.all<{ v: string }>("SELECT v FROM kv WHERE k = 'meta'")[0]?.v ?? null;
      if (existing !== null || init === undefined) return { meta: existing, created: false };
      this.sql.run("INSERT INTO kv (k, v) VALUES ('meta', ?)", init);
      return { meta: init, created: true };
    });
  }

  /** Apply ops in order; each op is its own compare-and-swap. */
  commit(ops: ReadonlyArray<Op>): OpResult[] {
    return ops.map((op) => this.sql.transaction(() => this.apply(op)));
  }

  private liveVersion(entry: Entry | null) {
    return entry === null || entry.deleted ? null : entry.version;
  }

  private append(
    path: string,
    previous: Entry | null,
    fields: { deleted: boolean; chunks: ReadonlyArray<string>; meta: string; device: string; movedTo?: string },
  ): Entry {
    const version = (previous?.version ?? 0) + 1;
    this.sql.run(
      "INSERT INTO versions (path, version, deleted, chunks, meta, device, created_at, moved_to) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      path,
      version,
      fields.deleted ? 1 : 0,
      JSON.stringify(fields.chunks),
      fields.meta,
      fields.device,
      this.now(),
      fields.movedTo ?? null,
    );
    const seq = this.seq();
    this.sql.run(
      "INSERT INTO head (path, seq) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET seq = excluded.seq",
      path,
      seq,
    );
    for (const hash of fields.chunks)
      this.sql.run(
        "INSERT INTO chunk_refs (hash, refs) VALUES (?, 1) ON CONFLICT(hash) DO UPDATE SET refs = refs + 1",
        hash,
      );
    return this.current(path)!;
  }

  private apply(op: Op): OpResult {
    switch (op.op) {
      case "put": {
        const current = this.current(op.path);
        if (this.liveVersion(current) !== op.baseVersion) return { ok: false, path: op.path, current };
        const entry = this.append(op.path, current, { deleted: false, chunks: op.chunks, meta: op.meta, device: op.device });
        return { ok: true, entries: [entry] };
      }
      case "remove": {
        const current = this.current(op.path);
        if (current === null || this.liveVersion(current) !== op.baseVersion)
          return { ok: false, path: op.path, current };
        const entry = this.append(op.path, current, { deleted: true, chunks: [], meta: current.meta, device: op.device });
        return { ok: true, entries: [entry] };
      }
      case "rename": {
        const source = this.current(op.from);
        if (source === null || this.liveVersion(source) !== op.baseVersion)
          return { ok: false, path: op.from, current: source };
        const target = this.current(op.to);
        if (this.liveVersion(target) !== null) return { ok: false, path: op.to, current: target };
        const removed = this.append(op.from, source, {
          deleted: true,
          chunks: [],
          meta: source.meta,
          device: op.device,
          movedTo: op.to,
        });
        const added = this.append(op.to, target, { deleted: false, chunks: source.chunks, meta: op.meta, device: op.device });
        return { ok: true, entries: [removed, added] };
      }
    }
  }

  /**
   * Drop non-current versions older than `cutoff` (ms epoch). Current entries,
   * including tombstones, are kept so long-offline devices still learn about deletes.
   * Returns chunk hashes that are no longer referenced (safe to delete from R2).
   */
  prune(cutoff: number): { prunedVersions: number; orphans: string[] } {
    return this.sql.transaction(() => {
      const rows = this.sql.all<{ seq: number; chunks: string }>(
        "SELECT seq, chunks FROM versions WHERE created_at < ? AND seq NOT IN (SELECT seq FROM head)",
        cutoff,
      );
      const touched = new Set<string>();
      for (const row of rows) {
        for (const hash of JSON.parse(row.chunks) as string[]) {
          this.sql.run("UPDATE chunk_refs SET refs = refs - 1 WHERE hash = ?", hash);
          touched.add(hash);
        }
        this.sql.run("DELETE FROM versions WHERE seq = ?", row.seq);
      }
      const orphans: string[] = [];
      for (const hash of touched) {
        const refs = this.sql.all<{ refs: number }>("SELECT refs FROM chunk_refs WHERE hash = ?", hash)[0]?.refs ?? 0;
        if (refs <= 0) {
          this.sql.run("DELETE FROM chunk_refs WHERE hash = ?", hash);
          orphans.push(hash);
        }
      }
      return { prunedVersions: rows.length, orphans };
    });
  }

  /** Of the given blob hashes, which ones no version references (uploaded but never committed). */
  unreferenced(hashes: ReadonlyArray<string>): string[] {
    return hashes.filter(
      (hash) => this.sql.all("SELECT 1 FROM chunk_refs WHERE hash = ? AND refs > 0", hash).length === 0,
    );
  }
}
