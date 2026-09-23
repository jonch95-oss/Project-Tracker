/**
 * File storage port. Production uses Vercel Blob (private access); tests and
 * local development use the in-memory / local-disk mock. Nothing outside
 * src/server/storage imports a provider SDK.
 */
export interface StoredObject {
  pathname: string;
  size: number;
  uploadedAt: Date;
  contentType?: string;
}

export interface FileStorage {
  readonly name: "vercel-blob" | "memory";
  put(pathname: string, body: Blob | ArrayBuffer | Uint8Array | string, opts?: { contentType?: string }): Promise<StoredObject>;
  /** Stream an object's bytes; null when it does not exist. */
  get(pathname: string): Promise<{ body: ReadableStream<Uint8Array>; size: number; contentType: string } | null>;
  /** Size and type of a stored object; null when it does not exist. */
  head(pathname: string): Promise<{ size: number; contentType: string } | null>;
  delete(pathnames: string[]): Promise<void>;
  /** List objects under a prefix (all pages). */
  list(prefix: string): Promise<StoredObject[]>;
}
