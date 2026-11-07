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
 *   homebase restore-deleted <file> [dir]
 */
import * as nodePath from "node:path";

import * as Effect from "effect/Effect";

import { fetchHttp, makeHttpRemote } from "../../plugin/src/core/http-remote.ts";
import { deletedFiles, fileHistory, restoreDeleted, restoreVersion } from "../../plugin/src/core/history.ts";
import { openPlainVault } from "../../plugin/src/core/plain-vault.ts";
import { type Config, defaultDevice, log, openVault, readStatus, readToken, writeConfig, writeStatus } from "./vault.ts";
import { watch } from "./watch.ts";

const USAGE = `Usage:
  homebase init <dir> --url <server> --vault <id> [--device <name>] [--token-env VAR | --token-file FILE]
  homebase sync [dir]
  homebase watch [dir]
  homebase status [dir]
  homebase history <file> [dir]
  homebase restore <file> --version <n> [dir]
  homebase deleted [dir]
  homebase restore-deleted <file> [dir]

The token is read from $OSCF_TOKEN unless the folder was set up with --token-env or --token-file.`;

const parseArgs = (argv: string[]) => {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
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
  const dirArg = (index: number) => nodePath.resolve(positional[index] ?? ".");

  switch (command) {
    case "init": {
      if (!positional[0] || !flags.url || !flags.vault) return fail(USAGE);
      const root = dirArg(0);
      const config: Config = {
        url: flags.url,
        vault: flags.vault,
        device: flags.device || defaultDevice(),
        ...(flags["token-env"] ? { tokenEnv: flags["token-env"] } : {}),
        ...(flags["token-file"] ? { tokenFile: nodePath.resolve(flags["token-file"]) } : {}),
      };
      const { created } = await ensurePlain(config);
      await writeConfig(root, config);
      log(`${created ? "created" : "joined"} vault ${config.vault} in ${root} as ${config.device}. Run \`homebase sync\` or \`homebase watch\`.`);
      return;
    }

    case "sync": {
      const report = await syncOnce(dirArg(0));
      log(
        `done: ${report.pulled} pulled, ${report.pushed} pushed, ${report.merged} merged, ${report.conflicts} conflicts, ${report.skipped} skipped`,
      );
      return;
    }

    case "watch": {
      const root = dirArg(0);
      await ensurePlain((await openVault(root)).config);
      await watch(root);
      return;
    }

    case "status": {
      const root = dirArg(0);
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
      const vault = await openVault(dirArg(1));
      const versions = await vault.run(fileHistory(positional[0]));
      if (versions.length === 0) console.log("No versions.");
      for (const v of versions)
        console.log(`v${v.version}  ${date(v.createdAt)}  ${v.deleted ? "deleted " : size(v.size).padEnd(8)}  ${v.device}`);
      return;
    }

    case "restore": {
      const file = positional[0];
      const version = Number(flags.version);
      if (!file || !Number.isInteger(version)) return fail(USAGE);
      const root = dirArg(1);
      const vault = await openVault(root);
      const info = (await vault.run(fileHistory(file))).find((v) => v.version === version);
      if (!info) return fail(`${file} has no version ${version}.`);
      if (info.deleted) return fail(`Version ${version} of ${file} is a deletion.`);
      await vault.run(restoreVersion(info));
      await Effect.runPromise(vault.engine.sync(new Set([file])));
      log(`restored ${file} to version ${version} (saved as a new version)`);
      return;
    }

    case "deleted": {
      const vault = await openVault(dirArg(0));
      const files = await vault.run(deletedFiles);
      if (files.length === 0) console.log("No deleted files.");
      for (const f of files) console.log(`${date(f.deletedAt)}  ${f.device.padEnd(16)}  ${f.path}`);
      return;
    }

    case "restore-deleted": {
      const file = positional[0];
      if (!file) return fail(USAGE);
      const vault = await openVault(dirArg(1));
      await vault.run(restoreDeleted(file));
      await Effect.runPromise(vault.engine.sync(new Set([file])));
      log(`restored ${file}`);
      return;
    }

    default:
      console.log(USAGE);
      if (command && command !== "help" && command !== "--help") process.exitCode = 1;
  }
};

main().catch((error) => fail(`homebase: ${error instanceof Error ? error.message : String(error)}`));
