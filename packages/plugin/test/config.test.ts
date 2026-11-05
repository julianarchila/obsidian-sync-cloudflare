import { describe, expect, test } from "bun:test";

import { configCategory, DEFAULT_CONFIG_SYNC, makeIsConfigSyncable, mergeJson } from "../src/core/config.ts";
import { setup } from "./harness.ts";

const SELF = "homebase";

describe("config categories", () => {
  test("classifies settings files and never syncs internal ones", () => {
    expect(configCategory("app.json", SELF)).toBe("main");
    expect(configCategory("core-plugins.json", SELF)).toBe("main");
    expect(configCategory("appearance.json", SELF)).toBe("appearance");
    expect(configCategory("hotkeys.json", SELF)).toBe("hotkeys");
    expect(configCategory("community-plugins.json", SELF)).toBe("communityPluginList");
    expect(configCategory("themes/Minimal/theme.css", SELF)).toBe("themes");
    expect(configCategory("snippets/wide.css", SELF)).toBe("themes");
    expect(configCategory("plugins/dataview/main.js", SELF)).toBe("plugins");
    expect(configCategory("plugins/dataview/data.json", SELF)).toBe("plugins");
    expect(configCategory("workspace.json", SELF)).toBeNull();
    expect(configCategory("workspace-mobile.json", SELF)).toBeNull();
    expect(configCategory(`plugins/${SELF}/data.json`, SELF)).toBeNull();
    expect(configCategory(`plugins/${SELF}/state-x.json`, SELF)).toBeNull();
    expect(configCategory("cache/whatever", SELF)).toBeNull();
    // A leftover folder from the plugin's former id must never sync (it holds a token and key).
    expect(configCategory("plugins/cloudflare-sync/data.json", SELF)).toBeNull();
    expect(configCategory("plugins/text-extractor/cache/abc.json", SELF)).toBeNull();
    expect(configCategory("plugins/x/.cache/deep/file", SELF)).toBeNull();
    expect(configCategory("plugins/text-extractor/data.json", SELF)).toBe("plugins");
  });

  test("per-category toggles", () => {
    const isSyncable = makeIsConfigSyncable(".obsidian", { ...DEFAULT_CONFIG_SYNC, plugins: false }, SELF);
    expect(isSyncable(".obsidian/hotkeys.json")).toBe(true);
    expect(isSyncable(".obsidian/plugins/dataview/main.js")).toBe(false);
    expect(isSyncable("notes/a.md")).toBe(false);
  });
});

describe("mergeJson", () => {
  test("keys changed on different sides both survive", () => {
    const base = JSON.stringify({ a: 1, b: 1, c: 1 });
    const ours = JSON.stringify({ a: 2, b: 1, c: 1 });
    const theirs = JSON.stringify({ a: 1, b: 1, c: 3, d: 4 });
    expect(JSON.parse(mergeJson(base, ours, theirs)!)).toEqual({ a: 2, b: 1, c: 3, d: 4 });
  });

  test("deletions on one side are kept; same key on both sides -> remote wins", () => {
    const base = JSON.stringify({ a: 1, b: 1 });
    const ours = JSON.stringify({ a: 2 }); // deleted b, changed a
    const theirs = JSON.stringify({ a: 3, b: 1 }); // changed a
    expect(JSON.parse(mergeJson(base, ours, theirs)!)).toEqual({ a: 3 });
  });

  test("not JSON objects -> null", () => {
    expect(mergeJson("{}", "[1]", "{}")).toBeNull();
    expect(mergeJson("{}", "not json", "{}")).toBeNull();
  });
});

describe("engine with settings sync", () => {
  const isConfig = makeIsConfigSyncable(".obsidian", DEFAULT_CONFIG_SYNC, SELF);
  const isSyncable = (p: string) => (p.startsWith(".obsidian/") ? isConfig(p) : true);

  test("themes, snippets and hotkeys sync; this plugin's data and workspace do not", async () => {
    const { devices: [a, b] } = await setup(2, { isSyncable });
    a!.write(".obsidian/snippets/wide.css", ".x{max-width:none}");
    a!.write(".obsidian/hotkeys.json", JSON.stringify({ "editor:save": [] }));
    a!.write(".obsidian/workspace.json", "{\"layout\":\"A\"}");
    a!.write(`.obsidian/plugins/${SELF}/data.json`, "{\"token\":\"secret-a\"}");
    a!.write(".obsidian/plugins/dataview/main.js", "console.log(1)");
    await a!.sync();
    await b!.sync();
    expect(b!.read(".obsidian/snippets/wide.css")).toBe(".x{max-width:none}");
    expect(b!.read(".obsidian/hotkeys.json")).toBe(JSON.stringify({ "editor:save": [] }));
    expect(b!.read(".obsidian/plugins/dataview/main.js")).toBe("console.log(1)");
    expect(b!.read(".obsidian/workspace.json")).toBeUndefined();
    expect(b!.read(`.obsidian/plugins/${SELF}/data.json`)).toBeUndefined();
  });
});
