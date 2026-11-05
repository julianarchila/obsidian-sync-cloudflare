import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { deletedFiles, fileHistory, readVersion, restoreDeleted, restoreVersion } from "../src/core/history.ts";
import { Codec, Remote, VaultIo } from "../src/core/services.ts";
import { type Device, setup } from "./harness.ts";

/** Run a history operation with a device's services. */
const on = <A, E>(device: Device, effect: Effect.Effect<A, E, Codec | Remote | VaultIo>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(Codec, device.codec),
          Layer.succeed(Remote, device.remote),
          Layer.succeed(VaultIo, {
            list: Effect.sync(() => []),
            stat: (p) => Effect.sync(() => (device.files.has(p) ? { path: p, mtime: 0, size: 0 } : null)),
            read: (p) => Effect.sync(() => device.files.get(p)?.data ?? null),
            write: (p, data) =>
              Effect.sync(() => {
                device.write(p, data);
                return { path: p, mtime: Date.now(), size: data.byteLength };
              }),
            remove: (p) => Effect.sync(() => device.remove(p)),
          }),
        ),
      ),
    ),
  );

describe("version history", () => {
  test("a file edited three times can be restored to version 1 on another device", async () => {
    const { devices: [a, b] } = await setup();
    for (const text of ["v1 content", "v2 content", "v3 content"]) {
      a!.write("note.md", text);
      await a!.sync();
    }
    await b!.sync();
    expect(b!.read("note.md")).toBe("v3 content");

    const history = await on(b!, fileHistory("note.md"));
    expect(history.map((v) => v.version)).toEqual([3, 2, 1]);
    expect(history.every((v) => v.device === "dev1")).toBe(true);
    expect(new TextDecoder().decode(await on(b!, readVersion(history[2]!)))).toBe("v1 content");

    await on(b!, restoreVersion(history[2]!));
    await b!.sync();
    await a!.sync();
    expect(a!.read("note.md")).toBe("v1 content");
    expect((await on(a!, fileHistory("note.md"))).map((v) => v.version)).toEqual([4, 3, 2, 1]);
  });

  test("deleted files are listed and can be recovered", async () => {
    const { devices: [a, b] } = await setup();
    a!.write("keep.md", "keep");
    a!.write("gone.md", "precious");
    await a!.sync();
    await b!.sync();
    a!.remove("gone.md");
    await a!.sync();
    await b!.sync();
    expect(b!.read("gone.md")).toBeUndefined();

    const deleted = await on(b!, deletedFiles);
    expect(deleted.map((d) => d.path)).toEqual(["gone.md"]);

    await on(b!, restoreDeleted("gone.md"));
    await b!.sync();
    await a!.sync();
    expect(a!.read("gone.md")).toBe("precious");
    expect(await on(a!, deletedFiles)).toEqual([]);
  });
});
