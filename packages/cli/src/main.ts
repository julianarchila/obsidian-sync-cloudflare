#!/usr/bin/env bun
/**
 * homebase: headless Homebase sync for a plain folder of notes.
 *
 *   homebase init <dir> --url <server> --vault <id> [--device <name>] [--token-env VAR | --token-file FILE]
 *   homebase sync [dir]                 one pass: pull, then push, then exit
 *   homebase watch [dir]                keep the folder in sync until stopped
 *   homebase status [dir]
 *   homebase history <file> [dir]
 *   homebase restore <file> --version N [dir]
 *   homebase deleted [dir]
 *   homebase restore-deleted <file|folder> [dir]
 *   homebase mv <from> <to> [--no-links]   move/rename and update links in other notes
 *
 * File arguments are relative to the current directory (or absolute); with an
 * explicit [dir], they are relative to that folder. Commands run anywhere
 * inside a synced folder.
 */
import * as nodePath from "node:path";

import * as Effect from "effect/Effect";

import { fetchHttp, makeHttpRemote } from "../../plugin/src/core/http-remote.ts";
import { deletedFiles, fileHistory, restoreDeleted, restoreVersion } from "../../plugin/src/core/history.ts";
import { rewriteLinks } from "../../plugin/src/core/links.ts";
import { openPlainVault } from "../../plugin/src/core/plain-vault.ts";
import * as fs from "node:fs/promises";
import { IGNORE_FILE } from "./ignore.ts";
import { writeAtomic } from "./fs-vault.ts";
import {
  type Config,
  defaultDevice,
  findRoot,
  log,
  openVault,
  readStatus,
  readToken,
  vaultPath,
  writeConfig,
  writeStatus,
} from "./vault.ts";
import { watch } from "./watch.ts";

const USAGE = `Usage:
  homebase init <dir> --url <server> --vault <id> [--device <name>] [--token-env VAR | --token-file FILE]
  homebase sync [dir]
  homebase watch [dir]
  homebase status [dir]
  homebase history <file> [dir]
  homebase restore <file> --version <n> [dir]
  homebase deleted [dir]
  homebase restore-deleted <file|folder> [dir]
  homebase mv <from> <to> [--no-links]

File arguments are relative to the current directory. Commands work anywhere inside a synced folder.
Paths matching .homebaseignore (gitignore-like) and hidden files are never synced.
The token is read from $OSCF_TOKEN unless the folder was set up with --token-env or --token-file.`;

const parseArgs = (argv: string[]) => {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--no-links" || arg === "--help") flags[arg.slice(2)] = "true";
    else if (arg.startsWith("--")) {
      const [key, inline] = arg.slice(2).split("=", 2) as [string, string | undefined];
      flags[key] = inline ?? argv[++i] ?? "";
    } else positional.push(arg);
  }
  return { positional, flags };
};

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const date = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);
const size = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;

const ensurePlain = async (config: Config) => {
  const token = await readToken(config);
  const remote = makeHttpRemote({ serverUrl: config.url, vaultId: config.vault, token, http: fetchHttp() });
  return Effect.runPromise(openPlainVault(remote));
};

const syncOnce = async (root: string, paths?: Set<string>) => {
  const vault = await openVault(root);
  await ensurePlain(vault.config);
  try {
    const report = await Effect.runPromise(vault.engine.sync(paths));
    await writeStatus(root, { at: Date.now(), ok: true });
    return report;
  } catch (error) {
    await writeStatus(root, { at: Date.now(), ok: false, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
};

const main = async () => {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);
  const dirArg = (index: number) => findRoot(positional[index] ?? ".");
  /** Root and vault path for a file argument (`[dir]` at `dirIndex` makes it vault-relative). */
  const fileArg = async (file: string, dirIndex: number) => {
    if (positional[dirIndex] !== undefined) {
      const root = await findRoot(positional[dirIndex]!);
      return { root, path: vaultPath(root, nodePath.join(root, file)) };
    }
    const root = await findRoot(".");
    return { root, path: vaultPath(root, file) };
  };
  if (flags.help) return void console.log(USAGE);

  switch (command) {
    case "init": {
      if (!positional[0] || !flags.url || !flags.vault) return fail(USAGE);
      const root = nodePath.resolve(positional[0]);
      const config: Config = {
        url: flags.url,
        vault: flags.vault,
        device: flags.device || defaultDevice(),
        ...(flags["token-env"] ? { tokenEnv: flags["token-env"] } : {}),
        ...(flags["token-file"] ? { tokenFile: nodePath.resolve(flags["token-file"]) } : {}),
      };
      const { created } = await ensurePlain(config);
      await writeConfig(root, config);
      await fs.access(nodePath.join(root, IGNORE_FILE)).catch(() =>
        writeAtomic(nodePath.join(root, IGNORE_FILE), "# Paths this folder never syncs (gitignore-like). Hidden files are always skipped.\n"),
      );
      log(`${created ? "created" : "joined"} vault ${config.vault} in ${root} as ${config.device}. Run \`homebase sync\` or \`homebase watch\`.`);
      return;
    }

    case "sync": {
      const report = await syncOnce(await dirArg(0));
      log(
        `done: ${report.pulled} pulled, ${report.pushed} pushed, ${report.merged} merged, ${report.conflicts} conflicts, ${report.skipped} skipped`,
      );
      return;
    }

    case "watch": {
      const root = await dirArg(0);
      await ensurePlain((await openVault(root)).config);
      await watch(root);
      return;
    }

    case "status": {
      const root = await dirArg(0);
      const vault = await openVault(root, { onActivity: () => {} });
      const files = await Effect.runPromise(vault.io.list);
      const pending = await Effect.runPromise(
        vault.engine.changedLocally([...files.map((f) => f.path), ...Object.keys(vault.engine.state.base)]),
      );
      const last = await readStatus(root);
      console.log(`folder:  ${root}`);
      console.log(`server:  ${vault.config.url}  vault: ${vault.config.vault}  device: ${vault.config.device}`);
      console.log(`cursor:  ${vault.engine.state.cursor}`);
      console.log(`tracked: ${Object.keys(vault.engine.state.base).length} files`);
      console.log(`pending: ${pending.length} local change(s)${pending.length ? `\n  ${pending.slice(0, 20).join("\n  ")}` : ""}`);
      if (last) console.log(`last:    ${date(last.at)} ${last.ok ? "ok" : `failed: ${last.error}`}`);
      return;
    }

    case "history": {
      if (!positional[0]) return fail(USAGE);
      const { root, path } = await fileArg(positional[0], 1);
      const vault = await openVault(root);
      const versions = await vault.run(fileHistory(path));
      if (versions.length === 0) return fail(`${path} has no history on the server.`);
      for (const v of versions)
        console.log(
          `v${v.version}  ${date(v.createdAt)}  ${v.deleted ? (v.entry.movedTo ? "moved   " : "deleted ") : size(v.size).padEnd(8)}  ${v.device}${v.path !== path ? `  (as ${v.path})` : ""}`,
        );
      return;
    }

    case "restore": {
      const file = positional[0];
      const version = Number(flags.version);
      if (!file || !Number.isInteger(version)) return fail(USAGE);
      const { root, path } = await fileArg(file, 1);
      const vault = await openVault(root);
      const info = (await vault.run(fileHistory(path))).find((v) => v.version === version && v.path === path);
      if (!info) return fail(`${path} has no version ${version}.`);
      if (info.deleted) return fail(`Version ${version} of ${path} is a deletion.`);
      await vault.run(restoreVersion(info, path));
      await Effect.runPromise(vault.engine.sync(new Set([path])));
      log(`restored ${path} to version ${version} (saved as a new version)`);
      return;
    }

    case "deleted": {
      const vault = await openVault(await dirArg(0));
      const files = await vault.run(deletedFiles);
      if (files.length === 0) console.log("No deleted files.");
      for (const f of files) console.log(`${date(f.deletedAt)}  ${f.device.padEnd(16)}  ${f.path}`);
      return;
    }

    case "restore-deleted": {
      const target = positional[0];
      if (!target) return fail(USAGE);
      const { root, path } = await fileArg(target, 1);
      const vault = await openVault(root);
      if ((await Effect.runPromise(vault.io.stat(path))) !== null) return fail(`${path} exists; it isn't deleted.`);
      const deleted = await vault.run(deletedFiles);
      // A file, or every deleted file under a folder.
      const paths = deleted.some((f) => f.path === path)
        ? [path]
        : deleted.map((f) => f.path).filter((p) => p.startsWith(`${path.replace(/\/$/, "")}/`));
      if (paths.length === 0) return fail(`Nothing deleted at ${path}. See \`homebase deleted\`.`);
      for (const p of paths) await vault.run(restoreDeleted(p));
      await Effect.runPromise(vault.engine.sync(new Set(paths)));
      log(`restored ${paths.length === 1 ? paths[0] : `${paths.length} files under ${path}/`}`);
      return;
    }

    case "mv": {
      if (!positional[0] || !positional[1]) return fail(USAGE);
      const root = await findRoot(".");
      const from = vaultPath(root, positional[0]);
      const to = vaultPath(root, positional[1]);
      const vault = await openVault(root);
      if (vault.isIgnored(to)) return fail(`${to} is ignored (hidden or in .homebaseignore).`);
      const absFrom = nodePath.join(root, ...from.split("/"));
      const absTo = nodePath.join(root, ...to.split("/"));
      if (!(await fs.stat(absFrom).catch(() => null))?.isFile()) return fail(`${from} is not a file.`);
      if (await fs.stat(absTo).catch(() => null)) return fail(`${to} already exists.`);
      await fs.mkdir(nodePath.dirname(absTo), { recursive: true });
      await fs.rename(absFrom, absTo);
      const touched = new Set([from, to]);
      if (!flags["no-links"] && /\.md$/i.test(from)) {
        let links = 0;
        for (const file of await Effect.runPromise(vault.io.list)) {
          if (!/\.md$/i.test(file.path)) continue;
          const abs = nodePath.join(root, ...file.path.split("/"));
          const { text, count } = rewriteLinks(await fs.readFile(abs, "utf8"), from, to);
          if (count === 0) continue;
          await writeAtomic(abs, text);
          touched.add(file.path);
          links += count;
          log(`updated ${count} link(s) in ${file.path}`);
        }
        if (links === 0) log("no links to update");
      }
      // Push now: the move is recorded as a move (history follows), link edits as normal edits.
      const report = await Effect.runPromise(vault.engine.sync(touched));
      log(`moved ${from} → ${to} (${report.pushed} change(s) pushed)`);
      return;
    }

    default:
      console.log(USAGE);
      if (command && command !== "help" && command !== "--help") process.exitCode = 1;
  }
};

main().catch((error) => fail(`homebase: ${error instanceof Error ? error.message : String(error)}`));
