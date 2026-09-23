import { and, asc, count, desc, eq, gte, lt, max, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { AUDIT_ACTIONS, GENESIS_HASH, verifyAuditChain } from "@/core/audit";
import { schema } from "../../db";
import { recordAudit, rowToEntry } from "../../services/audit";
import { readUsage } from "../../services/usage";
import { globalProcedure, router } from "../init";

export const auditRouter = router({
  list: globalProcedure("audit.view")
    .input(
      z.object({
        cursor: z.number().int().positive().nullish(), // seq to page below
        limit: z.number().int().min(1).max(200).default(50),
        action: z.enum(AUDIT_ACTIONS).optional(),
        actorId: z.string().optional(),
        entityType: z.string().max(60).optional(),
        q: z.string().trim().max(120).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const filters: SQL[] = [];
      if (input.cursor) filters.push(lt(schema.auditLog.seq, input.cursor));
      if (input.action) filters.push(eq(schema.auditLog.action, input.action));
      if (input.actorId) filters.push(eq(schema.auditLog.actorId, input.actorId));
      if (input.entityType) filters.push(eq(schema.auditLog.entityType, input.entityType));
      if (input.q) filters.push(sql`${schema.auditLog.summary} ilike ${"%" + input.q.replace(/[%_\\]/g, "\\$&") + "%"}`);
      const rows = await ctx.db
        .select({
          seq: schema.auditLog.seq,
          occurredAt: schema.auditLog.occurredAt,
          actorName: schema.auditLog.actorName,
          action: schema.auditLog.action,
          entityType: schema.auditLog.entityType,
          summary: schema.auditLog.summary,
          ip: schema.auditLog.ip,
          hash: schema.auditLog.hash,
        })
        .from(schema.auditLog)
        .where(filters.length ? and(...filters) : undefined)
        .orderBy(desc(schema.auditLog.seq))
        .limit(input.limit + 1);
      const hasMore = rows.length > input.limit;
      const items = hasMore ? rows.slice(0, input.limit) : rows;
      return { items, nextCursor: hasMore ? items[items.length - 1]!.seq : null };
    }),

  /** Recompute the whole hash chain. Recorded in the log itself. */
  verify: globalProcedure("audit.view").mutation(async ({ ctx }) => {
    const pageSize = 1000;
    let prev = GENESIS_HASH;
    let seq = 1;
    let checked = 0;
    for (;;) {
      const rows = await ctx.db
        .select()
        .from(schema.auditLog)
        .where(gte(schema.auditLog.seq, seq))
        .orderBy(asc(schema.auditLog.seq))
        .limit(pageSize);
      if (rows.length === 0) break;
      const result = await verifyAuditChain(rows.map(rowToEntry), prev, seq);
      if (!result.ok) {
        return { ok: false as const, checked: checked + result.checked, brokenAtSeq: result.brokenAtSeq, reason: result.reason };
      }
      checked += result.checked;
      prev = result.lastHash;
      seq += rows.length;
      if (rows.length < pageSize) break;
    }
    await recordAudit(ctx.db, {
      actorId: ctx.viewer.id,
      actorName: ctx.viewer.name,
      action: "audit.verify",
      entityType: "audit_log",
      summary: `${ctx.viewer.name} verified the audit log (${checked} entries intact)`,
      ip: ctx.ip,
    });
    return { ok: true as const, checked };
  }),
});

export const systemRouter = router({
  overview: globalProcedure("system.view").query(async ({ ctx }) => {
    const usage = await readUsage(ctx.db);
    const since = new Date(Date.now() - 7 * 86_400_000);

    const jobs = await ctx.db
      .select({
        id: schema.jobRun.id,
        job: schema.jobRun.job,
        status: schema.jobRun.status,
        trigger: schema.jobRun.trigger,
        startedAt: schema.jobRun.startedAt,
        durationSeconds: schema.jobRun.durationSeconds,
        billableMinutes: schema.jobRun.billableMinutes,
        error: schema.jobRun.error,
      })
      .from(schema.jobRun)
      .orderBy(desc(schema.jobRun.startedAt))
      .limit(25);

    const errors = await ctx.db
      .select({
        fingerprint: schema.errorLog.fingerprint,
        message: max(schema.errorLog.message),
        source: max(schema.errorLog.source),
        path: max(schema.errorLog.path),
        count: count(),
        lastAt: max(schema.errorLog.occurredAt),
      })
      .from(schema.errorLog)
      .where(gte(schema.errorLog.occurredAt, since))
      .groupBy(schema.errorLog.fingerprint)
      .orderBy(desc(max(schema.errorLog.occurredAt)))
      .limit(20);

    const outbox = await ctx.db
      .select({ status: schema.emailOutbox.status, n: count() })
      .from(schema.emailOutbox)
      .where(gte(schema.emailOutbox.createdAt, since))
      .groupBy(schema.emailOutbox.status);

    const backups = await ctx.db
      .select()
      .from(schema.backupRecord)
      .orderBy(desc(schema.backupRecord.createdAt))
      .limit(5);

    const heldEmails = await ctx.db
      .select({ id: schema.emailOutbox.id, to: schema.emailOutbox.toAddress, subject: schema.emailOutbox.subject, createdAt: schema.emailOutbox.createdAt, status: schema.emailOutbox.status, error: schema.emailOutbox.error })
      .from(schema.emailOutbox)
      .where(sql`${schema.emailOutbox.status} in ('held','failed')`)
      .orderBy(desc(schema.emailOutbox.createdAt))
      .limit(10);

    return {
      usage,
      jobs,
      errors,
      outbox: Object.fromEntries(outbox.map((o) => [o.status, o.n])) as Partial<Record<"queued" | "sent" | "held" | "failed", number>>,
      heldEmails,
      backups,
      generatedAt: new Date(),
    };
  }),
});
