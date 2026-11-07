/**
 * Obsidian links: [[wikilinks]] (by note name or path, with #heading, |alias
 * and ! embeds) and Markdown links (vault-absolute, relative to the note, or
 * rooted with `/`, with #anchors and <angle brackets>). Used to keep links
 * working when a note moves (MCP `move_note`, CLI `homebase mv`). Code spans
 * and fenced code blocks are left alone.
 */

export const stem = (path: string) => path.replace(/\.md$/i, "");
export const baseName = (path: string) => stem(path).split("/").pop()!;
export const WIKILINK = /(!?\[\[)([^\]|#\n]+)((?:#[^\]|\n]*)?(?:\|[^\]\n]*)?\]\])/g;
/** `[text](target)` / `![alt](target)`; target is `<...>` or has no spaces. */
const MDLINK = /(!?\[[^\]\n]*\]\()(<[^>\n]+>|[^)\s]+)((?:\s+"[^"\n]*")?\))/g;
const CODE = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/;

const dirOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const wikiKey = (target: string) => stem(target.trim()).normalize("NFC").toLowerCase();

/**
 * Does `target` (a wikilink target in `note`) point at `path`? By full path or,
 * Obsidian's default, by note name. With `paths` (every file in the vault), a
 * name several files share counts only when `path` is the one next to `note`,
 * the way Obsidian resolves it; otherwise it is left alone.
 */
export const linksTo = (target: string, path: string, note = "", paths?: ReadonlyArray<string>) => {
  const t = wikiKey(target);
  if (t === stem(path).toLowerCase()) return true;
  if (t !== baseName(path).toLowerCase()) return false;
  const named = paths?.filter((p) => baseName(p).toLowerCase() === t) ?? [];
  if (named.length <= 1) return true;
  return named.find((p) => dirOf(p) === dirOf(note)) === path;
};

/** Resolve `rel` against folder `dir` (vault paths, forward slashes). Null if it leaves the vault. */
const resolve = (dir: string, rel: string) => {
  const parts = dir === "" ? [] : dir.split("/");
  for (const part of rel.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join("/");
};

/** Path from folder `dir` to vault path `to`. */
const relative = (dir: string, to: string) => {
  const from = dir === "" ? [] : dir.split("/");
  const target = to.split("/");
  let common = 0;
  while (common < from.length && common < target.length - 1 && from[common] === target[common]) common++;
  return [...Array(from.length - common).fill(".."), ...target.slice(common)].join("/");
};

interface MdTarget {
  readonly path: string;
  readonly anchor: string;
  readonly style: "vault" | "relative" | "rooted";
  readonly angle: boolean;
  readonly encoded: boolean;
}

/** Parse a Markdown link target as written in `note`; null for URLs and anchors-only. */
const parseMd = (raw: string, note: string): MdTarget[] => {
  const angle = raw.startsWith("<") && raw.endsWith(">");
  const inner = angle ? raw.slice(1, -1) : raw;
  if (/^[a-z][a-z0-9+.-]*:/i.test(inner) || inner.startsWith("#")) return [];
  const hash = inner.indexOf("#");
  const [rawPath, anchor] = hash >= 0 ? [inner.slice(0, hash), inner.slice(hash)] : [inner, ""];
  let path: string;
  try {
    path = decodeURI(rawPath).normalize("NFC");
  } catch {
    path = rawPath;
  }
  const encoded = rawPath !== path || (!angle && !path.includes(" "));
  if (path.startsWith("/")) return [{ path: path.slice(1), anchor, style: "rooted", angle, encoded }];
  const candidates: MdTarget[] = [];
  // Obsidian resolves a bare path relative to the note first, then from the vault root.
  const rel = resolve(dirOf(note), path);
  if (rel !== null) candidates.push({ path: rel, anchor, style: "relative", angle, encoded });
  if (!path.startsWith(".")) candidates.push({ path, anchor, style: "vault", angle, encoded });
  return candidates;
};

const formatMd = (target: Omit<MdTarget, "path">, path: string, note: string) => {
  const written = target.style === "rooted" ? `/${path}` : target.style === "relative" ? relative(dirOf(note), path) : path;
  const body = `${target.encoded ? encodeURI(written) : written}${target.anchor}`;
  return target.angle || (!target.encoded && body.includes(" ")) ? `<${body}>` : body;
};

/** Apply `f` to the parts of `text` outside code spans and blocks. */
const outsideCode = (text: string, f: (part: string) => string) =>
  text
    .split(CODE)
    .map((part, i) => (i % 2 === 1 ? part : f(part)))
    .join("");

/**
 * Rewrite links in `text` (the content of note `note`) that point at `from`
 * so they point at `to`.
 */
export const rewriteLinks = (text: string, from: string, to: string, note = "", paths?: ReadonlyArray<string>) => {
  let count = 0;
  const out = outsideCode(text, (part) =>
    part
      .replace(WIKILINK, (all, open: string, target: string, rest: string) => {
        if (!linksTo(target, from, note, paths)) return all;
        const byPath = target.includes("/");
        const replacement = byPath ? stem(to) : baseName(to);
        if (replacement === stem(target.trim())) return all;
        count++;
        return `${open}${replacement}${rest}`;
      })
      .replace(MDLINK, (all, open: string, raw: string, close: string) => {
        const match = parseMd(raw, note).find((t) => t.path === from);
        if (!match) return all;
        count++;
        return `${open}${formatMd(match, to, note)}${close}`;
      }),
  );
  return { text: out, count };
};

/**
 * The moved note's own relative Markdown links: re-point them from its new
 * folder (wikilinks and vault paths don't depend on where the note is).
 */
export const rebaseLinks = (text: string, from: string, to: string) => {
  if (dirOf(from) === dirOf(to)) return { text, count: 0 };
  let count = 0;
  const out = outsideCode(text, (part) =>
    part.replace(MDLINK, (all, open: string, raw: string, close: string) => {
      const target = parseMd(raw, from).find((t) => t.style === "relative" && raw.replace(/^</, "").startsWith("."));
      if (!target) return all;
      count++;
      return `${open}${formatMd(target, target.path, to)}${close}`;
    }),
  );
  return { text: out, count };
};

/** Does `text` (the content of `note`) link to `path`? */
export const hasLinkTo = (text: string, path: string, note = "", paths?: ReadonlyArray<string>) => {
  let found = false;
  outsideCode(text, (part) => {
    if ([...part.matchAll(WIKILINK)].some((m) => linksTo(m[2]!, path, note, paths))) found = true;
    if ([...part.matchAll(MDLINK)].some((m) => parseMd(m[2]!, note).some((t) => t.path === path))) found = true;
    return part;
  });
  return found;
};

/**
 * Lookup keys for every link in `text` (the content of `note`): wikilink
 * targets and the paths Markdown links can resolve to, lowercased without
 * `.md`. A note links to `path` only if one of its keys is `linkKeysOf(path)`,
 * so an index of keys finds every candidate backlink.
 */
export const linkKeys = (text: string, note: string) => {
  const keys = new Set<string>();
  outsideCode(text, (part) => {
    for (const m of part.matchAll(WIKILINK)) keys.add(wikiKey(m[2]!));
    for (const m of part.matchAll(MDLINK)) for (const t of parseMd(m[2]!, note)) keys.add(stem(t.path).toLowerCase());
    return part;
  });
  return [...keys];
};

/** The keys a link to `path` can have: its full path or its name. */
export const linkKeysOf = (path: string) => [...new Set([stem(path).toLowerCase(), baseName(path).toLowerCase()])];
