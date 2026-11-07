/**
 * End-to-end test of the headless CLI against a running server (default
 * http://localhost:1337, `bun run dev`). Two folders, A and B, on a fresh
 * `e2e-cli-*` vault. Run from the repo root so Bun loads OSCF_TOKEN from .env.
 *
 *   bun scripts/cli-e2e.ts
 */
import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const serverUrl = process.env.OSCF_URL ?? "http://localhost:1337";
const stamp = Date.now();
const vaultId = `e2e-cli-${stamp}`;
const root = `/tmp/homebase-cli-test/${stamp}`;
const A = path.join(root, "a");
const B = path.join(root, "b");
const CLI = path.join(import.meta.dir, "../packages/cli/src/main.ts");

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures++;
};

const cli = (...args: string[]) => cliIn(process.cwd(), ...args);
const cliIn = async (cwd: string, ...args: string[]) => {
  const proc = Bun.spawn(["bun", CLI, ...args], { stdout: "pipe", stderr: "pipe", cwd });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`homebase ${args.join(" ")} failed (${code}): ${err || out}`);
  return out;
};

const write = async (dir: string, file: string, content: string | Uint8Array) => {
  await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
  await fs.writeFile(path.join(dir, file), content);
};
const read = (dir: string, file: string) => fs.readFile(path.join(dir, file), "utf8").catch(() => null);
const exists = (dir: string, file: string) => fs.stat(path.join(dir, file)).then(() => true, () => false);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const waitFor = async (predicate: () => Promise<boolean>, timeoutMs: number) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return Date.now() - start;
    await sleep(100);
  }
  return null;
};

await fs.mkdir(A, { recursive: true });
await fs.mkdir(B, { recursive: true });
await cli("init", A, "--url", serverUrl, "--vault", vaultId, "--device", "a");
await cli("init", B, "--url", serverUrl, "--vault", vaultId, "--device", "b");

// ------------------------------------------------------------ one-shot sync
await write(A, "Notes/one.md", "one\n");
await write(A, "Notes/two.md", "two\n");
await write(A, "Notes/gone.md", "bye\n");
await cli("sync", A);
await cli("sync", B);
check("create: new notes reach B", (await read(B, "Notes/one.md")) === "one\n" && (await read(B, "Notes/gone.md")) === "bye\n");

await write(A, "Notes/one.md", "one edited\n");
await fs.rm(path.join(A, "Notes/gone.md"));
await fs.mkdir(path.join(A, "Notes/Archive"), { recursive: true });
await fs.rename(path.join(A, "Notes/two.md"), path.join(A, "Notes/Archive/two.md"));
await cli("sync", A);
await cli("sync", B);
check("edit reaches B", (await read(B, "Notes/one.md")) === "one edited\n");
check("delete reaches B", !(await exists(B, "Notes/gone.md")));
check("rename reaches B", (await read(B, "Notes/Archive/two.md")) === "two\n" && !(await exists(B, "Notes/two.md")));

// ------------------------------------------------------------ merge
const base = "# Plan\n\nFirst paragraph.\n\nMiddle paragraph.\n\nLast paragraph.\n";
await write(A, "merge.md", base);
await cli("sync", A);
await cli("sync", B);
await write(A, "merge.md", base.replace("First paragraph.", "First paragraph, edited on A."));
await write(B, "merge.md", base.replace("Last paragraph.", "Last paragraph, edited on B."));
await cli("sync", A);
const mergeOut = await cli("sync", B);
await cli("sync", A);
const mergedA = await read(A, "merge.md");
const mergedB = await read(B, "merge.md");
check(
  "edits to different paragraphs merge on both sides",
  mergedA === mergedB && !!mergedA?.includes("edited on A") && !!mergedA?.includes("edited on B"),
  mergeOut.includes("merged") ? "B reported a merge" : "",
);

// ------------------------------------------------------------ conflict
await write(A, "clash.md", "same line\n");
await cli("sync", A);
await cli("sync", B);
await write(A, "clash.md", "A's version\n");
await write(B, "clash.md", "B's version\n");
await cli("sync", A);
await cli("sync", B);
const copies = (await fs.readdir(B)).filter((f) => f.startsWith("clash (conflict b"));
check(
  "overlapping edits: remote wins the path, local kept as a conflict copy",
  (await read(B, "clash.md")) === "A's version\n" && copies.length === 1 && (await read(B, copies[0]!)) === "B's version\n",
  copies[0],
);
await cli("sync", B);
await cli("sync", A);
check("conflict copy reaches A", copies.length === 1 && (await exists(A, copies[0]!)));

// ------------------------------------------------------------ binary
const small = randomBytes(300 * 1024);
const big = randomBytes(9 * 1024 * 1024); // crosses the 8 MB chunk size
await write(A, "Attachments/photo.png", small);
await write(A, "Attachments/video.mp4", big);
await cli("sync", A);
await cli("sync", B);
const gotSmall = await fs.readFile(path.join(B, "Attachments/photo.png")).catch(() => null);
const gotBig = await fs.readFile(path.join(B, "Attachments/video.mp4")).catch(() => null);
check("binary round trip (300 KB)", gotSmall !== null && Buffer.compare(gotSmall, small) === 0);
check("binary round trip (9 MB, two chunks)", gotBig !== null && Buffer.compare(gotBig, big) === 0);

// ------------------------------------------------------------ history and recovery
await write(A, "versions.md", "v1\n");
await cli("sync", A);
await write(A, "versions.md", "v2\n");
await cli("sync", A);
await write(A, "versions.md", "v3\n");
await cli("sync", A);
const historyOut = await cli("history", "versions.md", A);
check("history lists 3 versions", (historyOut.match(/^v\d/gm) ?? []).length === 3);
await cli("restore", "versions.md", "--version", "1", A);
await cli("sync", B);
check("restore version 1 reaches B", (await read(B, "versions.md")) === "v1\n");
await fs.rm(path.join(B, "versions.md"));
await cli("sync", B);
await cli("sync", A);
const deletedOut = await cli("deleted", A);
check("deleted lists the file", deletedOut.includes("versions.md"));
await cli("restore-deleted", "versions.md", A);
await cli("sync", B);
check("restore-deleted brings it back on B", (await read(B, "versions.md")) === "v1\n");

// ------------------------------------------------------------ status and ignore rules
await write(A, ".obsidian/workspace.json", "{}");
await write(A, ".git/HEAD", "ref");
await write(A, "Notes/.note.md.swp", "x");
await write(A, "pending.md", "not synced yet\n");
const statusOut = await cli("status", A);
check("status reports the pending change", statusOut.includes("pending: 1") && statusOut.includes("pending.md"), statusOut.split("\n").find((l) => l.startsWith("pending")));
await cli("sync", A);
await cli("sync", B);
check("ignored paths never sync", !(await exists(B, ".obsidian/workspace.json")) && !(await exists(B, ".git/HEAD")) && !(await exists(B, "Notes/.note.md.swp")));

// ------------------------------------------------------------ .homebaseignore
check("init creates an empty .homebaseignore", await exists(A, ".homebaseignore"));
await write(A, ".homebaseignore", "# local only\ndrafts/\n*.log\n/build\n");
await write(A, "drafts/wip.md", "wip\n");
await write(A, "Notes/run.log", "log\n");
await write(A, "build/out.md", "out\n");
await write(A, "Notes/build/kept.md", "kept\n");
await write(A, ".vscode/settings.json", "{}");
await write(A, "tools/__pycache__/x.pyc", "x");
await write(A, "Notes/a.tmp", "x");
await cli("sync", A);
await cli("sync", B);
check(
  ".homebaseignore patterns and defaults are never synced",
  !(await exists(B, "drafts/wip.md")) &&
    !(await exists(B, "Notes/run.log")) &&
    !(await exists(B, "build/out.md")) &&
    !(await exists(B, ".vscode/settings.json")) &&
    !(await exists(B, "tools/__pycache__/x.pyc")) &&
    !(await exists(B, "Notes/a.tmp")),
);
check("an anchored pattern only matches at the root", (await read(B, "Notes/build/kept.md")) === "kept\n");

// ------------------------------------------------------------ mv with links, paths relative to the current directory
await write(A, "Meetings/Kickoff.md", "# Kickoff\n");
await write(A, "Projects/Atlas.md", "See [[Kickoff]], [[Meetings/Kickoff|the kickoff]], ![[Kickoff#Notes]] and [md](Meetings/Kickoff.md).\n");
await cli("sync", A);
await cli("sync", B);
const mvOut = await cliIn(path.join(A, "Meetings"), "mv", "Kickoff.md", "../Archive/Kickoff 2026.md");
await cli("sync", B);
check(
  "homebase mv moves the file and rewrites links (run from a subfolder)",
  (await read(B, "Archive/Kickoff 2026.md")) === "# Kickoff\n" &&
    !(await exists(B, "Meetings/Kickoff.md")) &&
    (await read(B, "Projects/Atlas.md")) ===
      "See [[Kickoff 2026]], [[Archive/Kickoff 2026|the kickoff]], ![[Kickoff 2026#Notes]] and [md](Archive/Kickoff%202026.md).\n",
  mvOut.trim().split("\n").at(-1),
);
const movedHistory = await cliIn(A, "history", "Archive/Kickoff 2026.md");
check("history follows the move", movedHistory.includes("(as Meetings/Kickoff.md)") && movedHistory.includes("moved"), movedHistory.trim());
check("moved files are not listed as deleted", !(await cli("deleted", A)).includes("Meetings/Kickoff.md"));

// ------------------------------------------------------------ restore a deleted folder
await write(A, "Old/one.md", "1\n");
await write(A, "Old/two.md", "2\n");
await cli("sync", A);
await fs.rm(path.join(A, "Old"), { recursive: true });
await cli("sync", A);
await cli("sync", B);
const restoreFolder = await cliIn(A, "restore-deleted", "Old");
await cli("sync", B);
check("restore-deleted restores a whole folder", (await read(B, "Old/one.md")) === "1\n" && (await read(B, "Old/two.md")) === "2\n", restoreFolder.trim().split("\n").at(-1));
const notDeleted = await cliIn(A, "restore-deleted", "Projects/Atlas.md").then(() => "ok", (e: Error) => e.message);
check("restore-deleted refuses a file that exists", notDeleted.includes("isn't deleted"), notDeleted.slice(0, 120));

// ------------------------------------------------------------ watch
const spawnWatch = (dir: string) => {
  const proc = Bun.spawn(["bun", CLI, "watch", dir], { stdout: "pipe", stderr: "pipe" });
  const lines: string[] = [];
  void (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) lines.push(...decoder.decode(chunk).split("\n").filter(Boolean));
  })();
  return { proc, lines };
};
// An existing folder: writes into it are not announced by a folder-level event.
await fs.mkdir(path.join(A, "burst"), { recursive: true });
const wa = spawnWatch(A);
const wb = spawnWatch(B);
const ready = await waitFor(async () => [wa, wb].every((w) => w.lines.some((l) => l.includes("connection open") || l.includes("watching"))), 10_000);
check("watch starts on A and B", ready !== null);
await sleep(1500);

await write(A, "live/from-a.md", "hello from A\n");
let ms = await waitFor(async () => (await read(B, "live/from-a.md")) === "hello from A\n", 10_000);
check("watch: new file in A appears in B", ms !== null, ms === null ? "timeout" : `${ms} ms`);

await write(B, "live/from-a.md", "hello from A\nreply from B\n");
ms = await waitFor(async () => (await read(A, "live/from-a.md")) === "hello from A\nreply from B\n", 10_000);
check("watch: edit in B appears in A", ms !== null, ms === null ? "timeout" : `${ms} ms`);

await fs.rename(path.join(A, "live"), path.join(A, "live-renamed"));
ms = await waitFor(async () => (await exists(B, "live-renamed/from-a.md")) && !(await exists(B, "live/from-a.md")), 15_000);
check("watch: folder rename in A reaches B", ms !== null, ms === null ? "timeout" : `${ms} ms`);

const burstStart = Date.now();
await Promise.all(Array.from({ length: 200 }, (_, i) => fs.writeFile(path.join(A, "burst", `note-${i}.md`), `note ${i}\n`)));
ms = await waitFor(async () => (await fs.readdir(path.join(B, "burst")).catch(() => [] as string[])).length === 200, 90_000);
check("watch: burst of 200 files into an existing folder reaches B", ms !== null, ms === null ? "timeout" : `${Date.now() - burstStart} ms`);

await fs.rm(path.join(A, "burst"), { recursive: true });
ms = await waitFor(async () => !(await exists(B, "burst")), 60_000);
check("watch: deleting the burst folder reaches B", ms !== null, ms === null ? "timeout" : `${ms} ms`);

wa.proc.kill("SIGTERM");
wb.proc.kill("SIGTERM");
const codes = await Promise.all([wa.proc.exited, wb.proc.exited]);
check("watch exits cleanly on SIGTERM", codes.every((c) => c === 0), codes.join(","));

if (failures > 0) {
  console.log("\n--- watch A log (tail) ---\n" + wa.lines.slice(-25).join("\n"));
  console.log("\n--- watch B log (tail) ---\n" + wb.lines.slice(-25).join("\n"));
}
console.log(`\n${failures === 0 ? "all passed" : `${failures} failed`} (vault ${vaultId}, folders ${root})`);
process.exit(failures === 0 ? 0 : 1);
