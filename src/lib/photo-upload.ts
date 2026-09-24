"use client";

import { exifTakenAt } from "@/core/exif";
import { formatDateTimeET } from "@/core/time";
import {
  FULL_LONG_EDGE,
  fitLongEdge,
  MAX_ORIGINAL_PHOTO_BYTES,
  PHOTO_QUALITY,
  THUMB_LONG_EDGE,
  type PhotoContentType,
} from "@/core/images";

export interface CompressedPhoto {
  full: Blob;
  thumb: Blob;
  width: number;
  height: number;
  contentType: PhotoContentType;
  takenAt: Date | null;
}

export class PhotoError extends Error {}

/** Draw a date stamp (and location, when given) in the bottom-right corner, legible on any photo. */
function drawStamp(
  g: CanvasRenderingContext2D,
  w: number,
  h: number,
  text: string,
) {
  const size = Math.max(14, Math.round(Math.max(w, h) * 0.02));
  g.font = `600 ${size}px -apple-system, "Helvetica Neue", Arial, sans-serif`;
  const pad = Math.round(size * 0.5);
  const width = Math.min(w - pad * 2, g.measureText(text).width + pad * 2);
  const boxH = size + pad * 2;
  g.fillStyle = "rgba(20, 19, 17, 0.62)";
  g.fillRect(w - width - pad, h - boxH - pad, width, boxH);
  g.fillStyle = "#ffffff";
  g.textBaseline = "middle";
  g.fillText(text, w - width, h - pad - boxH / 2, width - pad * 2);
}

async function encode(
  bitmap: ImageBitmap,
  w: number,
  h: number,
  type: PhotoContentType,
  stamp?: string | null,
): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext("2d");
  if (!g) throw new PhotoError("This browser can't process photos.");
  g.imageSmoothingQuality = "high";
  g.drawImage(bitmap, 0, 0, w, h);
  if (stamp) drawStamp(g, w, h, stamp);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, type, PHOTO_QUALITY),
  );
  canvas.width = canvas.height = 0; // free memory on phones
  if (!blob) throw new PhotoError("Couldn't compress this photo.");
  return blob;
}

/**
 * Compress on the device before upload (brief §3): long edge 2560px at ~80%,
 * WebP where the browser can encode it, JPEG otherwise (Safari), plus a
 * small copy for cards. EXIF orientation is applied by createImageBitmap.
 */
export interface CaptureOptions {
  /** Taken with the camera just now: stamp it, and use now as the capture time when the photo carries none. */
  camera?: boolean;
  /** Where it was taken, when the person turned location on. */
  location?: PhotoLocation | null;
}

export interface PhotoLocation {
  latitude: number;
  longitude: number;
  accuracyM: number | null;
}

/** "2026-09-24 18-05" in New York time, for naming a photo file. */
export function photoFileTime(at: Date): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}-${p.minute}`;
}

/** The date stamp burned into a camera photo (New York time). Where it was taken is kept with the photo, not printed on it. */
export function stampText(at: Date): string {
  return formatDateTimeET(at);
}

export async function compressPhoto(
  file: File,
  opts: CaptureOptions = {},
): Promise<CompressedPhoto> {
  if (!file.type.startsWith("image/"))
    throw new PhotoError("That isn't an image.");
  if (file.size > MAX_ORIGINAL_PHOTO_BYTES)
    throw new PhotoError("That photo is over 60 MB. Pick a smaller one.");
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new PhotoError(
      "This photo format can't be read here. Try a JPEG, PNG or WebP, or take it with the camera.",
    );
  }
  try {
    const full = fitLongEdge(bitmap.width, bitmap.height, FULL_LONG_EDGE);
    const thumb = fitLongEdge(bitmap.width, bitmap.height, THUMB_LONG_EDGE);
    // Only a real capture time from the camera; the file's modified time is often just the export time.
    const exif =
      file.type === "image/jpeg"
        ? exifTakenAt(await file.slice(0, 256 * 1024).arrayBuffer())
        : null;
    const takenAt = exif ?? (opts.camera ? new Date() : null);
    const stamp = opts.camera
      ? stampText(takenAt ?? new Date())
      : null;
    let type: PhotoContentType = "image/webp";
    let fullBlob = await encode(bitmap, full.width, full.height, type, stamp);
    if (fullBlob.type !== "image/webp") {
      type = "image/jpeg";
      fullBlob = await encode(bitmap, full.width, full.height, type, stamp);
    }
    const thumbBlob = await encode(bitmap, thumb.width, thumb.height, type);
    return {
      full: fullBlob,
      thumb: thumbBlob,
      width: full.width,
      height: full.height,
      contentType: type,
      takenAt,
    };
  } finally {
    bitmap.close();
  }
}

/** Upload one object to wherever the server said (Vercel Blob in production, the local stand-in otherwise). */
export async function putObject(
  mode: "blob" | "local",
  uploadId: string,
  pathname: string,
  body: Blob,
  contentType: string,
): Promise<void> {
  if (mode === "blob") {
    const { upload } = await import("@vercel/blob/client");
    await upload(pathname, body, {
      access: "private",
      handleUploadUrl: "/api/uploads",
      clientPayload: uploadId,
      contentType,
    });
    return;
  }
  const res = await fetch(
    `/api/uploads/local?upload=${encodeURIComponent(uploadId)}&path=${encodeURIComponent(pathname)}`,
    {
      method: "PUT",
      headers: { "content-type": contentType },
      body,
    },
  );
  if (!res.ok) throw new PhotoError("The upload was refused. Try again.");
}

export function photoUrl(id: string, size: "thumb" | "full" = "thumb"): string {
  return `/api/media/photos/${id}?size=${size}`;
}

interface PhotoClient {
  photos: {
    beginUpload: {
      mutate: (i: {
        projectId: string;
        contentType: PhotoContentType;
        fullBytes: number;
        thumbBytes: number;
        width: number;
        height: number;
        takenAt: Date | null;
        siteLogId?: string | null;
        caption?: string | null;
        location?: PhotoLocation | null;
      }) => Promise<{
        uploadId: string;
        mode: "blob" | "local";
        objects: { role: string; pathname: string }[];
      }>;
    };
    completeUpload: {
      mutate: (i: {
        projectId: string;
        uploadId: string;
      }) => Promise<{ id: string }>;
    };
  };
}

/** Compress and upload photos one at a time (camera or library); returns the new photo ids and any per-file errors. */
export async function uploadPhotos(
  client: PhotoClient,
  projectId: string,
  files: File[],
  extra: { siteLogId?: string | null } & CaptureOptions = {},
  onProgress?: (done: number, total: number) => void,
): Promise<{ ids: string[]; errors: string[] }> {
  const ids: string[] = [];
  const errors: string[] = [];
  for (const [i, file] of files.entries()) {
    try {
      const c = await compressPhoto(file, extra);
      const begin = await client.photos.beginUpload.mutate({
        projectId,
        contentType: c.contentType,
        fullBytes: c.full.size,
        thumbBytes: c.thumb.size,
        width: c.width,
        height: c.height,
        takenAt: c.takenAt,
        siteLogId: extra.siteLogId ?? null,
        location: extra.location ?? null,
      });
      for (const o of begin.objects)
        await putObject(
          begin.mode,
          begin.uploadId,
          o.pathname,
          o.role === "full" ? c.full : c.thumb,
          c.contentType,
        );
      ids.push(
        (
          await client.photos.completeUpload.mutate({
            projectId,
            uploadId: begin.uploadId,
          })
        ).id,
      );
    } catch (e) {
      errors.push(
        `${file.name}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    onProgress?.(i + 1, files.length);
  }
  return { ids, errors };
}
