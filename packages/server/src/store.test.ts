import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { bunSql as wrap } from "./sql-bun.ts";
import { VaultStore } from "./store.ts";

const bunSql = () => wrap(new Database(":memory:"));

const h = (c: string) => c.repeat(64);
const put = (path: string, baseVersion: number | null, chunk = "a") =>
  ({ op: "put", path, baseVersion, chunks: [h(chunk)], meta: `m-${path}`, device: "d" }) as const;

describe("VaultStore", () => {
  test("put creates versions and enforces compare-and-swap", () => {
    const store = new VaultStore(bunSql());
    const [first] = store.commit([put("a", null)]);
    expect(first).toMatchObject({ ok: true, entries: [{ path: "a", version: 1 }] });

    const [stale] = store.commit([put("a", null, "b")]);
    expect(stale).toMatchObject({ ok: false, path: "a", current: { version: 1 } });

    const [second] = store.commit([put("a", 1, "b")]);
    expect(second).toMatchObject({ ok: true, entries: [{ version: 2, chunks: [h("b")] }] });
  });

  test("changes returns only the latest version per path, paginated", () => {
    const store = new VaultStore(bunSql());
    store.commit([put("a", null), put("b", null), put("c", null)]);
    store.commit([put("a", 1, "z")]);

    const all = store.changes(0, 10);
    expect(all.entries.map((e) => [e.path, e.version])).toEqual([
      ["b", 1],
      ["c", 1],
      ["a", 2],
    ]);
    expect(all.more).toBe(false);
    expect(all.seq).toBe(store.seq());

    const page = store.changes(0, 2);
    expect(page.more).toBe(true);
    const rest = store.changes(page.seq, 2);
    expect(rest.entries.map((e) => e.path)).toEqual(["a"]);
    expect(rest.more).toBe(false);

    expect(store.changes(store.seq(), 10).entries).toEqual([]);
  });

  test("remove writes a tombstone and a later put recreates the file", () => {
    const store = new VaultStore(bunSql());
    store.commit([put("a", null)]);
    expect(store.commit([{ op: "remove", path: "a", baseVersion: 1, device: "d" }])[0]).toMatchObject({
      ok: true,
      entries: [{ version: 2, deleted: true, chunks: [] }],
    });
    // A deleted path counts as absent for compare-and-swap.
    expect(store.commit([put("a", null)])[0]).toMatchObject({ ok: true, entries: [{ version: 3, deleted: false }] });
    expect(store.deleted()).toEqual([]);
  });

  test("rename moves content and leaves a tombstone", () => {
    const store = new VaultStore(bunSql());
    store.commit([put("a", null, "x")]);
    const [result] = store.commit([{ op: "rename", from: "a", to: "b", baseVersion: 1, meta: "m-b", device: "d" }]);
    expect(result).toMatchObject({
      ok: true,
      entries: [
        { path: "a", deleted: true },
        { path: "b", version: 1, chunks: [h("x")], meta: "m-b" },
      ],
    });
    // Renaming onto a live path conflicts.
    store.commit([put("c", null)]);
    const [blocked] = store.commit([{ op: "rename", from: "b", to: "c", baseVersion: 1, meta: "m", device: "d" }]);
    expect(blocked).toMatchObject({ ok: false, path: "c" });
  });

  test("meta is set once (first device wins)", () => {
    const store = new VaultStore(bunSql());
    expect(store.meta()).toEqual({ meta: null, created: false });
    expect(store.meta("one")).toEqual({ meta: "one", created: true });
    expect(store.meta("two")).toEqual({ meta: "one", created: false });
  });

  test("prune drops old non-current versions and reports orphan chunks", () => {
    let now = 1_000;
    const store = new VaultStore(bunSql(), () => now);
    store.commit([put("a", null, "1")]);
    store.commit([put("a", 1, "2")]);
    store.commit([put("b", null, "2")]); // shares chunk "2"
    now = 10_000;
    store.commit([put("a", 2, "3")]);

    const { prunedVersions, orphans } = store.prune(5_000);
    expect(prunedVersions).toBe(2); // a@1 and a@2; a@3 and b@1 are current
    expect(orphans).toEqual([h("1")]); // chunk "2" is still used by b
    expect(store.history("a").map((e) => e.version)).toEqual([3]);
    expect(store.unreferenced([h("1"), h("2"), h("3"), h("9")])).toEqual([h("1"), h("9")]);
  });

  test("20k files: one edit writes O(1) rows and catch-up only returns the change", () => {
    const store = new VaultStore(bunSql());
    const ops = Array.from({ length: 20_000 }, (_, i) => put(`f${i}`, null));
    for (let i = 0; i < ops.length; i += 200) store.commit(ops.slice(i, i + 200));
    const cursor = store.seq();
    const t0 = performance.now();
    store.commit([put("f123", 1, "e")]);
    expect(performance.now() - t0).toBeLessThan(50);
    expect(store.changes(cursor, 1000).entries.map((e) => e.path)).toEqual(["f123"]);
  });
});
