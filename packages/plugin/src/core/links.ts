/**
 * Obsidian links: [[wikilinks]] (by note name or path, with #heading,
 * |alias and ! embeds) and Markdown links. Used to keep links working when a
 * note moves (MCP `move_note`, CLI `homebase mv`).
 */

export const stem = (path: string) => path.replace(/\.md$/i, "");
export const baseName = (path: string) => stem(path).split("/").pop()!;
export const WIKILINK = /(!?\[\[)([^\]|#\n]+)((?:#[^\]|\n]*)?(?:\|[^\]\n]*)?\]\])/g;

/** Does `target` (a wikilink target) point at `path`? By full path or, Obsidian's default, by note name. */
export const linksTo = (target: string, path: string) => {
  const t = stem(target.trim()).normalize("NFC").toLowerCase();
  return t === stem(path).toLowerCase() || t === baseName(path).toLowerCase();
};

/** Rewrite wikilinks and Markdown links pointing at `from` so they point at `to`. */
export const rewriteLinks = (text: string, from: string, to: string) => {
  let count = 0;
  let out = text.replace(WIKILINK, (all, open: string, target: string, rest: string) => {
    if (!linksTo(target, from)) return all;
    const byPath = target.includes("/");
    const replacement = byPath ? stem(to) : baseName(to);
    if (replacement === stem(target.trim())) return all;
    count++;
    return `${open}${replacement}${rest}`;
  });
  for (const variant of new Set([from, encodeURI(from)])) {
    const link = `](${variant})`;
    if (out.includes(link)) {
      count += out.split(link).length - 1;
      out = out.split(link).join(`](${encodeURI(to)})`);
    }
  }
  return { text: out, count };
};

/** Does `text` link to `path`? */
export const hasLinkTo = (text: string, path: string) =>
  [...text.matchAll(WIKILINK)].some((m) => linksTo(m[2]!, path)) ||
  text.includes(`](${path})`) ||
  text.includes(`](${encodeURI(path)})`);
