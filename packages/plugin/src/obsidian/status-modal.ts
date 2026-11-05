/**
 * Status panel: state, progress of the current transfer, last sync and the
 * activity log. Opened from the ribbon icon (visible on mobile, where plugin
 * status bar items are not shown) or the "Show sync status" command.
 */
import { type App, Modal, setIcon } from "obsidian";

import { ACTIVITY_LABEL, formatBytes, STATE_ICON, STATE_LABEL, type SyncStatus } from "./status.ts";

const ago = (ms: number) => {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return new Date(ms).toLocaleString();
};

export class StatusModal extends Modal {
  private unsubscribe: (() => void) | undefined;
  private timer: number | undefined;

  constructor(
    app: App,
    private readonly status: SyncStatus,
    private readonly actions: { syncNow: () => void; reconnect: () => void },
  ) {
    super(app);
  }

  override onOpen() {
    this.titleEl.setText("Homebase");
    this.modalEl.addClass("homebase-status-modal");
    this.render();
    this.unsubscribe = this.status.subscribe(() => this.render());
    // Keep "x min ago" fresh.
    this.timer = window.setInterval(() => this.render(), 10_000);
  }

  override onClose() {
    this.unsubscribe?.();
    window.clearInterval(this.timer);
    this.contentEl.empty();
  }

  private render() {
    const { contentEl, status } = this;
    contentEl.empty();

    const head = contentEl.createDiv({ cls: "homebase-status-head" });
    setIcon(head.createSpan({ cls: "homebase-status-icon" }), STATE_ICON[status.state]);
    head.createSpan({ cls: "homebase-status-state", text: STATE_LABEL[status.state] });
    if (status.lastSync) head.createSpan({ cls: "homebase-status-muted", text: `Last synced ${ago(status.lastSync)}` });
    if (status.message) contentEl.createDiv({ cls: "homebase-status-message", text: status.message });

    const p = status.progress;
    if (p && p.total > 0) {
      const box = contentEl.createDiv({ cls: "homebase-progress" });
      box.createDiv({
        cls: "homebase-progress-label",
        text: `${p.phase === "download" ? "Downloading" : "Uploading"} ${p.done} of ${p.total} files` +
          (p.bytesTotal > 0 ? ` · ${formatBytes(p.bytesDone)} of ${formatBytes(p.bytesTotal)}` : ""),
      });
      const bar = box.createEl("progress");
      bar.max = p.bytesTotal > 0 ? p.bytesTotal : p.total;
      bar.value = p.bytesTotal > 0 ? p.bytesDone : p.done;
      if (p.current) box.createDiv({ cls: "homebase-status-muted homebase-ellipsis", text: p.current });
    }

    const buttons = contentEl.createDiv({ cls: "homebase-status-buttons" });
    buttons.createEl("button", { text: "Sync now", cls: "mod-cta" }).onclick = () => this.actions.syncNow();
    buttons.createEl("button", { text: "Reconnect" }).onclick = () => this.actions.reconnect();

    contentEl.createEl("h4", { text: "Activity" });
    if (status.activity.length === 0) {
      contentEl.createDiv({ cls: "homebase-status-muted", text: "Nothing yet in this session." });
      return;
    }
    const list = contentEl.createDiv({ cls: "homebase-activity" });
    for (const item of status.activity.slice(0, 100)) {
      const row = list.createDiv({ cls: `homebase-activity-row homebase-activity-${item.kind}` });
      row.createSpan({ cls: "homebase-activity-time", text: new Date(item.at).toLocaleTimeString() });
      row.createSpan({ cls: "homebase-activity-kind", text: ACTIVITY_LABEL[item.kind] });
      row.createSpan({ cls: "homebase-activity-path homebase-ellipsis", text: item.detail ? `${item.path} (${item.detail})` : item.path });
    }
  }
}
