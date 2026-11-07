/**
 * End-to-end smoke test against a running server (`bun run smoke:dev` locally,
 * `bun run smoke` against prod). Two in-memory devices run the real sync engine
 * over HTTP; a WebSocket checks live pushes. Uses a fresh `smoke-*` vault.
 */
import { routes } from "@oscf/protocol";

import * as Effect from "effect/Effect";

import { fetchHttp, makeHttpRemote, socketUrl } from "../packages/plugin/src/core/http-remote.ts";
import { mergeText } from "../packages/plugin/src/core/merge.ts";
import { openPlainVault } from "../packages/plugin/src/core/plain-vault.ts";
import { Device } from "../packages/plugin/test/harness.ts";

const serverUrl = process.env.OSCF_URL ?? "http://localhost:1337";
const token = process.env.OSCF_TOKEN ?? "";
const vaultId = `smoke-${Date.now()}`;
const remote = () => makeHttpRemote({ serverUrl, vaultId, token, http: fetchHttp() });

const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` (${detail})` : ""}`);
  if (!ok) process.exitCode = 1;
};

const unauthorized = await fetch(new URL(routes.changes(vaultId, 0), serverUrl));
check("rejects requests without a token", unauthorized.status === 401);

// Live push: open a socket before any change.
const pushes: number[] = [];
const socket = new WebSocket(socketUrl({ serverUrl, vaultId, token }));
let pongs = 0;
socket.onmessage = (event) => (event.data === "pong" ? pongs++ : pushes.push(JSON.parse(String(event.data)).seq));
await new Promise((resolve, reject) => {
  socket.onopen = resolve;
  socket.onerror = reject;
});

// Vault format: the first device creates a plain vault, the next one joins it.
const open = (id = vaultId) =>
  Effect.runPromise(openPlainVault(makeHttpRemote({ serverUrl, vaultId: id, token, http: fetchHttp() })).pipe(Effect.result));
const created = await open();
check("new vault is created (plain format)", created._tag === "Success" && created.success.created);
const joined = await open();
check("second device joins the same vault", joined._tag === "Success" && !joined.success.created);
// A vault in another format (e.g. from the encrypted versions before 0.3) is refused, not mixed.
const otherFormatId = `${vaultId}-legacy`;
await fetch(new URL(routes.meta(otherFormatId), serverUrl), {
  method: "PUT",
  headers: { authorization: `Bearer ${token}` },
  body: JSON.stringify({ v: 1, salt: "x", iterations: 600000, wrapped: "y" }),
});
const otherFormat = await open(otherFormatId);
check("a vault in another format is refused", otherFormat._tag === "Failure" && otherFormat.failure._tag === "VaultFormatError");
if (created._tag !== "Success") process.exit(1);

socket.send("ping");
await new Promise((r) => setTimeout(r, 1000));
check("keep-alive ping is auto-answered with pong", pongs === 1);

const a = await new Device("smoke-a", remote(), { merge: mergeText }).start();
const b = await new Device("smoke-b", remote(), { merge: mergeText }).start();

a.write("notes/hello.md", "hola");
await a.sync();
await b.sync();
check("create propagates", b.read("notes/hello.md") === "hola");

await new Promise((r) => setTimeout(r, 500));
check("WebSocket pushes the new seq", pushes.some((seq) => seq >= 1), `pushes=${pushes.join(",")}`);

b.write("notes/hello.md", "hola desde b");
await b.sync();
await a.sync();
check("edit propagates", a.read("notes/hello.md") === "hola desde b");

a.write("notes/hello.md", "A");
b.write("notes/hello.md", "B");
await a.sync();
await b.sync();
await a.sync();
const copies = Object.keys(a.snapshot()).filter((p) => p.includes("(conflict smoke-b"));
check("concurrent edit keeps both", a.read("notes/hello.md") === "A" && copies.length === 1);

a.rename("notes/hello.md", "archive/hello.md");
await a.sync();
await b.sync();
check("rename propagates", b.read("archive/hello.md") === "A" && b.read("notes/hello.md") === undefined);

const bigMb = Number(process.env.SMOKE_BIG_MB ?? 20);
const big = new Uint8Array(bigMb * 1024 * 1024).map((_, i) => (i * 7) % 253);
a.write("big.bin", big);
await a.sync();
await b.sync();
const got = b.files.get("big.bin")?.data;
check(`${bigMb} MB file round-trips in chunks`, !!got && got.length === big.length && got.every((v, i) => v === big[i]));

a.remove(copies[0]!);
await a.sync();
await b.sync();
check("delete propagates", b.read(copies[0]!) === undefined);
check("devices converge", JSON.stringify(a.snapshot()) === JSON.stringify(b.snapshot()));

// The MCP endpoint reads the same vault (owner token).
const mcp = await fetch(new URL(`/mcp/${vaultId}`, serverUrl), {
  method: "POST",
  headers: {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2026-07-28",
    "mcp-method": "tools/call",
    "mcp-name": "list_notes",
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "list_notes",
      arguments: {},
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { name: "smoke", version: "1" },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  }),
});
const mcpText = mcp.ok ? JSON.stringify(await mcp.json()) : `${mcp.status}`;
check("MCP endpoint lists the vault's notes", mcpText.includes("archive/hello.md"), mcpText.slice(0, 200));
const mcpNoAuth = await fetch(new URL(`/mcp/${vaultId}`, serverUrl), { method: "POST" });
check(
  "MCP endpoint asks for OAuth without a token",
  mcpNoAuth.status === 401 && (mcpNoAuth.headers.get("www-authenticate") ?? "").includes("resource_metadata"),
);

// Retention: prune everything older than now; current files must still sync to a fresh device.
const pruned = (await (
  await fetch(new URL(routes.prune(vaultId, 0), serverUrl), { method: "POST", headers: { authorization: `Bearer ${token}` } })
).json()) as { prunedVersions: number; deletedBlobs: number };
check("retention prunes old versions and their blobs", pruned.prunedVersions > 0 && pruned.deletedBlobs > 0, JSON.stringify(pruned));
const c = await new Device("smoke-c", remote(), { merge: mergeText }).start();
await c.sync();
check("a fresh device still gets every current file after pruning", JSON.stringify(c.snapshot()) === JSON.stringify(a.snapshot()));

socket.close();
console.log(process.exitCode ? "SMOKE FAILED" : "SMOKE OK");
process.exit();
