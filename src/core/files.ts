/**
 * File rules (brief §13, §14): sizes, previews, folder visibility, names.
 * Pure.
 */

export const MB = 1024 * 1024;
/** Largest single file (brief §13). */
export const MAX_FILE_BYTES = 500 * MB;
/** Above this the uploader is warned first: storage is a shared 10 GB budget. */
export const WARN_FILE_BYTES = 100 * MB;
/** Uploads above this go up in parallel parts with retries. */
export const MULTIPART_FROM_BYTES = 8 * MB;
/** Image thumbnails made on the device. */
export const THUMB_LONG_EDGE = 480;
export const MAX_THUMB_BYTES = 512 * 1024;
/** Days a removed file stays in the trash before its bytes are deleted. */
export const TRASH_DAYS = 30;
/** Signed download links expire quickly (brief §13: short-lived). */
export const DOWNLOAD_URL_TTL_MS = 5 * 60 * 1000;

export type PreviewKind = "image" | "pdf" | "none";

const IMAGE_PREVIEW = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"]);

export function previewKind(contentType: string): PreviewKind {
  const t = contentType.split(";")[0]!.trim().toLowerCase();
  if (IMAGE_PREVIEW.has(t)) return "image";
  if (t === "application/pdf") return "pdf";
  return "none";
}

/** A content type we can safely record: the browser's, or a generic one. */
export function normalizeContentType(type: string | null | undefined): string {
  const t = (type ?? "").split(";")[0]!.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/.test(t) ? t : "application/octet-stream";
}

/** The type a file is stored under: images and PDFs keep theirs (they preview); anything else is a plain download. */
export function storedContentType(type: string): string {
  return previewKind(type) === "none" ? "application/octet-stream" : type;
}

/** A display name: trimmed, no path parts or control characters, at most 200 characters. */
export function cleanDisplayName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  return base.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 200) || "Untitled";
}

export function fileExtension(name: string): string {
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(name);
  return m ? m[1]!.toLowerCase() : "";
}

export interface FolderLike {
  gated: boolean;
}

export interface FolderViewer {
  /** Internal team (sees every folder that isn't gated). */
  seesAll: boolean;
  /** Financial visibility on this project. */
  financials: boolean;
  /** Is this folder shared with them? (outside collaborators) */
  shared: boolean;
}

/**
 * Who sees a folder: the gated Financial folder only with financial
 * visibility; otherwise the internal team, or outsiders it's shared with.
 */
export function canSeeFolder(f: FolderLike, v: FolderViewer): boolean {
  if (f.gated && !v.financials) return false;
  return v.seesAll || v.shared;
}

export const DEFAULT_GATED_FOLDER = "Financial";
export const PHOTOS_FOLDER = "Photos";

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MB) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * MB) return `${(bytes / MB).toFixed(bytes < 10 * MB ? 1 : 0)} MB`;
  return `${(bytes / (1024 * MB)).toFixed(2)} GB`;
}
