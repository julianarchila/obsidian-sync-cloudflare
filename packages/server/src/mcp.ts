/**
 * MCP endpoint: the vault as tools for Claude, ChatGPT and other MCP clients.
 *
 * Stateless (MCP 2026-07-28, request-scoped server), so it runs in the Worker
 * with no sessions. Every request carries a `McpAccess` (who is calling, what
 * they may touch, and the vault) resolved by the Worker before routing here.
 *
 * Writes go through the change log like any device: compare-and-swap on the
 * version, three-way merge when the caller edited an older version, and the
 * client name is recorded as the device, so every change is attributable and
 * reversible from history.
 */
import * as McpProtocol from "effect/ai/McpProtocol";
import * as McpSchema from "effect/ai/McpSchema";
import * as McpServer from "effect/ai/McpServer";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as Layer from "effect/Layer";

import { baseName, linksTo, rewriteLinks, WIKILINK } from "../../plugin/src/core/links.ts";
import { diffLines, merge3 } from "../../plugin/src/core/merge.ts";
import { encode, type FileInfo, isTextPath, type VaultOps } from "./vault-ops.ts";

// ---------------------------------------------------------------- access

export interface McpClient {
  readonly name: string;
  /** `read` hides every write tool. */
  readonly access: "read" | "write";
  /** Folder prefixes this client may see and touch; empty means the whole vault. */
  readonly folders: ReadonlyArray<string>;
}

export interface McpAccessShape {
  readonly client: McpClient;
  readonly vault: string;
  readonly ops: VaultOps;
}

export class McpAccess extends Context.Service<McpAccess, McpAccessShape>()("homebase/McpAccess") {}

class ToolError extends Error {}

/** Hidden segments (`.obsidian`, `.trash`, `.git`, ...) are never exposed, whatever the case. */
const isHidden = (path: string) => path.split("/").some((part) => part.startsWith("."));

/** Normalize like Obsidian (NFC, forward slashes, no leading/trailing slash) and refuse unsafe paths. */
const normalizePath = (raw: string) => {
  const path = raw
    .normalize("NFC")
    .replace(/\u00a0/g, " ")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\.?\/+/, "")
    .replace(/\/+$/, "");
  const parts = path.split("/");
  if (path === "" || parts.some((part) => part === "" || part === "." || part === ".." || part !== part.trim() || part.includes("\0")))
    throw new ToolError(`Invalid path: ${JSON.stringify(raw)}`);
  if (isHidden(path)) throw new ToolError(`${path} is not accessible through this server (hidden or settings folder).`);
  return path;
};

const normalizeFolder = (raw: string | undefined) => {
  if (raw === undefined || raw.trim() === "" || raw.trim() === "/") return "";
  return `${normalizePath(raw)}/`;
};

const allowed = (client: McpClient, path: string) =>
  client.folders.length === 0 || client.folders.some((folder) => path.startsWith(folder));

const checkAllowed = (client: McpClient, path: string) => {
  if (!allowed(client, path))
    throw new ToolError(`${path} is outside the folders this connection may access (${client.folders.join(", ")}).`);
};

const isConfig = isHidden;

const checkText = (path: string) => {
  if (!isTextPath(path)) throw new ToolError(`${path} is not a text note (.md, .txt, .canvas, ...); attachments can't be edited here.`);
};

const when = (ms: number) => `${new Date(ms).toISOString().replace("T", " ").slice(0, 16)} UTC`;
const size = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

// ---------------------------------------------------------------- tool plumbing

interface ToolOutput {
  readonly text: string;
  readonly structured?: unknown;
  readonly image?: { readonly data: Uint8Array; readonly mimeType: string };
}

interface ToolDef {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly properties: Record<string, unknown>;
  readonly required?: ReadonlyArray<string>;
  readonly write?: boolean;
  readonly destructive?: boolean;
  readonly idempotent?: boolean;
  readonly run: (args: Record<string, unknown>, access: McpAccessShape) => Promise<ToolOutput>;
}

const str = (args: Record<string, unknown>, key: string) => {
  const value = args[key];
  if (typeof value !== "string") throw new ToolError(`\`${key}\` must be a string.`);
  return value;
};
const optStr = (args: Record<string, unknown>, key: string) => (typeof args[key] === "string" ? (args[key] as string) : undefined);
const optInt = (args: Record<string, unknown>, key: string) =>
  typeof args[key] === "number" && Number.isFinite(args[key]) ? Math.floor(args[key] as number) : undefined;

const register = (def: ToolDef) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    yield* server.addTool({
      tool: new McpSchema.Tool({
        name: def.name,
        title: def.title,
        description: def.description,
        inputSchema: { type: "object", properties: def.properties, required: [...(def.required ?? [])], additionalProperties: false },
        annotations: {
          title: def.title,
          readOnlyHint: !def.write,
          destructiveHint: def.destructive ?? false,
          idempotentHint: def.idempotent ?? !def.write,
          openWorldHint: false,
        } as never,
      }),
      annotations: Context.empty() as Context.Context<never>,
      handle: (payload: Record<string, unknown> | undefined) =>
        // The Worker passes McpAccess in the request context (see `makeMcpHandler`).
        (Effect.service(McpAccess) as unknown as Effect.Effect<McpAccessShape>).pipe(
          Effect.flatMap((access) =>
            Effect.promise(async (): Promise<McpSchema.CallToolResult> => {
              try {
                if (def.write && access.client.access !== "write")
                  throw new ToolError("This connection is read-only.");
                const out = await def.run(payload ?? {}, access);
                const content: Array<McpSchema.CallToolResult["content"][number]> = [{ type: "text", text: out.text } as never];
                if (out.image) content.push({ type: "image", data: out.image.data, mimeType: out.image.mimeType } as never);
                // Text only: clients such as Claude Code show `structuredContent` instead of
                // the text when both are present, which would hide note contents.
                return new McpSchema.CallToolResult({ content });
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return new McpSchema.CallToolResult({ content: [{ type: "text", text: message } as never], isError: true });
              }
            }),
          ),
        ),
    });
  });

// ---------------------------------------------------------------- edits

interface Edit {
  readonly old_text: string;
  readonly new_text: string;
  readonly replace_all?: boolean;
}

const applyEdits = (text: string, edits: ReadonlyArray<Edit>) => {
  let out = text;
  for (const [i, edit] of edits.entries()) {
    if (typeof edit?.old_text !== "string" || typeof edit?.new_text !== "string")
      throw new ToolError(`edits[${i}] needs old_text and new_text strings.`);
    if (edit.old_text === "") throw new ToolError(`edits[${i}].old_text is empty; use append_to_note or write_note.`);
    const count = out.split(edit.old_text).length - 1;
    if (count === 0) throw new ToolError(`edits[${i}].old_text was not found in the note. Re-read the note and try again.`);
    if (count > 1 && !edit.replace_all)
      throw new ToolError(`edits[${i}].old_text appears ${count} times; include more context or set replace_all.`);
    out = edit.replace_all ? out.split(edit.old_text).join(edit.new_text) : out.replace(edit.old_text, () => edit.new_text);
  }
  return out;
};

/**
 * Commit `next(currentText)` with compare-and-swap, retrying on races. When the
 * caller's view (`baseVersion`) is older than the server's, `next` is applied to
 * that base and three-way merged with the current text.
 */
const otherSideChanges = (before: string, after: string) => {
  const diff = diffLines(before, after);
  if (diff === null) return "";
  const changed = diff.filter((d) => d.kind !== "same").slice(0, 20);
  return changed.length === 0
    ? ""
    : `\nWhat changed meanwhile:\n${changed.map((d) => `${d.kind === "add" ? "+" : "-"} ${d.text.replace(/\n$/, "")}`).join("\n")}`;
};

const saveText = async (
  ops: VaultOps,
  path: string,
  next: (current: string | null) => string,
  baseVersion?: number,
): Promise<{ file: FileInfo; merged: boolean; created: boolean }> => {
  let baseText: string | undefined;
  if (baseVersion !== undefined) {
    const version = (await ops.history(path)).find((f) => f.entry.version === baseVersion);
    if (!version || version.entry.deleted) throw new ToolError(`${path} has no version ${baseVersion}.`);
    baseText = await ops.text(version);
  }
  for (let attempt = 0; attempt < 12; attempt++) {
    // Lost a race: back off with jitter so concurrent writers spread out.
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, Math.random() * 40 * 2 ** Math.min(attempt, 5)));
    const current = await ops.current(path);
    if (baseText !== undefined && current === null)
      throw new ToolError(`${path} was deleted after version ${baseVersion}. Use list_deleted / restore_version if it should come back.`);
    const currentText = current ? await ops.text(current) : null;
    let result: string;
    let merged = false;
    if (baseText !== undefined && current && current.entry.version !== baseVersion) {
      const ours = next(baseText);
      const combined = merge3(baseText, ours, currentText ?? "");
      if (combined === null)
        throw new ToolError(
          `Not saved: ${path} changed since version ${baseVersion} (now version ${current.entry.version}) and your change overlaps with that edit.` +
            otherSideChanges(baseText, currentText ?? "") +
            "\nRead the note again; if the other change matters, keep it or ask the user before replacing it.",
        );
      result = combined;
      merged = true;
    } else result = next(currentText);
    const saved = await ops.put(path, encode(result), current ? current.entry.version : null);
    if (saved.ok) return { file: saved.file, merged, created: current === null };
  }
  throw new ToolError(`${path} is being changed too often right now; try again.`);
};

/** Lines `[offset, offset+limit)` capped at `MAX_CHARS`, with a header that can't be mistaken for note content. */
const page = (label: string, text: string, offsetArg: number | undefined, limitArg: number | undefined) => {
  const lines = text.split("\n");
  const offset = Math.max(1, offsetArg ?? 1);
  const limit = Math.max(1, limitArg ?? DEFAULT_LINES);
  const out: string[] = [];
  let chars = 0;
  for (let i = offset - 1; i < Math.min(lines.length, offset - 1 + limit); i++) {
    if (chars + lines[i]!.length > MAX_CHARS && out.length > 0) break;
    out.push(lines[i]!);
    chars += lines[i]!.length + 1;
  }
  if (offset > lines.length) return `[${label} · ${lines.length} lines · offset ${offset} is past the end]`;
  const last = offset - 1 + out.length;
  const partial = offset > 1 || last < lines.length;
  const header = `[${label} · ${lines.length} lines${partial ? ` · showing lines ${offset}-${last}` : ""}]`;
  const more = last < lines.length ? `\n\n[… ${lines.length - last} more lines: call again with offset=${last + 1}]` : "";
  return `${header}\n\n${out.join("\n")}${more}`;
};

// ---------------------------------------------------------------- links

/** Notes that link to `path`, found through the search index and checked in their content. */
const backlinks = async (ops: VaultOps, client: McpClient, path: string) => {
  await ops.catchUpIndex(100);
  const { hits } = await ops.search(baseName(path), 200);
  const out: Array<{ file: FileInfo; text: string }> = [];
  for (const hit of hits) {
    if (hit.path === path || !allowed(client, hit.path)) continue;
    const file = await ops.current(hit.path);
    if (!file) continue;
    const text = await ops.text(file);
    WIKILINK.lastIndex = 0;
    const hasWiki = [...text.matchAll(WIKILINK)].some((m) => linksTo(m[2]!, path));
    if (hasWiki || text.includes(`](${path})`) || text.includes(`](${encodeURI(path)})`)) out.push({ file, text });
  }
  return out;
};

/** Every version of a path including the paths it was moved from, newest first. */
const fullHistory = async (ops: VaultOps, path: string) => {
  const out: FileInfo[] = [];
  const seen = new Set<string>();
  let current: string | undefined = path;
  while (current !== undefined && !seen.has(current) && seen.size < 20) {
    seen.add(current);
    out.push(...(await ops.history(current)));
    current = (await ops.movedFrom(current))[0];
  }
  return out;
};

const describeVersion = (f: FileInfo) =>
  `${f.path} v${f.entry.version}\t${when(f.entry.createdAt)}\t${
    f.entry.movedTo ? `moved to ${f.entry.movedTo}` : f.entry.deleted ? "deleted" : size(f.size)
  }\tby ${f.entry.device}`;

const findVersion = async (ops: VaultOps, path: string, version: number | undefined) => {
  if (version === undefined) throw new ToolError("`version` is required.");
  const file = (await ops.history(path)).find((f) => f.entry.version === version);
  if (!file || file.entry.deleted) throw new ToolError(`${path} has no readable version ${version} (see note_history).`);
  return file;
};

const savedMessage = (path: string, saved: { file: FileInfo; merged: boolean; created: boolean }) =>
  `${saved.created ? "Created" : "Saved"} ${path} (version ${saved.file.entry.version})` +
  (saved.merged ? ", merged with changes made since the version you read." : ".");

const mimeOf = (path: string) => {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return (
    { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" } as Record<string, string>
  )[ext];
};

const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const DEFAULT_LINES = 400;
/** Keep each result well under what clients show inline (Claude Code saves larger results to a file). */
const MAX_CHARS = 20_000;

// ---------------------------------------------------------------- tools

const notFound = async (ops: VaultOps, client: McpClient, path: string) => {
  const name = baseName(path).toLowerCase();
  const matches = (await ops.files())
    .filter((f) => allowed(client, f.path) && !isConfig(f.path) && baseName(f.path).toLowerCase() === name)
    .map((f) => f.path)
    .slice(0, 5);
  return new ToolError(
    matches.length > 0
      ? `${path} does not exist. Did you mean: ${matches.join(", ")}? (paths are relative to the vault root)`
      : `${path} does not exist. Use list_notes or search_notes to find notes.`,
  );
};

const readable = async (ops: VaultOps, client: McpClient, rawPath: string) => {
  const path = normalizePath(rawPath);
  checkAllowed(client, path);
  const file = await ops.current(path);
  if (!file) throw await notFound(ops, client, path);
  return { path, file };
};

const kindOf = (f: FileInfo) => (f.entry.movedTo ? "moved" : f.entry.deleted ? "deleted" : f.entry.version === 1 ? "created" : "edited");

const tools: ToolDef[] = [
  {
    name: "list_notes",
    title: "List notes",
    description:
      "List files in the vault (notes and attachments) with size and last change. Paths are relative to the vault root, e.g. `Projects/Plan.md`.",
    properties: {
      folder: { type: "string", description: "Only this folder (and subfolders). Omit for the whole vault." },
      recursive: { type: "boolean", description: "Include subfolders (default true)." },
      limit: { type: "integer", description: "Maximum files to return (default 500)." },
    },
    run: async (args, { ops, client }) => {
      const folder = normalizeFolder(optStr(args, "folder"));
      const recursive = args.recursive !== false;
      const limit = optInt(args, "limit") ?? 500;
      const files = (await ops.files()).filter(
        (f) =>
          !isConfig(f.path) &&
          allowed(client, f.path) &&
          f.path.startsWith(folder) &&
          (recursive || !f.path.slice(folder.length).includes("/")),
      );
      const shown = files.slice(0, limit);
      const lines = shown.map((f) => `${f.path}\t${size(f.size)}\t${when(f.entry.createdAt)}`);
      const more = files.length > shown.length ? `\n… ${files.length - shown.length} more (raise limit or narrow folder)` : "";
      return { text: files.length === 0 ? `No files${folder ? ` in ${folder}` : ""}.` : `${files.length} file(s):\n${lines.join("\n")}${more}` };
    },
  },
  {
    name: "read_note",
    title: "Read note",
    description:
      `Read a text note (Markdown, canvas, ...). The first line is a bracketed header [path · version N · lines] that is NOT part of the note. Pass that version to edit_note/write_note so concurrent edits are merged. Long notes come in pages (${DEFAULT_LINES} lines or ~20 KB); continue with offset.`,
    properties: {
      path: { type: "string", description: "Path relative to the vault root, e.g. `Daily/2026-11-07.md`." },
      offset: { type: "integer", description: "First line to return (1-based, default 1)." },
      limit: { type: "integer", description: `Number of lines (default ${DEFAULT_LINES}).` },
    },
    required: ["path"],
    run: async (args, { ops, client }) => {
      const { path, file } = await readable(ops, client, str(args, "path"));
      if (!isTextPath(path)) throw new ToolError(`${path} is not a text file; use read_attachment.`);
      return { text: page(`${path} · version ${file.entry.version}`, await ops.text(file), optInt(args, "offset"), optInt(args, "limit")) };
    },
  },
  {
    name: "read_notes",
    title: "Read several notes",
    description: "Read several short notes at once (each with its header). Stops at ~20 KB in total; read long notes with read_note.",
    properties: { paths: { type: "array", items: { type: "string" }, description: "Up to 30 paths." } },
    required: ["paths"],
    run: async (args, { ops, client }) => {
      if (!Array.isArray(args.paths) || args.paths.length === 0) throw new ToolError("`paths` must be a non-empty array.");
      const parts: string[] = [];
      let chars = 0;
      const skipped: string[] = [];
      for (const raw of (args.paths as unknown[]).slice(0, 30)) {
        try {
          const { path, file } = await readable(ops, client, String(raw));
          const text = await ops.text(file);
          if (chars + text.length > MAX_CHARS && parts.length > 0) {
            skipped.push(path);
            continue;
          }
          parts.push(page(`${path} · version ${file.entry.version}`, text, 1, DEFAULT_LINES));
          chars += Math.min(text.length, MAX_CHARS);
        } catch (error) {
          parts.push(`[${String(raw)} · error: ${error instanceof Error ? error.message : String(error)}]`);
        }
      }
      if (skipped.length > 0) parts.push(`[Not included (size limit), read separately: ${skipped.join(", ")}]`);
      return { text: parts.join("\n\n") };
    },
  },
  {
    name: "search_notes",
    title: "Search notes",
    description:
      "Full-text search over Markdown and text notes (words match as prefixes, all words must appear, accents ignored). Returns paths with a snippet; matches are marked «like this».",
    properties: {
      query: { type: "string", description: "Words to search for." },
      folder: { type: "string", description: "Only results in this folder." },
      limit: { type: "integer", description: "Maximum results (default 20)." },
    },
    required: ["query"],
    run: async (args, { ops, client }) => {
      const query = str(args, "query");
      const folder = normalizeFolder(optStr(args, "folder"));
      const limit = optInt(args, "limit") ?? 20;
      const backlog = await ops.catchUpIndex(100);
      const { hits } = await ops.search(query, 200);
      const visible = hits.filter((h) => allowed(client, h.path) && h.path.startsWith(folder) && !isConfig(h.path)).slice(0, limit);
      const note = backlog > 0 ? `\n(Index still catching up: ${backlog} file(s) not searchable yet; search again shortly.)` : "";
      return {
        text:
          (visible.length === 0
            ? `No notes match ${JSON.stringify(query)}.`
            : visible.map((h) => `${h.path}\n  ${h.snippet.replace(/\s+/g, " ")}`).join("\n")) + note,
      };
    },
  },
  {
    name: "find_backlinks",
    title: "Find backlinks",
    description: "List the notes that link to a note ([[wikilinks]], embeds or Markdown links), with the linking lines.",
    properties: { path: { type: "string" } },
    required: ["path"],
    run: async (args, { ops, client }) => {
      const path = normalizePath(str(args, "path"));
      checkAllowed(client, path);
      const found = await backlinks(ops, client, path);
      if (found.length === 0) return { text: `No notes link to ${path}.` };
      return {
        text: found
          .map(({ file, text }) => {
            const lines = text.split("\n").filter((line) => line.includes("[[") || line.includes("]("));
            const hits = lines.filter((line) => [...line.matchAll(WIKILINK)].some((m) => linksTo(m[2]!, path)) || line.includes(path));
            return `${file.path}\n${hits.slice(0, 3).map((l) => `  ${l.trim()}`).join("\n")}`;
          })
          .join("\n"),
      };
    },
  },
  {
    name: "recent_changes",
    title: "Recent changes",
    description:
      "What changed in the vault, newest first: created, edited, moved and deleted files, and which device or connection made each change. Times are UTC. Use `since` (a seq from a previous call) to get only newer changes.",
    properties: {
      limit: { type: "integer", description: "Maximum changes (default 30)." },
      since: { type: "integer", description: "Only changes after this seq." },
    },
    run: async (args, { ops, client }) => {
      const limit = Math.min(optInt(args, "limit") ?? 30, 200);
      const scoped = client.folders.length > 0;
      const all = await ops.recent(scoped ? 500 : limit + 50, optInt(args, "since") ?? 0);
      // A rename is stored as a tombstone (movedTo) plus the new path: show it once.
      const arrivals = new Set(all.filter((f) => f.entry.movedTo).map((f) => `${f.entry.movedTo}@${f.entry.seq + 1}`));
      const changes = all
        .filter((f) => !arrivals.has(`${f.path}@${f.entry.seq}`) && allowed(client, f.path) && !isConfig(f.path))
        .slice(0, limit);
      return {
        text:
          changes.length === 0
            ? "No changes."
            : changes
                .map(
                  (f) =>
                    `seq ${f.entry.seq}\t${when(f.entry.createdAt)}\t${kindOf(f)}\t${f.path}${f.entry.movedTo ? ` → ${f.entry.movedTo}` : ""}\tv${f.entry.version}\tby ${f.entry.device}`,
                )
                .join("\n"),
      };
    },
  },
  {
    name: "create_note",
    title: "Create note",
    description: "Create a new note. Fails if a file already exists at that path. Parent folders are implicit.",
    properties: {
      path: { type: "string", description: "Path of the new note, ending in .md for Markdown." },
      content: { type: "string", description: "Full content." },
    },
    required: ["path", "content"],
    write: true,
    run: async (args, { ops, client }) => {
      const path = normalizePath(str(args, "path"));
      checkAllowed(client, path);
      checkText(path);
      const saved = await ops.put(path, encode(str(args, "content")), null);
      if (!saved.ok) throw new ToolError(`${path} already exists (version ${saved.current?.entry.version}). Use edit_note or write_note.`);
      return { text: `Created ${path} (version ${saved.file.entry.version}).` };
    },
  },
  {
    name: "edit_note",
    title: "Edit note",
    description:
      "Change part of a note by exact text replacement. Each `old_text` must appear exactly once (or set replace_all). All edits apply together or none do. Pass the `version` you read: if the note changed meanwhile, your edits are merged with those changes (or refused, showing what changed, if they overlap).",
    properties: {
      path: { type: "string" },
      edits: {
        type: "array",
        description: "Replacements applied in order.",
        items: {
          type: "object",
          properties: {
            old_text: { type: "string", description: "Exact text to replace, with enough context to be unique." },
            new_text: { type: "string" },
            replace_all: { type: "boolean" },
          },
          required: ["old_text", "new_text"],
        },
      },
      version: { type: "integer", description: "Version from read_note (recommended)." },
    },
    required: ["path", "edits"],
    write: true,
    run: async (args, { ops, client }) => {
      const path = normalizePath(str(args, "path"));
      checkAllowed(client, path);
      checkText(path);
      if (!Array.isArray(args.edits) || args.edits.length === 0) throw new ToolError("`edits` must be a non-empty array.");
      const edits = args.edits as Edit[];
      const saved = await saveText(
        ops,
        path,
        (text) => {
          if (text === null) throw new ToolError(`${path} does not exist.`);
          try {
            return applyEdits(text, edits);
          } catch (error) {
            throw new ToolError(`No edits were applied. ${error instanceof Error ? error.message : String(error)}`);
          }
        },
        optInt(args, "version"),
      );
      return { text: savedMessage(path, saved) };
    },
  },
  {
    name: "write_note",
    title: "Write note",
    description:
      "Replace the whole content of a note (or create it). For an existing note, `version` (from read_note) is required: if the note changed since then, your content is merged with those changes, or refused if they overlap.",
    properties: {
      path: { type: "string" },
      content: { type: "string", description: "Full new content." },
      version: { type: "integer", description: "Version you based this content on (required if the note exists)." },
    },
    required: ["path", "content"],
    write: true,
    destructive: true,
    run: async (args, { ops, client }) => {
      const path = normalizePath(str(args, "path"));
      checkAllowed(client, path);
      checkText(path);
      const content = str(args, "content");
      const version = optInt(args, "version");
      const current = await ops.current(path);
      if (current && version === undefined)
        throw new ToolError(`${path} already exists (version ${current.entry.version}). Pass the version you read, or use edit_note.`);
      const saved = await saveText(ops, path, () => content, version);
      return { text: savedMessage(path, saved) };
    },
  },
  {
    name: "append_to_note",
    title: "Append to note",
    description:
      "Add text at the end of a note, creating it if needed (good for inboxes, logs and daily notes). Never conflicts with other edits.",
    properties: {
      path: { type: "string" },
      content: { type: "string", description: "Text to add; it goes on new line(s)." },
    },
    required: ["path", "content"],
    write: true,
    run: async (args, { ops, client }) => {
      const path = normalizePath(str(args, "path"));
      checkAllowed(client, path);
      checkText(path);
      const raw = str(args, "content");
      const content = raw.endsWith("\n") ? raw : `${raw}\n`;
      const saved = await saveText(ops, path, (text) =>
        text === null || text === "" ? content : `${text}${text.endsWith("\n") ? "" : "\n"}${content}`,
      );
      return { text: savedMessage(path, saved) };
    },
  },
  {
    name: "move_note",
    title: "Move or rename note",
    description:
      "Move or rename a file. note_history follows it to the new path. By default, [[links]], embeds and Markdown links to it in other notes are updated (update_links: false to skip).",
    properties: {
      from: { type: "string" },
      to: { type: "string" },
      update_links: { type: "boolean", description: "Rewrite links in other notes (default true)." },
    },
    required: ["from", "to"],
    write: true,
    run: async (args, { ops, client }) => {
      const from = normalizePath(str(args, "from"));
      const to = normalizePath(str(args, "to"));
      checkAllowed(client, from);
      checkAllowed(client, to);
      const file = await ops.current(from);
      if (!file) throw await notFound(ops, client, from);
      const linking = args.update_links === false || !/\.md$/i.test(from) ? [] : await backlinks(ops, client, from);
      const result = await ops.rename(file, to);
      if (!result.ok)
        throw new ToolError(result.current?.path === to ? `${to} already exists.` : `${from} changed meanwhile; try again.`);
      const updated: string[] = [];
      const failed: string[] = [];
      for (const { file: other } of linking) {
        try {
          let count = 0;
          await saveText(ops, other.path, (text) => {
            const rewritten = rewriteLinks(text ?? "", from, to);
            count = rewritten.count;
            return rewritten.text;
          });
          if (count > 0) updated.push(`${other.path} (${count})`);
        } catch {
          failed.push(other.path);
        }
      }
      return {
        text:
          `Moved ${from} → ${to}.` +
          (updated.length > 0 ? `\nUpdated links in: ${updated.join(", ")}.` : "") +
          (failed.length > 0 ? `\nCould not update links in: ${failed.join(", ")}.` : ""),
      };
    },
  },
  {
    name: "delete_note",
    title: "Delete note",
    description: "Delete a file. It stays recoverable (list_deleted, restore_version).",
    properties: { path: { type: "string" } },
    required: ["path"],
    write: true,
    destructive: true,
    run: async (args, { ops, client }) => {
      const { path, file } = await readable(ops, client, str(args, "path"));
      const result = await ops.remove(path, file.entry.version);
      if (!result.ok) throw new ToolError(`${path} changed meanwhile; read it again before deleting.`);
      return { text: `Deleted ${path}. Restore it with restore_version (path, version ${file.entry.version}).` };
    },
  },
  {
    name: "note_history",
    title: "Note history",
    description:
      "Stored versions of a file, newest first, including earlier paths if it was moved: time (UTC), size, and which device or connection made each one.",
    properties: { path: { type: "string" } },
    required: ["path"],
    run: async (args, { ops, client }) => {
      const path = normalizePath(str(args, "path"));
      checkAllowed(client, path);
      const versions = await fullHistory(ops, path);
      if (versions.length === 0) throw await notFound(ops, client, path);
      return { text: versions.map(describeVersion).join("\n") };
    },
  },
  {
    name: "read_version",
    title: "Read old version",
    description: "Read a past version of a text file (see note_history; use the path shown there). Paged like read_note.",
    properties: {
      path: { type: "string" },
      version: { type: "integer" },
      offset: { type: "integer" },
      limit: { type: "integer" },
    },
    required: ["path", "version"],
    run: async (args, { ops, client }) => {
      const path = normalizePath(str(args, "path"));
      checkAllowed(client, path);
      checkText(path);
      const file = await findVersion(ops, path, optInt(args, "version"));
      return {
        text: page(
          `${path} · version ${file.entry.version} · ${when(file.entry.createdAt)} by ${file.entry.device}`,
          await ops.text(file),
          optInt(args, "offset"),
          optInt(args, "limit"),
        ),
      };
    },
  },
  {
    name: "diff_versions",
    title: "Compare versions",
    description:
      "Show what changed between two versions of a text file (lines starting with - removed, + added). `to` defaults to the current version; `from` defaults to the version before `to`.",
    properties: { path: { type: "string" }, from: { type: "integer" }, to: { type: "integer" } },
    required: ["path"],
    run: async (args, { ops, client }) => {
      const path = normalizePath(str(args, "path"));
      checkAllowed(client, path);
      checkText(path);
      const history = (await ops.history(path)).filter((f) => !f.entry.deleted);
      if (history.length === 0) throw await notFound(ops, client, path);
      const toVersion = optInt(args, "to") ?? history[0]!.entry.version;
      const to = await findVersion(ops, path, toVersion);
      const fromVersion = optInt(args, "from") ?? history.find((f) => f.entry.version < toVersion)?.entry.version;
      const beforeText = fromVersion === undefined ? "" : await ops.text(await findVersion(ops, path, fromVersion));
      const diff = diffLines(beforeText, await ops.text(to));
      if (diff === null) return { text: "The versions differ too much to diff; read them with read_version." };
      const out: string[] = [];
      let chars = 0;
      for (const [i, d] of diff.entries()) {
        if (d.kind === "same") {
          const near = diff.slice(Math.max(0, i - 2), i + 3).some((x) => x.kind !== "same");
          if (near) out.push(`  ${d.text.replace(/\n$/, "")}`);
          else if (out.at(-1) !== "  …") out.push("  …");
          continue;
        }
        const line = `${d.kind === "add" ? "+" : "-"} ${d.text.replace(/\n$/, "")}`;
        chars += line.length;
        if (chars > MAX_CHARS) {
          out.push("[… diff truncated]");
          break;
        }
        out.push(line);
      }
      return {
        text: `[${path} · v${fromVersion ?? "(none)"} → v${toVersion} by ${to.entry.device} at ${when(to.entry.createdAt)}]\n\n${out.join("\n")}`,
      };
    },
  },
  {
    name: "revert_change",
    title: "Undo one change",
    description:
      "Undo the change made by one version of a text note, keeping later edits (e.g. undo an agent's edit but keep the user's newer typo fix). Fails if later edits touched the same lines.",
    properties: { path: { type: "string" }, version: { type: "integer", description: "The version whose change to undo." } },
    required: ["path", "version"],
    write: true,
    run: async (args, { ops, client }) => {
      const path = normalizePath(str(args, "path"));
      checkAllowed(client, path);
      checkText(path);
      const version = optInt(args, "version");
      const target = await findVersion(ops, path, version);
      const previous = (await ops.history(path)).find((f) => f.entry.version < target.entry.version && !f.entry.deleted);
      const changed = await ops.text(target);
      const before = previous ? await ops.text(previous) : "";
      const saved = await saveText(ops, path, (current) => {
        const result = merge3(changed, before, current ?? "");
        if (result === null)
          throw new ToolError(`Can't undo version ${version} automatically: later edits changed the same lines. Use diff_versions and edit_note.`);
        return result;
      });
      return { text: `Undid the change of version ${version}; ${path} is now version ${saved.file.entry.version}.` };
    },
  },
  {
    name: "restore_version",
    title: "Restore version",
    description: "Make a past version current again as a whole (also recovers deleted files). Nothing is lost: the restore is a new version.",
    properties: { path: { type: "string" }, version: { type: "integer" } },
    required: ["path", "version"],
    write: true,
    run: async (args, { ops, client }) => {
      const path = normalizePath(str(args, "path"));
      checkAllowed(client, path);
      const file = await findVersion(ops, path, optInt(args, "version"));
      const head = (await ops.history(path))[0]!;
      const saved = await ops.put(path, await ops.content(file), head.entry.deleted ? null : head.entry.version);
      if (!saved.ok) throw new ToolError(`${path} changed meanwhile; try again.`);
      return { text: `Restored ${path} to the content of version ${file.entry.version} (now version ${saved.file.entry.version}).` };
    },
  },
  {
    name: "list_deleted",
    title: "List deleted files",
    description: "Recently deleted files (moves are not listed) that can be brought back with restore_version.",
    properties: {},
    run: async (_args, { ops, client }) => {
      const files = (await ops.deleted()).filter((f) => allowed(client, f.path) && !isConfig(f.path));
      return {
        text:
          files.length === 0
            ? "No deleted files."
            : files
                .map((f) => `${f.path}\tdeleted ${when(f.entry.createdAt)} by ${f.entry.device}\trestore_version version ${f.entry.version - 1}`)
                .join("\n"),
      };
    },
  },
  {
    name: "read_attachment",
    title: "Read attachment",
    description: "Get an image from the vault (PNG, JPEG, GIF, WebP up to 3 MB) so you can see it. Other file types return their details only.",
    properties: { path: { type: "string" } },
    required: ["path"],
    run: async (args, { ops, client }) => {
      const { path, file } = await readable(ops, client, str(args, "path"));
      const mimeType = mimeOf(path);
      if (!mimeType || file.size > MAX_IMAGE_BYTES)
        return { text: `${path}: ${size(file.size)}, version ${file.entry.version}. ${mimeType ? "Too large to show." : "Not an image this server can show."}` };
      return { text: `${path} (${size(file.size)})`, image: { data: await ops.content(file), mimeType } };
    },
  },
];

const INSTRUCTIONS = `This server is the user's personal notes vault (Obsidian, Markdown), the same files their devices sync.
- Paths are relative to the vault root (e.g. "Projects/Plan.md"). Notes link to each other with [[Note name]].
- Find notes with search_notes or list_notes; read them with read_note (or read_notes for several). Output headers in [brackets] are not part of the notes.
- To change a note prefer edit_note (exact replacements) or append_to_note. Pass the version from read_note so concurrent edits from the user's devices are merged, not overwritten.
- Every change is recorded with this connection's name. diff_versions shows a change; revert_change undoes one change while keeping later ones; restore_version brings back a whole version. Deleted files are recoverable (list_deleted).
- move_note keeps history and updates links; find_backlinks lists notes linking to a note.
- recent_changes shows what changed and who changed it.`;

const registrations = Layer.effectDiscard(Effect.forEach(tools, register, { discard: true }));

/** Build the MCP web handler once per Worker isolate. */
export const makeMcpHandler = () => {
  const { handler } = HttpRouter.toWebHandler(
    McpServer.layerHttpRequestScoped({
      name: "homebase",
      version: "0.3.0",
      instructions: INSTRUCTIONS,
      path: "/mcp",
      protocols: [McpProtocol.v2026_07_28],
      registrations,
    }).pipe(Layer.provide(HttpServer.layerServices)),
    { disableLogger: true },
  );
  return (request: Request, access: McpAccessShape) =>
    (handler as (request: Request, context: Context.Context<never>) => Promise<Response>)(
      request,
      Context.make(McpAccess, access) as Context.Context<never>,
    );
};

/** Clients allowed to use MCP, besides the owner token. Parsed from OSCF_MCP_CLIENTS (JSON). */
export interface McpClientConfig extends McpClient {
  readonly token: string;
  /** Vault ids this client may open (required); `prefix-*` matches by prefix. */
  readonly vaults: ReadonlyArray<string>;
}

/** Invalid entries are skipped with a warning instead of taking the Worker (and sync) down. */
export const parseMcpClients = (raw: string, warn: (message: string) => void = console.warn): McpClientConfig[] => {
  if (raw.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    warn("OSCF_MCP_CLIENTS is not valid JSON; no extra MCP clients are enabled.");
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: McpClientConfig[] = [];
  for (const [i, entry] of (parsed as Array<Partial<McpClientConfig>>).entries()) {
    try {
      if (typeof entry?.name !== "string" || entry.name === "") throw new Error("missing name");
      if (typeof entry.token !== "string" || entry.token.length < 32) throw new Error("token must be at least 32 characters");
      if (!Array.isArray(entry.vaults) || entry.vaults.length === 0) throw new Error("`vaults` must list the vault ids it may open");
      out.push({
        name: entry.name,
        token: entry.token,
        access: entry.access === "read" ? "read" : "write",
        folders: (entry.folders ?? []).map((f) => normalizeFolder(f)).filter(Boolean),
        vaults: entry.vaults.map(String),
      });
    } catch (error) {
      warn(`OSCF_MCP_CLIENTS[${i}] skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return out;
};
