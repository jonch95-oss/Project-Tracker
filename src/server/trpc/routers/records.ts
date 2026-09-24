import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, gte, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { EXPIRY_CATEGORIES, expiryLabel, FINANCIAL_EXPIRY, vendorKey } from "@/core/expiries";
import { CLOSED_STAGES, parseBbl, SOURCES, VIOLATION_STAGES } from "@/core/records";
import { addDays, todayET } from "@/core/time";
import { schema, type DbOrTx } from "../../db";
import { recordAudit } from "../../services/audit";
import { expiredCoiFlags } from "../../services/expiries";
import { syncProjectRecords } from "../../services/records";
import { projectProcedure, router, type ProjectAccess } from "../init";

/** Public records, violations and expiries are the internal team's work (outsiders see what's shared with them only). */
function assertInternal(access: ProjectAccess) {
  if (!access.can("task.viewAll")) throw new TRPCError({ code: "FORBIDDEN", message: "Public records are for the project team." });
}

const SYNC_COOLDOWN_MS = 10 * 60_000;

export const recordsRouter = router({
  /** The Public Records tab: sync health with "data as of", alerts, and the records by kind with source links. */
  overview: projectProcedure().query(async ({ ctx, input }) => {
    assertInternal(ctx.project);
    const [p] = await ctx.db.select({ bbl: schema.project.bbl, address: schema.project.address }).from(schema.project).where(eq(schema.project.id, input.projectId));
    const lot = parseBbl(p?.bbl);
    const [syncs, items, alerts, cases] = await Promise.all([
      ctx.db.select().from(schema.recordSync).where(eq(schema.recordSync.projectId, input.projectId)),
      ctx.db.select().from(schema.recordItem).where(eq(schema.recordItem.projectId, input.projectId)).orderBy(desc(schema.recordItem.date)),
      ctx.db
        .select()
        .from(schema.recordAlert)
        .where(and(eq(schema.recordAlert.projectId, input.projectId), or(isNull(schema.recordAlert.dismissedAt), gte(schema.recordAlert.createdAt, sql`now() - interval '30 days'`))))
        .orderBy(desc(schema.recordAlert.critical), desc(schema.recordAlert.createdAt))
        .limit(100),
      ctx.db.select().from(schema.violationCase).where(eq(schema.violationCase.projectId, input.projectId)).orderBy(desc(schema.violationCase.issuedOn)),
    ]);
    const run = syncs.find((s) => s.source === "_run") ?? null;
    const byKind = (...kinds: string[]) => items.filter((i) => kinds.includes(i.kind));
    const canViewFinancials = ctx.project.can("financials.view");
    return {
      lot: lot ? { bbl: lot.bbl, boro: lot.boro, block: lot.block, lot: lot.lot } : null,
      lastRun: run ? { at: run.lastRunAt, ok: run.failures === 0, lastSuccessAt: run.lastSuccessAt } : null,
      sources: SOURCES.filter((d) => d.key !== "acris_legals").map((d) => {
        const s = syncs.find((x) => x.source === d.key);
        return { key: d.key, label: d.label, dataset: d.dataset, lastSuccessAt: s?.lastSuccessAt ?? null, dataAsOf: s?.dataAsOf ?? null, error: s?.failures ? s.error : null, rows: s?.rows ?? 0 };
      }),
      alerts: alerts.map((a) => ({ id: a.id, title: a.title, url: a.url, critical: a.critical, kind: a.kind, createdAt: a.createdAt, taskId: a.taskId, dismissed: !!a.dismissedAt })),
      ordersInForce: items.filter((i) => i.critical),
      jobs: byKind("job").slice(0, 100),
      permits: byKind("permit").slice(0, 100),
      violations: cases.map((c) => ({ ...c, closed: CLOSED_STAGES.includes(c.stage) })),
      complaints: byKind("complaint", "sr311").slice(0, 100),
      hearings: byKind("hearing").slice(0, 100),
      recordings: byKind("recording").slice(0, 40),
      acrisAsOf: syncs.find((s) => s.source === "acris_master")?.dataAsOf ?? null,
      // Past-due amounts are money: only people with financial access see the figure.
      tax: byKind("tax", "lien").map((i) => (canViewFinancials ? i : { ...i, detail: { ...i.detail, pastDueCents: null } })),
      access: { canEdit: ctx.project.can("checklist.edit"), canSync: ctx.project.can("project.edit") },
    };
  }),

  /** Run the sync for this project now (admins; once every 10 minutes). */
  syncNow: projectProcedure("project.edit").mutation(async ({ ctx, input }) => {
    const [p] = await ctx.db.select({ bbl: schema.project.bbl }).from(schema.project).where(eq(schema.project.id, input.projectId));
    if (!parseBbl(p?.bbl)) throw new TRPCError({ code: "BAD_REQUEST", message: "Add the project's BBL first (Edit project)." });
    const [run] = await ctx.db.select().from(schema.recordSync).where(and(eq(schema.recordSync.projectId, input.projectId), eq(schema.recordSync.source, "_run")));
    if (run?.lastRunAt && Date.now() - run.lastRunAt.getTime() < SYNC_COOLDOWN_MS) {
      throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Checked in the last 10 minutes. Try again shortly." });
    }
    const r = await syncProjectRecords(input.projectId);
    return { ok: r.ok.length, failed: r.failed.map((f) => f.source), alerts: r.alerts };
  }),

  dismissAlert: projectProcedure("checklist.edit")
    .input(z.object({ alertId: z.uuid(), dismissed: z.boolean().default(true) }))
    .mutation(async ({ ctx, input }) => {
      const r = await ctx.db
        .update(schema.recordAlert)
        .set(input.dismissed ? { dismissedAt: new Date(), dismissedById: ctx.viewer.id } : { dismissedAt: null, dismissedById: null })
        .where(and(eq(schema.recordAlert.id, input.alertId), eq(schema.recordAlert.projectId, input.projectId)))
        .returning({ id: schema.recordAlert.id });
      if (!r.length) throw new TRPCError({ code: "NOT_FOUND", message: "Alert not found" });
      return { ok: true };
    }),

  /** "Create task from this" (brief §10): a task in the current phase, linked back to the record. */
  createTask: projectProcedure("checklist.edit")
    .input(z.object({ alertId: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      return ctx.db.transaction(async (tx) => {
        const [a] = await tx.select().from(schema.recordAlert).where(and(eq(schema.recordAlert.id, input.alertId), eq(schema.recordAlert.projectId, input.projectId))).for("update");
        if (!a) throw new TRPCError({ code: "NOT_FOUND", message: "Alert not found" });
        if (a.taskId) return { taskId: a.taskId, created: false };
        const phaseKey = await currentPhase(tx, input.projectId);
        const [max] = await tx.select({ m: sql<number>`coalesce(max(${schema.task.sortOrder}), -1)::int` }).from(schema.task).where(and(eq(schema.task.projectId, input.projectId), eq(schema.task.phaseKey, phaseKey)));
        const id = randomUUID();
        await tx.insert(schema.task).values({
          id,
          projectId: input.projectId,
          phaseKey,
          title: `Follow up: ${a.title.replace(/^CRITICAL: /, "")}`.slice(0, 200),
          role: "PM",
          description: `From the public records watch.\nSource: ${a.url}`,
          priority: a.critical ? "high" : "normal",
          dueOn: addDays(todayET(), a.critical ? 1 : 7),
          dueManual: true,
          sortOrder: (max?.m ?? -1) + 1,
          createdById: ctx.viewer.id,
        });
        await tx.update(schema.recordAlert).set({ taskId: id }).where(eq(schema.recordAlert.id, a.id));
        await recordAudit(tx, { actorId: ctx.viewer.id, actorName: ctx.viewer.name, action: "create", entityType: "task", entityId: id, projectId: input.projectId, summary: `${ctx.viewer.name} created a task from a public-record alert: ${a.title}`, ip: ctx.ip });
        return { taskId: id, created: true };
      });
    }),

  /** Move a violation along (issued → hearing → fixed → certificate of correction → dismissed or paid), set its hearing date, add notes. */
  updateViolation: projectProcedure("checklist.edit")
    .input(
      z.object({
        id: z.uuid(),
        version: z.number().int().min(1),
        stage: z.enum(VIOLATION_STAGES.map((s) => s.key) as [string, ...string[]]).optional(),
        hearingOn: z.iso.date().nullish(),
        notes: z.string().trim().max(4000).nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.db.transaction(async (tx) => {
        const [v] = await tx.select().from(schema.violationCase).where(and(eq(schema.violationCase.id, input.id), eq(schema.violationCase.projectId, input.projectId))).for("update");
        if (!v) throw new TRPCError({ code: "NOT_FOUND", message: "Violation not found" });
        if (v.version !== input.version) throw new TRPCError({ code: "CONFLICT", message: "Someone else just updated this violation. Reload to see the latest." });
        const stage = (input.stage ?? v.stage) as typeof v.stage;
        const hearingOn = input.hearingOn === undefined ? v.hearingOn : input.hearingOn;
        const closed = CLOSED_STAGES.includes(stage);
        let keyDateId = v.keyDateId;
        if (hearingOn && !closed) {
          const label = `Hearing: ${v.title}`.slice(0, 120);
          if (keyDateId) await tx.update(schema.keyDate).set({ date: hearingOn, label, done: false, updatedAt: new Date() }).where(eq(schema.keyDate.id, keyDateId));
          else keyDateId = (await tx.insert(schema.keyDate).values({ projectId: input.projectId, kind: "oath_hearing", label, date: hearingOn, createdById: ctx.viewer.id, notes: `From ${v.url}` }).returning({ id: schema.keyDate.id }))[0]!.id;
        } else if (keyDateId && (closed || !hearingOn)) {
          await tx.update(schema.keyDate).set({ done: true, updatedAt: new Date() }).where(eq(schema.keyDate.id, keyDateId));
        }
        const [out] = await tx
          .update(schema.violationCase)
          .set({ stage, hearingOn: hearingOn ?? null, keyDateId, notes: input.notes === undefined ? v.notes : input.notes, closedOn: closed ? (v.closedOn ?? todayET()) : null, version: v.version + 1, updatedAt: new Date() })
          .where(eq(schema.violationCase.id, v.id))
          .returning({ version: schema.violationCase.version });
        const label = VIOLATION_STAGES.find((s) => s.key === stage)!.label;
        await recordAudit(tx, { actorId: ctx.viewer.id, actorName: ctx.viewer.name, action: "update", entityType: "violation", entityId: v.id, projectId: input.projectId, summary: `${ctx.viewer.name} updated ${v.title}: ${label}`, ip: ctx.ip });
        return { version: out!.version };
      });
    }),
});

async function currentPhase(tx: DbOrTx, projectId: string): Promise<string> {
  const phases = await tx.select().from(schema.projectPhase).where(eq(schema.projectPhase.projectId, projectId)).orderBy(asc(schema.projectPhase.sortOrder));
  const current = phases.find((p) => p.status === "active") ?? phases.find((p) => p.status === "pending") ?? phases[phases.length - 1];
  if (!current) throw new TRPCError({ code: "BAD_REQUEST", message: "This project has no phases to add a task to." });
  return current.key;
}

/* ------------------------------------------------------------------ */
/* Expiries (Module B)                                                 */
/* ------------------------------------------------------------------ */

const categoryKeys = EXPIRY_CATEGORIES.map((c) => c.key) as [string, ...string[]];

export const expiriesRouter = router({
  list: projectProcedure().query(async ({ ctx, input }) => {
    assertInternal(ctx.project);
    const fin = ctx.project.can("financials.view");
    const rows = await ctx.db.select().from(schema.expiryItem).where(eq(schema.expiryItem.projectId, input.projectId)).orderBy(asc(schema.expiryItem.expiresOn));
    const flags = await expiredCoiFlags(ctx.db, [input.projectId]);
    return {
      items: rows.filter((r) => fin || !FINANCIAL_EXPIRY.has(r.category)).map((r) => ({ ...r, name: expiryLabel(r.category, r.vendorName ?? r.label), fromRecords: !!r.recordRef })),
      coiFlags: flags.get(input.projectId) ?? [],
      categories: EXPIRY_CATEGORIES.filter((c) => fin || !FINANCIAL_EXPIRY.has(c.key)),
      canEdit: ctx.project.can("checklist.edit"),
    };
  }),

  save: projectProcedure("checklist.edit")
    .input(
      z.object({
        id: z.uuid().optional(),
        version: z.number().int().min(1).optional(),
        category: z.enum(categoryKeys),
        label: z.string().trim().max(120).nullish(),
        vendorName: z.string().trim().max(120).nullish(),
        expiresOn: z.iso.date(),
        notes: z.string().trim().max(2000).nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (FINANCIAL_EXPIRY.has(input.category) && !ctx.project.can("financials.view")) throw new TRPCError({ code: "FORBIDDEN", message: "Loan and deal deadlines need financial access." });
      if (input.category.startsWith("vendor_coi_") && !input.vendorName) throw new TRPCError({ code: "BAD_REQUEST", message: "Name the vendor this COI belongs to." });
      const values = { category: input.category, label: input.label || null, vendorName: input.vendorName || null, vendorKey: input.vendorName ? vendorKey(input.vendorName) || null : null, expiresOn: input.expiresOn, notes: input.notes || null };
      return ctx.db.transaction(async (tx) => {
        if (!input.id) {
          const [row] = await tx.insert(schema.expiryItem).values({ projectId: input.projectId, ...values, createdById: ctx.viewer.id }).returning({ id: schema.expiryItem.id });
          await recordAudit(tx, { actorId: ctx.viewer.id, actorName: ctx.viewer.name, action: "create", entityType: "expiry", entityId: row!.id, projectId: input.projectId, summary: `${ctx.viewer.name} added ${expiryLabel(values.category, values.vendorName ?? values.label)} (expires ${values.expiresOn})`, ip: ctx.ip });
          return { id: row!.id };
        }
        const [e] = await tx.select().from(schema.expiryItem).where(and(eq(schema.expiryItem.id, input.id), eq(schema.expiryItem.projectId, input.projectId))).for("update");
        if (!e || (FINANCIAL_EXPIRY.has(e.category) && !ctx.project.can("financials.view"))) throw new TRPCError({ code: "NOT_FOUND", message: "Item not found" });
        if (e.version !== input.version) throw new TRPCError({ code: "CONFLICT", message: "Someone else just changed this. Reload to see the latest." });
        await tx.update(schema.expiryItem).set({ ...values, closedAt: null, version: e.version + 1, updatedAt: new Date() }).where(eq(schema.expiryItem.id, e.id));
        await recordAudit(tx, { actorId: ctx.viewer.id, actorName: ctx.viewer.name, action: "update", entityType: "expiry", entityId: e.id, projectId: input.projectId, summary: `${ctx.viewer.name} updated ${expiryLabel(values.category, values.vendorName ?? values.label)} (expires ${values.expiresOn})`, ip: ctx.ip });
        return { id: e.id };
      });
    }),

  /** Renewed, or no longer relevant: stops reminders and the red flags; the record stays. */
  close: projectProcedure("checklist.edit")
    .input(z.object({ id: z.uuid(), version: z.number().int().min(1), closed: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const [e] = await ctx.db.select().from(schema.expiryItem).where(and(eq(schema.expiryItem.id, input.id), eq(schema.expiryItem.projectId, input.projectId)));
      if (!e || (FINANCIAL_EXPIRY.has(e.category) && !ctx.project.can("financials.view"))) throw new TRPCError({ code: "NOT_FOUND", message: "Item not found" });
      const r = await ctx.db
        .update(schema.expiryItem)
        .set({ closedAt: input.closed ? new Date() : null, version: e.version + 1, updatedAt: new Date() })
        .where(and(eq(schema.expiryItem.id, e.id), eq(schema.expiryItem.version, input.version)))
        .returning({ id: schema.expiryItem.id });
      if (!r.length) throw new TRPCError({ code: "CONFLICT", message: "Someone else just changed this. Reload to see the latest." });
      return { ok: true };
    }),

  remove: projectProcedure("checklist.edit")
    .input(z.object({ id: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [e] = await ctx.db.select().from(schema.expiryItem).where(and(eq(schema.expiryItem.id, input.id), eq(schema.expiryItem.projectId, input.projectId)));
      if (!e || (FINANCIAL_EXPIRY.has(e.category) && !ctx.project.can("financials.view"))) throw new TRPCError({ code: "NOT_FOUND", message: "Item not found" });
      if (e.recordRef) throw new TRPCError({ code: "BAD_REQUEST", message: "This permit comes from public records; mark it closed instead." });
      await ctx.db.delete(schema.expiryItem).where(eq(schema.expiryItem.id, e.id));
      await recordAudit(ctx.db, { actorId: ctx.viewer.id, actorName: ctx.viewer.name, action: "delete", entityType: "expiry", entityId: e.id, projectId: input.projectId, summary: `${ctx.viewer.name} removed ${expiryLabel(e.category, e.vendorName ?? e.label)}`, ip: ctx.ip });
      return { ok: true };
    }),
});
