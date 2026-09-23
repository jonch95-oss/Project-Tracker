import type { FileStorage, StoredObject } from "./types";

/** In-memory storage for tests and for local development without a Blob token. */
export function memoryStorage(): FileStorage {
  const objects = new Map<string, { bytes: Uint8Array; meta: StoredObject }>();
  const toBytes = async (body: Blob | ArrayBuffer | Uint8Array | string): Promise<Uint8Array> => {
    if (typeof body === "string") return new TextEncoder().encode(body);
    if (body instanceof Uint8Array) return body;
    if (body instanceof ArrayBuffer) return new Uint8Array(body);
    return new Uint8Array(await body.arrayBuffer());
  };
  return {
    name: "memory",
    async put(pathname, body, opts) {
      const bytes = await toBytes(body);
      const meta: StoredObject = { pathname, size: bytes.byteLength, uploadedAt: new Date(), contentType: opts?.contentType ?? "application/octet-stream" };
      objects.set(pathname, { bytes, meta });
      return meta;
    },
    async get(pathname) {
      const o = objects.get(pathname);
      if (!o) return null;
      return {
        body: new Blob([o.bytes as BlobPart]).stream(),
        size: o.meta.size,
        contentType: o.meta.contentType ?? "application/octet-stream",
      };
    },
    async delete(pathnames) {
      for (const p of pathnames) objects.delete(p);
    },
    async list(prefix) {
      return [...objects.values()].filter((o) => o.meta.pathname.startsWith(prefix)).map((o) => o.meta);
    },
  };
}
