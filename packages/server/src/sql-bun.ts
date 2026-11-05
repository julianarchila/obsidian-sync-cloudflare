import type { Database } from "bun:sqlite";

import type { Sql } from "./store.ts";

/** `Sql` over bun:sqlite, for tests and the in-memory test server. */
export const bunSql = (db: Database): Sql => ({
  all: (query, ...params) => db.query(query).all(...(params as never[])) as never,
  run: (query, ...params) => void db.run(query, params as never[]),
  transaction: (f) => db.transaction(f)(),
});
