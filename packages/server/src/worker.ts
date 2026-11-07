/**
 * The whole backend: one Worker that
 *  - authenticates every request with the deploy token,
 *  - forwards `/v1/vaults/<id>/{changes,commit,history,deleted,meta,socket}` to the vault's Durable Object,
 *  - serves `/v1/vaults/<id>/blobs/<sha256>` from R2 (content-addressed, immutable),
 *  - runs retention daily: prunes old versions and deletes unreferenced blobs.
 */
import * as Cloudflare from "@alchemy.run/cloudflare";
import { Request as NativeRequest } from "@alchemy.run/cloudflare/Workers";
import { MAX_BLOB_BYTES, VaultId, isValidBlobHash } from "@oscf/protocol";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import { isAuthorized, safeEqual } from "./auth.ts";
import { makeMcpHandler, type McpClient, parseMcpClients } from "./mcp.ts";
import { authenticateHeader, handleOAuth, verifyAccessToken } from "./oauth.ts";
import { makeVaultOps, VaultNotFound, VaultOpsError } from "./vault-ops.ts";
import { VaultObject } from "./vault-object.ts";

/** File chunks, keyed by `<vault>/<sha256 of the chunk>`. */
export const Blobs = Cloudflare.R2.Bucket("Blobs");

const VAULT_ROUTE = /^\/v1\/vaults\/([^/]+)(\/.*)$/;
const MCP_ROUTE = /^\/mcp\/([^/]+)\/?$/;
const BLOB_ROUTE = /^\/blobs\/([0-9a-f]{64})$/;
const DO_ROUTES = new Set(["/changes", "/commit", "/history", "/deleted", "/moved-from", "/meta", "/socket"]);
/** Orphan uploads (never committed) younger than this are left alone. */
const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;

const isVaultId = Schema.is(VaultId);

const hex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

const text = (body: string, status: number) => HttpServerResponse.text(body, { status });

export default class SyncWorker extends Cloudflare.Worker<SyncWorker>()(
  "SyncWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    // Bound to the Worker as secrets/vars at deploy time (from .env or your secrets manager).
    const token = yield* Config.Redacted("OSCF_TOKEN");
    const retentionDays = yield* Config.Number("OSCF_RETENTION_DAYS").pipe(Config.withDefault(365));
    const bucket = yield* Cloudflare.R2.ReadWriteBucket(Blobs);
    const vaults = yield* VaultObject;
    const mcpClients = parseMcpClients(
      Redacted.value(yield* Config.Redacted("OSCF_MCP_CLIENTS").pipe(Config.withDefault(Redacted.make("")))),
    );
    const mcp = makeMcpHandler();

    /** Forward a request to the vault's Durable Object, rewriting the path. */
    const callVault = (vault: string, route: string, init?: { method?: string; body?: string; source?: Request }) =>
      Effect.gen(function* () {
        const source = init?.source;
        const url = new URL(`https://vault${route}`);
        if (source && url.search === "") url.search = new URL(source.url).search;
        const forwarded = new Request(url, {
          method: init?.method ?? source?.method ?? "GET",
          headers: source?.headers,
          body: init?.body ?? (source && !["GET", "HEAD"].includes(source.method) ? source.body : undefined),
        });
        const response = yield* vaults
          .getByName(vault)
          .fetch(HttpServerRequest.fromWeb(forwarded))
          .pipe(Effect.orDie);
        return HttpServerResponse.toWeb(response);
      });

    const blobs = (request: Request, vault: string, hash: string) =>
      Effect.gen(function* () {
        const key = `${vault}/${hash}`;
        switch (request.method) {
          case "HEAD": {
            const head = yield* bucket.head(key);
            return HttpServerResponse.empty({ status: head ? 200 : 404 });
          }
          case "GET": {
            const object = yield* bucket.get(key);
            if (object === null) return text("Not found", 404);
            return HttpServerResponse.uint8Array(new Uint8Array(yield* object.arrayBuffer()), {
              headers: { "cache-control": "private, max-age=31536000, immutable" },
            });
          }
          case "PUT": {
            // Content-addressed: if it already exists, it's the same bytes.
            if (yield* bucket.head(key)) return HttpServerResponse.empty({ status: 204 });
            const body = yield* Effect.promise(() => request.arrayBuffer());
            if (body.byteLength > MAX_BLOB_BYTES) return text("Too large", 413);
            const actual = hex(yield* Effect.promise(() => crypto.subtle.digest("SHA-256", body)));
            if (actual !== hash) return text("Hash mismatch", 422);
            yield* bucket.put(key, new Uint8Array(body));
            return HttpServerResponse.empty({ status: 201 });
          }
          default:
            return text("Method not allowed", 405);
        }
      });

    /** Which MCP client a request comes from: the owner token, or one of OSCF_MCP_CLIENTS. */
    /** MCP tokens come only from the Authorization header (never the URL, which ends up in logs). */
    const mcpClient = async (request: Request, vault: string): Promise<McpClient | null> => {
      const header = request.headers.get("authorization");
      if (!header?.startsWith("Bearer ")) return null;
      const presented = header.slice("Bearer ".length);
      if (safeEqual(presented, Redacted.value(token))) return { name: "owner", access: "write", folders: [] };
      // Connectors added through OAuth (Claude, ChatGPT, ...).
      if (presented.startsWith("hb1.")) return verifyAccessToken(Redacted.value(token), presented, vault);
      const client = mcpClients.find((c) => safeEqual(presented, c.token));
      const vaultAllowed = (pattern: string) => (pattern.endsWith("*") ? vault.startsWith(pattern.slice(0, -1)) : pattern === vault);
      return client && client.vaults.some(vaultAllowed) ? client : null;
    };

    const mcpRequest = (request: Request, vault: string) =>
      Effect.gen(function* () {
        const client = yield* Effect.promise(() => mcpClient(request, vault));
        if (client === null)
          return HttpServerResponse.text("Unauthorized", {
            status: 401,
            headers: { "www-authenticate": authenticateHeader(new URL(request.url).origin, vault) },
          });
        // Bindings (R2, Durable Objects) need the Worker's runtime context.
        const services = yield* Effect.context<never>();
        const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          Effect.runPromiseWith(services)(effect as unknown as Effect.Effect<A, E>);
        const ops = makeVaultOps(
          {
            call: (route, init) => run(callVault(vault, route, init)),
            getBlob: (hash) =>
              run(
                Effect.gen(function* () {
                  const object = yield* bucket.get(`${vault}/${hash}`);
                  return object === null ? null : new Uint8Array(yield* object.arrayBuffer());
                }),
              ),
            hasBlob: (hash) => run(Effect.map(bucket.head(`${vault}/${hash}`), (head) => head !== null)),
            putBlob: (hash, bytes) => run(Effect.asVoid(bucket.put(`${vault}/${hash}`, bytes))),
          },
          `mcp:${client.name}`,
        );
        const ready = yield* Effect.tryPromise(() => ops.ensurePlain()).pipe(Effect.result);
        if (ready._tag === "Failure") {
          const cause = ready.failure.cause;
          if (cause instanceof VaultNotFound) return text(cause.message, 404);
          return text(cause instanceof VaultOpsError ? cause.message : "Vault unavailable", 409);
        }
        const url = new URL(request.url);
        url.pathname = "/mcp";
        const response = yield* Effect.promise(() => mcp(new Request(url, request), { client, vault, ops }));
        return HttpServerResponse.raw(response, { status: response.status });
      });

    const readJson = <A>(response: Response) => Effect.promise(() => response.json() as Promise<A>);

    const deleteBlobs = (vault: string, hashes: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const keys = hashes.map((hash) => `${vault}/${hash}`);
        for (let i = 0; i < keys.length; i += 1000) yield* bucket.delete(keys.slice(i, i + 1000));
        return keys.length;
      });

    /** Retention for one vault: prune old versions, then delete blobs nobody references. */
    const pruneVault = (vault: string, days: number) =>
      Effect.gen(function* () {
        const pruned = yield* readJson<{ prunedVersions: number; orphans: string[] }>(
          yield* callVault(vault, `/prune?days=${days}`, { method: "POST" }),
        );
        let deletedBlobs = yield* deleteBlobs(vault, pruned.orphans);

        // Uploads that were never committed (crashed or abandoned pushes).
        let cursor: string | undefined;
        do {
          const page = yield* bucket.list({ prefix: `${vault}/`, cursor, limit: 1000 });
          const old = page.objects.filter((o) => Date.now() - o.uploaded.getTime() > ORPHAN_GRACE_MS);
          if (old.length > 0) {
            const { hashes } = yield* readJson<{ hashes: string[] }>(
              yield* callVault(vault, "/unreferenced", {
                method: "POST",
                body: JSON.stringify({ hashes: old.map((o) => o.key.slice(vault.length + 1)) }),
              }),
            );
            deletedBlobs += yield* deleteBlobs(vault, hashes);
          }
          cursor = page.truncated ? page.cursor : undefined;
        } while (cursor);
        return { prunedVersions: pruned.prunedVersions, deletedBlobs };
      });

    /** Every vault that has stored at least one blob. */
    const listVaults = Effect.gen(function* () {
      const ids: string[] = [];
      let cursor: string | undefined;
      do {
        const page = yield* bucket.list({ delimiter: "/", cursor, limit: 1000 });
        ids.push(...page.delimitedPrefixes.map((prefix) => prefix.replace(/\/$/, "")));
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      return ids.filter(isVaultId);
    });

    yield* Cloudflare.Workers.cron("17 3 * * *", () =>
      Effect.gen(function* () {
        for (const vault of yield* listVaults) {
          const result = yield* pruneVault(vault, retentionDays);
          yield* Effect.log(`retention ${vault}`, result);
        }
      }).pipe(Effect.orDie),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* NativeRequest;
        const { pathname, searchParams } = new URL(request.url);

        if (pathname === "/health") return HttpServerResponse.text("ok");

        const oauth = yield* Effect.promise(() => handleOAuth(request, Redacted.value(token)));
        if (oauth) return HttpServerResponse.raw(oauth, { status: oauth.status });

        const mcpMatch = MCP_ROUTE.exec(pathname);
        if (mcpMatch) {
          if (!isVaultId(mcpMatch[1]!)) return text("Bad vault id", 400);
          return yield* mcpRequest(request, mcpMatch[1]!);
        }

        const match = VAULT_ROUTE.exec(pathname);
        if (!match) return text("Not found", 404);
        if (!isAuthorized(request, token)) return text("Unauthorized", 401);
        const [, vault, route] = match as unknown as [string, string, string];
        if (!isVaultId(vault)) return text("Bad vault id", 400);

        const blob = BLOB_ROUTE.exec(route);
        if (blob) return yield* blobs(request, vault, blob[1]!);

        // Manual retention run (tests, or after lowering the retention window).
        if (route === "/prune" && request.method === "POST") {
          const days = Math.max(0, Number(searchParams.get("days") ?? retentionDays));
          return yield* HttpServerResponse.json(yield* pruneVault(vault, days));
        }

        if (!DO_ROUTES.has(route)) return text("Not found", 404);
        return HttpServerResponse.raw(yield* callVault(vault, route, { source: request }));
      }).pipe(
        Effect.catchTag("R2Error", (error) => Effect.succeed(text(error.message, 500))),
        Effect.catchCause((cause) => Effect.succeed(text(`Internal error: ${String(cause)}`, 500))),
      ),
    };
  }).pipe(
    Effect.provide(Layer.mergeAll(Cloudflare.R2.ReadWriteBucketBinding, Cloudflare.Workers.CronEventSourceLive)),
  ),
) {}
