/**
 * Photo sizing rules. Photos are compressed on the device before upload
 * (brief §3): long edge 2560px for the full image, plus a small copy for cards
 * and thumbnails so browsing the portfolio doesn't spend the Blob transfer budget.
 */
export const FULL_LONG_EDGE = 2560;
export const THUMB_LONG_EDGE = 960;
export const PHOTO_QUALITY = 0.8;
/** Largest original photo accepted before compression (phones can produce ~50 MB HEIC/RAW). */
export const MAX_ORIGINAL_PHOTO_BYTES = 60 * 1024 * 1024;
/** Upper bound on a compressed upload; a 2560px WebP at 80% is normally 0.5–2 MB. */
export const MAX_COMPRESSED_PHOTO_BYTES = 12 * 1024 * 1024;

export const PHOTO_CONTENT_TYPES = ["image/webp", "image/jpeg"] as const;
export type PhotoContentType = (typeof PHOTO_CONTENT_TYPES)[number];

/** Target size for a long edge, never upscaling. */
export function fitLongEdge(width: number, height: number, longEdge: number): { width: number; height: number } {
  if (width <= 0 || height <= 0) throw new Error("Image has no size");
  const scale = Math.min(1, longEdge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** A safe object-name segment from a user file name (keeps the extension readable). */
export function safeFileName(name: string, fallback = "file"): string {
  const cleaned = name
    .normalize("NFKD")
    .replace(/[^\w.\- ]+/g, "")
    .replace(/\s+/g, "-")
    .replace(/^[.\-]+/, "")
    .slice(0, 100);
  return cleaned || fallback;
}
