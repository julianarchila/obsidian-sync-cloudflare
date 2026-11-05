import { describe, expect, test } from "bun:test";

import { diffLines, lcsPairs, merge3, mergeText, splitLines } from "../src/core/merge.ts";
import { setup } from "./harness.ts";

const doc = (...paragraphs: string[]) => `${paragraphs.join("\n\n")}\n`;

describe("diff", () => {
  test("splitLines keeps line endings and a final line without newline", () => {
    expect(splitLines("a\nb\nc")).toEqual(["a\n", "b\n", "c"]);
    expect(splitLines("a\n\n")).toEqual(["a\n", "\n"]);
    expect(splitLines("")).toEqual([]);
  });

  test("lcs finds a longest common subsequence", () => {
    const a = splitLines("a\nb\nc\nd\ne\n");
    const b = splitLines("a\nx\nc\nd\ny\ne\n");
    expect(lcsPairs(a, b)).toEqual([
      [0, 0],
      [2, 2],
      [3, 3],
      [4, 5],
    ]);
  });

  test("diffLines shows adds and deletes", () => {
    const d = diffLines("one\ntwo\nthree\n", "one\n2\nthree\nfour\n")!;
    expect(d.map((l) => `${l.kind[0]}${l.text.trim()}`)).toEqual(["sone", "dtwo", "a2", "sthree", "afour"]);
  });

  test("large inputs stay fast", () => {
    const base = Array.from({ length: 20_000 }, (_, i) => `line ${i}\n`);
    const edited = base.slice();
    edited[10] = "changed\n";
    edited.splice(15_000, 0, "inserted\n");
    const t0 = performance.now();
    expect(lcsPairs(base, edited)).not.toBeNull();
    expect(performance.now() - t0).toBeLessThan(200);
  });
});

describe("merge3", () => {
  const base = doc("# Title", "First paragraph.", "Second paragraph.", "Third paragraph.");

  test("edits to different paragraphs both survive", () => {
    const ours = doc("# Title", "First paragraph, edited by A.", "Second paragraph.", "Third paragraph.");
    const theirs = doc("# Title", "First paragraph.", "Second paragraph.", "Third paragraph, edited by B.");
    expect(merge3(base, ours, theirs)).toBe(
      doc("# Title", "First paragraph, edited by A.", "Second paragraph.", "Third paragraph, edited by B."),
    );
  });

  test("insertions on both sides and deletions merge", () => {
    const ours = doc("# Title", "New intro from A.", "First paragraph.", "Second paragraph.", "Third paragraph.");
    const theirs = doc("# Title", "First paragraph.", "Third paragraph.", "Appendix from B.");
    expect(merge3(base, ours, theirs)).toBe(
      doc("# Title", "New intro from A.", "First paragraph.", "Third paragraph.", "Appendix from B."),
    );
  });

  test("identical edits on both sides are taken once", () => {
    const both = doc("# Title", "First paragraph!", "Second paragraph.", "Third paragraph.");
    expect(merge3(base, both, both)).toBe(both);
  });

  test("overlapping different edits conflict", () => {
    const ours = doc("# Title", "First paragraph by A.", "Second paragraph.", "Third paragraph.");
    const theirs = doc("# Title", "First paragraph by B.", "Second paragraph.", "Third paragraph.");
    expect(merge3(base, ours, theirs)).toBeNull();
  });

  test("one side unchanged returns the other", () => {
    const ours = doc("anything");
    expect(merge3(base, ours, base)).toBe(ours);
    expect(merge3(base, base, ours)).toBe(ours);
  });

  test("mergeText only handles text notes with a base", () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(mergeText({ path: "a.png", base: enc("x"), ours: enc("y"), theirs: enc("z") })).toBeNull();
    expect(mergeText({ path: "a.md", base: null, ours: enc("y"), theirs: enc("z") })).toBeNull();
    expect(mergeText({ path: "a.md", base: enc("a\nb\n"), ours: enc("A\nb\n"), theirs: enc("a\nB\n") })).toBeNull();
    expect(
      new TextDecoder().decode(
        mergeText({ path: "a.md", base: enc("a\n\nb\n"), ours: enc("A\n\nb\n"), theirs: enc("a\n\nB\n") })!,
      ),
    ).toBe("A\n\nB\n");
  });
});

describe("engine with markdown merge", () => {
  const base = doc("# Plan", "Monday: gym.", "Tuesday: read.", "Wednesday: write.");

  test("concurrent edits to different paragraphs merge without a conflict copy", async () => {
    const { devices: [a, b] } = await setup(2, { merge: mergeText });
    a!.write("plan.md", base);
    await a!.sync();
    await b!.sync();
    a!.write("plan.md", doc("# Plan", "Monday: gym and swim.", "Tuesday: read.", "Wednesday: write."));
    b!.write("plan.md", doc("# Plan", "Monday: gym.", "Tuesday: read.", "Wednesday: write the report."));
    await a!.sync();
    await b!.sync();
    await a!.sync();
    const merged = doc("# Plan", "Monday: gym and swim.", "Tuesday: read.", "Wednesday: write the report.");
    expect(a!.snapshot()).toEqual({ "plan.md": merged });
    expect(b!.snapshot()).toEqual({ "plan.md": merged });
  });

  test("offline edits on both devices merge when B returns", async () => {
    const { server, devices: [a, b] } = await setup(2, { merge: mergeText });
    a!.write("plan.md", base);
    await a!.sync();
    await b!.sync();
    server.online = false;
    b!.write("plan.md", doc("# Plan", "Monday: gym.", "Tuesday: read, offline edit.", "Wednesday: write."));
    server.online = true;
    a!.write("plan.md", doc("# Plan", "Monday: rest.", "Tuesday: read.", "Wednesday: write."));
    await a!.sync();
    await b!.sync();
    await a!.sync();
    const merged = doc("# Plan", "Monday: rest.", "Tuesday: read, offline edit.", "Wednesday: write.");
    expect(b!.read("plan.md")).toBe(merged);
    expect(a!.read("plan.md")).toBe(merged);
  });

  test("overlapping edits still keep both versions", async () => {
    const { devices: [a, b] } = await setup(2, { merge: mergeText });
    a!.write("plan.md", base);
    await a!.sync();
    await b!.sync();
    a!.write("plan.md", doc("# Plan", "Monday: A.", "Tuesday: read.", "Wednesday: write."));
    b!.write("plan.md", doc("# Plan", "Monday: B.", "Tuesday: read.", "Wednesday: write."));
    await a!.sync();
    await b!.sync();
    await a!.sync();
    expect(a!.snapshot()).toEqual(b!.snapshot());
    expect(Object.keys(a!.snapshot()).filter((p) => p.includes("conflict"))).toHaveLength(1);
  });
});
