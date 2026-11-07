import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";

import { setup } from "./harness.ts";

describe("engine: basics", () => {
  test("create, edit, delete propagate", async () => {
    const { devices: [a, b] } = await setup();
    a!.write("notes/hello.md", "hola");
    await a!.sync();
    await b!.sync();
    expect(b!.read("notes/hello.md")).toBe("hola");

    b!.write("notes/hello.md", "hola desde b");
    await b!.sync();
    await a!.sync();
    expect(a!.read("notes/hello.md")).toBe("hola desde b");

    a!.remove("notes/hello.md");
    await a!.sync();
    await b!.sync();
    expect(b!.read("notes/hello.md")).toBeUndefined();
  });

  test("binary and multi-chunk files round-trip", async () => {
    const { devices: [a, b] } = await setup();
    const big = new Uint8Array(20 * 1024 * 1024).map((_, i) => (i * 31) % 251);
    a!.write("big.bin", big);
    await a!.sync();
    await b!.sync();
    expect(b!.files.get("big.bin")!.data).toEqual(big);
    expect(b!.state.base["big.bin"]!.chunks.length).toBe(3);
  });

  test("editing a big file re-uploads only changed chunks", async () => {
    const { server, devices: [a] } = await setup(1);
    const big = new Uint8Array(20 * 1024 * 1024).fill(7);
    a!.write("big.bin", big);
    await a!.sync();
    const before = server.blobs.size;
    const edited = big.slice();
    edited[edited.length - 1] = 9; // last chunk only
    a!.write("big.bin", edited);
    await a!.sync();
    expect(server.blobs.size - before).toBe(1);
  });

  test("rename is a single op that keeps content", async () => {
    const { server, devices: [a, b] } = await setup();
    a!.write("a.md", "content");
    await a!.sync();
    await b!.sync();
    a!.rename("a.md", "folder/b.md");
    await a!.sync();
    await b!.sync();
    expect(b!.snapshot()).toEqual({ "folder/b.md": "content" });
    expect(server.store.history("folder/b.md")).toHaveLength(1);
    expect(server.store.history("a.md").map((e) => e.deleted)).toEqual([true, false]);
  });

  test("a dirty-path sync only reads the given paths", async () => {
    const { devices: [a, b] } = await setup();
    a!.write("x.md", "1");
    a!.write("y.md", "1");
    await a!.sync(["x.md"]);
    await b!.sync();
    expect(b!.snapshot()).toEqual({ "x.md": "1" });
  });
});

describe("engine: conflicts", () => {
  test("concurrent edits keep both versions (remote wins the path)", async () => {
    const { devices: [a, b] } = await setup();
    a!.write("n.md", "base");
    await a!.sync();
    await b!.sync();
    a!.write("n.md", "from a");
    b!.write("n.md", "from b");
    await a!.sync();
    await b!.sync();
    await a!.sync();

    expect(a!.snapshot()).toEqual(b!.snapshot());
    expect(a!.read("n.md")).toBe("from a");
    const copies = Object.entries(a!.snapshot()).filter(([p]) => p.includes("(conflict dev2"));
    expect(copies.map(([, v]) => v)).toEqual(["from b"]);
  });

  test("a merger resolves concurrent edits without a copy", async () => {
    const merge = ({ ours, theirs }: { ours: Uint8Array; theirs: Uint8Array }) =>
      new TextEncoder().encode(`${new TextDecoder().decode(theirs)}+${new TextDecoder().decode(ours)}`);
    const { devices: [a, b] } = await setup(2, { merge });
    a!.write("n.md", "base");
    await a!.sync();
    await b!.sync();
    a!.write("n.md", "A");
    b!.write("n.md", "B");
    await a!.sync();
    await b!.sync();
    await a!.sync();
    expect(b!.snapshot()).toEqual({ "n.md": "A+B" });
    expect(a!.snapshot()).toEqual({ "n.md": "A+B" });
  });

  test("edit beats delete, both ways", async () => {
    const { devices: [a, b] } = await setup();
    a!.write("keep.md", "v1");
    a!.write("keep2.md", "v1");
    await a!.sync();
    await b!.sync();

    // A deletes, B edits (B syncs second).
    a!.remove("keep.md");
    b!.write("keep.md", "edited");
    // A edits, B deletes (B syncs second).
    a!.write("keep2.md", "edited");
    b!.remove("keep2.md");

    await a!.sync();
    await b!.sync();
    await a!.sync();
    expect(a!.snapshot()).toEqual({ "keep.md": "edited", "keep2.md": "edited" });
    expect(b!.snapshot()).toEqual(a!.snapshot());
  });

  test("a lost commit response is idempotent on retry", async () => {
    const { server, devices: [a] } = await setup(1);
    a!.write("n.md", "once");
    await a!.sync();
    // Simulate a lost response: forget the base, as if the commit never acknowledged.
    a!.state.base = {};
    await a!.start();
    await a!.sync();
    expect(server.store.history("n.md")).toHaveLength(1);
    expect(a!.snapshot()).toEqual({ "n.md": "once" });
  });
});

describe("engine: offline", () => {
  test("offline edits, deletes and renames on both sides converge", async () => {
    const { server, devices: [a, b] } = await setup();
    for (const p of ["keep.md", "del.md", "move.md", "both.md"]) a!.write(p, `${p} v1`);
    await a!.sync();
    await b!.sync();

    // B goes offline (Obsidian closed) and changes things.
    server.online = false;
    b!.write("keep.md", "keep.md edited offline by b");
    b!.remove("del.md");
    b!.rename("move.md", "moved/move.md");
    b!.write("new-b.md", "new on b");
    b!.write("both.md", "both by b");
    await expect(b!.sync()).rejects.toBeDefined();
    server.online = true;

    // Meanwhile A changes other things.
    a!.write("new-a.md", "new on a");
    a!.write("both.md", "both by a");
    await a!.sync();

    // B comes back.
    await b!.sync();
    await a!.sync();

    expect(a!.snapshot()).toEqual(b!.snapshot());
    const snap = a!.snapshot();
    expect(snap["keep.md"]).toBe("keep.md edited offline by b");
    expect(snap["del.md"]).toBeUndefined();
    expect(snap["move.md"]).toBeUndefined();
    expect(snap["moved/move.md"]).toBe("move.md v1");
    expect(snap["new-a.md"]).toBe("new on a");
    expect(snap["new-b.md"]).toBe("new on b");
    expect(snap["both.md"]).toBe("both by a");
    expect(Object.keys(snap).some((p) => p.startsWith("both (conflict dev2"))).toBe(true);
    // The offline rename was sent as a rename (content not re-uploaded as a new history).
    expect(server.store.history("moved/move.md")).toHaveLength(1);
  });

  test("a device that was away for a long time catches up incrementally", async () => {
    const { devices: [a, b] } = await setup();
    for (let i = 0; i < 120; i++) a!.write(`f${i}.md`, `v${i}`);
    await a!.sync();
    await b!.sync();
    const cursor = b!.state.cursor;
    a!.write("f7.md", "changed");
    await a!.sync();
    await b!.sync();
    expect(b!.read("f7.md")).toBe("changed");
    expect(b!.state.cursor).toBeGreaterThan(cursor);
  });

  test("unchanged files are not re-hashed on a full scan", async () => {
    const { devices: [a] } = await setup(1);
    for (let i = 0; i < 50; i++) a!.write(`f${i}.md`, `v${i}`);
    await a!.sync();
    const report = await a!.sync();
    expect(report).toEqual({ pulled: 0, pushed: 0, conflicts: 0, merged: 0, skipped: 0 });
  });
});

describe("engine: selective", () => {
  test("excluded paths are ignored both ways", async () => {
    const isSyncable = (p: string) => !p.startsWith("private/");
    const { server, devices: [a, b] } = await setup(2, { isSyncable });
    a!.write("private/secret.md", "nope");
    a!.write("public.md", "yes");
    await a!.sync();
    await b!.sync();
    expect(b!.snapshot()).toEqual({ "public.md": "yes" });
    expect(server.store.current("private/secret.md")).toBeNull();
  });
});

describe("engine: idle cost", () => {
  test("a local-only sync with nothing changed makes zero requests", async () => {
    const { server, devices: [a] } = await setup(1);
    for (let i = 0; i < 20; i++) a!.write(`f${i}.md`, `v${i}`);
    await a!.sync();
    const before = server.requests;
    for (let i = 0; i < 10; i++) await Effect.runPromise(a!.engine.sync(undefined, { pull: false }));
    expect(server.requests).toBe(before);
    expect(await Effect.runPromise(a!.engine.changedLocally(["f1.md", "f2.md"]))).toEqual([]);
  });

  test("changedLocally spots edits, new files and deletes by stat only", async () => {
    const { server, devices: [a] } = await setup(1);
    a!.write("a.md", "1");
    a!.write("b.md", "1");
    await a!.sync();
    const before = server.requests;
    a!.write("a.md", "2");
    a!.remove("b.md");
    a!.write("c.md", "new");
    const changed = await Effect.runPromise(a!.engine.changedLocally(["a.md", "b.md", "c.md", "d.md"]));
    expect(changed.sort()).toEqual(["a.md", "b.md", "c.md"]);
    expect(server.requests).toBe(before);
    // Pushing those changes without pulling only talks to the server to write them.
    await Effect.runPromise(a!.engine.sync(new Set(changed), { pull: false }));
    expect(server.store.current("a.md")?.version).toBe(2);
    expect(server.store.current("b.md")?.deleted).toBe(true);
  });
});

describe("engine: progress and priority", () => {
  test("download progress counts files and bytes, notes first, attachments last", async () => {
    const progress: Array<{ done: number; total: number; current?: string }> = [];
    const { devices: [a] } = await setup(1);
    const server = a!.remote;
    a!.write("big.pdf", new Uint8Array(3 * 1024 * 1024).fill(1));
    a!.write("note1.md", "one");
    a!.write("note2.md", "two");
    await a!.sync();

    const { Device } = await import("./harness.ts");
    const b = await new Device("b", server, {
      onProgress: (p) => p && progress.push({ done: p.done, total: p.total, current: p.current }),
    }).start();
    await b.sync();

    expect(progress[0]?.total).toBe(3);
    expect(progress.at(-1)).toMatchObject({ done: 3, total: 3 });
    const order = progress.filter((p) => p.current).map((p) => p.current);
    expect(order.indexOf("big.pdf")).toBe(2); // after both notes
  });

  test("a local edit made during a big download is pushed before the download finishes", async () => {
    const { server, devices: [a] } = await setup(1);
    for (let i = 0; i < 3; i++) a!.write(`att${i}.pdf`, new Uint8Array(2 * 1024 * 1024).fill(i + 1));
    await a!.sync();

    const { Device } = await import("./harness.ts");
    let edited = false;
    const b = await new Device("b", server).start();
    b.write("draft.md", "typed while downloading");
    const takeDirty = () => {
      if (edited) return new Set<string>();
      edited = true;
      return new Set(["draft.md"]);
    };
    server.ops = [];
    await Effect.runPromise(b.engine.sync(undefined, { takeDirty }));

    const firstCommit = server.ops.indexOf("commit");
    const lastBlob = server.ops.lastIndexOf("getBlob");
    expect(firstCommit).toBeGreaterThan(-1);
    expect(firstCommit).toBeLessThan(lastBlob);
    expect(server.store.current("draft.md")?.deleted).toBe(false);
  });

  test("activity events describe what happened", async () => {
    const events: string[] = [];
    const { devices: [a, b] } = await setup(2, { onActivity: (e) => events.push(`${e.kind}:${e.path}`) });
    a!.write("x.md", "1");
    await a!.sync();
    await b!.sync();
    a!.remove("x.md");
    await a!.sync();
    await b!.sync();
    expect(events).toEqual(["uploaded:x.md", "downloaded:x.md", "deleted-remote:x.md", "deleted-here:x.md"]);
  });
});

describe("engine: files this device can't write", () => {
  test("an invalid name on this device is skipped; everything else syncs and nothing is deleted", async () => {
    const { server, devices: [mac] } = await setup(1);
    mac!.write('Clippings/Farhan on X "Modal".md', "quoted");
    mac!.write("Clippings/Is it S3?.md", "question");
    mac!.write("Clippings/normal.md", "fine");
    mac!.write("note.md", "fine too");
    await mac!.sync();

    // An "Android" device whose filesystem rejects \ : * ? < > " |
    const { Device } = await import("./harness.ts");
    const events: string[] = [];
    const android = await new Device("android", server, { onActivity: (e) => events.push(`${e.kind}:${e.path}`) }).start();
    const realWrite = android.files.set.bind(android.files);
    android.files.set = (path, value) => {
      if (/[\\:*?<>"|]/.test(path)) throw new Error("File name cannot contain any of the following characters");
      return realWrite(path, value);
    };

    const report = await android.sync();
    expect(report.skipped).toBe(2);
    expect(android.snapshot()).toEqual({ "Clippings/normal.md": "fine", "note.md": "fine too" });
    expect(events.filter((e) => e.startsWith("skipped")).sort()).toEqual([
      'skipped:Clippings/Farhan on X "Modal".md',
      "skipped:Clippings/Is it S3?.md",
    ]);

    // A later sync neither retries forever nor deletes the skipped files remotely.
    expect((await android.sync()).skipped).toBe(0);
    expect(server.store.current('Clippings/Farhan on X "Modal".md')?.deleted).toBe(false);
    expect(server.store.current("Clippings/Is it S3?.md")?.deleted).toBe(false);
  });
});

describe("engine: moves", () => {
  test("a move edited in the same pass keeps its history", async () => {
    const { server, devices: [a, b] } = await setup();
    a!.write("Inbox/Plan.md", "v1\n");
    await a!.sync();
    await b!.sync();
    a!.rename("Inbox/Plan.md", "Projects/Plan.md");
    a!.write("Projects/Plan.md", "v1\nedited while moving\n");
    await a!.sync();
    await b!.sync();
    expect(b!.snapshot()).toEqual({ "Projects/Plan.md": "v1\nedited while moving\n" });
    // Recorded as a move plus an edit, not a delete and an unrelated new file.
    expect(server.store.movedFrom("Projects/Plan.md")).toEqual(["Inbox/Plan.md"]);
    expect(server.store.history("Projects/Plan.md").length).toBe(2);
    expect(server.store.deleted().length).toBe(0);
  });

  test("moved offline while edited elsewhere: the edit lands at the new path, no duplicate", async () => {
    const { devices: [a, b] } = await setup();
    a!.write("Trip.md", "draft\n");
    await a!.sync();
    await b!.sync();
    b!.rename("Trip.md", "Travel/Trip.md"); // b is offline: not synced yet
    a!.write("Trip.md", "draft\nedited on a\n");
    await a!.sync();
    await b!.sync();
    await a!.sync();
    expect(b!.snapshot()).toEqual({ "Travel/Trip.md": "draft\nedited on a\n" });
    expect(a!.snapshot()).toEqual(b!.snapshot());
  });

  test("receiving a rename reuses the local bytes instead of downloading them again", async () => {
    const { server, devices: [a, b] } = await setup();
    for (let i = 0; i < 20; i++) a!.write(`Old/n${i}.md`, `note ${i}`);
    await a!.sync();
    await b!.sync();
    for (let i = 0; i < 20; i++) a!.rename(`Old/n${i}.md`, `New/n${i}.md`);
    await a!.sync();
    server.ops = [];
    await b!.sync();
    expect(Object.keys(b!.snapshot()).every((p) => p.startsWith("New/"))).toBe(true);
    expect(Object.keys(b!.snapshot()).length).toBe(20);
    expect(server.ops.filter((op) => op === "getBlob").length).toBe(0);
  });
});
