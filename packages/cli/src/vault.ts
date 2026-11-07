/**
 * One synced folder: its config (`.homebase/config.json`), token, services
 * layer and engine.
 */
import * as fs from "node:fs/promises";
import { hostname } from "node:os";
import * as nodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { type Activity, type EngineOptions, makeEngine } from "../../plugin/src/core/engine.ts";
import { fetchHttp, makeHttpRemote } from "../../plugin/src/core/http-remote.ts";
import { mergeText } from "../../plugin/src/core/merge.ts";
import { LocalState, Remote, VaultIo } from "../../plugin/src/core/services.ts";
import { fsLocalState, fsVaultIo, STATE_DIR, writeAtomic } from "./fs-vault.ts";
import { IGNORE_FILE, loadIgnore } from "./ignore.ts";

export interface Config {
  readonly url: string;
  readonly vault: string;
  readonly device: string;
  /** Environment variable holding the token (default OSCF_TOKEN). */
  readonly tokenEnv?: string;
  /** Or a file holding the token. */
  readonly tokenFile?: string;
}

/** Last outcome of `sync`/`watch`, shown by `status`. */
export interface RunStatus {
  readonly at: number;
  readonly ok: boolean;
  readonly error?: string;
}

export const defaultDevice = () => `cli-${hostname().split(".")[0]!.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;

export const configPath = (root: string) => nodePath.join(root, STATE_DIR, "config.json");
const statusPath = (root: string) => nodePath.join(root, STATE_DIR, "status.json");

export const writeConfig = (root: string, config: Config) => writeAtomic(configPath(root), `${JSON.stringify(config, null, 2)}\n`);

export const readConfig = async (root: string): Promise<Config> => {
  try {
    return JSON.parse(await fs.readFile(configPath(root), "utf8")) as Config;
  } catch {
    throw new Error(`${root} is not a Homebase folder (run \`homebase init\` first).`);
  }
};

/** The synced folder containing `start` (looks upward, like git). */
export const findRoot = async (start: string) => {
  let dir = nodePath.resolve(start);
  for (;;) {
    try {
      await fs.access(configPath(dir));
      return dir;
    } catch {
      const parent = nodePath.dirname(dir);
      if (parent === dir) throw new Error(`${nodePath.resolve(start)} is not inside a Homebase folder (run \`homebase init\` first).`);
      dir = parent;
    }
  }
};

/** A file argument (relative to the current directory, or absolute) as a vault path. */
export const vaultPath = (root: string, arg: string) => {
  const relative = nodePath.relative(root, nodePath.resolve(arg));
  if (relative === "" || relative.startsWith("..") || nodePath.isAbsolute(relative))
    throw new Error(`${arg} is not inside ${root}.`);
  return relative.split(nodePath.sep).join("/").normalize("NFC");
};

export const readToken = async (config: Pick<Config, "tokenEnv" | "tokenFile">) => {
  if (config.tokenFile) return (await fs.readFile(config.tokenFile, "utf8")).trim();
  const name = config.tokenEnv ?? "OSCF_TOKEN";
  const token = process.env[name];
  if (!token) throw new Error(`No token: set ${name} (or use --token-file).`);
  return token;
};

export const writeStatus = (root: string, status: RunStatus) => writeAtomic(statusPath(root), JSON.stringify(status));
export const readStatus = async (root: string): Promise<RunStatus | null> => {
  try {
    return JSON.parse(await fs.readFile(statusPath(root), "utf8")) as RunStatus;
  } catch {
    return null;
  }
};

const ACTIVITY_ICON: Record<Activity["kind"], string> = {
  downloaded: "↓ downloaded",
  uploaded: "↑ uploaded",
  "deleted-here": "✕ deleted here",
  "deleted-remote": "✕ deleted on server",
  renamed: "→ renamed",
  merged: "⇄ merged",
  conflict: "⚠ conflict",
  restored: "↺ restored",
  skipped: "! skipped",
};

/** Under systemd, journald timestamps every line already. */
const underJournal = process.env.JOURNAL_STREAM !== undefined;

export const log = (message: string) => {
  if (underJournal) return console.log(message);
  const time = new Date().toTimeString().slice(0, 8);
  console.log(`[${time}] ${message}`);
};

export const formatActivity = (a: Activity) =>
  `${ACTIVITY_ICON[a.kind]} ${a.path}${a.detail ? ` (${a.kind === "renamed" ? `from ${a.detail}` : a.detail})` : ""}`;

/**
 * Activity lines, at most ACTIVITY_LINES per second; the rest are counted and
 * summarized, so a 20k-file sync doesn't flood the log.
 */
const ACTIVITY_LINES = 40;
let shown = 0;
let hidden = 0;
let windowStart = 0;
const activityLog = (activity: Activity) => {
  const now = Date.now();
  if (now - windowStart > 1000) {
    if (hidden > 0) log(`… and ${hidden} more change(s)`);
    windowStart = now;
    shown = 0;
    hidden = 0;
  }
  if (shown++ < ACTIVITY_LINES) log(formatActivity(activity));
  else {
    hidden++;
    if (hidden === 1) setTimeout(() => hidden > 0 && (log(`… and ${hidden} more change(s)`), (hidden = 0)), 1000);
  }
};

export const openVault = async (root: string, overrides: Partial<EngineOptions> = {}) => {
  const config = await readConfig(root);
  const token = await readToken(config);
  // Reloadable: `watch` picks up edits to .homebaseignore without a restart.
  let ignoreRules = await loadIgnore(root);
  const isIgnored = (path: string) => ignoreRules(path);
  const io = fsVaultIo(root, isIgnored);
  const remote = makeHttpRemote({ serverUrl: config.url, vaultId: config.vault, token, http: fetchHttp() });
  const layer = Layer.mergeAll(
    Layer.succeed(VaultIo, io),
    Layer.succeed(Remote, remote),
    Layer.succeed(LocalState, fsLocalState(root)),
  );
  const engine = await Effect.runPromise(
    makeEngine({
      device: config.device,
      isSyncable: (path) => !isIgnored(path),
      merge: mergeText,
      log,
      onActivity: activityLog,
      ...overrides,
    }).pipe(Effect.provide(layer)),
  );
  const run = <A, E>(effect: Effect.Effect<A, E, VaultIo | Remote | LocalState>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)));

  // When .homebaseignore changes, paths it no longer ignores may hold remote files the
  // cursor already went past: re-read the whole index (like the plugin's selective sync).
  const fingerprintFile = nodePath.join(root, STATE_DIR, "ignore-fingerprint");
  const checkIgnoreChange = async () => {
    const current = await fs.readFile(nodePath.join(root, IGNORE_FILE), "utf8").catch(() => "");
    const stored = await fs.readFile(fingerprintFile, "utf8").catch(() => null);
    if (stored === current) return;
    if (stored !== null) await Effect.runPromise(engine.resetCursor);
    await writeAtomic(fingerprintFile, current);
  };
  await checkIgnoreChange();
  const reloadIgnore = async () => {
    ignoreRules = await loadIgnore(root);
    await checkIgnoreChange();
  };
  return { config, token, remote, engine, run, io, isIgnored, reloadIgnore };
};
