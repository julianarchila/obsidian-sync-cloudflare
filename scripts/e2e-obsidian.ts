/**
 * End-to-end test in the real Obsidian app, driven by agent-desktop.
 *
 * Two disposable vaults (~/ObsidianTest/vault-a, vault-b) sync through the
 * deployed server under a fresh vault id. Files are changed on disk; Obsidian's
 * watcher feeds the plugin. The user's obsidian.json is backed up and restored.
 *
 *   OSCF_URL / OSCF_TOKEN from .env (or `doppler run --`):  bun run e2e
 *   Extra scenarios per milestone live in SCENARIOS below.
 */
import { $ } from "bun";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const CONFIG = join(HOME, "Library/Application Support/obsidian/obsidian.json");
const BACKUP = join(tmpdir(), `obsidian.json.e2e-backup-${Date.now()}`);
const ROOT = join(HOME, "ObsidianTest");
const VAULTS = { a: join(ROOT, "vault-a"), b: join(ROOT, "vault-b") } as const;
const IDS = { a: "e2e0000000000a01", b: "e2e0000000000b01" } as const;
const vaultId = `e2e-${Date.now()}`;
const serverUrl = process.env.OSCF_URL!;
const token = process.env.OSCF_TOKEN!;
const extraSettings = JSON.parse(process.env.E2E_SETTINGS ?? "{}") as Record<string, unknown>;

if (!serverUrl || !token) throw new Error("OSCF_URL and OSCF_TOKEN are required (set them in .env)");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push([name, ok, detail]);
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` (${detail})` : ""}`);
};

const file = (v: keyof typeof VAULTS, path: string) => join(VAULTS[v], path);
const read = async (v: keyof typeof VAULTS, path: string) =>
  existsSync(file(v, path)) ? await readFile(file(v, path), "utf8") : undefined;
const write = async (v: keyof typeof VAULTS, path: string, text: string | Uint8Array) => {
  await mkdir(join(file(v, path), ".."), { recursive: true });
  await writeFile(file(v, path), text);
};

export const waitFor = async (predicate: () => Promise<boolean> | boolean, timeoutMs = 45_000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await sleep(500);
  }
  return false;
};

/** Visible files (no .obsidian), sorted, with contents. */
const snapshot = async (v: keyof typeof VAULTS) => {
  const out: Record<string, string> = {};
  const walk = async (dir: string, prefix = "") => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(join(dir, entry.name), rel);
      else out[rel] = await readFile(join(dir, entry.name), "base64");
    }
  };
  await walk(VAULTS[v]);
  return JSON.stringify(Object.fromEntries(Object.entries(out).sort()));
};
const converged = async () => (await snapshot("a")) === (await snapshot("b"));

// ---------------------------------------------------------------- Obsidian control

const running = async () => (await $`pgrep -x Obsidian`.quiet().nothrow()).exitCode === 0;

/** Dismiss native alerts (e.g. "Vault not found") so they never block the run. */
const dismissAlerts = async () => {
  const snap = await $`agent-desktop snapshot --app Obsidian --surface alert -i --compact`.quiet().nothrow().text();
  const ref = /"name":"OK"[^}]*"ref_id":"([^"]+)"/.exec(snap)?.[1] ?? /"ref_id":"([^"]+)"[^}]*"name":"OK"/.exec(snap)?.[1];
  if (ref) await $`agent-desktop click ${ref}`.quiet().nothrow();
};

/** Quit for real: a pending alert can make a graceful quit silently time out. */
const closeObsidian = async () => {
  if (!(await running())) return;
  await dismissAlerts();
  await $`agent-desktop close-app Obsidian`.quiet().nothrow();
  if (await waitFor(async () => !(await running()), 15_000)) return;
  await $`pkill -TERM -x Obsidian`.quiet().nothrow();
  if (await waitFor(async () => !(await running()), 10_000)) return;
  await $`pkill -KILL -x Obsidian`.quiet().nothrow();
  await waitFor(async () => !(await running()), 10_000);
};

const freezeObsidian = async (frozen: boolean) => {
  await $`pkill ${frozen ? "-STOP" : "-CONT"} -f /Applications/Obsidian.app/`.quiet().nothrow();
};

const launchObsidian = async () => {
  await $`agent-desktop launch Obsidian --activate`.quiet().nothrow();
  await waitFor(async () => {
    const out = await $`agent-desktop list-windows --app Obsidian`.quiet().nothrow().text();
    return out.includes("vault-a") && out.includes("vault-b");
  }, 30_000);
  // First open of a vault with plugins asks for trust.
  await sleep(2000);
  const windows = JSON.parse(await $`agent-desktop list-windows --app Obsidian`.quiet().nothrow().text()).data ?? [];
  for (const w of windows as Array<{ id: string }>) {
    const snap = await $`agent-desktop snapshot --app Obsidian --window-id ${w.id} -i --compact`.quiet().nothrow().text();
    const ref = /"name":"Trust author and enable plugins"[^}]*"ref_id":"([^"]+)"/.exec(snap)?.[1]
      ?? /"ref_id":"([^"]+)"[^}]*"name":"Trust author and enable plugins"/.exec(snap)?.[1];
    if (ref) await $`agent-desktop click ${ref}`.quiet().nothrow();
  }
  // Let the plugin unlock and register its handlers before anything is sent to it.
  await sleep(8000);
  await dismissAlerts();
};

const registerVaults = async () => {
  const config = JSON.parse(await readFile(CONFIG, "utf8"));
  for (const id of Object.keys(config.vaults)) config.vaults[id].open = false;
  config.vaults[IDS.a] = { path: VAULTS.a, ts: Date.now(), open: true };
  config.vaults[IDS.b] = { path: VAULTS.b, ts: Date.now(), open: true };
  await writeFile(CONFIG, JSON.stringify(config));
};

const prepareVault = async (v: keyof typeof VAULTS) => {
  const dir = VAULTS[v];
  await mkdir(dir, { recursive: true });
  for (const entry of await readdir(dir)) if (entry !== ".obsidian") await rm(join(dir, entry), { recursive: true });
  const pluginDir = join(dir, ".obsidian/plugins/homebase");
  await rm(pluginDir, { recursive: true, force: true });
  await mkdir(pluginDir, { recursive: true });
  await cp("packages/plugin/dist/main.js", join(pluginDir, "main.js"));
  await cp("manifest.json", join(pluginDir, "manifest.json"));
  await cp("packages/plugin/styles.css", join(pluginDir, "styles.css"));
  await writeFile(join(dir, ".obsidian/community-plugins.json"), JSON.stringify(["homebase"]));
  await writeFile(
    join(pluginDir, "data.json"),
    JSON.stringify({ settings: { serverUrl, vaultId, token, device: `device-${v}`, password: "e2e-password", ...extraSettings } }),
  );
};

/** Patch a test vault's plugin settings on disk (Obsidian must be closed). */
const patchSettings = async (v: keyof typeof VAULTS, patch: Record<string, unknown>) => {
  const path = join(VAULTS[v], ".obsidian/plugins/homebase/data.json");
  const data = JSON.parse(await readFile(path, "utf8"));
  data.settings = { ...data.settings, ...patch };
  await writeFile(path, JSON.stringify(data));
};

// ---------------------------------------------------------------- scenarios

type Scenario = { name: string; run: () => Promise<boolean | [boolean, string]> };

const SCENARIOS: Scenario[] = [
  {
    name: "note created in A appears in B",
    run: async () => {
      await write("a", "hello.md", "# Hello\n\nfrom A\n");
      return waitFor(async () => (await read("b", "hello.md")) === "# Hello\n\nfrom A\n");
    },
  },
  {
    name: "edit in B reaches A",
    run: async () => {
      await write("b", "hello.md", "# Hello\n\nfrom A\n\nedited in B\n");
      return waitFor(async () => (await read("a", "hello.md"))?.includes("edited in B") ?? false);
    },
  },
  {
    name: "nested folder and binary file",
    run: async () => {
      const png = new Uint8Array(300_000).map((_, i) => (i * 13) % 256);
      await write("a", "projects/2026/plan.md", "plan");
      await write("a", "attachments/image.bin", png);
      return waitFor(async () => existsSync(file("b", "attachments/image.bin")) && (await read("b", "projects/2026/plan.md")) === "plan");
    },
  },
  {
    name: "rename in A moves the file in B",
    run: async () => {
      await $`mv ${file("a", "projects/2026/plan.md")} ${file("a", "projects/2026/plan-final.md")}`.quiet();
      return waitFor(async () => (await read("b", "projects/2026/plan-final.md")) === "plan" && !existsSync(file("b", "projects/2026/plan.md")));
    },
  },
  {
    name: "delete in B removes it from A",
    run: async () => {
      await rm(file("b", "attachments/image.bin"));
      return waitFor(() => !existsSync(file("a", "attachments/image.bin")));
    },
  },
  {
    name: "simultaneous edits converge without data loss",
    run: async () => {
      await write("a", "race.md", "base\n");
      await waitFor(async () => (await read("b", "race.md")) === "base\n");
      await Promise.all([write("a", "race.md", "from A\n"), write("b", "race.md", "from B\n")]);
      const ok = await waitFor(converged, 60_000);
      const all = (await snapshot("a")) + "";
      const keptBoth = all.includes(Buffer.from("from A\n").toString("base64")) && all.includes(Buffer.from("from B\n").toString("base64"));
      return [ok && keptBoth, ok ? "" : "did not converge"];
    },
  },
  {
    name: "offline: edits while Obsidian is closed converge on reopen",
    run: async () => {
      await closeObsidian();
      await write("a", "offline-a.md", "written while closed (A)");
      await write("b", "offline-b.md", "written while closed (B)");
      await write("b", "hello.md", "# Hello\n\nchanged offline in B\n");
      await rm(file("a", "projects/2026/plan-final.md"));
      await launchObsidian();
      const ok = await waitFor(
        async () =>
          (await converged()) &&
          (await read("a", "offline-b.md")) === "written while closed (B)" &&
          (await read("b", "offline-a.md")) === "written while closed (A)" &&
          (await read("a", "hello.md"))?.includes("changed offline in B") === true &&
          !existsSync(file("b", "projects/2026/plan-final.md")),
        60_000,
      );
      return ok;
    },
  },
];

const paras = (...p: string[]) => `${p.join("\n\n")}\n`;
SCENARIOS.push(
  {
    name: "markdown merge: simultaneous edits to different paragraphs merge without a copy",
    run: async () => {
      await write("a", "merge.md", paras("# Merge", "alpha", "beta", "gamma"));
      await waitFor(async () => (await read("b", "merge.md")) === paras("# Merge", "alpha", "beta", "gamma"));
      await Promise.all([
        write("a", "merge.md", paras("# Merge", "alpha edited by A", "beta", "gamma")),
        write("b", "merge.md", paras("# Merge", "alpha", "beta", "gamma edited by B")),
      ]);
      const expected = paras("# Merge", "alpha edited by A", "beta", "gamma edited by B");
      const ok = await waitFor(async () => (await read("a", "merge.md")) === expected && (await read("b", "merge.md")) === expected, 60_000);
      const copies = (await readdir(VAULTS.a)).filter((f) => f.startsWith("merge (conflict"));
      return [ok && copies.length === 0, `a=${JSON.stringify(await read("a", "merge.md"))} copies=${copies.length}`];
    },
  },
  {
    name: "markdown merge: offline edits on both sides merge on reopen",
    run: async () => {
      await closeObsidian();
      await write("a", "merge.md", paras("# Merge", "alpha edited by A, offline too", "beta", "gamma edited by B"));
      await write("b", "merge.md", paras("# Merge", "alpha edited by A", "beta edited offline by B", "gamma edited by B"));
      await launchObsidian();
      const expected = paras("# Merge", "alpha edited by A, offline too", "beta edited offline by B", "gamma edited by B");
      const ok = await waitFor(async () => (await read("a", "merge.md")) === expected && (await read("b", "merge.md")) === expected, 60_000);
      return [ok, `a=${JSON.stringify(await read("a", "merge.md"))}`];
    },
  },
);

/** Open a plugin URI in a vault and click the button named `label` in the modal it shows. */
const clickInModal = async (vault: "vault-a" | "vault-b", query: string, label: string) => {
  await $`open ${`obsidian://homebase?vault=${vault}&${query}`}`.quiet();
  return waitFor(async () => {
    await dismissAlerts();
    const windows = JSON.parse(await $`agent-desktop list-windows --app Obsidian`.quiet().nothrow().text()).data ?? [];
    const win = (windows as Array<{ id: string; title: string }>).find((w) => w.title.includes(vault));
    if (!win) return false;
    const snap = await $`agent-desktop snapshot --app Obsidian --window-id ${win.id} -i --compact`.quiet().nothrow().text();
    const esc = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const ref = new RegExp(`"name":"${esc}"[^}]*"ref_id":"([^"]+)"`).exec(snap)?.[1] ?? new RegExp(`"ref_id":"([^"]+)"[^}]*"name":"${esc}"`).exec(snap)?.[1];
    if (!ref) return false;
    await $`agent-desktop click ${ref}`.quiet().nothrow();
    return true;
  }, 30_000);
};

SCENARIOS.push(
  {
    name: "version history: a file edited three times is restored to v1 from B's history UI",
    run: async () => {
      for (const v of ["v1", "v2", "v3"]) {
        await write("a", "hist.md", `history ${v}\n`);
        if (!(await waitFor(async () => (await read("b", "hist.md")) === `history ${v}\n`))) return [false, `B never got ${v}`];
      }
      const clicked = await clickInModal("vault-b", "do=history&file=hist.md", "Restore v1");
      const restored = await waitFor(async () => (await read("a", "hist.md")) === "history v1\n" && (await read("b", "hist.md")) === "history v1\n");
      return [clicked && restored, `clicked=${clicked} restored=${restored}`];
    },
  },
  {
    name: "recovery: a file deleted in A is recovered from B's deleted-files UI",
    run: async () => {
      await write("a", "precious.md", "do not lose me\n");
      await waitFor(async () => (await read("b", "precious.md")) === "do not lose me\n");
      await rm(file("a", "precious.md"));
      await waitFor(() => !existsSync(file("b", "precious.md")));
      const clicked = await clickInModal("vault-b", "do=deleted", "Restore precious.md");
      const back = await waitFor(async () => (await read("a", "precious.md")) === "do not lose me\n");
      return [clicked && back, `clicked=${clicked} back=${back}`];
    },
  },
);

SCENARIOS.push({
  name: "status panel: shows state, progress-free idle and the activity log",
  run: async () => {
    await write("a", "status-check.md", "for the activity log\n");
    await waitFor(async () => (await read("b", "status-check.md")) === "for the activity log\n");
    await $`open ${"obsidian://homebase?vault=vault-b&do=status"}`.quiet();
    let names = "";
    const ok = await waitFor(async () => {
      const windows = JSON.parse(await $`agent-desktop list-windows --app Obsidian`.quiet().nothrow().text()).data ?? [];
      const win = (windows as Array<{ id: string; title: string }>).find((w) => w.title.includes("vault-b"));
      if (!win) return false;
      names = await $`agent-desktop snapshot --app Obsidian --window-id ${win.id} --compact`.quiet().nothrow().text();
      return names.includes("Activity") && names.includes("Synced") && names.includes("status-check.md") && names.includes("Sync now");
    }, 30_000);
    await $`agent-desktop press escape --app Obsidian`.quiet().nothrow();
    return [ok, ok ? "" : "panel not found or incomplete"];
  },
});

SCENARIOS.push({
  name: "settings sync: snippet, theme, hotkeys and app.json keys reach B; plugin data and workspace stay local",
  run: async () => {
    const cfg = (v: keyof typeof VAULTS, p: string) => join(VAULTS[v], ".obsidian", p);
    const readJson = async (path: string) => (existsSync(path) ? JSON.parse(await readFile(path, "utf8")) : undefined);
    const workspaceB = await readFile(cfg("b", "workspace.json"), "utf8").catch(() => "");
    await mkdir(cfg("a", "snippets"), { recursive: true });
    await mkdir(cfg("a", "themes/E2E Theme"), { recursive: true });
    await writeFile(cfg("a", "snippets/e2e.css"), ".e2e { color: hotpink; }\n");
    await writeFile(cfg("a", "themes/E2E Theme/theme.css"), "body { --e2e: 1; }\n");
    await writeFile(cfg("a", "themes/E2E Theme/manifest.json"), JSON.stringify({ name: "E2E Theme", version: "1.0.0" }));
    await writeFile(cfg("a", "hotkeys.json"), JSON.stringify({ "editor:toggle-bold": [{ modifiers: ["Mod"], key: "B" }] }));
    const files = await waitFor(
      () =>
        existsSync(cfg("b", "snippets/e2e.css")) &&
        existsSync(cfg("b", "themes/E2E Theme/theme.css")) &&
        existsSync(cfg("b", "hotkeys.json")),
      90_000,
    );

    // Concurrent edits to different keys of app.json merge by key.
    const appA = (await readJson(cfg("a", "app.json"))) ?? {};
    const appB = (await readJson(cfg("b", "app.json"))) ?? {};
    await Promise.all([
      writeFile(cfg("a", "app.json"), JSON.stringify({ ...appA, e2eFromA: true }, null, 2)),
      writeFile(cfg("b", "app.json"), JSON.stringify({ ...appB, e2eFromB: true }, null, 2)),
    ]);
    const merged = await waitFor(async () => {
      const [a, b] = [await readJson(cfg("a", "app.json")), await readJson(cfg("b", "app.json"))];
      return a?.e2eFromA && a?.e2eFromB && b?.e2eFromA && b?.e2eFromB;
    }, 120_000);

    const dataB = await readJson(cfg("b", "plugins/homebase/data.json"));
    const pluginLocal = dataB?.settings?.device === "device-b";
    const workspaceLocal = (await readFile(cfg("b", "workspace.json"), "utf8").catch(() => "")) === workspaceB || !workspaceB;
    return [files && merged && pluginLocal, `files=${files} merged=${!!merged} pluginLocal=${pluginLocal} workspaceUntouched=${workspaceLocal}`];
  },
});

SCENARIOS.push({
  name: "selective sync: excluded folder and type never reach B, then sync when re-included",
  run: async () => {
    await closeObsidian();
    await patchSettings("b", {
      selective: { excludedFolders: ["private"], types: { images: true, audio: true, video: false, pdf: true, other: true } },
    });
    await launchObsidian();
    await write("a", "private/secret.md", "not for B");
    await write("a", "media/clip.mp4", "fake video");
    await write("a", "public-m2.md", "for everyone");
    const publicArrived = await waitFor(async () => (await read("b", "public-m2.md")) === "for everyone");
    await sleep(8000);
    const leaked = existsSync(file("b", "private/secret.md")) || existsSync(file("b", "media/clip.mp4"));

    await closeObsidian();
    await patchSettings("b", { selective: { excludedFolders: [], types: { images: true, audio: true, video: true, pdf: true, other: true } } });
    await launchObsidian();
    const reincluded = await waitFor(
      async () => (await read("b", "private/secret.md")) === "not for B" && (await read("b", "media/clip.mp4")) === "fake video",
    );
    return [publicArrived && !leaked && reincluded, `public=${publicArrived} leaked=${leaked} reincluded=${reincluded}`];
  },
});

SCENARIOS.push({
  name: "E2EE: the server only stores opaque data",
  run: async () => {
    const headers = { authorization: `Bearer ${token}` };
    const raw = await (await fetch(new URL(`/v1/vaults/${vaultId}/changes?since=0`, serverUrl), { headers })).text();
    const entries = (JSON.parse(raw) as { entries: Array<{ chunks: string[] }> }).entries;
    const blobs = await Promise.all(
      entries.flatMap((e) => e.chunks).slice(0, 5).map(async (h) =>
        new TextDecoder().decode(await (await fetch(new URL(`/v1/vaults/${vaultId}/blobs/${h}`, serverUrl), { headers })).arrayBuffer()),
      ),
    );
    const leaks = /hello|plan|offline|race/i.test(raw) || blobs.some((b) => /Hello|from A|plan/.test(b));
    return [entries.length > 0 && !leaks, `${entries.length} entries checked`];
  },
});

SCENARIOS.push({
  name: "sleep: after Obsidian was frozen like a sleeping Mac, B's change reaches A on its own",
  run: async () => {
    // SIGSTOP freezes every Obsidian process the way sleep does: no timers, no socket reads.
    await freezeObsidian(true);
    try {
      await sleep(70_000);
      await write("b", "after-sleep.md", "written while asleep");
    } finally {
      await freezeObsidian(false);
    }
    return waitFor(async () => (await read("a", "after-sleep.md")) === "written while asleep", 60_000);
  },
});

// Milestone-specific scenarios register here via E2E_EXTRA (module path exporting `scenarios`).
if (process.env.E2E_EXTRA) {
  const extra = (await import(join(process.cwd(), process.env.E2E_EXTRA))) as {
    scenarios: (h: { read: typeof read; write: typeof write; file: typeof file; waitFor: typeof waitFor; converged: typeof converged }) => Scenario[];
  };
  SCENARIOS.push(...extra.scenarios({ read, write, file, waitFor, converged }));
}

// ---------------------------------------------------------------- run

await $`node esbuild.config.mjs`.cwd("packages/plugin").quiet();
await closeObsidian();
await cp(CONFIG, BACKUP);
try {
  await prepareVault("a");
  await prepareVault("b");
  await registerVaults();
  await launchObsidian();
  for (const scenario of SCENARIOS) {
    try {
      const outcome = await scenario.run();
      const [ok, detail] = Array.isArray(outcome) ? outcome : [outcome, ""];
      check(scenario.name, ok, detail);
    } catch (error) {
      check(scenario.name, false, error instanceof Error ? error.message : String(error));
    }
  }
} finally {
  await freezeObsidian(false);
  await closeObsidian();
  await cp(BACKUP, CONFIG);
  await rm(BACKUP);
}

const failed = results.filter(([, ok]) => !ok).length;
console.log(failed === 0 ? `E2E OK (${results.length} scenarios, vault ${vaultId})` : `E2E FAILED: ${failed}/${results.length}`);
process.exit(failed === 0 ? 0 : 1);
