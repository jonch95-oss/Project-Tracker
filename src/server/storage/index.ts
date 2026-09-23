import "server-only";
import { memoryStorage } from "./memory";
import type { FileStorage } from "./types";
import { vercelBlobStorage } from "./vercel-blob";

export type { FileStorage, StoredObject } from "./types";

let override: FileStorage | null = null;
// Kept on globalThis so every route bundle in `next dev` shares one in-memory store.
const g = globalThis as unknown as { __pcStorage?: FileStorage };

/** Tests swap in their own storage. */
export function setStorageForTests(s: FileStorage | null) {
  override = s;
}

/** Vercel Blob when BLOB_READ_WRITE_TOKEN is set (added by Vercel when a store is connected); memory otherwise. */
export function storage(): FileStorage {
  if (override) return override;
  if (g.__pcStorage) return g.__pcStorage;
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token && process.env.VERCEL_ENV === "production") {
    // Never fall back to memory in production: files would vanish per instance.
    throw new Error("File storage is not configured: connect the Vercel Blob store (BLOB_READ_WRITE_TOKEN).");
  }
  g.__pcStorage = token ? vercelBlobStorage(token) : memoryStorage();
  return g.__pcStorage;
}
