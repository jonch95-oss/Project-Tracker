import "server-only";
import { desc, sql } from "drizzle-orm";
import {
  GENESIS_HASH,
  computeAuditHash,
  scrubAuditData,
  type AuditAction,
  type AuditEntryContent,
} from "@/core/audit";
import { schema, type DbOrTx, type Tx } from "../db";

/** Arbitrary constant identifying the audit-chain advisory lock. */
const AUDIT_LOCK_ID = 7_310_204_551;

export interface AuditInput {
  actorId: string | null;
  actorName?: string | null;
  action: AuditAction;
  entityType: string;
  entityId?: string | null;
  projectId?: string | null;
  summary: string;
  data?: unknown;
  ip?: string | null;
}

function isTx(conn: DbOrTx): conn is Tx {
  return typeof (conn as Tx).rollback === "function";
}

/**
 * Append an entry to the hash-chained audit log. Call it inside the same
 * transaction as the change it records so both commit or neither does.
 */
export async function recordAudit(conn: DbOrTx, input: AuditInput): Promise<void> {
  const write = async (tx: Tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${AUDIT_LOCK_ID})`);
    const [last] = await tx
      .select({ seq: schema.auditLog.seq, hash: schema.auditLog.hash })
      .from(schema.auditLog)
      .orderBy(desc(schema.auditLog.seq))
      .limit(1);
    const prevHash = last?.hash ?? GENESIS_HASH;
    const occurredAt = new Date();
    const content: AuditEntryContent = {
      seq: (last?.seq ?? 0) + 1,
      occurredAt: occurredAt.toISOString(),
      actorId: input.actorId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      projectId: input.projectId ?? null,
      summary: input.summary,
      data: input.data === undefined ? null : scrubAuditData(input.data),
      ip: input.ip ?? null,
    };
    const hash = await computeAuditHash(prevHash, content);
    await tx.insert(schema.auditLog).values({
      seq: content.seq,
      occurredAt,
      actorId: content.actorId,
      actorName: input.actorName ?? null,
      action: content.action,
      entityType: content.entityType,
      entityId: content.entityId,
      projectId: content.projectId,
      summary: content.summary,
      data: content.data,
      ip: content.ip,
      prevHash,
      hash,
    });
  };
  if (isTx(conn)) await write(conn);
  else await conn.transaction(write);
}

type AuditRow = typeof schema.auditLog.$inferSelect;

export function rowToEntry(row: AuditRow) {
  return {
    seq: row.seq,
    occurredAt: row.occurredAt.toISOString(),
    actorId: row.actorId,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    projectId: row.projectId,
    summary: row.summary,
    data: row.data ?? null,
    ip: row.ip,
    prevHash: row.prevHash,
    hash: row.hash,
  };
}
