import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { clamp01, sheetNumberFromName } from "@/core/field";
import { todayET } from "@/core/time";
import { schema, type DbOrTx } from "../../db";
import { recordAudit } from "../../services/audit";
import { canSeeFolderNow } from "../../services/files";
import { nextSequence } from "../../services/sequence";
import { notify } from "../../services/tasks";
import { projectProcedure, router, type AuthedContext, type ProjectAccess } from "../init";
import { nextNumber, notifyMoneyApprovers } from "./financials";

type Ctx = AuthedContext & { project: ProjectAccess };
const date = z.iso.date();
const text = (max = 4000) => z.string().trim().max(max).nullish();
const conflict = () => new TRPCError({ code: "CONFLICT", message: "Someone else just changed this. Reload to see the latest." });
const notFound = (what: string) => new TRPCError({ code: "NOT_FOUND", message: `${what} not found` });
const MAX_CENTS = 1_000_000_000_000;

async function assertOnProject(tx: DbOrTx, projectId: string, userId: string | null | undefined) {
  if (!userId) return;
  const [m] = await tx.select({ id: schema.projectMember.userId }).from(schema.projectMember).where(and(eq(schema.projectMember.projectId, projectId), eq(schema.projectMember.userId, userId)));
  const [o] = await tx.select({ id: schema.user.id }).from(schema.user).where(and(eq(schema.user.id, userId), eq(schema.user.role, "owner")));
  if (!m && !o) throw new TRPCError({ code: "BAD_REQUEST", message: "That person isn't on this project." });
}

/** A file on this project the person can see (for attachments and drawing sheets). */
async function visibleFile(tx: DbOrTx, ctx: Ctx, fileId: string) {
  const [f] = await tx.select().from(schema.file).where(and(eq(schema.file.id, fileId), eq(schema.file.projectId, ctx.project.projectId), isNull(schema.file.deletedAt)));
  if (!f || !(await canSeeFolderNow(tx, ctx.project.projectId, f.folderId, [ctx.viewer.id])).has(ctx.viewer.id)) throw notFound("File");
  return f;
}

/* ------------------------------------------------------------------ */
/* RFIs (Module F)                                                     */
/* ------------------------------------------------------------------ */

async function loadRfi(tx: DbOrTx, projectId: string, id: string) {
  const [r] = await tx.select().from(schema.rfi).where(and(eq(schema.rfi.id, id), eq(schema.rfi.projectId, projectId)));
  if (!r) throw notFound("RFI");
  return r;
}

/** Outsiders see the RFIs they asked or must answer; the team sees all. */
function canSeeRfi(ctx: Ctx, r: { fromUserId: string | null; toUserId: string | null }) {
  return ctx.project.can("task.viewAll") || r.fromUserId === ctx.viewer.id || r.toUserId === ctx.viewer.id;
}

export const rfisRouter = router({
  list: projectProcedure().query(async ({ ctx, input }) => {
    const c = ctx as Ctx;
    const all = c.project.can("task.viewAll");
    const rows = await ctx.db
      .select()
      .from(schema.rfi)
      .where(and(eq(schema.rfi.projectId, input.projectId), all ? undefined : or(eq(schema.rfi.fromUserId, c.viewer.id), eq(schema.rfi.toUserId, c.viewer.id))))
      .orderBy(desc(schema.rfi.number));
    const fin = c.project.can("financials.view");
    const names = new Map((await ctx.db.select({ id: schema.user.id, name: schema.user.name }).from(schema.user).where(inArray(schema.user.id, [...new Set(rows.flatMap((r) => [r.fromUserId, r.toUserId]).filter((x): x is string => !!x))].concat(["-"])))).map((u) => [u.id, u.name]));
    const files = rows.length
      ? await ctx.db.select({ rfiId: schema.rfiAttachment.rfiId, fileId: schema.file.id, name: schema.file.name, folderId: schema.file.folderId }).from(schema.rfiAttachment).innerJoin(schema.file, eq(schema.file.id, schema.rfiAttachment.fileId)).where(inArray(schema.rfiAttachment.rfiId, rows.map((r) => r.id)))
      : [];
    return {
      rfis: rows.map((r) => ({
        ...r,
        costImpactCents: fin ? r.costImpactCents : null,
        fromLabel: r.fromUserId ? (names.get(r.fromUserId) ?? r.fromName) : r.fromName,
        toLabel: r.toUserId ? (names.get(r.toUserId) ?? r.toName) : r.toName,
        canAnswer: r.status === "open" && (r.toUserId === c.viewer.id || c.project.can("checklist.edit")),
        files: files.filter((f) => f.rfiId === r.id).map((f) => ({ id: f.fileId, name: f.name })),
      })),
      access: { canEdit: c.project.can("checklist.edit"), canSeeCost: fin, canRaiseCo: c.project.can("financials.edit") },
    };
  }),

  save: projectProcedure("checklist.edit")
    .input(
      z.object({
        id: z.uuid().optional(),
        version: z.number().int().min(1).optional(),
        subject: z.string().trim().min(1).max(200),
        question: z.string().trim().min(1).max(8000),
        fromUserId: z.string().max(64).nullable(),
        fromName: text(120),
        toUserId: z.string().max(64).nullable(),
        toName: text(120),
        dueOn: date.nullable(),
        costImpactCents: z.number().int().min(-MAX_CENTS).max(MAX_CENTS).nullable(),
        scheduleImpactDays: z.number().int().min(-3650).max(3650).nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      return ctx.db.transaction(async (tx) => {
        await assertOnProject(tx, input.projectId, input.fromUserId);
        await assertOnProject(tx, input.projectId, input.toUserId);
        // Cost is money: only people who see financials set or change it.
        const cost = c.project.can("financials.view") ? { costImpactCents: input.costImpactCents } : {};
        const values = { subject: input.subject, question: input.question, fromUserId: input.fromUserId, fromName: input.fromName || null, toUserId: input.toUserId, toName: input.toName || null, dueOn: input.dueOn, scheduleImpactDays: input.scheduleImpactDays, ...cost };
        if (input.id) {
          const r = await loadRfi(tx, input.projectId, input.id);
          if (r.version !== input.version) throw conflict();
          await tx.update(schema.rfi).set({ ...values, version: r.version + 1, updatedAt: new Date() }).where(eq(schema.rfi.id, r.id));
          if (input.toUserId && input.toUserId !== r.toUserId) await notify(tx, c.viewer.id, [{ userId: input.toUserId, kind: "assigned", title: `RFI #${r.number} needs your answer: ${input.subject}`, projectId: input.projectId, href: `/projects/${input.projectId}?tab=field&view=rfis` }]);
          return { id: r.id, number: r.number };
        }
        const [max] = await tx.select({ n: sql<number>`coalesce(max(${schema.rfi.number}), 0)::int` }).from(schema.rfi).where(eq(schema.rfi.projectId, input.projectId));
        const number = await nextSequence(tx, input.projectId, "rfi", max?.n ?? 0);
        const [row] = await tx.insert(schema.rfi).values({ projectId: input.projectId, number, ...values, status: "open", createdById: c.viewer.id }).returning({ id: schema.rfi.id });
        await recordAudit(tx, { actorId: c.viewer.id, actorName: c.viewer.name, action: "create", entityType: "rfi", entityId: row!.id, projectId: input.projectId, summary: `${c.viewer.name} raised RFI #${number}: ${input.subject}`, ip: c.ip });
        if (input.toUserId) await notify(tx, c.viewer.id, [{ userId: input.toUserId, kind: "assigned", title: `RFI #${number} needs your answer: ${input.subject}`, body: input.dueOn ? `Due ${input.dueOn}` : null, projectId: input.projectId, href: `/projects/${input.projectId}?tab=field&view=rfis` }]);
        return { id: row!.id, number };
      });
    }),

  /** The person it's addressed to (or the team) answers. */
  answer: projectProcedure()
    .input(z.object({ id: z.uuid(), version: z.number().int().min(1), answer: z.string().trim().min(1).max(8000) }))
    .mutation(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      return ctx.db.transaction(async (tx) => {
        const r = await loadRfi(tx, input.projectId, input.id);
        if (!canSeeRfi(c, r)) throw notFound("RFI");
        if (r.toUserId !== c.viewer.id && !c.project.can("checklist.edit")) throw new TRPCError({ code: "FORBIDDEN", message: "Only the person it's addressed to answers this RFI." });
        if (r.version !== input.version) throw conflict();
        await tx.update(schema.rfi).set({ answer: input.answer, answeredAt: new Date(), answeredById: c.viewer.id, status: "answered", version: r.version + 1, updatedAt: new Date() }).where(eq(schema.rfi.id, r.id));
        await recordAudit(tx, { actorId: c.viewer.id, actorName: c.viewer.name, action: "update", entityType: "rfi", entityId: r.id, projectId: input.projectId, summary: `${c.viewer.name} answered RFI #${r.number}`, ip: c.ip });
        const to = [r.createdById, r.fromUserId].filter((x): x is string => !!x);
        await notify(tx, c.viewer.id, to.map((userId) => ({ userId, kind: "comment" as const, title: `RFI #${r.number} answered: ${r.subject}`, projectId: input.projectId, href: `/projects/${input.projectId}?tab=field&view=rfis` })));
        return { ok: true };
      });
    }),

  setStatus: projectProcedure("checklist.edit")
    .input(z.object({ id: z.uuid(), version: z.number().int().min(1), status: z.enum(["open", "closed"]) }))
    .mutation(async ({ ctx, input }) => {
      const r = await ctx.db
        .update(schema.rfi)
        .set({ status: input.status, version: sql`${schema.rfi.version} + 1`, updatedAt: new Date() })
        .where(and(eq(schema.rfi.id, input.id), eq(schema.rfi.projectId, input.projectId), eq(schema.rfi.version, input.version)))
        .returning({ id: schema.rfi.id });
      if (!r.length) throw conflict();
      return { ok: true };
    }),

  attach: projectProcedure("checklist.edit")
    .input(z.object({ id: z.uuid(), fileId: z.uuid(), on: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      const r = await loadRfi(ctx.db, input.projectId, input.id);
      await visibleFile(ctx.db, c, input.fileId);
      if (input.on) await ctx.db.insert(schema.rfiAttachment).values({ rfiId: r.id, fileId: input.fileId }).onConflictDoNothing();
      else await ctx.db.delete(schema.rfiAttachment).where(and(eq(schema.rfiAttachment.rfiId, r.id), eq(schema.rfiAttachment.fileId, input.fileId)));
      return { ok: true };
    }),

  /** One click: an answered RFI with a cost or time impact becomes a change order waiting for approval. */
  toChangeOrder: projectProcedure("financials.edit")
    .input(z.object({ id: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      return ctx.db.transaction(async (tx) => {
        const [r] = await tx.select().from(schema.rfi).where(and(eq(schema.rfi.id, input.id), eq(schema.rfi.projectId, input.projectId))).for("update");
        if (!r) throw notFound("RFI");
        if (r.changeOrderId) return { changeOrderId: r.changeOrderId, created: false };
        if (r.status !== "answered" && r.status !== "closed") throw new TRPCError({ code: "BAD_REQUEST", message: "Answer the RFI first." });
        const number = await nextNumber(tx, schema.changeOrder, "change_order", input.projectId);
        const [co] = await tx
          .insert(schema.changeOrder)
          .values({ projectId: input.projectId, number, description: `RFI #${r.number}: ${r.subject}`.slice(0, 500), amountCents: r.costImpactCents ?? 0, scheduleDays: r.scheduleImpactDays ?? 0, status: "pending", createdById: c.viewer.id })
          .returning({ id: schema.changeOrder.id });
        await tx.update(schema.rfi).set({ changeOrderId: co!.id, version: r.version + 1, updatedAt: new Date() }).where(eq(schema.rfi.id, r.id));
        await recordAudit(tx, { actorId: c.viewer.id, actorName: c.viewer.name, action: "create", entityType: "change_order", entityId: co!.id, projectId: input.projectId, summary: `${c.viewer.name} raised CO #${number} from RFI #${r.number}`, ip: c.ip });
        await notifyMoneyApprovers(tx, c, `Change order #${number} (from RFI #${r.number}) needs approval`);
        return { changeOrderId: co!.id, created: true, number };
      });
    }),
});

/* ------------------------------------------------------------------ */
/* Submittals (Module F)                                               */
/* ------------------------------------------------------------------ */

const decision = z.enum(["approved", "approved_as_noted", "revise_resubmit", "rejected"]);

export const submittalsRouter = router({
  list: projectProcedure().query(async ({ ctx, input }) => {
    const c = ctx as Ctx;
    const all = c.project.can("task.viewAll");
    const rows = await ctx.db
      .select()
      .from(schema.submittal)
      .where(and(eq(schema.submittal.projectId, input.projectId), all ? undefined : eq(schema.submittal.reviewerId, c.viewer.id)))
      .orderBy(desc(schema.submittal.number));
    const revs = rows.length ? await ctx.db.select({ rev: schema.submittalRevision, fileName: schema.file.name }).from(schema.submittalRevision).leftJoin(schema.file, eq(schema.file.id, schema.submittalRevision.fileId)).where(inArray(schema.submittalRevision.submittalId, rows.map((r) => r.id))).orderBy(desc(schema.submittalRevision.revision)) : [];
    const reviewers = new Map((await ctx.db.select({ id: schema.user.id, name: schema.user.name }).from(schema.user).where(inArray(schema.user.id, rows.map((r) => r.reviewerId).filter((x): x is string => !!x).concat(["-"])))).map((u) => [u.id, u.name]));
    return {
      submittals: rows.map((s) => ({
        ...s,
        reviewerLabel: s.reviewerId ? (reviewers.get(s.reviewerId) ?? s.reviewerName) : s.reviewerName,
        revisions: revs.filter((r) => r.rev.submittalId === s.id).map((r) => ({ ...r.rev, fileName: r.fileName })),
        canDecide: s.status === "pending" && (s.reviewerId === c.viewer.id || c.project.can("checklist.edit")),
      })),
      canEdit: c.project.can("checklist.edit"),
    };
  }),

  create: projectProcedure("checklist.edit")
    .input(z.object({ specSection: text(40), item: z.string().trim().min(1).max(200), submittedBy: text(120), reviewerId: z.string().max(64).nullable(), reviewerName: text(120), dueOn: date.nullable(), fileId: z.uuid().nullable() }))
    .mutation(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      return ctx.db.transaction(async (tx) => {
        await assertOnProject(tx, input.projectId, input.reviewerId);
        if (input.fileId) await visibleFile(tx, c, input.fileId);
        const [max] = await tx.select({ n: sql<number>`coalesce(max(${schema.submittal.number}), 0)::int` }).from(schema.submittal).where(eq(schema.submittal.projectId, input.projectId));
        const number = await nextSequence(tx, input.projectId, "submittal", max?.n ?? 0);
        const [s] = await tx
          .insert(schema.submittal)
          .values({ projectId: input.projectId, number, specSection: input.specSection || null, item: input.item, submittedBy: input.submittedBy || null, reviewerId: input.reviewerId, reviewerName: input.reviewerName || null, dueOn: input.dueOn, createdById: c.viewer.id })
          .returning({ id: schema.submittal.id });
        await tx.insert(schema.submittalRevision).values({ submittalId: s!.id, revision: 0, fileId: input.fileId, submittedOn: todayET() });
        await recordAudit(tx, { actorId: c.viewer.id, actorName: c.viewer.name, action: "create", entityType: "submittal", entityId: s!.id, projectId: input.projectId, summary: `${c.viewer.name} logged submittal #${number}: ${input.item}`, ip: c.ip });
        if (input.reviewerId) await notify(tx, c.viewer.id, [{ userId: input.reviewerId, kind: "approval_requested", title: `Submittal #${number} to review: ${input.item}`, projectId: input.projectId, href: `/projects/${input.projectId}?tab=field&view=submittals` }]);
        return { id: s!.id, number };
      });
    }),

  decide: projectProcedure()
    .input(z.object({ id: z.uuid(), version: z.number().int().min(1), decision, notes: text(2000) }))
    .mutation(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      return ctx.db.transaction(async (tx) => {
        const [s] = await tx.select().from(schema.submittal).where(and(eq(schema.submittal.id, input.id), eq(schema.submittal.projectId, input.projectId))).for("update");
        if (!s || (!c.project.can("task.viewAll") && s.reviewerId !== c.viewer.id)) throw notFound("Submittal");
        if (s.reviewerId !== c.viewer.id && !c.project.can("checklist.edit")) throw new TRPCError({ code: "FORBIDDEN", message: "Only the reviewer decides this submittal." });
        if (s.version !== input.version) throw conflict();
        if (s.status !== "pending") throw new TRPCError({ code: "BAD_REQUEST", message: "This revision is already decided; log a resubmittal." });
        const [rev] = await tx.select().from(schema.submittalRevision).where(eq(schema.submittalRevision.submittalId, s.id)).orderBy(desc(schema.submittalRevision.revision)).limit(1);
        await tx.update(schema.submittalRevision).set({ decision: input.decision, decidedOn: todayET(), decidedById: c.viewer.id, notes: input.notes || null }).where(eq(schema.submittalRevision.id, rev!.id));
        await tx.update(schema.submittal).set({ status: input.decision, version: s.version + 1, updatedAt: new Date() }).where(eq(schema.submittal.id, s.id));
        await recordAudit(tx, { actorId: c.viewer.id, actorName: c.viewer.name, action: "update", entityType: "submittal", entityId: s.id, projectId: input.projectId, summary: `${c.viewer.name} marked submittal #${s.number} rev ${rev!.revision}: ${input.decision.replace(/_/g, " ")}`, ip: c.ip });
        if (s.createdById) await notify(tx, c.viewer.id, [{ userId: s.createdById, kind: "approval_decided", title: `Submittal #${s.number}: ${input.decision.replace(/_/g, " ")}`, body: s.item, projectId: input.projectId, href: `/projects/${input.projectId}?tab=field&view=submittals` }]);
        return { ok: true };
      });
    }),

  /** Revise and resubmit: a new revision, back to pending. History stays. */
  resubmit: projectProcedure("checklist.edit")
    .input(z.object({ id: z.uuid(), version: z.number().int().min(1), fileId: z.uuid().nullable() }))
    .mutation(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      return ctx.db.transaction(async (tx) => {
        const [s] = await tx.select().from(schema.submittal).where(and(eq(schema.submittal.id, input.id), eq(schema.submittal.projectId, input.projectId))).for("update");
        if (!s) throw notFound("Submittal");
        if (s.version !== input.version) throw conflict();
        if (s.status === "pending") throw new TRPCError({ code: "BAD_REQUEST", message: "The current revision hasn't been decided yet." });
        if (input.fileId) await visibleFile(tx, c, input.fileId);
        const [rev] = await tx.select({ n: sql<number>`max(${schema.submittalRevision.revision})::int` }).from(schema.submittalRevision).where(eq(schema.submittalRevision.submittalId, s.id));
        await tx.insert(schema.submittalRevision).values({ submittalId: s.id, revision: (rev?.n ?? 0) + 1, fileId: input.fileId, submittedOn: todayET() });
        await tx.update(schema.submittal).set({ status: "pending", version: s.version + 1, updatedAt: new Date() }).where(eq(schema.submittal.id, s.id));
        if (s.reviewerId) await notify(tx, c.viewer.id, [{ userId: s.reviewerId, kind: "approval_requested", title: `Submittal #${s.number} resubmitted: ${s.item}`, projectId: input.projectId, href: `/projects/${input.projectId}?tab=field&view=submittals` }]);
        return { revision: (rev?.n ?? 0) + 1 };
      });
    }),
});

/* ------------------------------------------------------------------ */
/* Drawing sets (Module F)                                             */
/* ------------------------------------------------------------------ */

const discipline = z.enum(["A", "S", "M", "E", "P", "FP"]);

async function sheetsWithFiles(conn: DbOrTx, where: ReturnType<typeof and>) {
  return conn
    .select({ sheet: schema.drawingSheet, set: schema.drawingSet, fileName: schema.file.name, folderId: schema.file.folderId, versionId: sql<string>`(select id from ${schema.fileVersion} v where v.file_id = ${schema.file.id} order by v.number desc limit 1)` })
    .from(schema.drawingSheet)
    .innerJoin(schema.drawingSet, eq(schema.drawingSet.id, schema.drawingSheet.setId))
    .innerJoin(schema.file, eq(schema.file.id, schema.drawingSheet.fileId))
    .where(and(where, isNull(schema.file.deletedAt)))
    .orderBy(asc(schema.drawingSet.discipline), asc(schema.drawingSheet.sortOrder));
}

/** Sheets whose PDF lives in a folder this person can see. */
async function visibleSheets<T extends { folderId: string }>(conn: DbOrTx, ctx: Ctx, rows: T[]): Promise<T[]> {
  const folders = [...new Set(rows.map((r) => r.folderId))];
  const ok = new Set<string>();
  for (const f of folders) if ((await canSeeFolderNow(conn, ctx.project.projectId, f, [ctx.viewer.id])).has(ctx.viewer.id)) ok.add(f);
  return rows.filter((r) => ok.has(r.folderId));
}

export const drawingsRouter = router({
  /** "What's current": the current set per discipline, plus superseded sets as history. */
  list: projectProcedure().query(async ({ ctx, input }) => {
    const c = ctx as Ctx;
    const rows = await visibleSheets(ctx.db, c, await sheetsWithFiles(ctx.db, eq(schema.drawingSheet.projectId, input.projectId)));
    const sets = await ctx.db.select().from(schema.drawingSet).where(eq(schema.drawingSet.projectId, input.projectId)).orderBy(asc(schema.drawingSet.discipline), desc(schema.drawingSet.createdAt));
    const pins = rows.length ? await ctx.db.select({ sheetId: schema.punchItem.sheetId, n: sql<number>`count(*)::int` }).from(schema.punchItem).where(and(eq(schema.punchItem.projectId, input.projectId), sql`${schema.punchItem.status} <> 'closed'`)).groupBy(schema.punchItem.sheetId) : [];
    return {
      sets: sets
        .map((s) => ({
          ...s,
          sheets: rows.filter((r) => r.set.id === s.id).map((r) => ({ id: r.sheet.id, number: r.sheet.number, title: r.sheet.title, fileName: r.fileName, versionId: r.versionId, openPunch: pins.find((p) => p.sheetId === r.sheet.id)?.n ?? 0 })),
        }))
        .filter((s) => s.sheets.length > 0),
      canEdit: c.project.can("checklist.edit"),
    };
  }),

  /** Issue a set: the PDFs (already uploaded to the project's files) become its sheets; the discipline's previous set is superseded. */
  createSet: projectProcedure("checklist.edit")
    .input(z.object({ discipline, name: z.string().trim().min(1).max(120), issuedOn: date.nullable(), fileIds: z.array(z.uuid()).min(1).max(200) }))
    .mutation(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      return ctx.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`drawings:${input.projectId}:${input.discipline}`}))`);
        const files = [];
        for (const id of input.fileIds) {
          const f = await visibleFile(tx, c, id);
          if (!/\.pdf$/i.test(f.name)) throw new TRPCError({ code: "BAD_REQUEST", message: `${f.name} isn't a PDF.` });
          files.push(f);
        }
        await tx.update(schema.drawingSet).set({ current: false, supersededAt: new Date() }).where(and(eq(schema.drawingSet.projectId, input.projectId), eq(schema.drawingSet.discipline, input.discipline), eq(schema.drawingSet.current, true)));
        const [set] = await tx.insert(schema.drawingSet).values({ projectId: input.projectId, discipline: input.discipline, name: input.name, issuedOn: input.issuedOn, current: true, createdById: c.viewer.id }).returning({ id: schema.drawingSet.id });
        files.sort((a, b) => sheetNumberFromName(a.name).localeCompare(sheetNumberFromName(b.name), undefined, { numeric: true }));
        await tx.insert(schema.drawingSheet).values(files.map((f, i) => ({ setId: set!.id, projectId: input.projectId, number: sheetNumberFromName(f.name), title: f.name.replace(/\.pdf$/i, ""), fileId: f.id, sortOrder: i })));
        await recordAudit(tx, { actorId: c.viewer.id, actorName: c.viewer.name, action: "create", entityType: "drawing_set", entityId: set!.id, projectId: input.projectId, summary: `${c.viewer.name} issued ${input.discipline} set "${input.name}" (${files.length} sheets)`, ip: c.ip });
        return { id: set!.id };
      });
    }),

  /** One sheet for the viewer, with whether it's superseded and its punch pins. */
  sheet: projectProcedure()
    .input(z.object({ sheetId: z.uuid() }))
    .query(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      const [row] = await visibleSheets(ctx.db, c, await sheetsWithFiles(ctx.db, and(eq(schema.drawingSheet.id, input.sheetId), eq(schema.drawingSheet.projectId, input.projectId))));
      if (!row) throw notFound("Sheet");
      const all = c.project.can("task.viewAll");
      const pins = await ctx.db
        .select()
        .from(schema.punchItem)
        .where(and(eq(schema.punchItem.sheetId, row.sheet.id), all ? undefined : eq(schema.punchItem.assigneeId, c.viewer.id)))
        .orderBy(asc(schema.punchItem.number));
      return { sheet: row.sheet, set: row.set, versionId: row.versionId, superseded: !row.set.current, pins, canPin: all };
    }),
});

/* ------------------------------------------------------------------ */
/* Punch lists on the drawings (Module K)                              */
/* ------------------------------------------------------------------ */

const punchFields = z.object({
  title: z.string().trim().min(1).max(200),
  description: text(2000),
  trade: text(60),
  vendorName: text(120),
  assigneeId: z.string().max(64).nullable(),
  floor: text(20),
  unit: text(20),
  dueOn: date.nullable(),
  photoId: z.uuid().nullable(),
});

export const punchRouter = router({
  list: projectProcedure()
    .input(z.object({ floor: z.string().max(20).optional(), unit: z.string().max(20).optional(), trade: z.string().max(60).optional(), vendor: z.string().max(120).optional(), status: z.enum(["open", "ready", "closed"]).optional() }))
    .query(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      const all = c.project.can("task.viewAll");
      const rows = await ctx.db
        .select({ item: schema.punchItem, sheetNumber: schema.drawingSheet.number, assigneeName: schema.user.name })
        .from(schema.punchItem)
        .leftJoin(schema.drawingSheet, eq(schema.drawingSheet.id, schema.punchItem.sheetId))
        .leftJoin(schema.user, eq(schema.user.id, schema.punchItem.assigneeId))
        .where(
          and(
            eq(schema.punchItem.projectId, input.projectId),
            all ? undefined : eq(schema.punchItem.assigneeId, c.viewer.id),
            input.floor ? eq(schema.punchItem.floor, input.floor) : undefined,
            input.unit ? eq(schema.punchItem.unit, input.unit) : undefined,
            input.trade ? eq(schema.punchItem.trade, input.trade) : undefined,
            input.vendor ? eq(schema.punchItem.vendorName, input.vendor) : undefined,
            input.status ? eq(schema.punchItem.status, input.status) : undefined,
          ),
        )
        .orderBy(asc(schema.punchItem.status), asc(schema.punchItem.number));
      const facets = all
        ? await ctx.db.select({ floor: schema.punchItem.floor, unit: schema.punchItem.unit, trade: schema.punchItem.trade, vendor: schema.punchItem.vendorName }).from(schema.punchItem).where(eq(schema.punchItem.projectId, input.projectId))
        : [];
      const uniq = (k: "floor" | "unit" | "trade" | "vendor") => [...new Set(facets.map((f) => f[k]).filter((x): x is string => !!x))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      return {
        items: rows.map((r) => ({ ...r.item, sheetNumber: r.sheetNumber, assigneeName: r.assigneeName })),
        facets: { floors: uniq("floor"), units: uniq("unit"), trades: uniq("trade"), vendors: uniq("vendor") },
        canEdit: all,
      };
    }),

  /** Drop a pin (on a sheet) or add an item without one. */
  create: projectProcedure()
    .input(punchFields.extend({ sheetId: z.uuid().nullable(), page: z.number().int().min(1).max(500).default(1), x: z.number().nullable(), y: z.number().nullable() }))
    .mutation(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      if (!c.project.can("task.viewAll")) throw new TRPCError({ code: "FORBIDDEN", message: "The project team adds punch items." });
      return ctx.db.transaction(async (tx) => {
        if (input.sheetId) {
          const [s] = await tx.select({ id: schema.drawingSheet.id }).from(schema.drawingSheet).where(and(eq(schema.drawingSheet.id, input.sheetId), eq(schema.drawingSheet.projectId, input.projectId)));
          if (!s) throw notFound("Sheet");
        }
        if (input.photoId) {
          const [p] = await tx.select({ id: schema.projectPhoto.id }).from(schema.projectPhoto).where(and(eq(schema.projectPhoto.id, input.photoId), eq(schema.projectPhoto.projectId, input.projectId)));
          if (!p) throw notFound("Photo");
        }
        await assertOnProject(tx, input.projectId, input.assigneeId);
        const [max] = await tx.select({ n: sql<number>`coalesce(max(${schema.punchItem.number}), 0)::int` }).from(schema.punchItem).where(eq(schema.punchItem.projectId, input.projectId));
        const number = await nextSequence(tx, input.projectId, "punch", max?.n ?? 0);
        const [row] = await tx
          .insert(schema.punchItem)
          .values({
            projectId: input.projectId,
            number,
            sheetId: input.sheetId,
            page: input.page,
            x: input.x === null ? null : clamp01(input.x),
            y: input.y === null ? null : clamp01(input.y),
            title: input.title,
            description: input.description || null,
            trade: input.trade || null,
            vendorName: input.vendorName || null,
            assigneeId: input.assigneeId,
            floor: input.floor || null,
            unit: input.unit || null,
            dueOn: input.dueOn,
            photoId: input.photoId,
            createdById: c.viewer.id,
          })
          .returning({ id: schema.punchItem.id });
        if (input.assigneeId) await notify(tx, c.viewer.id, [{ userId: input.assigneeId, kind: "assigned", title: `Punch #${number}: ${input.title}`, body: [input.floor && `Floor ${input.floor}`, input.unit && `Unit ${input.unit}`].filter(Boolean).join(" · ") || null, projectId: input.projectId, href: `/projects/${input.projectId}?tab=field&view=punch` }]);
        return { id: row!.id, number };
      });
    }),

  /** The team edits anything; the sub it's assigned to can only mark it ready for review. */
  update: projectProcedure()
    .input(punchFields.partial().extend({ id: z.uuid(), version: z.number().int().min(1), status: z.enum(["open", "ready", "closed"]).optional() }))
    .mutation(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      return ctx.db.transaction(async (tx) => {
        const [p] = await tx.select().from(schema.punchItem).where(and(eq(schema.punchItem.id, input.id), eq(schema.punchItem.projectId, input.projectId))).for("update");
        const team = c.project.can("task.viewAll");
        if (!p || (!team && p.assigneeId !== c.viewer.id)) throw notFound("Punch item");
        if (p.version !== input.version) throw conflict();
        const { id: _id, version: _v, projectId: _p, ...fields } = input;
        void _id;
        void _v;
        void _p;
        if (!team) {
          const allowed = Object.keys(fields).every((k) => k === "status") && (fields.status === "ready" || fields.status === "open");
          if (!allowed) throw new TRPCError({ code: "FORBIDDEN", message: "Mark it ready for review; the team closes it." });
        }
        if (fields.assigneeId !== undefined) await assertOnProject(tx, input.projectId, fields.assigneeId);
        const set = {
          ...fields,
          ...(fields.status ? { closedAt: fields.status === "closed" ? new Date() : null } : {}),
          version: p.version + 1,
          updatedAt: new Date(),
        };
        await tx.update(schema.punchItem).set(set).where(eq(schema.punchItem.id, p.id));
        if (fields.status === "ready" && p.createdById && p.createdById !== c.viewer.id) {
          await notify(tx, c.viewer.id, [{ userId: p.createdById, kind: "comment", title: `Punch #${p.number} ready for review: ${p.title}`, projectId: input.projectId, href: `/projects/${input.projectId}?tab=field&view=punch` }]);
        }
        if (fields.assigneeId && fields.assigneeId !== p.assigneeId) await notify(tx, c.viewer.id, [{ userId: fields.assigneeId, kind: "assigned", title: `Punch #${p.number}: ${fields.title ?? p.title}`, projectId: input.projectId, href: `/projects/${input.projectId}?tab=field&view=punch` }]);
        return { version: p.version + 1 };
      });
    }),

  remove: projectProcedure("checklist.edit")
    .input(z.object({ id: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      const r = await ctx.db.delete(schema.punchItem).where(and(eq(schema.punchItem.id, input.id), eq(schema.punchItem.projectId, input.projectId))).returning({ id: schema.punchItem.id });
      if (!r.length) throw notFound("Punch item");
      return { ok: true };
    }),
});
