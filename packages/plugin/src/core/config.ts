/**
 * Settings sync (M5): which files under the config dir (`.obsidian`) sync,
 * per category, plus a key-level merge for JSON settings.
 */

export interface ConfigSyncSettings {
  /** app.json, core-plugins.json, graph.json, … (top-level settings files). */
  readonly main: boolean;
  /** appearance.json */
  readonly appearance: boolean;
  /** themes/ and snippets/ */
  readonly themes: boolean;
  /** community-plugins.json (which community plugins are enabled) */
  readonly communityPluginList: boolean;
  /** plugins/<id>/ (code and data) */
  readonly plugins: boolean;
  /** hotkeys.json */
  readonly hotkeys: boolean;
}

export const DEFAULT_CONFIG_SYNC: ConfigSyncSettings = {
  main: true,
  appearance: true,
  themes: true,
  communityPluginList: true,
  plugins: true,
  hotkeys: true,
};

export type ConfigCategory = keyof ConfigSyncSettings;

/**
 * Category of a path inside the config dir, or null when it must never sync:
 * workspace layouts (per device), caches, and this plugin's own folder
 * (token, encryption key, sync state).
 */
/** Former ids of this plugin: their folders hold a token and key too, so never sync them. */
const LEGACY_SELF_IDS = ["cloudflare-sync"];

export const configCategory = (relative: string, selfPluginId: string): ConfigCategory | null => {
  for (const id of [selfPluginId, ...LEGACY_SELF_IDS])
    if (relative.startsWith(`plugins/${id}/`) || relative === `plugins/${id}`) return null;
  if (relative.startsWith("plugins/")) {
    const parts = relative.split("/");
    // Per-device caches (e.g. text-extractor/cache) are rebuilt locally: never sync them.
    if (parts.slice(2, -1).some((segment) => /^\.?cache$/i.test(segment))) return null;
    return parts.length >= 3 ? "plugins" : null;
  }
  if (relative.startsWith("themes/") || relative.startsWith("snippets/")) return "themes";
  if (relative.includes("/")) return null; // other folders (caches, …)
  if (/^workspace.*\.json$/.test(relative)) return null;
  if (relative === "appearance.json") return "appearance";
  if (relative === "hotkeys.json") return "hotkeys";
  if (relative === "community-plugins.json") return "communityPluginList";
  return relative.endsWith(".json") ? "main" : null;
};

export const makeIsConfigSyncable =
  (configDir: string, settings: ConfigSyncSettings, selfPluginId: string) =>
  (path: string) => {
    if (!path.startsWith(`${configDir}/`)) return false;
    const category = configCategory(path.slice(configDir.length + 1), selfPluginId);
    return category !== null && settings[category];
  };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Three-way merge of JSON objects by top-level key. Keys changed on one side
 * take that side; keys changed on both sides take `theirs` (remote wins, like
 * the file-level rule). Returns null when the inputs are not JSON objects.
 */
export const mergeJson = (base: string | null, ours: string, theirs: string): string | null => {
  let b: unknown;
  let o: unknown;
  let t: unknown;
  try {
    b = base === null ? {} : JSON.parse(base);
    o = JSON.parse(ours);
    t = JSON.parse(theirs);
  } catch {
    return null;
  }
  if (!isObject(b) || !isObject(o) || !isObject(t)) return null;
  const out: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(t), ...Object.keys(o), ...Object.keys(b)])) {
    const inBase = key in b;
    const ourChanged = !equal(o[key], b[key]) || (key in o) !== inBase;
    const value = ourChanged && equal(t[key], b[key]) && (key in t) === inBase ? o[key] : t[key];
    const present = ourChanged && equal(t[key], b[key]) && (key in t) === inBase ? key in o : key in t;
    if (present) out[key] = value;
  }
  // Keep Obsidian's pretty-printed style.
  return `${JSON.stringify(out, null, 2)}`;
};

const utf8 = new TextDecoder("utf-8", { fatal: true });
const asText = (bytes: Uint8Array | null) => {
  if (bytes === null) return null;
  try {
    return utf8.decode(bytes);
  } catch {
    return null;
  }
};

/**
 * Merge hook for config files: JSON settings merge by key; anything else
 * (themes, plugin code) takes the remote version, because conflict copies
 * inside the config dir would only clutter it.
 */
export const mergeConfig =
  (configDir: string) =>
  (input: { path: string; base: Uint8Array | null; ours: Uint8Array; theirs: Uint8Array }): Uint8Array | null => {
    if (!input.path.startsWith(`${configDir}/`)) return null;
    if (input.path.endsWith(".json")) {
      const [ours, theirs] = [asText(input.ours), asText(input.theirs)];
      if (ours !== null && theirs !== null) {
        const merged = mergeJson(asText(input.base), ours, theirs);
        if (merged !== null) return new TextEncoder().encode(merged);
      }
    }
    return input.theirs;
  };
