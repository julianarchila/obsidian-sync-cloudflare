/**
 * HTTP surface of one vault, independent of Cloudflare: the Durable Object and
 * the in-memory test server both call this with a `VaultStore`.
 *
 * Paths are relative to the vault: `/changes`, `/commit`, `/history`, ...
 * Authentication happens before this (in the Worker).
 */
import { CommitRequest } from "@oscf/protocol";
import * as Schema from "effect/Schema";

import type { SearchIndex } from "./search-index.ts";
import type { VaultStore } from "./store.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const decodeCommit = Schema.decodeUnknownSync(CommitRequest);
const Hashes = Schema.Struct({ hashes: Schema.Array(Schema.String) });
const decodeHashes = Schema.decodeUnknownSync(Hashes);
const decodeReplace = Schema.decodeUnknownSync(Schema.Struct({ expected: Schema.String, next: Schema.String }));
const decodeIndex = Schema.decodeUnknownSync(
  Schema.Struct({
    docs: Schema.Array(
      Schema.Struct({
        pathId: Schema.String,
        seq: Schema.Int,
        path: Schema.NullOr(Schema.String),
        text: Schema.NullOr(Schema.String),
      }),
    ),
  }),
);

export interface VaultHttpResult {
  readonly response: Response;
  /** Set when the log advanced and connected devices should be notified. */
  readonly advancedTo?: number;
}

export const handleVaultHttp = async (
  store: VaultStore,
  request: Request,
  route: string,
  index?: SearchIndex,
): Promise<VaultHttpResult> => {
  const url = new URL(request.url);
  const int = (name: string, fallback: number) => {
    const value = Number(url.searchParams.get(name) ?? fallback);
    return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
  };

  try {
    switch (`${request.method} ${route}`) {
      case "GET /changes":
        return { response: json(store.changes(int("since", 0), Math.min(int("limit", 1000), 5000))) };

      case "POST /commit": {
        const { ops } = decodeCommit(await request.json());
        const before = store.seq();
        const results = store.commit(ops);
        const seq = store.seq();
        return { response: json({ results, seq }), advancedTo: seq > before ? seq : undefined };
      }

      case "GET /history": {
        const path = url.searchParams.get("path");
        if (!path) return { response: json({ error: "missing path" }, 400) };
        return { response: json({ entries: store.history(path) }) };
      }

      case "GET /recent":
        return { response: json({ entries: store.recent(Math.min(int("limit", 50), 500), int("since", 0)) }) };

      // Search index (used by the Worker's MCP endpoint, never by devices).
      case "GET /index/pending":
        if (!index) break;
        return { response: json({ docs: index.pending(Math.min(int("limit", 50), 500)), backlog: index.backlog() }) };

      case "POST /index":
        if (!index) break;
        index.apply(decodeIndex(await request.json()).docs);
        return { response: json({ backlog: index.backlog() }) };

      case "GET /search":
        if (!index) break;
        return {
          response: json({
            hits: index.search(url.searchParams.get("q") ?? "", Math.min(int("limit", 20), 200)),
            backlog: index.backlog(),
          }),
        };

      case "GET /moved-from": {
        const path = url.searchParams.get("path");
        if (!path) return { response: json({ error: "missing path" }, 400) };
        return { response: json({ paths: store.movedFrom(path) }) };
      }

      case "GET /deleted":
        return { response: json({ entries: store.deleted() }) };

      case "GET /meta":
        return { response: json(store.meta()) };

      case "PUT /meta": {
        const body = await request.text();
        if (body.length === 0 || body.length > 16_384) return { response: json({ error: "bad meta" }, 400) };
        return { response: json(store.meta(body)) };
      }

      case "POST /meta/replace": {
        const { expected, next } = decodeReplace(await request.json());
        if (next.length === 0 || next.length > 16_384) return { response: json({ error: "bad meta" }, 400) };
        return { response: json(store.replaceMeta(expected, next)) };
      }

      case "POST /prune": {
        const days = int("days", 365);
        const { prunedVersions, orphans } = store.prune(Date.now() - days * 86_400_000);
        return { response: json({ prunedVersions, orphans }) };
      }

      case "POST /unreferenced": {
        const { hashes } = decodeHashes(await request.json());
        return { response: json({ hashes: store.unreferenced(hashes) }) };
      }

      default:
        break;
    }
    return { response: json({ error: "not found" }, 404) };
  } catch (error) {
    return { response: json({ error: error instanceof Error ? error.message : String(error) }, 400) };
  }
};
