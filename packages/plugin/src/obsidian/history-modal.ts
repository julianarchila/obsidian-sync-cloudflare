/**
 * Version history and deleted-file recovery UI (M4).
 */
import { type App, Modal, Notice, Setting } from "obsidian";
import type * as Effect from "effect/Effect";

import { deletedFiles, fileHistory, readVersion, restoreDeleted, restoreVersion, type VersionInfo } from "../core/history.ts";
import { diffLines } from "../core/merge.ts";
import type { Remote, VaultIo } from "../core/services.ts";

export type Run = <A, E>(effect: Effect.Effect<A, E, Remote | VaultIo>) => Promise<A>;

const when = (ms: number) => new Date(ms).toLocaleString();
const kb = (bytes: number) => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`);
const strict = new TextDecoder("utf-8", { fatal: true });
const text = (bytes: Uint8Array) => {
  try {
    return strict.decode(bytes);
  } catch {
    return null;
  }
};

export class HistoryModal extends Modal {
  constructor(
    app: App,
    private readonly path: string,
    private readonly run: Run,
    private readonly onRestored: (path: string) => void,
  ) {
    super(app);
  }

  override async onOpen() {
    this.titleEl.setText(`Version history: ${this.path}`);
    const { contentEl } = this;
    contentEl.createEl("p", { text: "Loading…" });
    try {
      const versions = await this.run(fileHistory(this.path));
      contentEl.empty();
      if (versions.length === 0) {
        contentEl.createEl("p", { text: "No history for this file yet." });
        return;
      }
      const list = contentEl.createDiv();
      const preview = contentEl.createDiv({ cls: "homebase-history-preview" });
      const current = versions.find((v) => !v.deleted);
      for (const v of versions) this.row(list, v, current, preview);
    } catch (error) {
      contentEl.empty();
      contentEl.createEl("p", { text: `Could not load history: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  private row(list: HTMLElement, v: VersionInfo, current: VersionInfo | undefined, preview: HTMLElement) {
    const setting = new Setting(list)
      .setName(`v${v.version}${v.deleted ? " · deleted" : ""}${v === current ? " · current" : ""}`)
      .setDesc(`${when(v.createdAt)} · ${v.device}${v.deleted ? "" : ` · ${kb(v.size)}`}`);
    if (v.deleted) return;
    setting.addButton((b) =>
      b.setButtonText(`Show v${v.version}`).onClick(async () => {
        preview.empty();
        const [old, now] = await Promise.all([
          this.run(readVersion(v)),
          current && current !== v ? this.run(readVersion(current)) : Promise.resolve(null),
        ]);
        const oldText = text(old);
        if (oldText === null) {
          preview.setText(`Binary file (${kb(old.byteLength)}).`);
          return;
        }
        const nowText = now ? text(now) : null;
        const diff = nowText === null ? null : diffLines(nowText, oldText);
        if (!diff) {
          preview.setText(oldText);
          return;
        }
        preview.createDiv({ cls: "homebase-history-title", text: `Changes from current to v${v.version}:` });
        for (const line of diff) {
          preview.createDiv({
            cls: line.kind === "add" ? "homebase-diff-add" : line.kind === "del" ? "homebase-diff-del" : "",
            text: `${line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "} ${line.text.replace(/\n$/, "")}`,
          });
        }
      }),
    );
    if (v !== current)
      setting.addButton((b) =>
        b
          .setButtonText(`Restore v${v.version}`)
          .setWarning()
          .onClick(async () => {
            await this.run(restoreVersion(v, this.path));
            this.onRestored(this.path);
            new Notice(`Restored ${this.path} to v${v.version}${v.path !== this.path ? ` (from ${v.path})` : ""}`);
            this.close();
          }),
      );
  }

  override onClose() {
    this.contentEl.empty();
  }
}

export class DeletedFilesModal extends Modal {
  constructor(
    app: App,
    private readonly run: Run,
    private readonly onRestored: (path: string) => void,
  ) {
    super(app);
  }

  override async onOpen() {
    this.titleEl.setText("Recover deleted files");
    const { contentEl } = this;
    contentEl.createEl("p", { text: "Loading…" });
    try {
      const files = await this.run(deletedFiles);
      contentEl.empty();
      if (files.length === 0) contentEl.createEl("p", { text: "No deleted files to recover." });
      for (const file of files)
        new Setting(contentEl)
          .setName(file.path)
          .setDesc(`Deleted ${when(file.deletedAt)} on ${file.device}`)
          .addButton((b) =>
            b.setButtonText(`Restore ${file.path}`).onClick(async () => {
              await this.run(restoreDeleted(file.path));
              this.onRestored(file.path);
              new Notice(`Restored ${file.path}`);
              b.setDisabled(true).setButtonText("Restored");
            }),
          );
    } catch (error) {
      contentEl.empty();
      contentEl.createEl("p", { text: `Could not load deleted files: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  override onClose() {
    this.contentEl.empty();
  }
}
