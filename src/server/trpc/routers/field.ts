import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { planDate } from "../dates";
import { carryForward, manpowerTotal, MAX_LOG_RANGE_DAYS, meetingItemStatus } from "@/core/field";
import { criticalPath, forecast, plannedSpan, slippageDays } from "@/core/schedule";
import { daysBetween, todayET } from "@/core/time";
import { schema, type DbOrTx } from "../../db";
import type { SiteWeather } from "../../db/schema/app";
import { recordAudit } from "../../services/audit";
import { currentBaseline, fetchWeather, loadScheduleTasks, lockBaseline, lockBaselineMutex, nextBaselineNumber } from "../../services/field";
import { notify, taskHref } from "../../services/tasks";
import { projectProcedure, router, type ProjectAccess } from "../init";

const date = planDate;
const text = (max = 4000) => z.string().trim().max(max).nullish();

function internal(access: ProjectAccess) {
  if (!access.can("task.viewAll")) throw new TRPCError({ code: "FORBIDDEN", message: "This is for the project team." });
}
const conflict = () => new TRPCError({ code: "CONFLICT", message: "Someone else just changed this. Reload to see the latest." });

async function currentPhaseKey(tx: DbOrTx, projectId: string): Promise<string> {
  const phases = await tx.select().from(schema.projectPhase).where(eq(schema.projectPhase.projectId, projectId)).orderBy(asc(schema.projectPhase.sortOrder));
  const p = phases.find((x) => x.status === "active") ?? phases.find((x) => x.status === "pending") ?? phases[phases.length - 1];
  if (!p) throw new TRPCError({ code: "BAD_REQUEST", message: "This project has no phases." });
  return p.key;
}

/* ------------------------------------------------------------------ */
/* Daily site log (Module D)                                           */
/* ------------------------------------------------------------------ */

const logInput = z.object({
  date,
  version: z.number().int().min(1).optional(),
  weather: z
    .object({ summary: z.string().trim().max(60), highF: z.number().min(-60).max(140).nullable(), lowF: z.number().min(-60).max(140).nullable(), precipIn: z.number().min(0).max(40).nullable(), windMph: z.number().min(0).max(200).nullable() })
    .nullish(),
  manpower: z.array(z.object({ trade: z.string().trim().min(1).max(60), company: z.string().trim().max(80).nullable(), count: z.number().int().min(0).max(999) })).max(40),
  workPerformed: text(),
  deliveries: text(2000),
  inspections: z.array(z.object({ what: z.string().trim().min(1).max(120), result: z.enum(["pass", "fail", "partial", "pending"]), notes: z.string().trim().max(500).nullable() })).max(20),
  visitors: text(2000),
  safety: text(2000),
  delays: z.array(z.object({ cause: z.string().trim().min(1).max(120), hours: z.number().min(0).max(24).nullable(), notes: z.string().trim().max(500).nullable() })).max(20),
  notes: text(),
});

export const siteLogsRouter = router({
  /** One day's log (or the empty form, with yesterday's crew to copy). */
  get: projectProcedure()
    .input(z.object({ date }))
    .query(async ({ ctx, input }) => {
      internal(ctx.project);
      const [log] = await ctx.db.select().from(schema.siteLog).where(and(eq(schema.siteLog.projectId, input.projectId), eq(schema.siteLog.date, input.date)));
      const [previous] = await ctx.db
        .select({ manpower: schema.siteLog.manpower, date: schema.siteLog.date })
        .from(schema.siteLog)
        .where(and(eq(schema.siteLog.projectId, input.projectId), lt(schema.siteLog.date, input.date)))
        .orderBy(desc(schema.siteLog.date))
        .limit(1);
      const photos = log
        ? await ctx.db.select({ id: schema.projectPhoto.id, width: schema.projectPhoto.width, height: schema.projectPhoto.height, caption: schema.projectPhoto.caption }).from(schema.projectPhoto).where(eq(schema.projectPhoto.siteLogId, log.id)).orderBy(asc(schema.projectPhoto.createdAt))
        : [];
      let author: string | null = null;
      if (log?.updatedById) author = (await ctx.db.select({ name: schema.user.name }).from(schema.user).where(eq(schema.user.id, log.updatedById)))[0]?.name ?? null;
      return { log: log ?? null, photos, previousManpower: previous?.manpower ?? [], previousDate: previous?.date ?? null, author };
    }),

  list: projectProcedure()
    .input(z.object({ before: date.optional(), limit: z.number().int().min(1).max(60).default(30) }))
    .query(async ({ ctx, input }) => {
      internal(ctx.project);
      const rows = await ctx.db
        .select()
        .from(schema.siteLog)
        .where(and(eq(schema.siteLog.projectId, input.projectId), input.before ? lt(schema.siteLog.date, input.before) : undefined))
        .orderBy(desc(schema.siteLog.date))
        .limit(input.limit);
      const photoCounts = rows.length
        ? await ctx.db.select({ id: schema.projectPhoto.siteLogId, n: sql<number>`count(*)::int` }).from(schema.projectPhoto).where(inArray(schema.projectPhoto.siteLogId, rows.map((r) => r.id))).groupBy(schema.projectPhoto.siteLogId)
        : [];
      return rows.map((r) => ({
        id: r.id,
        date: r.date,
        weather: r.weather?.summary ?? null,
        crew: manpowerTotal(r.manpower),
        failedInspections: r.inspections.filter((i) => i.result === "fail").length,
        incidents: !!r.safety,
        delays: r.delays.length,
        photos: photoCounts.find((p) => p.id === r.id)?.n ?? 0,
      }));
    }),

  /** Full logs for a date range (the dated PDF for lender draws and claims), at most six months. */
  range: projectProcedure()
    .input(z.object({ from: date, to: date }))
    .query(async ({ ctx, input }) => {
      internal(ctx.project);
      if (input.from > input.to) throw new TRPCError({ code: "BAD_REQUEST", message: "The range is backwards." });
      if (daysBetween(input.from, input.to) > MAX_LOG_RANGE_DAYS) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick six months or less for one PDF." });
      const logs = await ctx.db
        .select()
        .from(schema.siteLog)
        .where(and(eq(schema.siteLog.projectId, input.projectId), sql`${schema.siteLog.date} between ${input.from} and ${input.to}`))
        .orderBy(asc(schema.siteLog.date));
      const authors = new Map((await ctx.db.select({ id: schema.user.id, name: schema.user.name }).from(schema.user).where(inArray(schema.user.id, logs.map((l) => l.updatedById).filter((x): x is string => !!x).concat(["-"])))).map((u) => [u.id, u.name]));
      const photos = logs.length ? await ctx.db.select({ siteLogId: schema.projectPhoto.siteLogId, n: sql<number>`count(*)::int` }).from(schema.projectPhoto).where(inArray(schema.projectPhoto.siteLogId, logs.map((l) => l.id))).groupBy(schema.projectPhoto.siteLogId) : [];
      return logs.map((l) => ({ ...l, author: l.updatedById ? (authors.get(l.updatedById) ?? null) : null, photos: photos.find((p) => p.siteLogId === l.id)?.n ?? 0 }));
    }),

  /** Create or update a day's log (anyone on the internal team; the super's two-minute form). Weather fills itself. */
  save: projectProcedure()
    .input(logInput)
    .mutation(async ({ ctx, input }) => {
      internal(ctx.project);
      if (input.date > todayET()) throw new TRPCError({ code: "BAD_REQUEST", message: "Logs are for today or earlier." });
      let weather: SiteWeather | null = input.weather ? { ...input.weather, source: "manual" } : null;
      if (!weather) {
        const [p] = await ctx.db.select({ lat: schema.project.latitude, lon: schema.project.longitude }).from(schema.project).where(eq(schema.project.id, input.projectId));
        if (p?.lat !== null && p?.lat !== undefined && p.lon !== null) weather = await fetchWeather(p.lat, p.lon!, input.date);
      }
      const values = {
        manpower: input.manpower,
        workPerformed: input.workPerformed || null,
        deliveries: input.deliveries || null,
        inspections: input.inspections,
        visitors: input.visitors || null,
        safety: input.safety || null,
        delays: input.delays,
        notes: input.notes || null,
        updatedById: ctx.viewer.id,
      };
      return ctx.db.transaction(async (tx) => {
        const [existing] = await tx.select().from(schema.siteLog).where(and(eq(schema.siteLog.projectId, input.projectId), eq(schema.siteLog.date, input.date))).for("update");
        if (existing) {
          // A brand-new form (no version) meeting a log someone just filed must not overwrite it.
          if (input.version === undefined || existing.version !== input.version) throw conflict();
          const [row] = await tx
            .update(schema.siteLog)
            .set({ ...values, weather: weather ?? existing.weather, version: existing.version + 1, updatedAt: new Date() })
            .where(eq(schema.siteLog.id, existing.id))
            .returning({ id: schema.siteLog.id, version: schema.siteLog.version });
          return row!;
        }
        const [row] = await tx
          .insert(schema.siteLog)
          .values({ projectId: input.projectId, date: input.date, weather, ...values, createdById: ctx.viewer.id })
          .onConflictDoNothing()
          .returning({ id: schema.siteLog.id, version: schema.siteLog.version });
        if (!row) throw conflict();
        await recordAudit(tx, { actorId: ctx.viewer.id, actorName: ctx.viewer.name, action: "create", entityType: "site_log", entityId: row.id, projectId: input.projectId, summary: `${ctx.viewer.name} filed the site log for ${input.date}`, ip: ctx.ip });
        return row;
      });
    }),
});

/* ------------------------------------------------------------------ */
/* Schedule, baseline and slippage (Module E)                          */
/* ------------------------------------------------------------------ */

export const scheduleRouter = router({
  /** The Gantt: planned and forecast spans, the critical path, the baseline and days ahead or behind. */
  get: projectProcedure().query(async ({ ctx, input }) => {
    internal(ctx.project);
    const today = todayET();
    const tasks = await loadScheduleTasks(ctx.db, input.projectId);
    const cp = criticalPath(tasks);
    const fc = forecast(tasks, today);
    const baseline = await currentBaseline(ctx.db, input.projectId);
    const history = await ctx.db.select().from(schema.scheduleBaseline).where(eq(schema.scheduleBaseline.projectId, input.projectId)).orderBy(desc(schema.scheduleBaseline.number));
    const phases = await ctx.db.select({ key: schema.projectPhase.key, name: schema.projectPhase.name, sortOrder: schema.projectPhase.sortOrder }).from(schema.projectPhase).where(eq(schema.projectPhase.projectId, input.projectId)).orderBy(asc(schema.projectPhase.sortOrder));
    const base = new Map((baseline?.items ?? []).map((i) => [i.taskId, i]));
    const order = new Map(phases.map((p) => [p.key, p.sortOrder]));
    const version = new Map((await ctx.db.select({ id: schema.task.id, version: schema.task.version }).from(schema.task).where(eq(schema.task.projectId, input.projectId))).map((t) => [t.id, t.version]));
    return {
      today,
      phases,
      tasks: tasks
        .filter((t) => plannedSpan(t) || t.done)
        .sort((a, b) => (order.get(a.phaseKey) ?? 0) - (order.get(b.phaseKey) ?? 0) || a.sortOrder - b.sortOrder)
        .map((t) => ({
          id: t.id,
          title: t.title,
          phaseKey: t.phaseKey,
          status: t.status,
          milestone: t.milestone,
          version: version.get(t.id) ?? 1,
          startOn: t.startOn,
          dueOn: t.projected ? null : t.dueOn,
          startedOn: t.startedOn,
          completedOn: t.completedOn,
          planned: plannedSpan(t),
          projected: t.projected,
          forecast: fc.byTask.get(t.id) ?? null,
          baseline: base.get(t.id) ?? null,
          critical: cp.critical.has(t.id),
          slack: cp.slack.get(t.id) ?? null,
          deps: t.deps,
        })),
      plannedFinish: cp.finish,
      forecastFinish: fc.finish,
      baseline: baseline ? { id: baseline.id, number: baseline.number, finishOn: baseline.finishOn, lockedAt: baseline.lockedAt, reason: baseline.reason } : null,
      slippage: slippageDays(baseline?.finishOn ?? null, fc.finish),
      history: history.map((h) => ({ id: h.id, number: h.number, status: h.status, finishOn: h.finishOn, reason: h.reason, lockedAt: h.lockedAt, createdAt: h.createdAt })),
      access: { canEdit: ctx.project.can("checklist.edit"), canLock: ctx.project.can("project.edit"), canApprove: ctx.actor.role === "owner" },
    };
  }),

  /** Planned start and finish for a task (the finish is its due date). */
  setDates: projectProcedure("checklist.edit")
    .input(z.object({ taskId: z.uuid(), version: z.number().int().min(1), startOn: date.nullable(), dueOn: date.nullable() }))
    .mutation(async ({ ctx, input }) => {
      if (input.startOn && input.dueOn && input.startOn > input.dueOn) throw new TRPCError({ code: "BAD_REQUEST", message: "The start has to be on or before the finish." });
      const r = await ctx.db
        .update(schema.task)
        .set({ startOn: input.startOn, dueOn: input.dueOn, dueManual: input.dueOn !== null, version: sql`${schema.task.version} + 1`, updatedAt: new Date() })
        .where(and(eq(schema.task.id, input.taskId), eq(schema.task.projectId, input.projectId), eq(schema.task.version, input.version)))
        .returning({ version: schema.task.version });
      if (!r.length) throw conflict();
      return r[0]!;
    }),

  /** The first baseline (it also locks by itself when the project enters Pre-Construction). */
  lock: projectProcedure("project.edit")
    .input(z.object({ reason: text(500) }))
    .mutation(async ({ ctx, input }) => {
      return ctx.db.transaction(async (tx) => {
        await lockBaselineMutex(tx, input.projectId);
        if (await currentBaseline(tx, input.projectId)) throw new TRPCError({ code: "BAD_REQUEST", message: "A baseline is locked. Changing it needs the owner's approval: request a re-baseline." });
        const id = await lockBaseline(tx, input.projectId, { requestedById: ctx.viewer.id, approvedById: ctx.viewer.id, reason: input.reason || "Locked by hand" });
        await recordAudit(tx, { actorId: ctx.viewer.id, actorName: ctx.viewer.name, action: "create", entityType: "schedule_baseline", entityId: id, projectId: input.projectId, summary: `${ctx.viewer.name} locked the schedule baseline`, ip: ctx.ip });
        return { id };
      });
    }),

  /** Re-baselining needs the owner's approval (A); an owner's own request is approved as it's made. History is kept. */
  requestRebaseline: projectProcedure("project.edit")
    .input(z.object({ reason: z.string().trim().min(3).max(500) }))
    .mutation(async ({ ctx, input }) => {
      return ctx.db.transaction(async (tx) => {
        await lockBaselineMutex(tx, input.projectId);
        if (!(await currentBaseline(tx, input.projectId))) throw new TRPCError({ code: "BAD_REQUEST", message: "Lock a first baseline instead." });
        const [open] = await tx.select({ id: schema.scheduleBaseline.id }).from(schema.scheduleBaseline).where(and(eq(schema.scheduleBaseline.projectId, input.projectId), eq(schema.scheduleBaseline.status, "requested")));
        if (open) throw new TRPCError({ code: "BAD_REQUEST", message: "A re-baseline request is already waiting for the owner." });
        const [row] = await tx
          .insert(schema.scheduleBaseline)
          .values({ projectId: input.projectId, number: await nextBaselineNumber(tx, input.projectId), reason: input.reason, status: "requested", requestedById: ctx.viewer.id })
          .returning({ id: schema.scheduleBaseline.id });
        if (ctx.actor.role === "owner") {
          await lockBaseline(tx, input.projectId, { requestedById: ctx.viewer.id, approvedById: ctx.viewer.id, reason: input.reason, requestId: row!.id });
          return { id: row!.id, approved: true };
        }
        const [p] = await tx.select({ name: schema.project.name }).from(schema.project).where(eq(schema.project.id, input.projectId));
        const owners = await tx.select({ id: schema.user.id }).from(schema.user).where(and(eq(schema.user.role, "owner"), eq(schema.user.status, "active")));
        await notify(tx, ctx.viewer.id, owners.map((o) => ({ userId: o.id, kind: "approval_requested" as const, title: `Re-baseline the schedule for ${p?.name ?? "a project"}?`, body: input.reason, projectId: input.projectId, href: `/projects/${input.projectId}?tab=field&view=schedule` })));
        return { id: row!.id, approved: false };
      });
    }),

  decideRebaseline: projectProcedure()
    .input(z.object({ id: z.uuid(), approve: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      if (ctx.actor.role !== "owner") throw new TRPCError({ code: "FORBIDDEN", message: "Only the owner approves a re-baseline." });
      return ctx.db.transaction(async (tx) => {
        await lockBaselineMutex(tx, input.projectId);
        const [req] = await tx.select().from(schema.scheduleBaseline).where(and(eq(schema.scheduleBaseline.id, input.id), eq(schema.scheduleBaseline.projectId, input.projectId), eq(schema.scheduleBaseline.status, "requested")));
        if (!req) throw new TRPCError({ code: "NOT_FOUND", message: "That request was already decided." });
        if (input.approve) await lockBaseline(tx, input.projectId, { requestedById: req.requestedById, approvedById: ctx.viewer.id, reason: req.reason, requestId: req.id });
        else await tx.update(schema.scheduleBaseline).set({ status: "declined", approvedById: ctx.viewer.id }).where(eq(schema.scheduleBaseline.id, req.id));
        await recordAudit(tx, { actorId: ctx.viewer.id, actorName: ctx.viewer.name, action: "update", entityType: "schedule_baseline", entityId: req.id, projectId: input.projectId, summary: `${ctx.viewer.name} ${input.approve ? "approved" : "declined"} a re-baseline: ${req.reason ?? ""}`, ip: ctx.ip });
        if (req.requestedById) await notify(tx, ctx.viewer.id, [{ userId: req.requestedById, kind: "approval_decided", title: `Re-baseline ${input.approve ? "approved" : "declined"}`, body: req.reason, projectId: input.projectId, href: `/projects/${input.projectId}?tab=field&view=schedule` }]);
        return { ok: true };
      });
    }),
});

/* ------------------------------------------------------------------ */
/* Meetings (Module G)                                                 */
/* ------------------------------------------------------------------ */

const meetingType = z.enum(["oac", "design", "lender", "partner", "other"]);
const attendee = z.object({ name: z.string().trim().min(1).max(80), company: z.string().trim().max(80).nullable(), userId: z.string().max(64).nullable() });

async function loadMeeting(tx: DbOrTx, projectId: string, id: string) {
  const [m] = await tx.select().from(schema.meeting).where(and(eq(schema.meeting.id, id), eq(schema.meeting.projectId, projectId)));
  if (!m) throw new TRPCError({ code: "NOT_FOUND", message: "Meeting not found" });
  return m;
}

/** An action item becomes (or updates) an assigned task with a due date. */
async function syncActionTask(tx: DbOrTx, projectId: string, m: { type: string; number: number }, item: typeof schema.meetingItem.$inferSelect, actor: { id: string; name: string }) {
  if (item.kind !== "action") {
    // Turned into a note: its task goes too if nobody has started on it; started work stays on the list.
    if (item.taskId) {
      await tx.delete(schema.task).where(and(eq(schema.task.id, item.taskId), eq(schema.task.status, "not_started")));
      await tx.update(schema.meetingItem).set({ taskId: null }).where(eq(schema.meetingItem.taskId, item.taskId));
    }
    return;
  }
  const title = item.text.slice(0, 200);
  if (item.taskId) {
    const [t] = await tx.select().from(schema.task).where(eq(schema.task.id, item.taskId));
    if (t) {
      const assigneeChanged = t.assigneeId !== item.assigneeId;
      const close = item.status === "closed" && t.status !== "done";
      const reopen = item.status === "open" && t.status === "done";
      await tx
        .update(schema.task)
        .set({
          title,
          assigneeId: item.assigneeId,
          dueOn: item.dueOn,
          dueManual: !!item.dueOn,
          ...(close ? { status: "done" as const, completedOn: todayET(), completedAt: new Date(), completedById: actor.id } : {}),
          ...(reopen ? { status: "not_started" as const, completedOn: null, completedAt: null, completedById: null } : {}),
          version: sql`${schema.task.version} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(schema.task.id, t.id));
      if (assigneeChanged && item.assigneeId) await notify(tx, actor.id, [{ userId: item.assigneeId, kind: "assigned", title: `Assigned: “${title}”`, body: `From ${m.type.toUpperCase()} meeting #${m.number}`, projectId, taskId: t.id, href: taskHref(projectId, t.id) }]);
      return;
    }
  }
  const phaseKey = await currentPhaseKey(tx, projectId);
  const [max] = await tx.select({ m: sql<number>`coalesce(max(${schema.task.sortOrder}), -1)::int` }).from(schema.task).where(and(eq(schema.task.projectId, projectId), eq(schema.task.phaseKey, phaseKey)));
  const id = randomUUID();
  await tx.insert(schema.task).values({ id, projectId, phaseKey, title, role: "PM", description: `Action item from ${m.type.toUpperCase()} meeting #${m.number}.`, assigneeId: item.assigneeId, dueOn: item.dueOn, dueManual: !!item.dueOn, sortOrder: (max?.m ?? -1) + 1, createdById: actor.id });
  await tx.update(schema.meetingItem).set({ taskId: id }).where(eq(schema.meetingItem.id, item.id));
  if (item.assigneeId) await notify(tx, actor.id, [{ userId: item.assigneeId, kind: "assigned", title: `Assigned: “${title}”`, body: `From ${m.type.toUpperCase()} meeting #${m.number}`, projectId, taskId: id, href: taskHref(projectId, id) }]);
}

export const meetingsRouter = router({
  list: projectProcedure().query(async ({ ctx, input }) => {
    internal(ctx.project);
    const rows = await ctx.db.select().from(schema.meeting).where(eq(schema.meeting.projectId, input.projectId)).orderBy(desc(schema.meeting.heldOn), desc(schema.meeting.number));
    const counts = rows.length
      ? await ctx.db
          .select({ id: schema.meetingItem.meetingId, open: sql<number>`(count(*) filter (where ${schema.meetingItem.kind} = 'action' and ${schema.meetingItem.status} = 'open' and ${schema.task.status} is distinct from 'done'))::int` })
          .from(schema.meetingItem)
          .leftJoin(schema.task, eq(schema.task.id, schema.meetingItem.taskId))
          .where(inArray(schema.meetingItem.meetingId, rows.map((r) => r.id)))
          .groupBy(schema.meetingItem.meetingId)
      : [];
    return rows.map((r) => ({ id: r.id, type: r.type, number: r.number, title: r.title, heldOn: r.heldOn, attendees: r.attendees.length, openActions: counts.find((c) => c.id === r.id)?.open ?? 0 }));
  }),

  get: projectProcedure()
    .input(z.object({ id: z.uuid() }))
    .query(async ({ ctx, input }) => {
      internal(ctx.project);
      const m = await loadMeeting(ctx.db, input.projectId, input.id);
      const items = await ctx.db
        .select({ item: schema.meetingItem, assigneeName: schema.user.name, taskStatus: schema.task.status })
        .from(schema.meetingItem)
        .leftJoin(schema.user, eq(schema.user.id, schema.meetingItem.assigneeId))
        .leftJoin(schema.task, eq(schema.task.id, schema.meetingItem.taskId))
        .where(eq(schema.meetingItem.meetingId, m.id))
        .orderBy(asc(schema.meetingItem.sortOrder), asc(schema.meetingItem.createdAt));
      return { meeting: m, items: items.map((i) => ({ ...i.item, status: meetingItemStatus({ status: i.item.status, taskStatus: i.taskStatus }), assigneeName: i.assigneeName, taskStatus: i.taskStatus })), canEdit: ctx.project.can("checklist.edit") };
    }),

  /** A new meeting carries the open action items of the last meeting of the same type forward. */
  create: projectProcedure("checklist.edit")
    .input(z.object({ type: meetingType, heldOn: date, title: text(160) }))
    .mutation(async ({ ctx, input }) => {
      return ctx.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`meeting:${input.projectId}:${input.type}`}))`);
        const [last] = await tx.select().from(schema.meeting).where(and(eq(schema.meeting.projectId, input.projectId), eq(schema.meeting.type, input.type))).orderBy(desc(schema.meeting.number)).limit(1);
        const [m] = await tx
          .insert(schema.meeting)
          .values({ projectId: input.projectId, type: input.type, number: (last?.number ?? 0) + 1, heldOn: input.heldOn, title: input.title || null, attendees: last?.attendees ?? [], createdById: ctx.viewer.id })
          .returning();
        if (last) {
          const previous = await tx
            .select({ item: schema.meetingItem, taskStatus: schema.task.status })
            .from(schema.meetingItem)
            .leftJoin(schema.task, eq(schema.task.id, schema.meetingItem.taskId))
            .where(eq(schema.meetingItem.meetingId, last.id))
            .orderBy(asc(schema.meetingItem.sortOrder));
          const open = carryForward(previous.map((r) => ({ ...r.item, taskStatus: r.taskStatus })));
          if (open.length) {
            await tx.insert(schema.meetingItem).values(open.map((i, n) => ({ meetingId: m!.id, kind: i.kind, text: i.text, assigneeId: i.assigneeId, dueOn: i.dueOn, taskId: i.taskId, carriedFromId: i.id, status: "open" as const, sortOrder: n })));
            // The earlier minutes keep the item, marked as carried to this meeting (not done).
            await tx.update(schema.meetingItem).set({ status: "carried" }).where(inArray(schema.meetingItem.id, open.map((i) => i.id)));
          }
        }
        await recordAudit(tx, { actorId: ctx.viewer.id, actorName: ctx.viewer.name, action: "create", entityType: "meeting", entityId: m!.id, projectId: input.projectId, summary: `${ctx.viewer.name} started ${input.type.toUpperCase()} meeting #${m!.number}`, ip: ctx.ip });
        return { id: m!.id };
      });
    }),

  update: projectProcedure("checklist.edit")
    .input(z.object({ id: z.uuid(), version: z.number().int().min(1), title: text(160), heldOn: date, attendees: z.array(attendee).max(60), agenda: text(8000), notes: text(20000) }))
    .mutation(async ({ ctx, input }) => {
      const r = await ctx.db
        .update(schema.meeting)
        .set({ title: input.title || null, heldOn: input.heldOn, attendees: input.attendees, agenda: input.agenda || null, notes: input.notes || null, version: sql`${schema.meeting.version} + 1`, updatedAt: new Date() })
        .where(and(eq(schema.meeting.id, input.id), eq(schema.meeting.projectId, input.projectId), eq(schema.meeting.version, input.version)))
        .returning({ version: schema.meeting.version });
      if (!r.length) throw conflict();
      return r[0]!;
    }),

  saveItem: projectProcedure("checklist.edit")
    .input(z.object({ meetingId: z.uuid(), id: z.uuid().optional(), kind: z.enum(["note", "action"]), text: z.string().trim().min(1).max(1000), assigneeId: z.string().max(64).nullable(), dueOn: date.nullable(), status: z.enum(["open", "closed"]).default("open") }))
    .mutation(async ({ ctx, input }) => {
      return ctx.db.transaction(async (tx) => {
        const m = await loadMeeting(tx, input.projectId, input.meetingId);
        if (input.kind === "action" && (!input.assigneeId || !input.dueOn)) throw new TRPCError({ code: "BAD_REQUEST", message: "An action item needs someone and a due date." });
        if (input.assigneeId) {
          const [mem] = await tx.select().from(schema.projectMember).where(and(eq(schema.projectMember.projectId, input.projectId), eq(schema.projectMember.userId, input.assigneeId)));
          const [owner] = await tx.select().from(schema.user).where(and(eq(schema.user.id, input.assigneeId), eq(schema.user.role, "owner")));
          if (!mem && !owner) throw new TRPCError({ code: "BAD_REQUEST", message: "That person isn't on this project." });
        }
        const values = { kind: input.kind, text: input.text, assigneeId: input.kind === "action" ? input.assigneeId : null, dueOn: input.kind === "action" ? input.dueOn : null, status: input.status };
        let item: typeof schema.meetingItem.$inferSelect;
        if (input.id) {
          const [was] = await tx.select({ status: schema.meetingItem.status }).from(schema.meetingItem).where(and(eq(schema.meetingItem.id, input.id), eq(schema.meetingItem.meetingId, m.id)));
          if (was?.status === "carried") throw new TRPCError({ code: "BAD_REQUEST", message: "This item moved on to the next meeting. Edit it there." });
          const [row] = await tx.update(schema.meetingItem).set(values).where(and(eq(schema.meetingItem.id, input.id), eq(schema.meetingItem.meetingId, m.id))).returning();
          if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Item not found" });
          item = row;
        } else {
          const [max] = await tx.select({ n: sql<number>`coalesce(max(${schema.meetingItem.sortOrder}), -1)::int` }).from(schema.meetingItem).where(eq(schema.meetingItem.meetingId, m.id));
          [item] = await tx.insert(schema.meetingItem).values({ meetingId: m.id, ...values, sortOrder: (max?.n ?? -1) + 1 }).returning() as [typeof schema.meetingItem.$inferSelect];
        }
        await syncActionTask(tx, input.projectId, m, item, { id: ctx.viewer.id, name: ctx.viewer.name });
        return { id: item.id };
      });
    }),

  deleteItem: projectProcedure("checklist.edit")
    .input(z.object({ id: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [row] = await ctx.db
        .select({ id: schema.meetingItem.id })
        .from(schema.meetingItem)
        .innerJoin(schema.meeting, eq(schema.meeting.id, schema.meetingItem.meetingId))
        .where(and(eq(schema.meetingItem.id, input.id), eq(schema.meeting.projectId, input.projectId)));
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Item not found" });
      // The task (if any) stays: work that was assigned isn't silently deleted.
      await ctx.db.delete(schema.meetingItem).where(eq(schema.meetingItem.id, row.id));
      return { ok: true };
    }),
});
