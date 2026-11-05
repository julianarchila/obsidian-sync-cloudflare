import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";

import { categoryOf, DEFAULT_SELECTIVE, makeIsSyncable, selectiveFingerprint } from "../src/core/filter.ts";
import { Device, Server } from "./harness.ts";

describe("selective sync rules", () => {
  test("categories by extension", () => {
    expect(categoryOf("a/Note.md")).toBe("notes");
    expect(categoryOf("x/photo.JPG")).toBe("images");
    expect(categoryOf("song.mp3")).toBe("audio");
    expect(categoryOf("clip.mov")).toBe("video");
    expect(categoryOf("paper.pdf")).toBe("pdf");
    expect(categoryOf("data.csv")).toBe("other");
    expect(categoryOf("Makefile")).toBe("other");
  });

  test("excluded folders and disabled types", () => {
    const isSyncable = makeIsSyncable({
      excludedFolders: ["Private", "/Archive/old/"],
      types: { ...DEFAULT_SELECTIVE.types, video: false, other: false },
    });
    expect(isSyncable("Private/diary.md")).toBe(false);
    expect(isSyncable("Private")).toBe(false);
    expect(isSyncable("PrivateNotes/x.md")).toBe(true);
    expect(isSyncable("Archive/old/a.md")).toBe(false);
    expect(isSyncable("Archive/new/a.md")).toBe(true);
    expect(isSyncable("clip.mp4")).toBe(false);
    expect(isSyncable("data.csv")).toBe(false);
    expect(isSyncable("note.md")).toBe(true); // notes are always synced
  });

  test("fingerprint ignores order and slashes", () => {
    const a = selectiveFingerprint({ ...DEFAULT_SELECTIVE, excludedFolders: ["b", "/a/"] });
    const b = selectiveFingerprint({ ...DEFAULT_SELECTIVE, excludedFolders: ["a", "b"] });
    expect(a).toBe(b);
  });
});

describe("selective sync in the engine", () => {
  test("excluded folder never syncs; re-including it pulls it", async () => {
    const server = new Server();
    let excluded = ["Private"];
    const isSyncable = (p: string) => makeIsSyncable({ ...DEFAULT_SELECTIVE, excludedFolders: excluded })(p);
    const a = await new Device("a", server).start();
    const b = await new Device("b", server, { isSyncable }).start();

    a.write("Private/diary.md", "secret");
    a.write("public.md", "hi");
    await a.sync();
    await b.sync();
    expect(b.snapshot()).toEqual({ "public.md": "hi" });

    // B's own excluded files stay local and are never uploaded or deleted.
    b.write("Private/local-only.md", "mine");
    await b.sync();
    await a.sync();
    expect(a.read("Private/local-only.md")).toBeUndefined();

    // Re-include: reset the cursor so the whole index is re-read.
    excluded = [];
    await Effect.runPromise(b.engine.resetCursor);
    await b.sync();
    await a.sync();
    expect(b.read("Private/diary.md")).toBe("secret");
    expect(a.read("Private/local-only.md")).toBe("mine");
  });

  test("disabling a type leaves existing local files in place", async () => {
    const server = new Server();
    let types = { ...DEFAULT_SELECTIVE.types };
    const isSyncable = (p: string) => makeIsSyncable({ excludedFolders: [], types })(p);
    const a = await new Device("a", server).start();
    const b = await new Device("b", server, { isSyncable }).start();
    a.write("v.mp4", "video");
    await a.sync();
    await b.sync();
    expect(b.read("v.mp4")).toBe("video");

    types = { ...types, video: false };
    a.remove("v.mp4");
    await a.sync();
    await b.sync();
    // Excluded now: B neither deletes nor re-uploads it.
    expect(b.read("v.mp4")).toBe("video");
    expect(a.read("v.mp4")).toBeUndefined();
  });
});
