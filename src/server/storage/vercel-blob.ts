import { BlobNotFoundError, del, get, head, list, put } from "@vercel/blob";
import type { FileStorage, StoredObject } from "./types";

/**
 * Vercel Blob adapter. Every object is private: reads go through the server
 * (or short-lived signed URLs), never public URLs.
 */
export function vercelBlobStorage(token: string): FileStorage {
  return {
    name: "vercel-blob",
    async put(pathname, body, opts) {
      const r = await put(pathname, body as Blob, {
        access: "private",
        token,
        contentType: opts?.contentType,
        addRandomSuffix: false,
        allowOverwrite: false,
      });
      return { pathname: r.pathname, size: byteLength(body), uploadedAt: new Date(), contentType: r.contentType };
    },
    async get(pathname) {
      const r = await get(pathname, { access: "private", token });
      if (!r || r.statusCode !== 200) return null;
      return { body: r.stream, size: r.blob.size, contentType: r.blob.contentType };
    },
    async head(pathname) {
      try {
        const r = await head(pathname, { token });
        return { size: r.size, contentType: r.contentType };
      } catch (e) {
        if (e instanceof BlobNotFoundError) return null;
        throw e;
      }
    },
    async delete(pathnames) {
      if (pathnames.length) await del(pathnames, { token });
    },
    async list(prefix) {
      const out: StoredObject[] = [];
      let cursor: string | undefined;
      do {
        const page = await list({ prefix, cursor, limit: 1000, token });
        for (const b of page.blobs) out.push({ pathname: b.pathname, size: b.size, uploadedAt: new Date(b.uploadedAt) });
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor);
      return out;
    },
  };
}

function byteLength(body: Blob | ArrayBuffer | Uint8Array | string): number {
  if (typeof body === "string") return new TextEncoder().encode(body).byteLength;
  if (body instanceof Blob) return body.size;
  return body.byteLength;
}
