/**
 * Full-text index of the vault's notes (SQLite FTS5), next to the change log.
 *
 * The Durable Object never sees file contents (they live in R2), so the Worker
 * keeps the index current: `pending` lists head entries newer than what was
 * indexed, the Worker reads their text and hands it back with `apply`.
 * Each note's link keys (see `linkKeys` in links.ts) are kept too, so
 * backlinks are a lookup rather than a text search.
 */
import type { Sql } from "./store.ts";

export interface PendingDoc {
  readonly pathId: string;
  readonly seq: number;
  readonly deleted: boolean;
  readonly chunks: ReadonlyArray<string>;
  readonly meta: string;
}

export interface IndexedDoc {
  readonly pathId: string;
  readonly seq: number;
  /** Real path (from the plain meta); null removes the document. */
  readonly path: string | null;
  readonly text: string | null;
  /** Link keys found in the text. */
  readonly links?: ReadonlyArray<string>;
}

export interface SearchHit {
  readonly path: string;
  readonly snippet: string;
}

/** Words become quoted prefix terms, so user input can't break FTS5 syntax. */
export const toFtsQuery = (query: string) =>
  query
    .split(/\s+/)
    .map((word) => word.replace(/"/g, "").trim())
    .filter((word) => word.length > 0)
    .map((word) => `"${word}"*`)
    .join(" ");

export class SearchIndex {
  constructor(private readonly sql: Sql) {
    sql.run("CREATE TABLE IF NOT EXISTS search_docs (path_id TEXT PRIMARY KEY, seq INTEGER NOT NULL)");
    sql.run(
      "CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(path_id UNINDEXED, path, body, tokenize = 'unicode61 remove_diacritics 2')",
    );
    const hadLinks = sql.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'search_links'").length > 0;
    sql.run("CREATE TABLE IF NOT EXISTS search_links (path_id TEXT NOT NULL, link TEXT NOT NULL, PRIMARY KEY (link, path_id))");
    sql.run("CREATE INDEX IF NOT EXISTS search_links_by_doc ON search_links (path_id)");
    // Documents indexed before links were tracked: index everything again.
    if (!hadLinks) sql.run("DELETE FROM search_docs");
  }

  pending(limit: number): PendingDoc[] {
    return this.sql
      .all<{ path: string; seq: number; deleted: number; chunks: string; meta: string }>(
        `SELECT v.path, v.seq, v.deleted, v.chunks, v.meta
         FROM head h JOIN versions v ON v.seq = h.seq
         LEFT JOIN search_docs d ON d.path_id = h.path
         WHERE (d.seq IS NULL AND v.deleted = 0) OR (d.seq IS NOT NULL AND d.seq < h.seq)
         ORDER BY h.seq LIMIT ?`,
        limit,
      )
      .map((row) => ({
        pathId: row.path,
        seq: row.seq,
        deleted: row.deleted === 1,
        chunks: JSON.parse(row.chunks) as string[],
        meta: row.meta,
      }));
  }

  apply(docs: ReadonlyArray<IndexedDoc>) {
    this.sql.transaction(() => {
      for (const doc of docs) {
        // Never let an older read (a concurrent catch-up) overwrite a newer one.
        const indexed = this.sql.all<{ seq: number }>("SELECT seq FROM search_docs WHERE path_id = ?", doc.pathId)[0]?.seq;
        if (indexed !== undefined && indexed > doc.seq) continue;
        this.sql.run("DELETE FROM search_fts WHERE path_id = ?", doc.pathId);
        this.sql.run("DELETE FROM search_links WHERE path_id = ?", doc.pathId);
        if (doc.path !== null && doc.text !== null) {
          this.sql.run("INSERT INTO search_fts (path_id, path, body) VALUES (?, ?, ?)", doc.pathId, doc.path, doc.text);
          for (const link of new Set(doc.links ?? []))
            this.sql.run("INSERT OR IGNORE INTO search_links (path_id, link) VALUES (?, ?)", doc.pathId, link);
        }
        this.sql.run(
          "INSERT INTO search_docs (path_id, seq) VALUES (?, ?) ON CONFLICT(path_id) DO UPDATE SET seq = excluded.seq",
          doc.pathId,
          doc.seq,
        );
      }
    });
  }

  search(query: string, limit: number): SearchHit[] {
    const fts = toFtsQuery(query);
    if (fts === "") return [];
    return this.sql.all<SearchHit>(
      `SELECT path, snippet(search_fts, 2, '«', '»', '…', 16) AS snippet
       FROM search_fts WHERE search_fts MATCH ? ORDER BY bm25(search_fts, 0, 4, 1) LIMIT ?`,
      fts,
      limit,
    );
  }

  /** Indexed notes with a link whose key is one of `keys`. */
  linking(keys: ReadonlyArray<string>): string[] {
    if (keys.length === 0) return [];
    return this.sql
      .all<{ path: string }>(
        `SELECT DISTINCT f.path FROM search_links l JOIN search_fts f ON f.path_id = l.path_id
         WHERE l.link IN (${keys.map(() => "?").join(", ")}) ORDER BY f.path`,
        ...keys,
      )
      .map((r) => r.path);
  }

  /** How many head entries are not indexed yet. */
  backlog(): number {
    return (
      this.sql.all<{ n: number }>(
        `SELECT COUNT(*) AS n FROM head h JOIN versions v ON v.seq = h.seq
         LEFT JOIN search_docs d ON d.path_id = h.path
         WHERE (d.seq IS NULL AND v.deleted = 0) OR (d.seq IS NOT NULL AND d.seq < h.seq)`,
      )[0]?.n ?? 0
    );
  }
}
