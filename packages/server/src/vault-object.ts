/**
 * One Durable Object per vault: owns the SQLite change log and the devices'
 * WebSockets (hibernation API, so idle connections cost nothing).
 */
import * as Cloudflare from "@alchemy.run/cloudflare";
import type { WebSocket } from "@alchemy.run/cloudflare/Workers";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import { SearchIndex } from "./search-index.ts";
import { type Sql, VaultStore } from "./store.ts";
import { handleVaultHttp } from "./vault-http.ts";

type Handlers = {
  readonly fetch: Effect.Effect<HttpServerResponse.HttpServerResponse, never, HttpServerRequest.HttpServerRequest>;
  readonly webSocketMessage: (socket: WebSocket, message: string | ArrayBuffer) => Effect.Effect<void>;
  readonly webSocketClose: (socket: WebSocket) => Effect.Effect<void>;
  readonly webSocketError: (socket: WebSocket) => Effect.Effect<void>;
};

const doSql = (storage: DurableObjectStorage): Sql => ({
  all: (query, ...params) => storage.sql.exec(query, ...(params as SqlStorageValue[])).toArray() as never,
  run: (query, ...params) => void storage.sql.exec(query, ...(params as SqlStorageValue[])),
  transaction: (f) => storage.transactionSync(f),
});

const raw = (response: Response) => HttpServerResponse.raw(response, { status: response.status });

/** Keep this name stable: it identifies the stored vault data. */
export const VaultObject = Cloudflare.DurableObject<Handlers>()(
  "VaultLog",
  Effect.map(Cloudflare.DurableObjectState, (state) =>
    Effect.sync((): Handlers => {
      const native = state.raw;
      const sql = doSql(native.storage);
      const store = new VaultStore(sql);
      const index = new SearchIndex(sql);
      // Keep-alive pings are answered by the runtime without waking this object (no billed duration).
      native.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));

      const broadcast = (seq: number) => {
        const message = JSON.stringify({ type: "seq", seq });
        for (const socket of native.getWebSockets()) {
          try {
            socket.send(message);
          } catch {
            // Closed sockets are cleaned up by the runtime.
          }
        }
      };

      return {
        fetch: Effect.gen(function* () {
          const request = yield* HttpServerRequest.toWeb(yield* HttpServerRequest.HttpServerRequest).pipe(Effect.orDie);
          const route = new URL(request.url).pathname;

          if (route === "/socket") {
            if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
              return raw(new Response("Expected WebSocket", { status: 426 }));
            const pair = new WebSocketPair();
            native.acceptWebSocket(pair[1]);
            pair[1].send(JSON.stringify({ type: "seq", seq: store.seq() }));
            return raw(new Response(null, { status: 101, webSocket: pair[0] }));
          }

          const result = yield* Effect.promise(() => handleVaultHttp(store, request, route, index));
          if (result.advancedTo !== undefined) broadcast(result.advancedTo);
          return raw(result.response);
        }),
        // Clients only listen; anything they send is a keep-alive.
        webSocketMessage: () => Effect.void,
        webSocketClose: (socket) => Effect.sync(() => socket.ws.close()),
        webSocketError: () => Effect.void,
      };
    }),
  ),
);
