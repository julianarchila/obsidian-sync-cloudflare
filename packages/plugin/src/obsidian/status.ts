/**
 * Observable sync status: what the ribbon icon, the status bar and the status
 * panel render. The client and the engine callbacks write to it.
 */
import type { Activity, Progress } from "../core/engine.ts";

export type SyncState = "not-configured" | "unlocking" | "locked" | "connecting" | "syncing" | "synced" | "offline";

const MAX_ACTIVITY = 200;

export class SyncStatus {
  state: SyncState = "not-configured";
  /** Extra context for the state (lock reason, last error). */
  message = "";
  progress: Progress | null = null;
  lastSync: number | undefined;
  activity: Activity[] = [];
  private listeners = new Set<() => void>();

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private emit() {
    for (const listener of this.listeners) listener();
  }

  setState(state: SyncState, message = "") {
    this.state = state;
    this.message = message;
    if (state === "synced") this.lastSync = Date.now();
    this.emit();
  }

  setProgress(progress: Progress | null) {
    this.progress = progress;
    this.emit();
  }

  add(activity: Activity) {
    this.activity.unshift(activity);
    if (this.activity.length > MAX_ACTIVITY) this.activity.length = MAX_ACTIVITY;
    this.emit();
  }
}

export const STATE_LABEL: Record<SyncState, string> = {
  "not-configured": "Not configured",
  unlocking: "Unlocking…",
  locked: "Locked",
  connecting: "Connecting…",
  syncing: "Syncing…",
  synced: "Synced",
  offline: "Offline",
};

/** Lucide icon names shipped with Obsidian. */
export const STATE_ICON: Record<SyncState, string> = {
  "not-configured": "cloud-cog",
  unlocking: "key-round",
  locked: "lock",
  connecting: "loader",
  syncing: "refresh-cw",
  synced: "cloud",
  offline: "cloud-off",
};

export const formatBytes = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;

/** "↓ 12/327 · 4.0/345.6 MB" */
export const formatProgress = (p: Progress) =>
  `${p.phase === "download" ? "↓" : "↑"} ${p.done}/${p.total}` +
  (p.bytesTotal > 0 ? ` · ${formatBytes(p.bytesDone)} / ${formatBytes(p.bytesTotal)}` : "");

export const ACTIVITY_LABEL: Record<Activity["kind"], string> = {
  downloaded: "Downloaded",
  uploaded: "Uploaded",
  "deleted-here": "Deleted (from another device)",
  "deleted-remote": "Deleted",
  renamed: "Renamed",
  merged: "Merged edits",
  conflict: "Conflict, kept both",
  restored: "Restored",
};
