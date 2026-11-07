/**
 * Restore drill: download a whole vault as a brand-new device would, then
 * compare it byte for byte with a local folder. Read-only.
 *
 *   bun scripts/verify-restore.ts <vault-id> <local-dir>
 *
 * Only files the plugin syncs are compared (same rules: dotfiles skipped,
 * settings-sync categories, never the plugin's own folder or workspace files).
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import * as Effect from "effect/Effect";

import { DEFAULT_CONFIG_SYNC, makeIsConfigSyncable } from "../packages/plugin/src/core/config.ts";
import { DEFAULT_SELECTIVE, makeIsSyncable } from "../packages/plugin/src/core/filter.ts";
import { fetchHttp, makeHttpRemote } from "../packages/plugin/src/core/http-remote.ts";
import { isPlainMeta } from "../packages/plugin/src/core/plain-vault.ts";
import { Device } from "../packages/plugin/test/harness.ts";

const [vaultId, dir] = process.argv.slice(2);
if (!vaultId || !dir) throw new Error("usage: verify-restore.ts <vault-id> <local-dir>");
const serverUrl = process.env.OSCF_URL!;
const token = process.env.OSCF_TOKEN!;
const remote = makeHttpRemote({ serverUrl, vaultId, token, http: fetchHttp() });

const { meta } = await Effect.runPromise(remote.meta());
if (meta === null) throw new Error(`vault ${vaultId} does not exist`);
if (!isPlainMeta(meta)) throw new Error(`vault ${vaultId} is not a plain-v1 vault`);

const configDir = ".obsidian";
const notes = makeIsSyncable(DEFAULT_SELECTIVE, [`${configDir}/plugins/homebase`]);
const config = makeIsConfigSyncable(configDir, DEFAULT_CONFIG_SYNC, "homebase");
const isSyncable = (p: string) =>
  p.startsWith(`${configDir}/`) ? config(p) : !p.split("/").some((part) => part.startsWith(".")) && notes(p);

const t0 = Date.now();
const device = await new Device("restore-drill", remote, { isSyncable }).start();
await device.sync();
// Compare names the way Obsidian reports them: macOS may store NFD while Obsidian
// uses NFC, and Obsidian exposes U+202F (macOS screenshot names) as a plain space.
const nfc = (p: string) => p.normalize("NFC").replace(/\u202f/g, " ");
const restored = new Map([...device.files].map(([p, f]) => [nfc(p), f.data]));

const local = new Map<string, Uint8Array>();
const walk = async (d: string) => {
  for (const e of await readdir(d, { withFileTypes: true })) {
    const full = join(d, e.name);
    const rel = nfc(relative(dir, full));
    if (e.isDirectory()) await walk(full);
    else if (isSyncable(rel)) local.set(rel, new Uint8Array(await readFile(full)));
  }
};
await walk(dir);

const missing = [...local.keys()].filter((p) => !restored.has(p));
const extra = [...restored.keys()].filter((p) => !local.has(p));
const different = [...local.keys()].filter((p) => restored.has(p) && Buffer.compare(local.get(p)!, restored.get(p)!) !== 0);
const bytes = [...restored.values()].reduce((n, b) => n + b.byteLength, 0);

console.log(`restored ${restored.size} files (${(bytes / 1048576).toFixed(1)} MB) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`local syncable files: ${local.size}`);
for (const [label, list] of [["missing", missing], ["extra", extra], ["different", different]] as const)
  if (list.length) console.log(`✗ ${label} (${list.length}): ${list.slice(0, 10).join(", ")}`);
const ok = missing.length === 0 && extra.length === 0 && different.length === 0;
console.log(ok ? "RESTORE OK: byte-for-byte identical" : "RESTORE MISMATCH");
process.exit(ok ? 0 : 1);
