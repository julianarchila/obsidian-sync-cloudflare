import { describe, expect, test } from "bun:test";

import { hasLinkTo, linkKeys, linkKeysOf, rebaseLinks, rewriteLinks } from "../src/core/links.ts";

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

describe("links: names several notes share", () => {
  const paths = ["Work/Plan.md", "Personal/Plan.md", "Personal/Todo.md", "Other/Index.md"];

  test("a bare name resolves to the note next to the linking note", () => {
    expect(rewriteLinks("[[Plan]]", "Work/Plan.md", "Work/Roadmap.md", "Personal/Todo.md", paths).count).toBe(0);
    expect(rewriteLinks("[[Plan]]", "Personal/Plan.md", "Personal/Roadmap.md", "Personal/Todo.md", paths).text).toBe("[[Roadmap]]");
    // Ambiguous from elsewhere: left alone; a path link is always exact.
    expect(rewriteLinks("[[Plan]] [[Work/Plan]]", "Work/Plan.md", "Work/Roadmap.md", "Other/Index.md", paths).text).toBe(
      "[[Plan]] [[Work/Roadmap]]",
    );
  });

  test("linkKeys covers every link hasLinkTo can match", () => {
    const text = "[[Plan#x|y]] [a](../Work/Plan.md) [b](<My Note.md>) [c](My%20Note.md) `[[code]]` [w](https://x.y)";
    expect(linkKeys(text, "Notes/n.md").sort()).toEqual(["my note", "notes/my note", "plan", "work/plan"]);
    for (const path of ["Work/Plan.md", "Notes/My Note.md"]) {
      expect(hasLinkTo(text, path, "Notes/n.md")).toBe(true);
      expect(linkKeysOf(path).some((k) => linkKeys(text, "Notes/n.md").includes(k))).toBe(true);
    }
  });
});
