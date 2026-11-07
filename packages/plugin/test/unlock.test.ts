import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";

import { makeCryptoCodec } from "../src/core/legacy/crypto-codec.ts";
import { changeVaultPassword, unlockVault } from "../src/core/legacy/unlock.ts";
import { Device, Server } from "./harness.ts";

const unlock = (server: Server, input: Parameters<typeof unlockVault>[1]) =>
  Effect.runPromise(unlockVault(server.remote(), { iterations: 1000, ...input }).pipe(Effect.result));

describe("unlockVault", () => {
  test("first device creates the vault, others must match the password", async () => {
    const server = new Server();
    const none = await unlock(server, {});
    expect(none).toMatchObject({ _tag: "Failure", failure: { reason: "NeedPassword", isNewVault: true } });

    const first = await unlock(server, { password: "s3cret" });
    expect(first).toMatchObject({ _tag: "Success", success: { created: true } });

    const second = await unlock(server, { password: "s3cret" });
    expect(second).toMatchObject({ _tag: "Success", success: { created: false } });
    if (first._tag === "Success" && second._tag === "Success") expect(second.success.master).toEqual(first.success.master);

    expect(await unlock(server, { password: "wrong" })).toMatchObject({
      _tag: "Failure",
      failure: { reason: "WrongPassword" },
    });
  });

  test("a remembered key unlocks without the password", async () => {
    const server = new Server();
    const first = await unlock(server, { password: "pw" });
    if (first._tag !== "Success") throw new Error("setup");
    expect(await unlock(server, { rememberedKey: first.success.master })).toMatchObject({ _tag: "Success" });
    expect(await unlock(server, { rememberedKey: new Uint8Array(32) })).toMatchObject({
      _tag: "Failure",
      failure: { reason: "NeedPassword", isNewVault: false },
    });
  });

  test("changing the password keeps the data and other devices' remembered keys", async () => {
    const server = new Server();
    const created = await unlock(server, { password: "old-pw" });
    if (created._tag !== "Success") throw new Error("setup");
    const key = created.success.master;
    const codec = await Effect.runPromise(makeCryptoCodec(key));
    const a = await new Device("a", server, {}, codec).start();
    a.write("n.md", "secret note");
    await a.sync();

    await Effect.runPromise(changeVaultPassword(server.remote(), key, "new-pw", 1000));

    expect(await unlock(server, { password: "old-pw" })).toMatchObject({ _tag: "Failure", failure: { reason: "WrongPassword" } });
    const viaNew = await unlock(server, { password: "new-pw" });
    expect(viaNew).toMatchObject({ _tag: "Success" });
    if (viaNew._tag === "Success") expect(viaNew.success.master).toEqual(key);
    expect(await unlock(server, { rememberedKey: key })).toMatchObject({ _tag: "Success" });

    // Nothing was re-encrypted: a new device with the unwrapped key reads the old data.
    const b = await new Device("b", server, {}, await Effect.runPromise(makeCryptoCodec(key))).start();
    await b.sync();
    expect(b.read("n.md")).toBe("secret note");
  });

  test("a stale record cannot overwrite a concurrent password change", async () => {
    const server = new Server();
    const created = await unlock(server, { password: "pw" });
    if (created._tag !== "Success") throw new Error("setup");
    const before = server.store.meta().meta!;
    await Effect.runPromise(changeVaultPassword(server.remote(), created.success.master, "first", 1000));
    expect(server.store.replaceMeta(before, "stale")).toMatchObject({ replaced: false });
    expect(await unlock(server, { password: "first" })).toMatchObject({ _tag: "Success" });
  });
});
