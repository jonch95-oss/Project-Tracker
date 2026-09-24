"use client";

import { useMutation } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { fitLongEdge } from "@/core/images";
import { MAX_FILE_BYTES, MAX_THUMB_BYTES, MULTIPART_FROM_BYTES, normalizeContentType, previewKind, THUMB_LONG_EDGE, WARN_FILE_BYTES, formatFileSize } from "@/core/files";
import { errorMessage, useTRPC } from "./trpc";

export class UploadError extends Error {}

/** A small thumbnail for image files, made on the device. Null when the browser can't read the image. */
async function makeThumb(file: File): Promise<{ blob: Blob; contentType: "image/webp" | "image/jpeg" } | null> {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const { width, height } = fitLongEdge(bitmap.width, bitmap.height, THUMB_LONG_EDGE);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    for (const type of ["image/webp", "image/jpeg"] as const) {
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, type, 0.8));
      if (blob && blob.type === type && blob.size <= MAX_THUMB_BYTES) {
        canvas.width = canvas.height = 0;
        return { blob, contentType: type };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Write one object to storage (Vercel Blob in production, the local stand-in otherwise), reporting progress 0–1. */
async function putObject(mode: "blob" | "local", uploadId: string, pathname: string, body: Blob, contentType: string, onProgress: (p: number) => void) {
  if (mode === "blob") {
    const { upload } = await import("@vercel/blob/client");
    await upload(pathname, body, {
      access: "private",
      handleUploadUrl: "/api/uploads",
      clientPayload: uploadId,
      contentType,
      multipart: body.size >= MULTIPART_FROM_BYTES,
      onUploadProgress: (e) => onProgress(e.percentage / 100),
    });
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", `/api/uploads/local?upload=${encodeURIComponent(uploadId)}&path=${encodeURIComponent(pathname)}`);
    xhr.setRequestHeader("content-type", contentType);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new UploadError("The upload was refused. Try again.")));
    xhr.onerror = () => reject(new UploadError("The connection dropped. Try again."));
    xhr.send(body);
  });
}

export interface UploadItem {
  key: string;
  name: string;
  size: number;
  progress: number;
  state: "uploading" | "done" | "error";
  error?: string;
}

/** Files over the warning size that the person has to confirm first (brief §13). */
export function largeFiles(files: File[]): File[] {
  return files.filter((f) => f.size > WARN_FILE_BYTES);
}

export function tooLarge(files: File[]): File[] {
  return files.filter((f) => f.size > MAX_FILE_BYTES);
}

export const sizeLimitMessage = (f: File) => `${f.name} is ${formatFileSize(f.size)}; the limit is ${formatFileSize(MAX_FILE_BYTES)}.`;

/**
 * Upload files into a folder (or as a new version of a file, or attached to a
 * task): authorize → upload straight to storage → confirm. One at a time, so
 * a phone on a slow connection isn't swamped.
 */
export function useFileUpload(projectId: string) {
  const trpc = useTRPC();
  const [items, setItems] = useState<UploadItem[]>([]);
  const begin = useMutation(trpc.files.beginUpload.mutationOptions());
  const complete = useMutation(trpc.files.completeUpload.mutationOptions());
  const patch = (key: string, p: Partial<UploadItem>) => setItems((cur) => cur.map((i) => (i.key === key ? { ...i, ...p } : i)));

  const upload = useCallback(
    async (files: File[], target: { folderId?: string; fileId?: string; taskId?: string; note?: string }): Promise<{ ok: number; failed: number; lastFileId: string | null }> => {
      const queued = files.map((f) => ({ file: f, key: `${f.name}-${f.size}-${Math.random().toString(36).slice(2, 7)}` }));
      setItems((cur) => [...cur.filter((i) => i.state === "uploading"), ...queued.map((q) => ({ key: q.key, name: q.file.name, size: q.file.size, progress: 0, state: "uploading" as const }))]);
      let ok = 0;
      let lastFileId: string | null = null;
      for (const { file, key } of queued) {
        try {
          if (file.size > MAX_FILE_BYTES) throw new UploadError(sizeLimitMessage(file));
          if (file.size === 0) throw new UploadError(`${file.name} is empty.`);
          const contentType = normalizeContentType(file.type);
          const thumb = previewKind(contentType) === "image" ? await makeThumb(file) : null;
          const b = await begin.mutateAsync({
            projectId,
            ...target,
            name: file.name,
            contentType,
            sizeBytes: file.size,
            ...(thumb ? { thumb: { bytes: thumb.blob.size, contentType: thumb.contentType } } : {}),
          });
          for (const o of b.objects) {
            const body = o.role === "thumb" ? thumb!.blob : file;
            await putObject(b.mode, b.uploadId, o.pathname, body, o.contentType, (p) => o.role === "file" && patch(key, { progress: p }));
          }
          const r = await complete.mutateAsync({ projectId, uploadId: b.uploadId });
          lastFileId = r.fileId;
          patch(key, { progress: 1, state: "done" });
          ok++;
        } catch (e) {
          patch(key, { state: "error", error: e instanceof UploadError ? e.message : errorMessage(e) });
        }
      }
      return { ok, failed: queued.length - ok, lastFileId };
    },
    [begin, complete, projectId],
  );

  const busy = items.some((i) => i.state === "uploading");
  useEffect(() => {
    if (!busy) return;
    // Leaving the page mid-upload would lose it: ask first.
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy]);

  const clear = useCallback(() => setItems((cur) => cur.filter((i) => i.state === "uploading")), []);
  return { upload, items, clear, busy };
}

export function fileUrl(versionId: string, opts: { thumb?: boolean } = {}): string {
  return `/api/media/files/${versionId}${opts.thumb ? "?thumb=1" : ""}`;
}
