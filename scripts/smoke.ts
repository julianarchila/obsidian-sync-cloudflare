/**
 * End-to-end smoke test against a running server (`bun run smoke:dev` locally,
 * `bun run smoke` against prod). Two in-memory devices run the real sync engine
 * over HTTP; a WebSocket checks live pushes. Uses a fresh `smoke-*` vault.
 */
import { routes } from "@oscf/protocol";

import * as Effect from "effect/Effect";

import { makeCryptoCodec } from "../packages/plugin/src/core/crypto-codec.ts";
import { fetchHttp, makeHttpRemote, socketUrl } from "../packages/plugin/src/core/http-remote.ts";
import { changeVaultPassword, unlockVault } from "../packages/plugin/src/core/unlock.ts";
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

// End-to-end encryption: device A creates the vault, B unlocks it with the same password.
const unlock = (password: string) =>
  Effect.runPromise(unlockVault(remote(), { password, iterations: 10_000 }).pipe(Effect.result));
const created = await unlock("smoke-password");
check("new vault is created with a password", created._tag === "Success" && created.success.created);
const joined = await unlock("smoke-password");
check("second device unlocks with the same password", joined._tag === "Success" && !joined.success.created);
const wrong = await unlock("not-the-password");
check("wrong password is rejected", wrong._tag === "Failure");
if (created._tag !== "Success") process.exit(1);

// Password change: re-wraps the key; old password stops working, data stays readable.
await Effect.runPromise(changeVaultPassword(remote(), created.success.master, "smoke-password-2", 10_000));
const oldPw = await unlock("smoke-password");
const newPw = await unlock("smoke-password-2");
check("password change: old password rejected, new one opens the same key",
  oldPw._tag === "Failure" && newPw._tag === "Success" && newPw.success.master.every((v, i) => v === created.success.master[i]));
const codec = await Effect.runPromise(makeCryptoCodec(created.success.master));

socket.send("ping");
await new Promise((r) => setTimeout(r, 1000));
check("keep-alive ping is auto-answered with pong", pongs === 1);

const a = await new Device("smoke-a", remote(), {}, codec).start();
const b = await new Device("smoke-b", remote(), {}, codec).start();

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

// What the server stores must be opaque.
const raw = await (await fetch(new URL(routes.changes(vaultId, 0), serverUrl), { headers: { authorization: `Bearer ${token}` } })).text();
check("server index has no plaintext paths", !/hello|archive|notes|big\.bin/i.test(raw));
const firstChunk = (JSON.parse(raw) as { entries: Array<{ chunks: string[] }> }).entries.find((e) => e.chunks.length)?.chunks[0];
const blob = firstChunk
  ? new Uint8Array(await (await fetch(new URL(routes.blob(vaultId, firstChunk), serverUrl), { headers: { authorization: `Bearer ${token}` } })).arrayBuffer())
  : new Uint8Array();
check("stored blobs are ciphertext", blob.length > 0 && !new TextDecoder().decode(blob).includes("hola"));

// Retention: prune everything older than now; current files must still sync to a fresh device.
const pruned = (await (
  await fetch(new URL(routes.prune(vaultId, 0), serverUrl), { method: "POST", headers: { authorization: `Bearer ${token}` } })
).json()) as { prunedVersions: number; deletedBlobs: number };
check("retention prunes old versions and their blobs", pruned.prunedVersions > 0 && pruned.deletedBlobs > 0, JSON.stringify(pruned));
const c = await new Device("smoke-c", remote(), {}, codec).start();
await c.sync();
check("a fresh device still gets every current file after pruning", JSON.stringify(c.snapshot()) === JSON.stringify(a.snapshot()));

socket.close();
console.log(process.exitCode ? "SMOKE FAILED" : "SMOKE OK");
process.exit();
