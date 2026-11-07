/**
 * `Remote` over HTTP. The transport is injected: Obsidian's `requestUrl` in the
 * plugin (no CORS), `fetch` in scripts and tests. Responses are validated with
 * the shared protocol schemas.
 */
import {
  ChangesResponse,
  CommitResponse,
  EntriesResponse,
  MovedFromResponse,
  type Op,
  ReplaceMetaResponse,
  VaultMetaResponse,
  routes,
} from "@oscf/protocol";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { decodeText } from "./bytes.ts";
import { RemoteError, type RemoteShape } from "./services.ts";

export interface HttpRequest {
  readonly method: "GET" | "PUT" | "POST" | "HEAD";
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body?: Uint8Array | string;
}

export interface HttpResponse {
  readonly status: number;
  readonly body: Uint8Array;
}

export type HttpFn = (request: HttpRequest) => Promise<HttpResponse>;

/** `fetch`-based transport (Bun, browsers with CORS, tests). */
export const fetchHttp =
  (fetchFn: typeof fetch = fetch): HttpFn =>
  async ({ method, url, headers, body }) => {
    const response = await fetchFn(url, { method, headers, body: body as RequestInit["body"] });
    return { status: response.status, body: new Uint8Array(await response.arrayBuffer()) };
  };

export interface HttpRemoteOptions {
  readonly serverUrl: string;
  readonly vaultId: string;
  readonly token: string;
  readonly http: HttpFn;
}

export const makeHttpRemote = ({ serverUrl, vaultId, token, http }: HttpRemoteOptions): RemoteShape => {
  const headers = { authorization: `Bearer ${token}` };
  const url = (path: string) => new URL(path, serverUrl).href;

  const send = (request: Omit<HttpRequest, "headers"> & { headers?: Record<string, string> }) =>
    Effect.tryPromise({
      try: () => http({ ...request, headers: { ...headers, ...request.headers } }),
      catch: (error) => new RemoteError({ message: error instanceof Error ? error.message : String(error) }),
    });

  const json = <S extends Schema.Top>(schema: S, request: Parameters<typeof send>[0]) =>
    send(request).pipe(
      Effect.flatMap((response) =>
        response.status >= 200 && response.status < 300
          ? Effect.try({
              try: () => JSON.parse(decodeText(response.body)) as unknown,
              catch: () => new RemoteError({ message: "Invalid JSON", status: response.status }),
            })
          : Effect.fail(
              new RemoteError({ message: decodeText(response.body).slice(0, 200), status: response.status }),
            ),
      ),
      Effect.flatMap((body) =>
        Schema.decodeUnknownEffect(schema)(body).pipe(
          Effect.mapError((error) => new RemoteError({ message: `Unexpected response: ${error.message}` })),
        ),
      ),
    ) as Effect.Effect<S["Type"], RemoteError>;

  return {
    changes: (since) => json(ChangesResponse, { method: "GET", url: url(routes.changes(vaultId, since)) }),
    commit: (ops: ReadonlyArray<Op>) =>
      json(CommitResponse, {
        method: "POST",
        url: url(routes.commit(vaultId)),
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ops }),
      }).pipe(Effect.map((response) => response.results)),
    history: (pathId) =>
      json(EntriesResponse, { method: "GET", url: url(routes.history(vaultId, pathId)) }).pipe(
        Effect.map((r) => r.entries),
      ),
    deleted: json(EntriesResponse, { method: "GET", url: url(routes.deleted(vaultId)) }).pipe(
      Effect.map((r) => r.entries),
    ),
    movedFrom: (pathId) =>
      json(MovedFromResponse, { method: "GET", url: url(routes.movedFrom(vaultId, pathId)) }).pipe(Effect.map((r) => r.paths)),
    meta: (init) =>
      init === undefined
        ? json(VaultMetaResponse, { method: "GET", url: url(routes.meta(vaultId)) })
        : json(VaultMetaResponse, { method: "PUT", url: url(routes.meta(vaultId)), body: init }),
    replaceMeta: (expected, next) =>
      json(ReplaceMetaResponse, {
        method: "POST",
        url: url(routes.replaceMeta(vaultId)),
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expected, next }),
      }),
    putBlob: (hash, data) =>
      send({
        method: "PUT",
        url: url(routes.blob(vaultId, hash)),
        headers: { "content-type": "application/octet-stream" },
        body: data,
      }).pipe(
        Effect.flatMap((response) =>
          response.status < 300
            ? Effect.void
            : Effect.fail(new RemoteError({ message: `Blob upload failed`, status: response.status })),
        ),
      ),
    getBlob: (hash) =>
      send({ method: "GET", url: url(routes.blob(vaultId, hash)) }).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response.body)
            : Effect.fail(new RemoteError({ message: `Blob download failed`, status: response.status })),
        ),
      ),
  };
};

/** WebSocket URL for live `seq` pushes. */
export const socketUrl = ({ serverUrl, vaultId, token }: Omit<HttpRemoteOptions, "http">) => {
  const u = new URL(routes.socket(vaultId), serverUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.searchParams.set("token", token);
  return u.href;
};
