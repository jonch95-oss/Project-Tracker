"use client";

import { exifTakenAt } from "@/core/exif";
import { FULL_LONG_EDGE, fitLongEdge, MAX_ORIGINAL_PHOTO_BYTES, PHOTO_QUALITY, THUMB_LONG_EDGE, type PhotoContentType } from "@/core/images";

export interface CompressedPhoto {
  full: Blob;
  thumb: Blob;
  width: number;
  height: number;
  contentType: PhotoContentType;
  takenAt: Date | null;
}

export class PhotoError extends Error {}

async function encode(bitmap: ImageBitmap, w: number, h: number, type: PhotoContentType): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext("2d");
  if (!g) throw new PhotoError("This browser can't process photos.");
  g.imageSmoothingQuality = "high";
  g.drawImage(bitmap, 0, 0, w, h);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, PHOTO_QUALITY));
  canvas.width = canvas.height = 0; // free memory on phones
  if (!blob) throw new PhotoError("Couldn't compress this photo.");
  return blob;
}

/**
 * Compress on the device before upload (brief §3): long edge 2560px at ~80%,
 * WebP where the browser can encode it, JPEG otherwise (Safari), plus a
 * small copy for cards. EXIF orientation is applied by createImageBitmap.
 */
export async function compressPhoto(file: File): Promise<CompressedPhoto> {
  if (!file.type.startsWith("image/")) throw new PhotoError("That isn't an image.");
  if (file.size > MAX_ORIGINAL_PHOTO_BYTES) throw new PhotoError("That photo is over 60 MB. Pick a smaller one.");
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new PhotoError("This photo format can't be read here. Try a JPEG, PNG or WebP, or take it with the camera.");
  }
  try {
    const full = fitLongEdge(bitmap.width, bitmap.height, FULL_LONG_EDGE);
    const thumb = fitLongEdge(bitmap.width, bitmap.height, THUMB_LONG_EDGE);
    let type: PhotoContentType = "image/webp";
    let fullBlob = await encode(bitmap, full.width, full.height, type);
    if (fullBlob.type !== "image/webp") {
      type = "image/jpeg";
      fullBlob = await encode(bitmap, full.width, full.height, type);
    }
    const thumbBlob = await encode(bitmap, thumb.width, thumb.height, type);
    // Only a real capture time from the camera; the file's modified time is often just the export time.
    const takenAt = file.type === "image/jpeg" ? exifTakenAt(await file.slice(0, 256 * 1024).arrayBuffer()) : null;
    return { full: fullBlob, thumb: thumbBlob, width: full.width, height: full.height, contentType: type, takenAt };
  } finally {
    bitmap.close();
  }
}

/** Upload one object to wherever the server said (Vercel Blob in production, the local stand-in otherwise). */
export async function putObject(mode: "blob" | "local", uploadId: string, pathname: string, body: Blob, contentType: string): Promise<void> {
  if (mode === "blob") {
    const { upload } = await import("@vercel/blob/client");
    await upload(pathname, body, { access: "private", handleUploadUrl: "/api/uploads", clientPayload: uploadId, contentType });
    return;
  }
  const res = await fetch(`/api/uploads/local?upload=${encodeURIComponent(uploadId)}&path=${encodeURIComponent(pathname)}`, {
    method: "PUT",
    headers: { "content-type": contentType },
    body,
  });
  if (!res.ok) throw new PhotoError("The upload was refused. Try again.");
}

export function photoUrl(id: string, size: "thumb" | "full" = "thumb"): string {
  return `/api/media/photos/${id}?size=${size}`;
}

interface PhotoClient {
  photos: {
    beginUpload: { mutate: (i: { projectId: string; contentType: PhotoContentType; fullBytes: number; thumbBytes: number; width: number; height: number; takenAt: Date | null; siteLogId?: string | null; caption?: string | null }) => Promise<{ uploadId: string; mode: "blob" | "local"; objects: { role: string; pathname: string }[] }> };
    completeUpload: { mutate: (i: { projectId: string; uploadId: string }) => Promise<{ id: string }> };
  };
}

/** Compress and upload photos one at a time (camera or library); returns the new photo ids and any per-file errors. */
export async function uploadPhotos(client: PhotoClient, projectId: string, files: File[], extra: { siteLogId?: string | null } = {}, onProgress?: (done: number, total: number) => void): Promise<{ ids: string[]; errors: string[] }> {
  const ids: string[] = [];
  const errors: string[] = [];
  for (const [i, file] of files.entries()) {
    try {
      const c = await compressPhoto(file);
      const begin = await client.photos.beginUpload.mutate({ projectId, contentType: c.contentType, fullBytes: c.full.size, thumbBytes: c.thumb.size, width: c.width, height: c.height, takenAt: c.takenAt, siteLogId: extra.siteLogId ?? null });
      for (const o of begin.objects) await putObject(begin.mode, begin.uploadId, o.pathname, o.role === "full" ? c.full : c.thumb, c.contentType);
      ids.push((await client.photos.completeUpload.mutate({ projectId, uploadId: begin.uploadId })).id);
    } catch (e) {
      errors.push(`${file.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
    onProgress?.(i + 1, files.length);
  }
  return { ids, errors };
}
