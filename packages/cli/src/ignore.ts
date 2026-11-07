/**
 * Which paths the CLI never syncs.
 *
 * Built in: hidden files and folders (anything starting with `.`, which
 * Obsidian doesn't see either: `.obsidian`, `.git`, `.vscode`, editor locks),
 * the CLI's own temp files, and common junk. Each folder can add patterns in
 * `.homebaseignore` (gitignore-like: `*`, `**`, `?`, a trailing `/` for
 * folders, a leading `/` to anchor at the root, `#` comments). The file itself
 * is hidden, so it stays local to this folder.
 */
import * as fs from "node:fs/promises";
import * as nodePath from "node:path";

export const IGNORE_FILE = ".homebaseignore";

export const DEFAULT_PATTERNS = [
  "node_modules/",
  "__pycache__/",
  "*.tmp",
  "*.temp",
  "*.orig",
  "*.swp",
  "*.swo",
  "*.swx",
  "*~",
  "*.kate-swp",
  "4913",
  "Thumbs.db",
  "desktop.ini",
];

interface Rule {
  readonly regex: RegExp;
  readonly dirOnly: boolean;
  readonly anchored: boolean;
}

const globToRegex = (glob: string) =>
  new RegExp(
    `^${glob
      .split("**")
      .map((part) =>
        part
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*/g, "[^/]*")
          .replace(/\?/g, "[^/]"),
      )
      .join(".*")}$`,
  );

export const parseIgnore = (text: string): Rule[] =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#") && !line.startsWith("!"))
    .map((line) => {
      const dirOnly = line.endsWith("/");
      const body = line.replace(/^\/+/, "").replace(/\/+$/, "");
      return { regex: globToRegex(body), dirOnly, anchored: line.startsWith("/") || body.includes("/") };
    });

/** Matcher for vault-relative paths (forward slashes). */
export const makeIsIgnored = (rules: ReadonlyArray<Rule>) => (path: string) => {
  const parts = path.split("/");
  if (parts.some((part) => part.startsWith("."))) return true;
  for (const rule of rules) {
    // Folders are every proper prefix; a file pattern can also match the file itself.
    const last = rule.dirOnly ? parts.length - 1 : parts.length;
    for (let i = 0; i < last; i++) {
      const candidate = rule.anchored ? parts.slice(0, i + 1).join("/") : parts[i]!;
      if (rule.regex.test(candidate)) return true;
    }
  }
  return false;
};

/** Built-in rules plus the folder's `.homebaseignore`. */
export const loadIgnore = async (root: string) => {
  let custom = "";
  try {
    custom = await fs.readFile(nodePath.join(root, IGNORE_FILE), "utf8");
  } catch {
    // none
  }
  return makeIsIgnored(parseIgnore([...DEFAULT_PATTERNS, custom].join("\n")));
};
