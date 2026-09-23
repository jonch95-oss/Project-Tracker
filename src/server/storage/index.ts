import "server-only";
import { memoryStorage } from "./memory";
import type { FileStorage } from "./types";
import { vercelBlobStorage } from "./vercel-blob";

export type { FileStorage, StoredObject } from "./types";

let override: FileStorage | null = null;
let cached: FileStorage | null = null;

/** Tests swap in their own storage. */
export function setStorageForTests(s: FileStorage | null) {
  override = s;
}

/** Vercel Blob when BLOB_READ_WRITE_TOKEN is set (added by Vercel when a store is connected); memory otherwise. */
export function storage(): FileStorage {
  if (override) return override;
  if (cached) return cached;
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  cached = token ? vercelBlobStorage(token) : memoryStorage();
  return cached;
}
