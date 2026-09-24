import "server-only";
import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { FREE_TIER_LIMITS, uploadAllowed } from "@/core/freeTier";
import { db, schema, type Database, type DbOrTx } from "../db";
import { storage } from "../storage";
import { logError } from "./errors";
import { bumpCounter } from "./usage";

/** How long a client has to finish an authorized upload (small files). */
export const UPLOAD_WINDOW_MS = 15 * 60 * 1000;
/** Big files get longer: 15 minutes plus the time at a slow 1 Mbps uplink, up to 2 hours. */
export function uploadWindowMs(totalBytes: number): number {
  return Math.min(2 * 3_600_000, UPLOAD_WINDOW_MS + Math.ceil((totalBytes * 8) / 1_000_000) * 1000);
}

export type UploadObject = { role: string; pathname: string; maxBytes: number; contentType: string };
export type PendingUpload = typeof schema.pendingUpload.$inferSelect;

/** Bytes currently stored in Blob by this app: files we metered plus the backups the workflow reported. */
export async function blobStoredBytes(conn: Database = db()): Promise<number> {
  const [files] = await conn
    .select({ value: schema.usageCounter.value })
    .from(schema.usageCounter)
    .where(and(eq(schema.usageCounter.key, "blob.storage"), eq(schema.usageCounter.periodKey, "total")));
  const [backups] = await conn.execute<{ total: string | null }>(
    sql`select sum(size_bytes)::text as total from (select size_bytes from backup_record where kind = 'nightly' order by created_at desc limit 30) b`,
  ).then((r) => r.rows);
  return Number(files?.value ?? 0) + Number(backups?.total ?? 0);
}

/** Bytes authorized for uploads still in progress (they may land any moment). */
export async function reservedUploadBytes(conn: Database = db(), now = new Date()): Promise<number> {
  const [r] = await conn.execute<{ total: string | null }>(sql`
    select sum((o->>'maxBytes')::bigint)::text as total
    from pending_upload, jsonb_array_elements(objects) o
    where completed_at is null and expires_at > ${now}`).then((x) => x.rows);
  return Number(r?.total ?? 0);
}

/** Refuse uploads that would take Blob past 95% of the app's budget, counting uploads still in flight. */
export async function assertUploadBudget(totalBytes: number, conn: Database = db()): Promise<void> {
  const stored = (await blobStoredBytes(conn)) + (await reservedUploadBytes(conn));
  if (!uploadAllowed(stored, totalBytes)) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `File storage is nearly full (95% of the ${Math.round(FREE_TIER_LIMITS["blob.storage"].limit / 1024 ** 3)} GB budget). Remove old files or ask the owner to raise the budget.`,
    });
  }
}

export function objectPath(projectId: string, kind: "photos", ext: string, suffix = ""): string {
  return `projects/${projectId}/${kind}/${randomUUID()}${suffix}.${ext}`;
}

/** Files keep their (cleaned) name as the last path part, so downloads save under a sensible name. */
export function filePath(projectId: string, safeName: string): { dir: string; object: string } {
  const dir = `projects/${projectId}/files/${randomUUID()}`;
  return { dir, object: `${dir}/${safeName}` };
}

export async function createPendingUpload(
  conn: Database,
  input: { userId: string; projectId: string | null; purpose: "photo" | "file" | "directory"; objects: UploadObject[]; meta?: unknown },
  now = new Date(),
): Promise<PendingUpload> {
  const [row] = await conn
    .insert(schema.pendingUpload)
    .values({ ...input, meta: input.meta ?? null, expiresAt: new Date(now.getTime() + uploadWindowMs(input.objects.reduce((s, o) => s + o.maxBytes, 0))) })
    .returning();
  return row!;
}

/**
 * Look up an authorized upload for this user, still open. Used both when the
 * storage provider asks for a client token and when the client says it is done.
 */
export async function openUpload(conn: Database, uploadId: string, userId: string, now = new Date()): Promise<PendingUpload | null> {
  if (!/^[0-9a-f-]{36}$/i.test(uploadId)) return null;
  const [row] = await conn.select().from(schema.pendingUpload).where(eq(schema.pendingUpload.id, uploadId));
  if (!row || row.userId !== userId || row.completedAt || row.expiresAt <= now) return null;
  return row;
}

/**
 * Check every object the client was allowed to write actually exists, fits
 * its size limit and has the right type. Never trust the client's word.
 */
export async function verifyUploadedObjects(row: PendingUpload): Promise<Record<string, { pathname: string; size: number; contentType: string }>> {
  const out: Record<string, { pathname: string; size: number; contentType: string }> = {};
  for (const o of row.objects) {
    const h = await storage().head(o.pathname);
    if (!h) throw new TRPCError({ code: "BAD_REQUEST", message: "The upload didn't finish. Try again." });
    const type = h.contentType.split(";")[0]!.trim();
    if (h.size > o.maxBytes || h.size === 0 || type !== o.contentType) {
      await storage().delete(row.objects.map((x) => x.pathname));
      throw new TRPCError({ code: "BAD_REQUEST", message: "The uploaded file didn't match what was expected, so it was discarded." });
    }
    out[o.role] = { pathname: o.pathname, size: h.size, contentType: type };
  }
  return out;
}

/**
 * Atomically claim an open upload for completion (inside the caller's
 * transaction). Only one caller can win, so a double-submit can never record
 * the same files twice, and the hourly cleanup (which only looks at
 * unclaimed, expired rows) can't delete files being recorded.
 */
export async function claimUpload(tx: DbOrTx, id: string, userId: string, now = new Date()): Promise<boolean> {
  const rows = await tx
    .update(schema.pendingUpload)
    .set({ completedAt: now })
    .where(and(eq(schema.pendingUpload.id, id), eq(schema.pendingUpload.userId, userId), isNull(schema.pendingUpload.completedAt), gt(schema.pendingUpload.expiresAt, now)))
    .returning({ id: schema.pendingUpload.id });
  return rows.length === 1;
}

export async function meterStored(bytes: number): Promise<void> {
  if (bytes > 0) await bumpCounter("blob.storage", bytes);
}

/**
 * Remove stored objects and give their bytes back to the meter. The meter
 * goes down first (the rows are already gone); a storage failure is logged
 * with the keys so they can be removed by hand rather than lost silently.
 */
export async function deleteStoredObjects(pathnames: string[], bytes: number): Promise<void> {
  if (bytes > 0) await bumpCounter("blob.storage", -bytes);
  try {
    await storage().delete(pathnames);
  } catch (e) {
    await logError("job", e, { path: "storage.delete", context: { pathnames } });
  }
}

/**
 * Hourly: uploads that were authorized but never completed may have left
 * objects behind. Delete whatever exists and drop the rows. Completed rows are
 * kept a week for troubleshooting, then dropped.
 */
export async function cleanupAbandonedUploads(conn: Database = db(), now = new Date()): Promise<{ abandoned: number; objectsRemoved: number }> {
  const stale = await conn
    .select()
    .from(schema.pendingUpload)
    .where(and(isNull(schema.pendingUpload.completedAt), lt(schema.pendingUpload.expiresAt, now)))
    .limit(200);
  let objectsRemoved = 0;
  for (const row of stale) {
    const present: string[] = [];
    for (const o of row.objects) if (await storage().head(o.pathname)) present.push(o.pathname);
    if (present.length) await storage().delete(present);
    objectsRemoved += present.length;
    await conn.delete(schema.pendingUpload).where(eq(schema.pendingUpload.id, row.id));
  }
  await conn
    .delete(schema.pendingUpload)
    .where(and(sql`${schema.pendingUpload.completedAt} is not null`, lt(schema.pendingUpload.completedAt, new Date(now.getTime() - 7 * 86_400_000))));
  return { abandoned: stale.length, objectsRemoved };
}
