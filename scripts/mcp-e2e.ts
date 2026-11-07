/**
 * MCP endpoint against a running server (`bun run dev`): a device running the
 * real sync engine and MCP calls edit the same vault. Uses a fresh `e2e-mcp-*`
 * vault. Needs OSCF_TOKEN and OSCF_MCP_CLIENTS (with a read-only `reader` and a
 * `work-agent` limited to `Work/`) in the environment.
 */
import * as Effect from "effect/Effect";

import { fetchHttp, makeHttpRemote } from "../packages/plugin/src/core/http-remote.ts";
import { mergeText } from "../packages/plugin/src/core/merge.ts";
import { openPlainVault } from "../packages/plugin/src/core/plain-vault.ts";
import { Device } from "../packages/plugin/test/harness.ts";

const serverUrl = process.env.OSCF_URL ?? "http://localhost:1337";
const token = process.env.OSCF_TOKEN ?? "";
const clients = JSON.parse(process.env.OSCF_MCP_CLIENTS ?? "[]") as Array<{ name: string; token: string }>;
const readerToken = clients.find((c) => c.name === "reader")?.token ?? "";
const workToken = clients.find((c) => c.name === "work-agent")?.token ?? "";
const vaultId = `e2e-mcp-${Date.now()}`;

const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail && !ok ? `\n    ${detail.replace(/\n/g, "\n    ")}` : ""}`);
  if (!ok) process.exitCode = 1;
};

let id = 0;
const call = async (name: string, args: Record<string, unknown> = {}, bearer = token, vault = vaultId) => {
  const response = await fetch(`${serverUrl}/mcp/${vault}`, {
    method: "POST",
    headers: {
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/call",
      "mcp-name": name,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: ++id,
      method: "tools/call",
      params: {
        name,
        arguments: args,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "mcp-e2e", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  if (response.status !== 200) return { status: response.status, text: await response.text(), isError: true, content: [] as any[] };
  const body = (await response.json()) as { result?: { content: Array<{ type: string; text?: string; mimeType?: string }>; isError?: boolean }; error?: { message: string } };
  if (body.error) return { status: 200, text: `RPC error: ${body.error.message}`, isError: true, content: [] };
  const content = body.result?.content ?? [];
  return { status: 200, text: content.filter((c) => c.type === "text").map((c) => c.text).join("\n"), isError: body.result?.isError === true, content };
};
const listTools = async (bearer: string) => {
  const response = await fetch(`${serverUrl}/mcp/${vaultId}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/list",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: ++id,
      method: "tools/list",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "mcp-e2e", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  const body = (await response.json()) as { result?: { tools: Array<{ name: string }> } };
  return (body.result?.tools ?? []).map((t) => t.name);
};
const versionOf = (text: string) => Number(/version (\d+)/.exec(text)?.[1]);

const remote = makeHttpRemote({ serverUrl, vaultId, token, http: fetchHttp() });
await Effect.runPromise(openPlainVault(remote));
const laptop = await new Device("laptop", remote, { merge: mergeText }).start();

// ---- auth
check("no token → 401", (await call("list_notes", {}, "")).status === 401);
check("wrong token → 401", (await call("list_notes", {}, "nope-nope-nope-nope-nope")).status === 401);

// ---- device → MCP
laptop.write("Projects/Plan.md", "# Plan\n\nIntro paragraph.\n\nMiddle paragraph.\n\nClosing paragraph.\n");
laptop.write("Work/Todo.md", "- [ ] ship\n");
await laptop.sync();
const read1 = await call("read_note", { path: "Projects/Plan.md" });
check("MCP reads a note written by a device", read1.text.includes("Middle paragraph.") && versionOf(read1.text) === 1, read1.text);

// ---- concurrent edits: device edits paragraph 1, MCP edits paragraph 3 based on v1 → merge
laptop.write("Projects/Plan.md", "# Plan\n\nIntro paragraph, edited on the laptop.\n\nMiddle paragraph.\n\nClosing paragraph.\n");
await laptop.sync();
const merged = await call("edit_note", {
  path: "Projects/Plan.md",
  version: 1,
  edits: [{ old_text: "Closing paragraph.", new_text: "Closing paragraph, edited by the agent." }],
});
check("stale edit on another paragraph is merged", !merged.isError && merged.text.includes("merged"), merged.text);
await laptop.sync();
const both = laptop.read("Projects/Plan.md") ?? "";
check("device receives the merged note with both edits", both.includes("edited on the laptop") && both.includes("edited by the agent"), both);

// ---- overlapping stale edit → refused, nothing overwritten
const overlap = await call("edit_note", {
  path: "Projects/Plan.md",
  version: 1,
  edits: [{ old_text: "Intro paragraph.", new_text: "Intro paragraph, rewritten by the agent." }],
});
check("overlapping stale edit is refused", overlap.isError && overlap.text.includes("overlaps"), overlap.text);

// ---- write_note guards
const blind = await call("write_note", { path: "Projects/Plan.md", content: "oops" });
check("write_note on an existing note requires a version", blind.isError && blind.text.includes("Pass the version"), blind.text);

// ---- concurrent appends (compare-and-swap retries)
const appends = await Promise.all(
  Array.from({ length: 8 }, (_, i) => call("append_to_note", { path: "Inbox/log.md", content: `- entry ${i}` })),
);
const log = await call("read_note", { path: "Inbox/log.md" });
const entries = Array.from({ length: 8 }, (_, i) => log.text.includes(`- entry ${i}`)).filter(Boolean).length;
check("8 parallel appends all land", entries === 8, `${entries}/8; errors: ${appends.filter((a) => a.isError).map((a) => a.text).join(" | ")}`);

// ---- create / exists
check("create_note creates", !(await call("create_note", { path: "Ideas/new.md", content: "hello" })).isError);
const dup = await call("create_note", { path: "Ideas/new.md", content: "again" });
check("create_note refuses an existing path", dup.isError, dup.text);

// ---- attribution
const recent = await call("recent_changes", { limit: 50 });
check("recent_changes attributes MCP and device changes", recent.text.includes("by mcp:owner") && recent.text.includes("by laptop"), recent.text);

// ---- move, delete, restore
await call("move_note", { from: "Ideas/new.md", to: "Archive/new.md" });
await laptop.sync();
check("move reaches the device", laptop.read("Archive/new.md") === "hello" && laptop.read("Ideas/new.md") === undefined);
await call("delete_note", { path: "Archive/new.md" });
const deleted = await call("list_deleted");
check("deleted file is listed", deleted.text.includes("Archive/new.md"), deleted.text);
const restored = await call("restore_version", { path: "Archive/new.md", version: 1 });
await laptop.sync();
check("restore_version brings it back on the device", !restored.isError && laptop.read("Archive/new.md") === "hello", restored.text);
const history = await call("note_history", { path: "Projects/Plan.md" });
check("note_history shows who made each version", history.text.includes("by laptop") && history.text.includes("by mcp:owner"), history.text);

// ---- search index follows device writes and deletes
laptop.write("Notes/zoo.md", "Un unicornio en el zoológico.");
await laptop.sync();
const found = await call("search_notes", { query: "unicornio zoologico" });
check("search finds a note a device just wrote (accents ignored)", found.text.includes("Notes/zoo.md"), found.text);
laptop.remove("Notes/zoo.md");
await laptop.sync();
const gone = await call("search_notes", { query: "unicornio" });
check("search forgets a note a device deleted", !gone.text.includes("Notes/zoo.md"), gone.text);

// ---- image
const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
laptop.write("Attachments/dot.png", png);
await laptop.sync();
const image = await call("read_attachment", { path: "Attachments/dot.png" });
check("read_attachment returns an image block", image.content.some((c) => c.type === "image" && c.mimeType === "image/png"), image.text);

// ---- scoped clients
if (readerToken && workToken) {
  const readerTools = await listTools(readerToken);
  const ownerTools = await listTools(token);
  check(
    "read-only client doesn't see write tools",
    readerTools.includes("read_note") && !readerTools.includes("edit_note") && ownerTools.includes("edit_note"),
    `reader: ${readerTools.join(",")}`,
  );
  check("read-only client can read", !(await call("read_note", { path: "Projects/Plan.md" }, readerToken)).isError);
  const denied = await call("create_note", { path: "x.md", content: "x" }, readerToken);
  check("read-only client cannot write", denied.isError, denied.text);
  const scopedList = await call("list_notes", {}, workToken);
  check("folder-scoped client only sees its folder", scopedList.text.includes("Work/Todo.md") && !scopedList.text.includes("Projects/"), scopedList.text);
  const outside = await call("read_note", { path: "Projects/Plan.md" }, workToken);
  check("folder-scoped client cannot read outside", outside.isError, outside.text);
  const scopedSearch = await call("search_notes", { query: "paragraph" }, workToken);
  check("folder-scoped search hides other folders", !scopedSearch.text.includes("Projects/"), scopedSearch.text);
  const inside = await call("edit_note", { path: "Work/Todo.md", edits: [{ old_text: "- [ ] ship", new_text: "- [x] ship" }] }, workToken);
  await laptop.sync();
  check("folder-scoped client edits inside, attributed to it", !inside.isError && laptop.read("Work/Todo.md") === "- [x] ship\n" && (await call("recent_changes", { limit: 3 })).text.includes("by mcp:work-agent"));
} else console.log("- skipped scoped-client checks (OSCF_MCP_CLIENTS not set)");

// ---- moves keep history and update links
laptop.write("Meetings/Kickoff.md", "# Kickoff\nNotes.\n");
laptop.write("Projects/Links.md", "See [[Kickoff]], [[Meetings/Kickoff|the kickoff]], ![[Kickoff#Notes]] and [md](Meetings/Kickoff.md).\n");
await laptop.sync();
await call("edit_note", { path: "Meetings/Kickoff.md", edits: [{ old_text: "Notes.", new_text: "Notes, v2." }] });
const moved = await call("move_note", { from: "Meetings/Kickoff.md", to: "Archive/Kickoff 2026.md" });
await laptop.sync();
const linksNow = laptop.read("Projects/Links.md") ?? "";
check(
  "move_note rewrites wikilinks, aliases, embeds and Markdown links",
  linksNow === "See [[Kickoff 2026]], [[Archive/Kickoff 2026|the kickoff]], ![[Kickoff 2026#Notes]] and [md](Archive/Kickoff%202026.md).\n",
  `${moved.text}\n${linksNow}`,
);
const movedHistory = await call("note_history", { path: "Archive/Kickoff 2026.md" });
check("note_history follows the move", movedHistory.text.includes("Meetings/Kickoff.md v2") && movedHistory.text.includes("moved to"), movedHistory.text);
check("moves are not listed as deleted", !(await call("list_deleted")).text.includes("Meetings/Kickoff.md"));
const recentMove = await call("recent_changes", { limit: 5 });
check("recent_changes shows a move once", recentMove.text.includes("moved\tMeetings/Kickoff.md → Archive/Kickoff 2026.md"), recentMove.text);
const back = await call("find_backlinks", { path: "Archive/Kickoff 2026.md" });
check("find_backlinks lists the linking note", back.text.includes("Projects/Links.md"), back.text);

// ---- diff and targeted undo
laptop.write("Notes/undo.md", "one\ntwo\nthree\nfour\nfive\n");
await laptop.sync();
await call("edit_note", { path: "Notes/undo.md", edits: [{ old_text: "two", new_text: "TWO (agent)" }] });
laptop.write("Notes/undo.md", (laptop.read("Notes/undo.md") ?? "").replace("five", "five (user fix)"));
await laptop.sync();
const diff = await call("diff_versions", { path: "Notes/undo.md", from: 1, to: 2 });
check("diff_versions shows the agent's change", diff.text.includes("- two") && diff.text.includes("+ TWO (agent)"), diff.text);
const undo = await call("revert_change", { path: "Notes/undo.md", version: 2 });
await laptop.sync();
check("revert_change undoes one change and keeps the later one", laptop.read("Notes/undo.md") === "one\ntwo\nthree\nfour\nfive (user fix)\n", `${undo.text}\n${laptop.read("Notes/undo.md")}`);

// ---- output format and paging
laptop.write("Notes/fm.md", "---\ntags: [a]\n---\nBody\n");
laptop.write("Notes/long.md", Array.from({ length: 3000 }, (_, i) => `line ${i + 1} ${"x".repeat(40)}`).join("\n"));
await laptop.sync();
const fm = await call("read_note", { path: "Notes/fm.md" });
check("read_note header is not a --- line", fm.text.startsWith("[Notes/fm.md · version 1") && !fm.text.includes("---\n---"), fm.text);
const long = await call("read_note", { path: "Notes/long.md" });
check("long notes are paged under ~20 KB with a continue hint", long.text.length < 22_000 && /offset=\d+/.test(long.text), String(long.text.length));
const many = await call("read_notes", { paths: ["Notes/fm.md", "Notes/undo.md", "Nope.md"] });
check("read_notes reads several and reports missing ones", many.text.includes("Body") && many.text.includes("five (user fix)") && many.text.includes("Nope.md · error"), many.text);
const hint = await call("read_note", { path: "fm.md" });
check("a wrong path suggests the right one", hint.isError && hint.text.includes("Did you mean: Notes/fm.md"), hint.text);

// ---- guards
check("text tools refuse binary files", (await call("append_to_note", { path: "Attachments/dot.png", content: "x" })).isError);
check("hidden folders are refused in any case", (await call("read_note", { path: ".Obsidian/app.json" })).isError && (await call("create_note", { path: "a/.git/x.md", content: "x" })).isError);
laptop.write("Notes/gone.md", "bye\n");
await laptop.sync();
laptop.remove("Notes/gone.md");
await laptop.sync();
const resurrect = await call("write_note", { path: "Notes/gone.md", content: "back?", version: 1 });
check("write_note on a note deleted meanwhile is refused", resurrect.isError && resurrect.text.includes("was deleted"), resurrect.text);
const appended = await call("append_to_note", { path: "Inbox/nl.md", content: "- a" });
await call("append_to_note", { path: "Inbox/nl.md", content: "- b" });
await laptop.sync();
check("append_to_note ends lines with a newline", laptop.read("Inbox/nl.md") === "- a\n- b\n", `${appended.text} ${JSON.stringify(laptop.read("Inbox/nl.md"))}`);
const missingVault = await call("list_notes", {}, token, `${vaultId}-typo`);
check("an unknown vault id is a 404, not an empty vault", missingVault.status === 404, `${missingVault.status} ${missingVault.text}`);
if (workToken) check("a client token only opens its vaults", (await call("list_notes", {}, workToken, "other-vault")).status === 401);

// ---- config dir is off limits
check("paths in .obsidian are refused", (await call("read_note", { path: ".obsidian/app.json" })).isError);

// ---- vaults in another format (e.g. from the encrypted versions) are refused
const otherFormatId = `${vaultId}-enc`;
await fetch(`${serverUrl}/v1/vaults/${otherFormatId}/meta`, {
  method: "PUT",
  headers: { authorization: `Bearer ${token}` },
  body: JSON.stringify({ v: 1, salt: "x", iterations: 600000, wrapped: "y" }),
});
const otherFormat = await call("list_notes", {}, token, otherFormatId);
check("a vault in another format is refused with a clear message", otherFormat.status === 409, `${otherFormat.status} ${otherFormat.text}`);

console.log(process.exitCode ? "MCP E2E FAILED" : "MCP E2E OK");
process.exit();
