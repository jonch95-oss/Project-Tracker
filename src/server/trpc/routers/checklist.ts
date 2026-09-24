import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { cyclePath, unmetDependencies } from "@/core/deps";
import type { ProjectTypeKey } from "@/core/labels";
import { phaseKeyFor } from "@/core/phases";
import { dueRuleSchema } from "@/core/template-schema";
import { mergeConditionalParts, projectToTemplate, type DueRule, type Recurrence } from "@/core/templates";
import { isToggleKey, irrelevantToggles } from "@/core/toggles";
import { isIsoDate, todayET } from "@/core/time";
import { schema, type DbOrTx } from "../../db";
import { recordAudit } from "../../services/audit";
import { applyTemplateUpdate, applyToggles, assertValidTemplate, loadTemplate, describeDiff, effectiveToggles, lockProject, previewToggles, projectEdges, reschedule, templateUpdatePreview, unmetPrerequisites } from "../../services/checklist";
import { afterCompleted, notify, resolveApprover, sharedTaskIds, taskHref, undoRecurrence } from "../../services/tasks";
import { projectPeople } from "./tasks";
import { projectProcedure, router, type AuthedContext, type ProjectAccess } from "../init";

type Ctx = AuthedContext & { project: ProjectAccess };

const taskConflict = () => new TRPCError({ code: "CONFLICT", message: "Someone else changed this task a moment ago. It has been refreshed; try again." });

async function loadTask(tx: DbOrTx, projectId: string, taskId: string) {
  const [t] = await tx.select().from(schema.task).where(and(eq(schema.task.id, taskId), eq(schema.task.projectId, projectId)));
  if (!t) throw new TRPCError({ code: "NOT_FOUND", message: "Task not found" });
  return t;
}

/** Outside collaborators only see tasks assigned to them or shared with them as a watcher (brief §4). */
function canSeeTask(ctx: Ctx, t: { id: string; assigneeId: string | null }, shared: ReadonlySet<string>): boolean {
  return ctx.project.can("task.viewAll") || t.assigneeId === ctx.viewer.id || shared.has(t.id);
}

async function sharedFor(ctx: Ctx, tx: DbOrTx): Promise<Set<string>> {
  return ctx.project.can("task.viewAll") ? new Set() : sharedTaskIds(tx, ctx.project.projectId, ctx.viewer.id);
}

/** Working a task: the internal team on the project, or whoever it's assigned to. */
function canWorkTask(ctx: Ctx, t: { assigneeId: string | null }): boolean {
  return ctx.project.can("checklist.edit") || ctx.project.can("task.viewAll") || t.assigneeId === ctx.viewer.id;
}

async function bumpTask(tx: DbOrTx, id: string, version: number, set: Partial<typeof schema.task.$inferInsert>) {
  const r = await tx
    .update(schema.task)
    .set({ ...set, version: sql`${schema.task.version} + 1`, updatedAt: new Date() })
    .where(and(eq(schema.task.id, id), eq(schema.task.version, version)))
    .returning({ version: schema.task.version });
  if (r.length === 0) throw taskConflict();
  return r[0]!.version;
}

async function audit(tx: DbOrTx, ctx: Ctx, summary: string, entityId: string, data?: unknown, action: "create" | "update" | "delete" | "approve" = "update") {
  await recordAudit(tx, { actorId: ctx.viewer.id, actorName: ctx.viewer.name, action, entityType: "task", entityId, projectId: ctx.project.projectId, summary, data, ip: ctx.ip });
}

const toggleList = z.array(z.string().min(1).max(60)).max(30);

export const checklistRouter = router({
  /** Phases, tasks, dependencies and why each blocked task is blocked. */
  get: projectProcedure().query(async ({ ctx, input }) => {
    const c = ctx as Ctx;
    const [project] = await ctx.db.select({ type: schema.project.type, toggles: schema.project.toggles, templateId: schema.project.templateId, templateVersion: schema.project.templateVersion }).from(schema.project).where(eq(schema.project.id, input.projectId));
    const phases = await ctx.db.select().from(schema.projectPhase).where(eq(schema.projectPhase.projectId, input.projectId)).orderBy(asc(schema.projectPhase.sortOrder));
    const all = await ctx.db
      .select({
        id: schema.task.id,
        phaseKey: schema.task.phaseKey,
        templateKey: schema.task.templateKey,
        title: schema.task.title,
        description: schema.task.description,
        role: schema.task.role,
        assigneeId: schema.task.assigneeId,
        assigneeName: schema.user.name,
        status: schema.task.status,
        priority: schema.task.priority,
        blockedReason: schema.task.blockedReason,
        waitingOnParty: schema.task.waitingOn,
        followUpOn: schema.task.followUpOn,
        approvalDecision: schema.task.approvalDecision,
        approvalNote: schema.task.approvalNote,
        approverId: schema.task.approverId,
        dueOn: schema.task.dueOn,
        dueRule: schema.task.dueRule,
        dueManual: schema.task.dueManual,
        requiresApproval: schema.task.requiresApproval,
        approverRole: schema.task.approverRole,
        requiredAttachment: schema.task.requiredAttachment,
        subItems: schema.task.subItems,
        recurrence: schema.task.recurrence,
        killScreen: schema.task.killScreen,
        milestone: schema.task.milestone,
        toggleSource: schema.task.toggleSource,
        sortOrder: schema.task.sortOrder,
        version: schema.task.version,
        completedOn: schema.task.completedOn,
      })
      .from(schema.task)
      .leftJoin(schema.user, eq(schema.user.id, schema.task.assigneeId))
      .where(eq(schema.task.projectId, input.projectId))
      .orderBy(asc(schema.task.sortOrder), asc(schema.task.createdAt));
    const shared = await sharedFor(c, ctx.db);
    const visible = all.filter((t) => canSeeTask(c, t, shared));
    const visibleIds = new Set(visible.map((t) => t.id));
    const edges = await projectEdges(ctx.db, input.projectId);
    const done = new Set(all.filter((t) => t.status === "done").map((t) => t.id));
    const titles = new Map(all.map((t) => [t.id, t.title]));
    const [tpl] = project?.templateId ? await ctx.db.select({ name: schema.template.name, version: schema.template.version }).from(schema.template).where(eq(schema.template.id, project.templateId)) : [];
    return {
      toggles: project?.toggles ?? [],
      impliedToggles: [...effectiveToggles(project!.type as ProjectTypeKey, [])],
      hiddenToggles: irrelevantToggles(project!.type as ProjectTypeKey),
      template: tpl ? { name: tpl.name, latestVersion: tpl.version, projectVersion: project!.templateVersion } : null,
      phases: phases.map((p) => ({ key: p.key, name: p.name, status: p.status, startedOn: p.startedOn, completedOn: p.completedOn, sortOrder: p.sortOrder })),
      tasks: visible.map((t) => {
        const deps = edges.get(t.id) ?? [];
        return {
          ...t,
          dueRule: t.dueRule as DueRule | null,
          recurrence: t.recurrence as Recurrence | null,
          // Only dependencies the viewer can see are named; the rest are counted.
          dependsOn: deps.filter((d) => visibleIds.has(d)),
          waitingOn: unmetDependencies(edges, t.id, (id) => done.has(id)).map((id) => (visibleIds.has(id) ? { id, title: titles.get(id)! } : { id: null, title: "A task you can't see" })),
        };
      }),
      // For assigning and bulk reassigning; only checklist editors get the list.
      people: ctx.project.can("checklist.edit") ? (await projectPeople(ctx.db, input.projectId)).map((p) => ({ id: p.id, name: p.name, projectRole: p.projectRole, external: p.external })) : [],
      access: {
        canEdit: ctx.project.can("checklist.edit"),
        canApprove: ctx.project.can("task.approve"),
      },
    };
  }),

  /**
   * One-tap complete (and undo). A task with unfinished prerequisites can't be
   * completed; the error names them. A task that needs approval goes to
   * "Awaiting approval" unless the person checking it off can approve.
   */
  setDone: projectProcedure()
    .input(z.object({ taskId: z.uuid(), done: z.boolean(), version: z.number().int().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      return ctx.db.transaction(async (tx) => {
        const t = await loadTask(tx, input.projectId, input.taskId);
        const shared = await sharedFor(c, tx);
        if (!canSeeTask(c, t, shared)) throw new TRPCError({ code: "NOT_FOUND", message: "Task not found" });
        if (!canWorkTask(c, t)) throw new TRPCError({ code: "FORBIDDEN" });
        if (input.done) {
          if (t.status === "done") return { status: "done" as const, version: t.version };
          const unmet = await unmetPrerequisites(tx, t.id);
          if (unmet.length) {
            // Only name prerequisites this person can see; count the rest.
            const seeAll = ctx.project.can("task.viewAll");
            const vis = seeAll ? unmet.map((u) => u.id) : (await tx.select({ id: schema.task.id, assigneeId: schema.task.assigneeId }).from(schema.task).where(inArray(schema.task.id, unmet.map((u) => u.id)))).filter((r) => canSeeTask(c, r, shared)).map((r) => r.id);
            const named = unmet.filter((u) => vis.includes(u.id));
            const hidden = unmet.length - named.length;
            const parts = [...named.map((u) => u.title), ...(hidden ? [`${hidden} other task${hidden === 1 ? "" : "s"} on the project`] : [])];
            throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Waiting on: ${parts.join("; ")}. Finish ${unmet.length === 1 ? "it" : "those"} first.` });
          }
          const today = todayET();
          if (t.requiresApproval && !ctx.project.can("task.approve")) {
            if (t.status === "awaiting_approval") return { status: "awaiting_approval" as const, version: t.version };
            const approverId = await resolveApprover(tx, t);
            const version = await bumpTask(tx, t.id, input.version, { status: "awaiting_approval", approverId, approvalRequestedAt: new Date(), approvalDecision: null, approvalNote: null, waitingOn: null, waitingSince: null, followUpOn: null, blockedReason: null });
            await audit(tx, c, `${ctx.viewer.name} sent "${t.title}" for approval`, t.id, { status: "awaiting_approval", approverId });
            if (approverId) {
              const [p] = await tx.select({ name: schema.project.name }).from(schema.project).where(eq(schema.project.id, input.projectId));
              await notify(tx, ctx.viewer.id, [{ userId: approverId, kind: "approval_requested", title: `${ctx.viewer.name} needs your approval on “${t.title}”`, body: p?.name ?? null, projectId: input.projectId, taskId: t.id, href: taskHref(input.projectId, t.id) }]);
            }
            return { status: "awaiting_approval" as const, version };
          }
          // The person ticking it can approve: their tick is the approval.
          const version = await bumpTask(tx, t.id, input.version, {
            status: "done",
            completedOn: today,
            completedAt: new Date(),
            completedById: ctx.viewer.id,
            waitingOn: null,
            waitingSince: null,
            followUpOn: null,
            blockedReason: null,
            ...(t.requiresApproval ? { approvalDecision: "approved" as const, approvalDecidedAt: new Date(), approvalDecidedById: ctx.viewer.id, approvalNote: null } : {}),
          });
          await audit(tx, c, `${ctx.viewer.name} completed "${t.title}"${t.requiresApproval ? " (approved)" : ""}`, t.id, { status: "done" }, t.requiresApproval ? "approve" : "update");
          const [fresh] = await tx.select().from(schema.task).where(eq(schema.task.id, t.id));
          const { nextId } = await afterCompleted(tx, fresh!, ctx.viewer.id, today);
          return { status: "done" as const, version, nextId };
        }
        if (t.status !== "done") return { status: t.status, version: t.version };
        if (t.requiresApproval && !ctx.project.can("task.approve")) {
          throw new TRPCError({ code: "FORBIDDEN", message: "This task was approved. Only someone who can approve can reopen it." });
        }
        const version = await bumpTask(tx, t.id, input.version, { status: "not_started", completedOn: null, completedAt: null, completedById: null, approvalDecision: null, approvalDecidedAt: null, approvalDecidedById: null });
        await undoRecurrence(tx, t);
        await audit(tx, c, `${ctx.viewer.name} reopened "${t.title}"`, t.id, { status: "not_started" });
        // Tasks dated relative to this one go back to its due date.
        await reschedule(tx, input.projectId);
        return { status: "not_started" as const, version };
      });
    }),

  addTask: projectProcedure("checklist.edit")
    .input(z.object({ phaseKey: z.string().min(1).max(60), title: z.string().trim().min(1).max(200), role: z.string().trim().min(1).max(60).default("PM"), dueOn: z.iso.date().nullish(), description: z.string().trim().max(4000).nullish() }))
    .mutation(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      return ctx.db.transaction(async (tx) => {
        const [ph] = await tx.select().from(schema.projectPhase).where(and(eq(schema.projectPhase.projectId, input.projectId), eq(schema.projectPhase.key, input.phaseKey)));
        if (!ph) throw new TRPCError({ code: "BAD_REQUEST", message: "That phase isn't on this project." });
        const [max] = await tx.select({ m: sql<number>`coalesce(max(${schema.task.sortOrder}), -1)::int` }).from(schema.task).where(and(eq(schema.task.projectId, input.projectId), eq(schema.task.phaseKey, input.phaseKey)));
        const id = randomUUID();
        await tx.insert(schema.task).values({ id, projectId: input.projectId, phaseKey: input.phaseKey, title: input.title, role: input.role, description: input.description ?? null, dueOn: input.dueOn ?? null, dueManual: !!input.dueOn, sortOrder: (max?.m ?? -1) + 1, createdById: ctx.viewer.id });
        await audit(tx, c, `${ctx.viewer.name} added "${input.title}" to ${ph.name}`, id, undefined, "create");
        return { id };
      });
    }),

  /** Rename, re-describe, re-role, re-date or move a task to another phase. */
  updateTask: projectProcedure("checklist.edit")
    .input(
      z.object({
        taskId: z.uuid(),
        version: z.number().int().min(1),
        title: z.string().trim().min(1).max(200).optional(),
        description: z.string().trim().max(4000).nullish(),
        role: z.string().trim().min(1).max(60).optional(),
        phaseKey: z.string().min(1).max(60).optional(),
        /** A date sets it by hand; null clears it and goes back to the rule. */
        dueOn: z.iso.date().nullish(),
        dueRule: dueRuleSchema.nullish(),
        requiresApproval: z.boolean().optional(),
        approverRole: z.string().trim().max(60).nullish(),
        subItems: z.array(z.object({ id: z.string().min(1).max(40), text: z.string().trim().min(1).max(200), done: z.boolean() })).max(50).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      return ctx.db.transaction(async (tx) => {
        const t = await loadTask(tx, input.projectId, input.taskId);
        const touchesApproval =
          (input.requiresApproval !== undefined && input.requiresApproval !== t.requiresApproval) || (input.approverRole !== undefined && (input.approverRole ?? null) !== t.approverRole);
        if (touchesApproval && !ctx.project.can("task.approve")) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Only someone who can approve tasks can change a task's approval." });
        }
        if (touchesApproval && t.status === "awaiting_approval") {
          throw new TRPCError({ code: "BAD_REQUEST", message: "This task is waiting for approval. Approve or send it back first." });
        }
        const set: Partial<typeof schema.task.$inferInsert> = {};
        if (input.title !== undefined) set.title = input.title;
        if (input.description !== undefined) set.description = input.description ?? null;
        if (input.role !== undefined) set.role = input.role;
        if (input.requiresApproval !== undefined) set.requiresApproval = input.requiresApproval;
        if (input.approverRole !== undefined) set.approverRole = input.approverRole ?? null;
        if (input.subItems !== undefined) set.subItems = input.subItems;
        if (input.phaseKey !== undefined && input.phaseKey !== t.phaseKey) {
          const [ph] = await tx.select().from(schema.projectPhase).where(and(eq(schema.projectPhase.projectId, input.projectId), eq(schema.projectPhase.key, input.phaseKey)));
          if (!ph) throw new TRPCError({ code: "BAD_REQUEST", message: "That phase isn't on this project." });
          const [max] = await tx.select({ m: sql<number>`coalesce(max(${schema.task.sortOrder}), -1)::int` }).from(schema.task).where(and(eq(schema.task.projectId, input.projectId), eq(schema.task.phaseKey, input.phaseKey)));
          set.phaseKey = input.phaseKey;
          set.sortOrder = (max?.m ?? -1) + 1;
        }
        if (input.dueRule !== undefined) set.dueRule = input.dueRule;
        if (input.dueOn !== undefined) {
          if (input.dueOn && !isIsoDate(input.dueOn)) throw new TRPCError({ code: "BAD_REQUEST", message: "Not a date" });
          set.dueOn = input.dueOn ?? null;
          set.dueManual = !!input.dueOn;
        }
        if (input.requiresApproval && !(input.approverRole ?? t.approverRole)) set.approverRole = "Owner";
        const version = await bumpTask(tx, t.id, input.version, set);
        const changed = Object.keys(set).filter((k) => k !== "sortOrder");
        await audit(tx, c, `${ctx.viewer.name} edited "${set.title ?? t.title}"`, t.id, { changed });
        if (set.dueOn === null || set.dueRule !== undefined || set.phaseKey) await reschedule(tx, input.projectId);
        return { version };
      });
    }),

  deleteTask: projectProcedure("checklist.edit")
    .input(z.object({ taskId: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      await ctx.db.transaction(async (tx) => {
        const t = await loadTask(tx, input.projectId, input.taskId);
        await tx.delete(schema.task).where(eq(schema.task.id, t.id));
        await audit(tx, c, `${ctx.viewer.name} deleted "${t.title}"`, t.id, { status: t.status }, "delete");
      });
      return { ok: true };
    }),

  /** New order for the tasks of one phase (all of them, top to bottom). */
  reorder: projectProcedure("checklist.edit")
    .input(z.object({ phaseKey: z.string().min(1).max(60), taskIds: z.array(z.uuid()).max(1000) }))
    .mutation(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      await ctx.db.transaction(async (tx) => {
        const rows = await tx.select({ id: schema.task.id }).from(schema.task).where(and(eq(schema.task.projectId, input.projectId), eq(schema.task.phaseKey, input.phaseKey)));
        const have = new Set(rows.map((r) => r.id));
        if (rows.length !== input.taskIds.length || !input.taskIds.every((id) => have.has(id))) {
          throw new TRPCError({ code: "CONFLICT", message: "The checklist changed while you were reordering. It has been refreshed; try again." });
        }
        for (const [i, id] of input.taskIds.entries()) await tx.update(schema.task).set({ sortOrder: i }).where(eq(schema.task.id, id));
        await audit(tx, c, `${ctx.viewer.name} reordered tasks`, input.phaseKey, { phaseKey: input.phaseKey });
      });
      return { ok: true };
    }),

  /** Replace a task's prerequisites. Cycles are refused with the loop spelled out. */
  setDependencies: projectProcedure("checklist.edit")
    .input(z.object({ taskId: z.uuid(), dependsOnIds: z.array(z.uuid()).max(50) }))
    .mutation(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      await ctx.db.transaction(async (tx) => {
        // One structure change at a time per project, so two edits can't form a loop together.
        await lockProject(tx, input.projectId);
        const t = await loadTask(tx, input.projectId, input.taskId);
        const ids = [...new Set(input.dependsOnIds)];
        if (ids.length) {
          const found = await tx.select({ id: schema.task.id, title: schema.task.title }).from(schema.task).where(and(eq(schema.task.projectId, input.projectId), inArray(schema.task.id, ids)));
          if (found.length !== ids.length) throw new TRPCError({ code: "BAD_REQUEST", message: "A prerequisite isn't on this project." });
        }
        const edges = await projectEdges(tx, input.projectId);
        edges.set(t.id, []); // replacing this task's edges
        const titles = new Map((await tx.select({ id: schema.task.id, title: schema.task.title }).from(schema.task).where(eq(schema.task.projectId, input.projectId))).map((r) => [r.id, r.title]));
        for (const d of ids) {
          const loop = cyclePath(edges, t.id, d);
          if (loop) throw new TRPCError({ code: "BAD_REQUEST", message: `That would make a loop: ${loop.map((x) => titles.get(x) ?? "?").join(" → ")}.` });
          edges.set(t.id, [...(edges.get(t.id) ?? []), d]);
        }
        await tx.delete(schema.taskDependency).where(eq(schema.taskDependency.taskId, t.id));
        if (ids.length) await tx.insert(schema.taskDependency).values(ids.map((d) => ({ taskId: t.id, dependsOnId: d })));
        await audit(tx, c, `${ctx.viewer.name} set the prerequisites of "${t.title}"`, t.id, { count: ids.length });
      });
      return { ok: true };
    }),

  /** What turning toggles on/off would add and remove (the live preview). */
  previewToggles: projectProcedure("checklist.edit")
    .input(z.object({ toggles: toggleList }))
    .query(async ({ ctx, input }) => {
      for (const k of input.toggles) if (!isToggleKey(k)) throw new TRPCError({ code: "BAD_REQUEST", message: `Unknown toggle: ${k}` });
      const p = await previewToggles(ctx.db, input.projectId, input.toggles);
      return {
        add: p.add.map((k) => ({ key: k.key, title: k.title, phase: p.phaseNames[k.phaseKey] ?? k.phaseKey })),
        remove: p.remove.map((t) => ({ id: t.id, title: t.title, phase: p.phaseNames[t.phaseKey] ?? t.phaseKey })),
        ask: p.ask.map((t) => ({ id: t.id, title: t.title, phase: p.phaseNames[t.phaseKey] ?? t.phaseKey })),
        phasesAdded: p.phasesAdded.map((ph) => ph.name),
        phasesRemoved: p.phasesRemoved.map((k) => p.phaseNames[k] ?? k),
      };
    }),

  setToggles: projectProcedure("checklist.edit")
    .input(z.object({ toggles: toggleList, removeStarted: z.array(z.uuid()).max(500).default([]), expectedToggles: toggleList.optional() }))
    .mutation(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      for (const k of input.toggles) if (!isToggleKey(k)) throw new TRPCError({ code: "BAD_REQUEST", message: `Unknown toggle: ${k}` });
      return ctx.db.transaction(async (tx) => {
        await lockProject(tx, input.projectId);
        const [before] = await tx.select({ toggles: schema.project.toggles }).from(schema.project).where(eq(schema.project.id, input.projectId));
        // The preview was made against these conditions; if someone changed them since, start over.
        if (input.expectedToggles && [...input.expectedToggles].sort().join() !== [...before!.toggles].sort().join()) {
          throw new TRPCError({ code: "CONFLICT", message: "Someone else changed the site conditions a moment ago. Reopen the dialog to see the current ones." });
        }
        const out = await applyToggles(tx, input.projectId, [...new Set(input.toggles)], input.removeStarted, ctx.viewer.id);
        const on = input.toggles.filter((k) => !before!.toggles.includes(k));
        const off = before!.toggles.filter((k) => !input.toggles.includes(k));
        await recordAudit(tx, {
          actorId: ctx.viewer.id,
          actorName: ctx.viewer.name,
          action: "update",
          entityType: "checklist",
          entityId: input.projectId,
          projectId: input.projectId,
          summary: `${ctx.viewer.name} changed the site conditions: ${[...on.map((k) => `+${k}`), ...off.map((k) => `−${k}`)].join(", ") || "no change"} (${out.added} tasks added, ${out.removed} removed)`,
          data: { on, off, ...out },
          ip: c.ip,
        });
        return out;
      });
    }),

  /** Tick a sub-checklist item: anyone who can work the task, no version race (one item, one atomic update). */
  setSubItem: projectProcedure()
    .input(z.object({ taskId: z.uuid(), itemId: z.string().min(1).max(40), done: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      return ctx.db.transaction(async (tx) => {
        const [t] = await tx.select().from(schema.task).where(and(eq(schema.task.id, input.taskId), eq(schema.task.projectId, input.projectId))).for("update");
        if (!t || !canSeeTask(c, t, await sharedFor(c, tx))) throw new TRPCError({ code: "NOT_FOUND", message: "Task not found" });
        if (!canWorkTask(c, t)) throw new TRPCError({ code: "FORBIDDEN" });
        if (!t.subItems.some((s) => s.id === input.itemId)) throw new TRPCError({ code: "NOT_FOUND", message: "That item was removed." });
        const items = t.subItems.map((s) => (s.id === input.itemId ? { ...s, done: input.done } : s));
        const [r] = await tx.update(schema.task).set({ subItems: items, version: sql`${schema.task.version} + 1`, updatedAt: new Date() }).where(eq(schema.task.id, t.id)).returning({ version: schema.task.version });
        return { version: r!.version };
      });
    }),

  /** Review what applying the template's latest version would change on this project. */
  templateUpdatePreview: projectProcedure("checklist.edit").query(async ({ ctx, input }) => {
    const p = await templateUpdatePreview(ctx.db, input.projectId);
    if (!p) throw new TRPCError({ code: "BAD_REQUEST", message: "This project wasn't made from a template." });
    return { fromVersion: p.fromVersion, toVersion: p.toVersion, templateName: p.templateName, ...describeDiff(p.diff) };
  }),

  applyTemplateUpdate: projectProcedure("checklist.edit")
    .input(z.object({ expectedVersion: z.number().int().min(1) }))
    .mutation(async ({ ctx, input }) => {
      return ctx.db.transaction(async (tx) => {
        const out = await applyTemplateUpdate(tx, input.projectId, ctx.viewer.id, input.expectedVersion);
        await recordAudit(tx, {
          actorId: ctx.viewer.id,
          actorName: ctx.viewer.name,
          action: "update",
          entityType: "checklist",
          entityId: input.projectId,
          projectId: input.projectId,
          summary: `${ctx.viewer.name} applied the latest template: ${out.added} added, ${out.removed} removed, ${out.changed} changed`,
          data: out,
          ip: ctx.ip,
        });
        return out;
      });
    }),

  renamePhase: projectProcedure("checklist.edit")
    .input(z.object({ key: z.string().min(1).max(60), name: z.string().trim().min(1).max(80) }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.transaction(async (tx) => {
        const r = await tx.update(schema.projectPhase).set({ name: input.name }).where(and(eq(schema.projectPhase.projectId, input.projectId), eq(schema.projectPhase.key, input.key))).returning({ id: schema.projectPhase.id });
        if (!r.length) throw new TRPCError({ code: "NOT_FOUND" });
        await recordAudit(tx, { actorId: ctx.viewer.id, actorName: ctx.viewer.name, action: "update", entityType: "project_phase", entityId: input.projectId, projectId: input.projectId, summary: `${ctx.viewer.name} renamed a phase to ${input.name}`, ip: ctx.ip });
      });
      return { ok: true };
    }),

  /** Add a custom phase after an existing one. */
  addPhase: projectProcedure("checklist.edit")
    .input(z.object({ name: z.string().trim().min(1).max(80), afterKey: z.string().min(1).max(60) }))
    .mutation(async ({ ctx, input }) => {
      return ctx.db.transaction(async (tx) => {
        const phases = await tx.select().from(schema.projectPhase).where(eq(schema.projectPhase.projectId, input.projectId)).orderBy(asc(schema.projectPhase.sortOrder));
        const at = phases.findIndex((p) => p.key === input.afterKey);
        if (at === -1) throw new TRPCError({ code: "BAD_REQUEST", message: "That phase isn't on this project." });
        const key = phaseKeyFor(input.name, phases.map((p) => p.key));
        const allDone = phases.every((p) => p.status === "done" || p.status === "skipped");
        const ordered = [...phases.slice(0, at + 1), null, ...phases.slice(at + 1)];
        for (const [i, p] of ordered.entries()) if (p && p.sortOrder !== i) await tx.update(schema.projectPhase).set({ sortOrder: i }).where(eq(schema.projectPhase.id, p.id));
        await tx.insert(schema.projectPhase).values({ projectId: input.projectId, key, name: input.name, sortOrder: at + 1, status: allDone ? "active" : "pending", startedOn: allDone ? todayET() : null });
        await tx.update(schema.project).set({ version: sql`${schema.project.version} + 1` }).where(eq(schema.project.id, input.projectId));
        await recordAudit(tx, { actorId: ctx.viewer.id, actorName: ctx.viewer.name, action: "create", entityType: "project_phase", entityId: input.projectId, projectId: input.projectId, summary: `${ctx.viewer.name} added the phase ${input.name}`, ip: ctx.ip });
        return { key };
      });
    }),

  /** "Save as template": this project's phases and tasks become a new template. */
  saveAsTemplate: projectProcedure("checklist.edit")
    .input(z.object({ name: z.string().trim().min(1).max(120) }))
    .mutation(async ({ ctx, input }) => {
      if (ctx.actor.role !== "owner" && ctx.actor.role !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: "Only the owner or an admin can create templates." });
      return ctx.db.transaction(async (tx) => {
        const [p] = await tx.select().from(schema.project).where(eq(schema.project.id, input.projectId));
        const phases = await tx.select().from(schema.projectPhase).where(eq(schema.projectPhase.projectId, input.projectId)).orderBy(asc(schema.projectPhase.sortOrder));
        const tasks = await tx.select().from(schema.task).where(eq(schema.task.projectId, input.projectId)).orderBy(asc(schema.task.sortOrder));
        const edges = await projectEdges(tx, input.projectId);
        const source = p!.templateId ? await loadTemplate(tx, p!.templateId) : null;
        const def0 = projectToTemplate({
          name: input.name,
          projectType: p!.type as ProjectTypeKey,
          description: `Saved from ${p!.name}.`,
          phases: phases.map((x) => {
            const sp = source?.def.phases.find((y) => y.key === x.key);
            return { key: x.key, name: x.name, status: x.status, startedOn: x.startedOn, showIf: sp?.showIf, hideIf: sp?.hideIf };
          }),
          tasks: tasks.map((t) => ({
            id: t.id,
            templateKey: t.templateKey,
            phaseKey: t.phaseKey,
            title: t.title,
            description: t.description,
            role: t.role,
            dueOn: t.dueOn,
            due: t.dueRule as DueRule | null,
            requiresApproval: t.requiresApproval,
            approverRole: t.approverRole,
            dependsOnIds: edges.get(t.id) ?? [],
            subItems: t.subItems.map((s) => s.text),
            requiredAttachment: t.requiredAttachment,
            recurrence: t.recurrence as Recurrence | null,
            toggleSource: t.toggleSource,
            killScreen: t.killScreen,
            milestone: t.milestone,
            hideIf: source?.def.tasks.find((k) => k.key === t.templateKey)?.hideIf,
          })),
        });
        const def = mergeConditionalParts(def0, source?.def ?? null);
        assertValidTemplate(def);
        const [row] = await tx.insert(schema.template).values({ name: input.name, projectType: def.projectType, definition: def, createdById: ctx.viewer.id }).returning({ id: schema.template.id });
        await tx.insert(schema.templateRevision).values({ templateId: row!.id, version: 1, definition: def, savedById: ctx.viewer.id });
        await recordAudit(tx, { actorId: ctx.viewer.id, actorName: ctx.viewer.name, action: "create", entityType: "template", entityId: row!.id, projectId: input.projectId, summary: `${ctx.viewer.name} saved ${p!.name} as the template ${input.name}`, ip: ctx.ip });
        return { templateId: row!.id };
      });
    }),
});
