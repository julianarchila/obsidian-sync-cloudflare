/**
 * Selective sync (M2): which paths this device syncs. Pure, so the same rule
 * applies to uploads and downloads. Excluded files are left untouched locally.
 */

export interface SelectiveSettings {
  /** Vault-relative folders, e.g. "Private" or "Attachments/raw". */
  readonly excludedFolders: ReadonlyArray<string>;
  readonly types: {
    readonly images: boolean;
    readonly audio: boolean;
    readonly video: boolean;
    readonly pdf: boolean;
    /** Anything that is not a note, image, audio, video or PDF. */
    readonly other: boolean;
  };
}

export const DEFAULT_SELECTIVE: SelectiveSettings = {
  excludedFolders: [],
  types: { images: true, audio: true, video: true, pdf: true, other: true },
};

const EXTENSIONS: Record<"notes" | "images" | "audio" | "video" | "pdf", ReadonlyArray<string>> = {
  notes: ["md", "canvas", "base"],
  images: ["png", "jpg", "jpeg", "gif", "bmp", "svg", "webp", "avif", "heic", "tif", "tiff", "ico"],
  audio: ["mp3", "wav", "m4a", "ogg", "flac", "aac", "3gp", "opus"],
  video: ["mp4", "webm", "ogv", "mov", "mkv", "m4v"],
  pdf: ["pdf"],
};

export type Category = keyof typeof EXTENSIONS | "other";

export const categoryOf = (path: string): Category => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  for (const [category, list] of Object.entries(EXTENSIONS)) if (list.includes(ext)) return category as Category;
  return "other";
};

const normalizeFolder = (folder: string) => folder.trim().replace(/^\/+|\/+$/g, "");

export const makeIsSyncable = (settings: SelectiveSettings, alwaysExcluded: ReadonlyArray<string> = []) => {
  const folders = [...settings.excludedFolders, ...alwaysExcluded].map(normalizeFolder).filter(Boolean);
  return (path: string) => {
    if (folders.some((folder) => path === folder || path.startsWith(`${folder}/`))) return false;
    const category = categoryOf(path);
    return category === "notes" || settings.types[category];
  };
};

/** Stable fingerprint: when it changes, the device must re-read the whole index. */
export const selectiveFingerprint = (settings: SelectiveSettings) =>
  JSON.stringify({
    f: [...settings.excludedFolders].map(normalizeFolder).filter(Boolean).sort(),
    t: settings.types,
  });
