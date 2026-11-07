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
import { plainCodec } from "../../plugin/src/core/plain-codec.ts";
import { Codec, LocalState, Remote, VaultIo } from "../../plugin/src/core/services.ts";
import { fsLocalState, fsVaultIo, isIgnored, STATE_DIR, writeAtomic } from "./fs-vault.ts";

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

export const log = (message: string) => {
  const time = new Date().toTimeString().slice(0, 8);
  console.log(`[${time}] ${message}`);
};

export const formatActivity = (a: Activity) =>
  `${ACTIVITY_ICON[a.kind]} ${a.path}${a.detail ? ` (${a.kind === "renamed" ? `from ${a.detail}` : a.detail})` : ""}`;

export const openVault = async (root: string, overrides: Partial<EngineOptions> = {}) => {
  const config = await readConfig(root);
  const token = await readToken(config);
  const remote = makeHttpRemote({ serverUrl: config.url, vaultId: config.vault, token, http: fetchHttp() });
  const layer = Layer.mergeAll(
    Layer.succeed(VaultIo, fsVaultIo(root)),
    Layer.succeed(Remote, remote),
    Layer.succeed(Codec, plainCodec),
    Layer.succeed(LocalState, fsLocalState(root)),
  );
  const engine = await Effect.runPromise(
    makeEngine({
      device: config.device,
      isSyncable: (path) => !isIgnored(path),
      merge: mergeText,
      log,
      onActivity: (activity) => log(formatActivity(activity)),
      ...overrides,
    }).pipe(Effect.provide(layer)),
  );
  const run = <A, E>(effect: Effect.Effect<A, E, VaultIo | Remote | Codec | LocalState>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)));
  return { config, token, remote, engine, run, io: fsVaultIo(root) };
};
