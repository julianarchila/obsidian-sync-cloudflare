import { type App, Notice, Platform, Plugin, PluginSettingTab, Setting, setIcon, type TAbstractFile, TFile } from "obsidian";
import * as Effect from "effect/Effect";

import { type ConfigSyncSettings, DEFAULT_CONFIG_SYNC, makeIsConfigSyncable, mergeConfig } from "./core/config.ts";
import { DEFAULT_SELECTIVE, makeIsSyncable, type SelectiveSettings, selectiveFingerprint } from "./core/filter.ts";
import { makeHttpRemote } from "./core/http-remote.ts";
import { mergeText } from "./core/merge.ts";
import { openPlainVault } from "./core/plain-vault.ts";
import { combinedVaultIo, obsidianConfigIo, obsidianHttp, obsidianLocalState, obsidianVaultIo } from "./obsidian/adapters.ts";
import { DeletedFilesModal, HistoryModal } from "./obsidian/history-modal.ts";
import { formatBytes, formatProgress, STATE_ICON, STATE_LABEL, type SyncState, SyncStatus } from "./obsidian/status.ts";
import { StatusModal } from "./obsidian/status-modal.ts";
import { SyncClient } from "./obsidian/sync-client.ts";

interface Settings {
  serverUrl: string;
  vaultId: string;
  token: string;
  device: string;
  selective: SelectiveSettings;
  /** Which parts of the config dir (.obsidian) this device syncs. */
  configSync: ConfigSyncSettings;
}

interface Data {
  settings: Settings;
  /** Selective-sync fingerprint of the last run; a change triggers a full index re-read. */
  selectiveFingerprint?: string;
}

const DEFAULTS: Settings = {
  serverUrl: "",
  vaultId: "",
  token: "",
  device: Platform.isMobile ? "mobile" : "desktop",
  selective: DEFAULT_SELECTIVE,
  configSync: DEFAULT_CONFIG_SYNC,
};

const CONFIG_POLL_MS = 30_000;
const OPEN_RETRY_MIN_MS = 5_000;
const OPEN_RETRY_MAX_MS = 60_000;

export default class CloudflareSyncPlugin extends Plugin {
  data: Data = { settings: { ...DEFAULTS } };
  openError = "";
  private client: SyncClient | undefined;
  readonly sync = new SyncStatus();
  private statusBar!: HTMLElement;
  private ribbon!: HTMLElement;
  private reloadNotice: number | undefined;
  /** A long transfer in progress (announced with a notice when it starts and ends). */
  private bigTransfer = false;
  /** Server unreachable while opening the vault (e.g. opened before the network was up): retry. */
  private openRetry: number | undefined;
  private openBackoff = OPEN_RETRY_MIN_MS;

  get conf() {
    return this.data.settings;
  }

  override async onload() {
    const stored = (await this.loadData()) as Partial<Data> | null;
    const settings: Partial<Settings> = stored?.settings ?? {};
    this.data = {
      settings: {
        ...DEFAULTS,
        ...settings,
        selective: {
          excludedFolders: settings.selective?.excludedFolders ?? [],
          types: { ...DEFAULT_SELECTIVE.types, ...settings.selective?.types },
        },
        configSync: { ...DEFAULT_CONFIG_SYNC, ...settings.configSync },
      },
      selectiveFingerprint: stored?.selectiveFingerprint,
    };

    // Status: ribbon icon (also on mobile, where plugin status bar items are hidden) + desktop status bar.
    this.statusBar = this.addStatusBarItem();
    this.statusBar.addClass("mod-clickable");
    this.statusBar.onclick = () => this.openStatus();
    this.ribbon = this.addRibbonIcon(STATE_ICON["not-configured"], "Homebase", () => this.openStatus());
    this.register(this.sync.subscribe(() => this.renderStatus()));
    this.renderStatus();
    this.addCommand({ id: "show-status", name: "Show sync status", callback: () => this.openStatus() });
    this.addSettingTab(new SettingsTab(this.app, this));
    this.addCommand({ id: "full-sync", name: "Sync now", callback: () => void this.client?.fullSync() });
    this.addCommand({ id: "reconnect", name: "Reconnect", callback: () => void this.restart() });

    // ---- version history and recovery (M4)
    this.addCommand({
      id: "file-history",
      name: "Show version history of current file",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !this.client) return false;
        if (!checking) this.openHistory(file.path);
        return true;
      },
    });
    this.addCommand({ id: "deleted-files", name: "Recover deleted files", callback: () => this.openDeleted() });
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFile) || !this.client) return;
        menu.addItem((item) => item.setTitle("Version history").setIcon("history").onClick(() => this.openHistory(file.path)));
      }),
    );
    // obsidian://homebase?vault=<name>&do=history&file=Note.md  |  do=deleted  |  do=sync  |  do=status
    // `action` is always the protocol name (hence `do`), and Obsidian treats a `path`
    // parameter as an absolute filesystem path to pick the vault (hence `file`).
    this.registerObsidianProtocolHandler("homebase", (params) => {
      if (params.do === "history" && params.file) this.openHistory(params.file);
      if (params.do === "deleted") this.openDeleted();
      if (params.do === "sync") void this.client?.fullSync();
      if (params.do === "status") this.openStatus();
    });

    // Register vault listeners only after startup, otherwise `create` fires for every file.
    this.app.workspace.onLayoutReady(() => {
      const dirty = (file: TAbstractFile) => this.client?.markDirty(file.path);
      this.registerEvent(this.app.vault.on("create", dirty));
      this.registerEvent(this.app.vault.on("modify", dirty));
      this.registerEvent(this.app.vault.on("delete", dirty));
      this.registerEvent(this.app.vault.on("rename", (file, old) => this.client?.markDirty(file.path, old)));
      // The config dir has no vault events: poll it (stat-only unless something changed).
      this.registerInterval(window.setInterval(() => void this.pollConfig(), CONFIG_POLL_MS));
      this.registerDomEvent(window, "online", () => {
        if (this.openRetry !== undefined) void this.restart();
      });
      void this.restart();
    });
  }

  override onunload() {
    this.client?.stop();
  }

  private async pollConfig() {
    const client = this.client;
    if (!client?.engine) return;
    const configDir = this.app.vault.configDir;
    const adapter = this.app.vault.adapter;
    const listAll = async (dir: string): Promise<string[]> => {
      if (!(await adapter.exists(dir))) return [];
      const { files, folders } = await adapter.list(dir);
      return [...files, ...(await Promise.all(folders.map(listAll))).flat()];
    };
    const known = Object.keys(client.engine.state.base).filter((p) => p.startsWith(`${configDir}/`));
    // Stat-only comparison against the last sync: no hashing and no network unless something changed.
    const changed = await Effect.runPromise(client.engine.changedLocally([...(await listAll(configDir)), ...known]));
    if (changed.length > 0) client.markDirty(...changed);
  }

  /** Settings written by another device apply after a reload. */
  private settingsChangedRemotely() {
    window.clearTimeout(this.reloadNotice);
    this.reloadNotice = window.setTimeout(
      () => new Notice("Homebase: settings were updated from another device. Reload Obsidian to apply them.", 10_000),
      3000,
    );
  }

  private runner() {
    const client = this.client;
    if (!client) {
      new Notice("Homebase is not connected.");
      return null;
    }
    return <A, E>(effect: Parameters<typeof client.withServices<A, E>>[0]) => client.withServices(effect);
  }

  openHistory(path: string) {
    const run = this.runner();
    if (run) new HistoryModal(this.app, path, run, (p) => this.client?.markDirty(p)).open();
  }

  openDeleted() {
    const run = this.runner();
    if (run) new DeletedFilesModal(this.app, run, (p) => this.client?.markDirty(p)).open();
  }

  setState(state: SyncState, message = "") {
    this.sync.setState(state, message);
  }

  openStatus() {
    new StatusModal(this.app, this.sync, {
      syncNow: () => void this.client?.fullSync(),
      reconnect: () => void this.restart(),
    }).open();
  }

  private renderStatus() {
    const { state, progress } = this.sync;
    const label = progress && progress.total > 0 ? formatProgress(progress) : STATE_LABEL[state];
    this.statusBar.setText(`☁ ${label}`);
    setIcon(this.ribbon, progress ? "refresh-cw" : STATE_ICON[state]);
    this.ribbon.setAttribute("aria-label", `Homebase: ${label}`);
  }

  /** Announce long transfers so a first sync on a phone is never silent. */
  private onProgress(progress: import("./core/engine.ts").Progress | null) {
    if (progress && !this.bigTransfer && (progress.total >= 20 || progress.bytesTotal >= 5 * 1024 * 1024)) {
      this.bigTransfer = true;
      const verb = progress.phase === "download" ? "Downloading" : "Uploading";
      new Notice(`Homebase: ${verb} ${progress.total} files (${formatBytes(progress.bytesTotal)}). Tap the cloud icon to follow progress.`, 8000);
    }
    if (!progress && this.bigTransfer) {
      this.bigTransfer = false;
      new Notice("Homebase: sync complete.", 5000);
    }
    this.sync.setProgress(progress);
  }

  get stateFile() {
    return `${this.manifest.dir}/state-${this.conf.vaultId}.json`;
  }

  async saveSettings() {
    await this.saveData(this.data);
  }

  async restart() {
    window.clearTimeout(this.openRetry);
    this.openRetry = undefined;
    this.client?.stop();
    this.client = undefined;
    const { serverUrl, vaultId, token, device } = this.conf;
    if (!serverUrl || !vaultId || !token) return this.setState("not-configured");

    // ---- open the vault (created as plain on first use)
    this.setState("opening");
    const remote = makeHttpRemote({ serverUrl, vaultId, token, http: obsidianHttp });
    const opened = await Effect.runPromise(openPlainVault(remote).pipe(Effect.result));
    if (opened._tag === "Failure") {
      const error = opened.failure;
      this.openError = error._tag === "RemoteError" ? `Server unreachable: ${error.message}` : error.message;
      this.setState(error._tag === "RemoteError" ? "offline" : "error", this.openError);
      if (error._tag !== "RemoteError") new Notice(`Homebase: ${this.openError}`);
      else {
        // Retry with backoff; coming back online retries right away.
        this.openRetry = window.setTimeout(() => void this.restart(), this.openBackoff);
        this.openBackoff = Math.min(this.openBackoff * 2, OPEN_RETRY_MAX_MS);
      }
      return;
    }
    this.openBackoff = OPEN_RETRY_MIN_MS;
    this.openError = "";
    if (opened.success.created) new Notice("Homebase: new vault created.");

    // ---- start syncing
    const pluginDir = this.manifest.dir ?? "";
    const configDir = this.app.vault.configDir;
    const fingerprint = `${selectiveFingerprint(this.conf.selective)}|${JSON.stringify(this.conf.configSync)}`;
    const resetCursor = this.data.selectiveFingerprint !== undefined && this.data.selectiveFingerprint !== fingerprint;
    this.data.selectiveFingerprint = fingerprint;
    await this.saveData(this.data);
    this.client = new SyncClient({
      serverUrl,
      vaultId,
      token,
      vaultIo: combinedVaultIo(obsidianVaultIo(this.app), obsidianConfigIo(this.app, configDir), configDir),
      localState: obsidianLocalState(this.app, this.stateFile),
      resetCursor,
      engine: {
        device,
        // Notes: selective sync. Config dir: per-category settings sync, never this plugin's
        // own files (token, sync state) nor per-device workspace layouts.
        isSyncable: (() => {
          const notes = makeIsSyncable(this.conf.selective, [pluginDir]);
          const config = makeIsConfigSyncable(configDir, this.conf.configSync, this.manifest.id);
          return (path: string) => (path.startsWith(`${configDir}/`) ? config(path) : notes(path));
        })(),
        // Config JSON merges by key; Markdown gets a three-way merge; the rest keeps both copies.
        merge: (input) => mergeConfig(configDir)(input) ?? mergeText(input),
        onProgress: (progress) => this.onProgress(progress),
        onActivity: (activity) => this.sync.add(activity),
        onLocalWrite: (path) => {
          if (path.startsWith(`${configDir}/`)) this.settingsChangedRemotely();
        },
        log: (message) => {
          console.log(`[homebase] ${message}`);
          if (message.startsWith("conflict") || message.startsWith("merged")) new Notice(`Homebase: ${message}`);
        },
      },
      onStatus: (status) => this.setState(status as SyncState),
      onReport: (report) => {
        if (report.skipped === 0) return;
        const text =
          `${report.skipped} file${report.skipped === 1 ? "" : "s"} couldn't be saved on this device ` +
          `(usually a name with \\ / : * ? < > " that this system doesn't allow). ` +
          "Rename them on another device to sync them here. See Activity.";
        this.sync.setWarning(text);
        new Notice(`Homebase: ${text}`, 10_000);
      },
      onError: (message) => this.setState("offline", message),
    });
    await this.client.start();
  }
}

class SettingsTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: CloudflareSyncPlugin,
  ) {
    super(app, plugin);
  }

  display() {
    const { containerEl } = this;
    const settings = this.plugin.conf;
    containerEl.empty();

    const text = (name: string, desc: string, key: "serverUrl" | "vaultId" | "token" | "device", secret = false) =>
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addText((input) => {
          if (secret) input.inputEl.type = "password";
          input.setValue(settings[key]).onChange((value) => {
            settings[key] = value.trim();
          });
        });

    text("Server URL", "The URL printed by `bun run deploy`.", "serverUrl");
    text("Vault id", "Lowercase letters, numbers, - and _. Use the same id on every device.", "vaultId");
    text("Token", "The OSCF_TOKEN you deployed with.", "token", true);
    text("Device name", "Shown in conflict file names.", "device");

    if (this.plugin.openError) containerEl.createEl("p", { text: this.plugin.openError, cls: "mod-warning" });

    new Setting(containerEl).setHeading().setName("Selective sync");
    new Setting(containerEl)
      .setName("Excluded folders")
      .setDesc("One folder per line. Excluded files are neither uploaded nor downloaded, and are left untouched here.")
      .addTextArea((area) => {
        area.inputEl.rows = 4;
        area.setPlaceholder("Private\nAttachments/raw");
        area.setValue(settings.selective.excludedFolders.join("\n")).onChange((value) => {
          settings.selective = {
            ...settings.selective,
            excludedFolders: value.split("\n").map((l) => l.trim()).filter(Boolean),
          };
        });
      });
    const typeToggle = (key: keyof SelectiveSettings["types"], name: string) =>
      new Setting(containerEl).setName(name).addToggle((toggle) =>
        toggle.setValue(settings.selective.types[key]).onChange((value) => {
          settings.selective = { ...settings.selective, types: { ...settings.selective.types, [key]: value } };
        }),
      );
    typeToggle("images", "Sync images");
    typeToggle("audio", "Sync audio");
    typeToggle("video", "Sync videos");
    typeToggle("pdf", "Sync PDFs");
    typeToggle("other", "Sync other file types");

    new Setting(containerEl).setHeading().setName("Settings sync");
    containerEl.createEl("p", {
      text: "Sync parts of your Obsidian configuration. This plugin's own data and workspace layouts never sync. Changes from other devices apply after reloading Obsidian.",
      cls: "setting-item-description",
    });
    const configToggle = (key: keyof ConfigSyncSettings, name: string) =>
      new Setting(containerEl).setName(name).addToggle((toggle) =>
        toggle.setValue(settings.configSync[key]).onChange((value) => {
          settings.configSync = { ...settings.configSync, [key]: value };
        }),
      );
    configToggle("main", "Main settings");
    configToggle("appearance", "Appearance");
    configToggle("themes", "Themes and CSS snippets");
    configToggle("communityPluginList", "Enabled community plugins list");
    configToggle("plugins", "Installed community plugins (code and settings)");
    configToggle("hotkeys", "Hotkeys");

    new Setting(containerEl).addButton((button) =>
      button
        .setButtonText("Save & connect")
        .setCta()
        .onClick(async () => {
          await this.plugin.saveSettings();
          await this.plugin.restart();
          this.display();
        }),
    );
  }
}
