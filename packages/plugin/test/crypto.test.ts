import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";

import { decodeText, encodeText } from "../src/core/bytes.ts";
import { createVault, deriveMasterKey, makeCryptoCodec, openVault, verifyMasterKey } from "../src/core/legacy/crypto-codec.ts";
import type { CodecShape } from "../src/core/services.ts";
import { Device, Server } from "./harness.ts";

const run = Effect.runPromise;
const salt = new Uint8Array(16).fill(1);
// Fewer iterations keep tests fast; production uses PBKDF2_ITERATIONS.
const master = await run(deriveMasterKey("correct horse", salt, 1000));
const codec = await run(makeCryptoCodec(master));
const other = await run(makeCryptoCodec(await run(deriveMasterKey("wrong", salt, 1000))));

describe("crypto codec", () => {
  test("vault record unwraps with the right password only", async () => {
    // A long password: a 2-letter one can appear by chance inside the base64 salt.
    const password = "correct-horse-battery-staple";
    const { vaultKey, record } = await run(createVault(password, 1000));
    expect(vaultKey.byteLength).toBe(32);
    expect(await run(openVault(password, record))).toEqual(vaultKey);
    expect(await run(openVault("nope", record))).toBeNull();
    expect(await run(verifyMasterKey(vaultKey, record))).toBe(true);
    expect(await run(verifyMasterKey(new Uint8Array(32), record))).toBe(false);
    expect(JSON.stringify(record)).not.toContain(password);
  });

  test("path ids are deterministic, opaque and key-dependent", async () => {
    const a = await run(codec.pathId("Notes/Secret plan.md"));
    expect(a).toBe(await run(codec.pathId("Notes/Secret plan.md")));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(await run(other.pathId("Notes/Secret plan.md")));
  });

  test("metadata round-trips and is bound to its path", async () => {
    const meta = { path: "Notes/Secret plan.md", hash: "ab".repeat(32), size: 12, mtime: 5 };
    const id = await run(codec.pathId(meta.path));
    const sealed = await run(codec.sealMeta(id, meta));
    expect(sealed).not.toContain("Secret");
    expect(await run(codec.openMeta(id, sealed))).toEqual(meta);
    // Moved onto another path id, or opened with another key: rejected.
    await expect(run(codec.openMeta(await run(codec.pathId("other.md")), sealed))).rejects.toBeDefined();
    await expect(run(other.openMeta(id, sealed))).rejects.toBeDefined();
  });

  test("chunks are deterministic, padded and authenticated", async () => {
    const plain = encodeText("hello world");
    const sealed = await run(codec.sealChunk(plain));
    expect(sealed).toEqual(await run(codec.sealChunk(plain)));
    expect(sealed.byteLength).toBe(12 + 4096 + 16);
    expect(decodeText(await run(codec.openChunk(sealed)))).toBe("hello world");
    const tampered = sealed.slice();
    tampered[40] = tampered[40]! ^ 1;
    await expect(run(codec.openChunk(tampered))).rejects.toBeDefined();
    await expect(run(other.openChunk(sealed))).rejects.toBeDefined();
    expect(decodeText(await run(codec.openChunk(await run(codec.sealChunk(new Uint8Array())))))).toBe("");
  });
});

describe("engine with end-to-end encryption", () => {
  const encrypted = (): CodecShape => codec;

  test("devices sync while the server only sees opaque data", async () => {
    const server = new Server();
    const a = await new Device("a", server, {}, encrypted()).start();
    const b = await new Device("b", server, {}, encrypted()).start();
    a.write("Diary/2026-11-05 secret.md", "my very private thoughts");
    a.write("big.bin", new Uint8Array(9 * 1024 * 1024).fill(3));
    await a.sync();
    await b.sync();
    expect(b.read("Diary/2026-11-05 secret.md")).toBe("my very private thoughts");
    expect(b.files.get("big.bin")!.data.every((v) => v === 3)).toBe(true);

    const rows = JSON.stringify(server.store.changes(0, 100));
    expect(rows).not.toContain("Diary");
    expect(rows).not.toContain("secret");
    for (const blob of server.blobs.values()) expect(decodeText(blob)).not.toContain("private");

    // Conflicts, renames and deletes work the same with encryption.
    a.rename("Diary/2026-11-05 secret.md", "Archive/old.md");
    await a.sync();
    await b.sync();
    expect(b.snapshot()).toMatchObject({ "Archive/old.md": "my very private thoughts" });
    expect(b.read("Diary/2026-11-05 secret.md")).toBeUndefined();
  });

  test("a device with the wrong key cannot read anything", async () => {
    const server = new Server();
    const a = await new Device("a", server, {}, codec).start();
    const intruder = await new Device("x", server, {}, other).start();
    a.write("n.md", "secret");
    await a.sync();
    // Unreadable entries are skipped one by one instead of failing the whole sync.
    expect((await intruder.sync()).skipped).toBe(1);
    expect(intruder.snapshot()).toEqual({});
  });
});
