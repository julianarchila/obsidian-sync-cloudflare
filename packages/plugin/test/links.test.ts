import { describe, expect, test } from "bun:test";

import { hasLinkTo, rebaseLinks, rewriteLinks } from "../src/core/links.ts";

describe("links", () => {
  const from = "Projects/idea.md";
  const to = "Archive/2026/idea v2.md";

  test("wikilinks by name and path, with headings, aliases and embeds", () => {
    const text = "[[idea]] [[Projects/idea|alias]] ![[idea#Plan]] [[idea.md]] [[other]]";
    expect(rewriteLinks(text, from, to, "Notes/n.md").text).toBe(
      "[[idea v2]] [[Archive/2026/idea v2|alias]] ![[idea v2#Plan]] [[idea v2]] [[other]]",
    );
  });

  test("Markdown links: vault paths, relative, rooted, anchors, angle brackets", () => {
    const note = "Notes/Sub/n.md";
    const text = [
      "[a](Projects/idea.md)",
      "[b](../../Projects/idea.md)",
      "[c](Projects/idea.md#Plan)",
      "[d](/Projects/idea.md)",
      "[e](<../../Projects/idea.md>)",
      "[f](https://example.com/Projects/idea.md)",
      "![img](../../Projects/idea.md \"title\")",
    ].join("\n");
    expect(rewriteLinks(text, from, to, note).text).toBe(
      [
        "[a](Archive/2026/idea%20v2.md)",
        "[b](../../Archive/2026/idea%20v2.md)",
        "[c](Archive/2026/idea%20v2.md#Plan)",
        "[d](/Archive/2026/idea%20v2.md)",
        "[e](<../../Archive/2026/idea v2.md>)",
        "[f](https://example.com/Projects/idea.md)",
        '![img](../../Archive/2026/idea%20v2.md "title")',
      ].join("\n"),
    );
  });

  test("code spans and blocks are left alone", () => {
    const text = "`[[idea]]` and\n```\n[[idea]]\n```\nbut [[idea]]";
    expect(rewriteLinks(text, from, to).text).toBe("`[[idea]]` and\n```\n[[idea]]\n```\nbut [[idea v2]]");
  });

  test("a moved note's relative links are re-pointed from its new folder", () => {
    const text = "[x](../Notes/a.md) [y](Notes/a.md) [[a]]";
    expect(rebaseLinks(text, "Projects/idea.md", "Archive/2026/idea.md").text).toBe("[x](../../Notes/a.md) [y](Notes/a.md) [[a]]");
  });

  test("hasLinkTo finds relative Markdown links", () => {
    expect(hasLinkTo("see [it](../Projects/idea.md#x)", from, "Notes/n.md")).toBe(true);
    expect(hasLinkTo("see `[[idea]]`", from, "Notes/n.md")).toBe(false);
  });
});
