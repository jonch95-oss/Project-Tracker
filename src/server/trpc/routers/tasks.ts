import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { planDate } from "../dates";
import { addBusinessDays } from "@/core/calendar";
import { KEY_DATE_KINDS, keyDateLabel, upcomingKeyDates } from "@/core/key-dates";
import { expiryLabel, FINANCIAL_EXPIRY } from "@/core/expiries";
import { commentPlainText, mentionedIds } from "@/core/mentions";
import { canGlobal, canProject, type Membership, isInternalRole } from "@/core/permissions";
import { canSetStatus, MY_TASK_SECTIONS, myTaskSection, shiftDate, TASK_STATUS_LABEL, type MyTaskSection, type TaskStatus } from "@/core/tasks";
import { todayET } from "@/core/time";
import { schema, type DbOrTx } from "../../db";
import { recordAudit } from "../../services/audit";
import { reschedule } from "../../services/checklist";
import { afterCompleted, canDecideApproval, FOLLOW_UP_DAYS, notify, sharedTaskIds, taskAudience, taskHref } from "../../services/tasks";
import { loadHeroes } from "./projects";
import { projectProcedure, protectedProcedure, router, type AuthedContext, type ProjectAccess } from "../init";

type Ctx = AuthedContext & { project: ProjectAccess };
type TaskRow = typeof schema.task.$inferSelect;

const taskConflict = () => new TRPCError({ code: "CONFLICT", message: "Someone else changed this task a moment ago. It has been refreshed; try again." });
const notFound = () => new TRPCError({ code: "NOT_FOUND", message: "Task not found" });

/** Outside collaborators see only tasks assigned to them or shared with them as a watcher (brief §4). */
async function visibleTask(ctx: Ctx, tx: DbOrTx, taskId: string, forUpdate = false): Promise<TaskRow> {
  const q = tx.select().from(schema.task).where(and(eq(schema.task.id, taskId), eq(schema.task.projectId, ctx.project.projectId)));
  const [t] = forUpdate ? await q.for("update") : await q;
  if (!t) throw notFound();
  if (ctx.project.can("task.viewAll") || t.assigneeId === ctx.viewer.id) return t;
  const shared = await sharedTaskIds(tx, ctx.project.projectId, ctx.viewer.id);
  if (!shared.has(t.id)) throw notFound();
  return t;
}

/** Working a task (status, comments): the internal team, or the person it's assigned to. Watchers can comment. */
function canWork(ctx: Ctx, t: TaskRow): boolean {
  return ctx.project.can("task.viewAll") || t.assigneeId === ctx.viewer.id;
}

async function bump(tx: DbOrTx, id: string, version: number, set: Partial<typeof schema.task.$inferInsert>): Promise<number> {
  const r = await tx
    .update(schema.task)
    .set({ ...set, version: sql`${schema.task.version} + 1`, updatedAt: new Date() })
    .where(and(eq(schema.task.id, id), eq(schema.task.version, version)))
    .returning({ version: schema.task.version });
  if (r.length === 0) throw taskConflict();
  return r[0]!.version;
}

async function audit(tx: DbOrTx, ctx: Ctx, summary: string, entityId: string, data?: unknown, action: "create" | "update" | "delete" | "approve" = "update", entityType = "task") {
  await recordAudit(tx, { actorId: ctx.viewer.id, actorName: ctx.viewer.name, action, entityType, entityId, projectId: ctx.project.projectId, summary, data, ip: ctx.ip });
}

export interface ProjectPerson {
  id: string;
  name: string;
  role: string;
  projectRole: string | null;
  external: boolean;
}

/** People on a project (members, plus owners and admins), for assigning, watching and @mentions. */
export async function projectPeople(conn: DbOrTx, projectId: string): Promise<ProjectPerson[]> {
  const members = await conn
    .select({ id: schema.user.id, name: schema.user.name, role: schema.user.role, projectRole: schema.projectMember.projectRole })
    .from(schema.projectMember)
    .innerJoin(schema.user, eq(schema.user.id, schema.projectMember.userId))
    // Investors and lenders read their portal; they are never given, shown or @mentioned on tasks.
    .where(and(eq(schema.projectMember.projectId, projectId), eq(schema.user.status, "active"), ne(schema.user.role, "investor")));
  // Owners and admins run every project, so they can always be given work here.
  const leads = await conn.select({ id: schema.user.id, name: schema.user.name, role: schema.user.role }).from(schema.user).where(and(inArray(schema.user.role, ["owner", "admin"]), eq(schema.user.status, "active")));
  const out = new Map<string, ProjectPerson>();
  for (const o of leads) if (o.role === "owner") out.set(o.id, { ...o, projectRole: "Owner", external: false });
  for (const m of members) if (!out.has(m.id)) out.set(m.id, { ...m, external: !isInternalRole(m.role) });
  for (const o of leads) if (!out.has(o.id)) out.set(o.id, { ...o, projectRole: "Admin", external: false });
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** People allowed to see a task: the internal team, its assignee and its watchers. */
function taskReaders(people: ProjectPerson[], t: Pick<TaskRow, "assigneeId">, watcherIds: string[]): ProjectPerson[] {
  return people.filter((p) => !p.external || p.id === t.assigneeId || watcherIds.includes(p.id));
}

async function requirePerson(conn: DbOrTx, projectId: string, userId: string): Promise<ProjectPerson> {
  const p = (await projectPeople(conn, projectId)).find((x) => x.id === userId);
  if (!p) throw new TRPCError({ code: "BAD_REQUEST", message: "That person isn't on this project. Add them on the Team tab first." });
  return p;
}

const statusInput = z.enum(["not_started", "in_progress", "waiting", "blocked"]);

/* ------------------------------------------------------------------ */
/* Cross-project reads                                                 */
/* ------------------------------------------------------------------ */

interface Access {
  projectIds: string[];
  memberships: Map<string, Membership>;
}

async function accessibleProjects(ctx: AuthedContext): Promise<Access> {
  const all = canGlobal(ctx.actor, "projects.viewAll");
  const rows = await ctx.db
    .select({ id: schema.project.id })
    .from(schema.project)
    .where(isNull(schema.project.archivedAt));
  const ms = await ctx.db
    .select({ projectId: schema.projectMember.projectId, projectRole: schema.projectMember.projectRole, canViewFinancials: schema.projectMember.canViewFinancials, canEditChecklist: schema.projectMember.canEditChecklist, canApprove: schema.projectMember.canApprove })
    .from(schema.projectMember)
    .where(eq(schema.projectMember.userId, ctx.actor.userId));
  const memberships = new Map(ms.map((m) => [m.projectId, m]));
  return { projectIds: rows.map((r) => r.id).filter((id) => all || memberships.has(id)), memberships };
}

async function heroes(conn: DbOrTx, projectIds: string[]) {
  if (projectIds.length === 0) return new Map<string, { id: string; width: number; height: number }>();
  const projects = await conn.select({ id: schema.project.id, heroPhotoId: schema.project.heroPhotoId }).from(schema.project).where(inArray(schema.project.id, projectIds));
  return loadHeroes(conn, projects);
}

/** Ids of open tasks with at least one unfinished prerequisite. */
async function waitingOnPrereqs(conn: DbOrTx, taskIds: string[]): Promise<Set<string>> {
  if (taskIds.length === 0) return new Set();
  const rows = await conn
    .selectDistinct({ id: schema.taskDependency.taskId })
    .from(schema.taskDependency)
    .innerJoin(schema.task, eq(schema.task.id, schema.taskDependency.dependsOnId))
    .where(and(inArray(schema.taskDependency.taskId, taskIds), ne(schema.task.status, "done")));
  return new Set(rows.map((r) => r.id));
}

/** Set many due dates (by hand) in one statement. Returns how many rows changed. */
async function setDueDates(tx: DbOrTx, moves: { id: string; due: string }[]): Promise<number> {
  if (moves.length === 0) return 0;
  const r = await tx.execute(sql`
    update ${schema.task} as t
    set due_on = v.due, due_manual = true, version = t.version + 1, updated_at = now()
    from jsonb_to_recordset(${JSON.stringify(moves)}::jsonb) as v(id uuid, due text)
    where t.id = v.id`);
  return r.rowCount ?? moves.length;
}

export const tasksRouter = router({
  /** Everything the task sheet shows beyond the checklist row: comments, watchers, people, approval. */
  detail: projectProcedure()
    .input(z.object({ taskId: z.uuid() }))
    .query(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      const t = await visibleTask(c, ctx.db, input.taskId);
      const people = await projectPeople(ctx.db, input.projectId);
      const watchers = (await ctx.db.select({ userId: schema.taskWatcher.userId }).from(schema.taskWatcher).where(eq(schema.taskWatcher.taskId, t.id))).map((w) => w.userId);
      const comments = await ctx.db
        .select({ id: schema.taskComment.id, authorId: schema.taskComment.authorId, authorName: schema.user.name, body: schema.taskComment.body, createdAt: schema.taskComment.createdAt, editedAt: schema.taskComment.editedAt, deletedAt: schema.taskComment.deletedAt })
        .from(schema.taskComment)
        .leftJoin(schema.user, eq(schema.user.id, schema.taskComment.authorId))
        .where(eq(schema.taskComment.taskId, t.id))
        .orderBy(asc(schema.taskComment.createdAt));
      const readers = taskReaders(people, t, watchers);
      const internal = ctx.project.can("task.viewAll");
      const name = (id: string | null) => (id ? (people.find((p) => p.id === id)?.name ?? "Former teammate") : null);
      return {
        id: t.id,
        version: t.version,
        status: t.status as TaskStatus,
        assigneeId: t.assigneeId,
        assigneeName: name(t.assigneeId),
        priority: t.priority,
        blockedReason: t.blockedReason,
        waitingOn: t.waitingOn,
        waitingSince: t.waitingSince,
        followUpOn: t.followUpOn,
        approval: {
          required: t.requiresApproval,
          approverId: t.approverId,
          approverName: name(t.approverId),
          decision: t.approvalDecision,
          note: t.approvalNote,
          requestedAt: t.approvalRequestedAt,
          decidedAt: t.approvalDecidedAt,
          decidedByName: name(t.approvalDecidedById),
          canDecide: t.status === "awaiting_approval" && canDecideApproval(t, { id: ctx.viewer.id, role: ctx.actor.role }) && ctx.project.can("task.approve"),
        },
        recurrence: t.recurrence as { freq: string } | null,
        watcherIds: watchers,
        watching: watchers.includes(ctx.viewer.id),
        comments: comments.map((cm) => ({ ...cm, body: cm.deletedAt ? "" : cm.body, mine: cm.authorId === ctx.viewer.id })),
        // Outside collaborators see names only of people who can see the task; never the rest of the team.
        people: (internal ? people : readers).map((p) => ({ id: p.id, name: p.name, projectRole: p.projectRole, external: p.external })),
        mentionable: readers.map((p) => ({ id: p.id, name: p.name })),
        access: {
          canWork: canWork(c, t),
          canAssign: ctx.project.can("checklist.edit"),
          canPrioritize: ctx.project.can("checklist.edit") || t.assigneeId === ctx.viewer.id,
          canManageWatchers: ctx.project.can("checklist.edit"),
          canComment: true,
          canModerate: ctx.project.can("project.edit"),
          canWatch: ctx.project.can("task.viewAll"),
        },
      };
    }),

  assign: projectProcedure("checklist.edit")
    .input(z.object({ taskId: z.uuid(), version: z.number().int().min(1), assigneeId: z.string().min(1).max(64).nullable() }))
    .mutation(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      return ctx.db.transaction(async (tx) => {
        const t = await visibleTask(c, tx, input.taskId);
        const who = input.assigneeId ? await requirePerson(tx, input.projectId, input.assigneeId) : null;
        const version = await bump(tx, t.id, input.version, { assigneeId: who?.id ?? null });
        await audit(tx, c, who ? `${ctx.viewer.name} assigned "${t.title}" to ${who.name}` : `${ctx.viewer.name} unassigned "${t.title}"`, t.id, { assigneeId: who?.id ?? null });
        if (who && who.id !== t.assigneeId) {
          const pname = (await tx.select({ n: schema.project.name }).from(schema.project).where(eq(schema.project.id, input.projectId)))[0]?.n ?? "";
          await notify(tx, ctx.viewer.id, [{ userId: who.id, kind: "assigned", title: `${ctx.viewer.name} gave you “${t.title}”`, body: `${pname}${t.dueOn ? ` · due ${t.dueOn}` : ""}`, projectId: input.projectId, taskId: t.id, href: taskHref(input.projectId, t.id) }]);
        }
        return { version };
      });
    }),

  /** Not started / In progress / Waiting on third party (who) / Blocked (why). */
  setStatus: projectProcedure()
    .input(
      z.object({
        taskId: z.uuid(),
        version: z.number().int().min(1),
        status: statusInput,
        waitingOn: z.string().trim().min(1).max(200).optional(),
        blockedReason: z.string().trim().min(1).max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      return ctx.db.transaction(async (tx) => {
        const t = await visibleTask(c, tx, input.taskId);
        if (!canWork(c, t)) throw new TRPCError({ code: "FORBIDDEN" });
        const from = t.status as TaskStatus;
        if (from === "done") throw new TRPCError({ code: "BAD_REQUEST", message: "This task is done. Reopen it first." });
        if (!canSetStatus(from, input.status) && !(from === input.status && (input.status === "waiting" || input.status === "blocked"))) {
          throw new TRPCError({ code: "BAD_REQUEST", message: from === "awaiting_approval" ? "This task is waiting for approval. Withdraw the request by setting it back to In progress." : "That status change isn't allowed." });
        }
        if (input.status === "waiting" && !input.waitingOn) throw new TRPCError({ code: "BAD_REQUEST", message: "Say who you're waiting on, e.g. “Expediter — DOB plan exam”." });
        if (input.status === "blocked" && !input.blockedReason) throw new TRPCError({ code: "BAD_REQUEST", message: "Say what's blocking it." });
        const today = todayET();
        const set: Partial<typeof schema.task.$inferInsert> = { status: input.status };
        // Module E: the first time work starts is the actual start.
        if (input.status === "in_progress" && !t.startedOn) set.startedOn = todayET();
        if (input.status === "waiting") {
          set.waitingOn = input.waitingOn!;
          if (from !== "waiting") set.waitingSince = today;
          set.followUpOn = addBusinessDays(today, FOLLOW_UP_DAYS);
        } else {
          set.waitingSince = null;
          set.followUpOn = null;
          if (from === "waiting") set.waitingOn = null;
        }
        set.blockedReason = input.status === "blocked" ? input.blockedReason! : null;
        if (from === "awaiting_approval") {
          set.approvalRequestedAt = null;
          set.approverId = null;
        }
        const version = await bump(tx, t.id, input.version, set);
        const what = input.status === "waiting" ? `waiting on ${input.waitingOn}` : input.status === "blocked" ? `blocked: ${input.blockedReason}` : TASK_STATUS_LABEL[input.status].toLowerCase();
        await audit(tx, c, `${ctx.viewer.name} set "${t.title}" to ${what}`, t.id, { status: input.status });
        return { version };
      });
    }),

  setPriority: projectProcedure()
    .input(z.object({ taskId: z.uuid(), version: z.number().int().min(1), priority: z.enum(["low", "normal", "high"]) }))
    .mutation(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      return ctx.db.transaction(async (tx) => {
        const t = await visibleTask(c, tx, input.taskId);
        if (!ctx.project.can("checklist.edit") && t.assigneeId !== ctx.viewer.id) throw new TRPCError({ code: "FORBIDDEN" });
        const version = await bump(tx, t.id, input.version, { priority: input.priority });
        await audit(tx, c, `${ctx.viewer.name} set "${t.title}" to ${input.priority} priority`, t.id, { priority: input.priority });
        return { version };
      });
    }),

  /** Approve (the task is done) or send back with a note (it goes back to In progress). */
  decide: projectProcedure()
    .input(z.object({ taskId: z.uuid(), version: z.number().int().min(1), decision: z.enum(["approved", "rejected"]), note: z.string().trim().max(1000).optional() }))
    .mutation(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      return ctx.db.transaction(async (tx) => {
        const t = await visibleTask(c, tx, input.taskId);
        if (t.status !== "awaiting_approval") throw new TRPCError({ code: "CONFLICT", message: "This task isn't waiting for approval any more. It has been refreshed." });
        if (!canDecideApproval(t, { id: ctx.viewer.id, role: ctx.actor.role }) || !ctx.project.can("task.approve")) throw new TRPCError({ code: "FORBIDDEN", message: "This approval is waiting on someone else." });
        if (input.decision === "rejected" && !input.note) throw new TRPCError({ code: "BAD_REQUEST", message: "Add a note saying what needs to change." });
        if (input.decision === "approved" && t.requiredAttachment) {
          const [att] = await tx
            .select({ n: sql<number>`count(*)::int` })
            .from(schema.taskAttachment)
            .innerJoin(schema.file, eq(schema.file.id, schema.taskAttachment.fileId))
            .where(and(eq(schema.taskAttachment.taskId, t.id), isNull(schema.file.deletedAt)));
          if ((att?.n ?? 0) === 0) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `The ${t.requiredAttachment} was removed. Send it back so it can be attached again.` });
        }
        const today = todayET();
        const approved = input.decision === "approved";
        const version = await bump(tx, t.id, input.version, {
          status: approved ? "done" : "in_progress",
          approvalDecision: input.decision,
          approvalNote: input.note || null,
          approvalDecidedAt: new Date(),
          approvalDecidedById: ctx.viewer.id,
          approverId: null,
          approvalRequestedAt: null,
          completedOn: approved ? today : null,
          completedAt: approved ? new Date() : null,
          completedById: approved ? (t.assigneeId ?? ctx.viewer.id) : null,
        });
        await audit(tx, c, approved ? `${ctx.viewer.name} approved "${t.title}"` : `${ctx.viewer.name} sent back "${t.title}": ${input.note}`, t.id, { decision: input.decision }, "approve");
        const audience = await taskAudience(tx, t);
        await notify(
          tx,
          ctx.viewer.id,
          audience.map((userId) => ({
            userId,
            kind: "approval_decided" as const,
            title: approved ? `${ctx.viewer.name} approved “${t.title}”` : `${ctx.viewer.name} sent back “${t.title}”`,
            body: input.note || null,
            projectId: input.projectId,
            taskId: t.id,
            href: taskHref(input.projectId, t.id),
          })),
        );
        if (approved) {
          const [fresh] = await tx.select().from(schema.task).where(eq(schema.task.id, t.id));
          await afterCompleted(tx, fresh!, ctx.viewer.id, today);
        }
        return { version };
      });
    }),

  addComment: projectProcedure()
    .input(z.object({ taskId: z.uuid(), body: z.string().trim().min(1).max(4000), clientId: z.string().min(8).max(64).regex(/^[A-Za-z0-9-]+$/).optional() }))
    .mutation(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      // Sent before (a lost answer, an offline sync, a second tab): the comment is already there.
      const already = async () => {
        if (!input.clientId) return null;
        const [row] = await ctx.db.select({ id: schema.taskComment.id }).from(schema.taskComment).where(and(eq(schema.taskComment.authorId, ctx.viewer.id), eq(schema.taskComment.clientId, input.clientId)));
        return row ? { id: row.id } : null;
      };
      const seen = await already();
      if (seen) return seen;
      return ctx.db
        .transaction(async (tx) => {
        const t = await visibleTask(c, tx, input.taskId);
        const people = await projectPeople(tx, input.projectId);
        const watchers = (await tx.select({ userId: schema.taskWatcher.userId }).from(schema.taskWatcher).where(eq(schema.taskWatcher.taskId, t.id))).map((w) => w.userId);
        const readers = taskReaders(people, t, watchers);
        const mentions = mentionedIds(input.body, readers);
        const [row] = await tx.insert(schema.taskComment).values({ taskId: t.id, projectId: input.projectId, authorId: ctx.viewer.id, body: input.body, mentions, clientId: input.clientId ?? null }).returning({ id: schema.taskComment.id });
        await audit(tx, c, `${ctx.viewer.name} commented on "${t.title}"`, t.id, { commentId: row!.id }, "create");
        const text = commentPlainText(input.body);
        const href = taskHref(input.projectId, t.id);
        await notify(tx, ctx.viewer.id, mentions.map((userId) => ({ userId, kind: "mention" as const, title: `${ctx.viewer.name} mentioned you on “${t.title}”`, body: text, projectId: input.projectId, taskId: t.id, href })));
        const audience = (await taskAudience(tx, t)).filter((u) => !mentions.includes(u));
        await notify(tx, ctx.viewer.id, audience.map((userId) => ({ userId, kind: "comment" as const, title: `${ctx.viewer.name} commented on “${t.title}”`, body: text, projectId: input.projectId, taskId: t.id, href })));
        return { id: row!.id };
      }).catch(async (e: unknown) => {
        // Two sends of the same comment at once: the other one saved it.
        const dup = (e as { code?: string; cause?: { code?: string } }).code === "23505" || (e as { cause?: { code?: string } }).cause?.code === "23505";
        const row = dup ? await already() : null;
        if (row) return row;
        throw e;
      });
    }),

  editComment: projectProcedure()
    .input(z.object({ taskId: z.uuid(), commentId: z.uuid(), body: z.string().trim().min(1).max(4000) }))
    .mutation(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      return ctx.db.transaction(async (tx) => {
        const t = await visibleTask(c, tx, input.taskId);
        const [cm] = await tx.select().from(schema.taskComment).where(and(eq(schema.taskComment.id, input.commentId), eq(schema.taskComment.taskId, t.id)));
        if (!cm || cm.deletedAt) throw new TRPCError({ code: "NOT_FOUND", message: "Comment not found" });
        if (cm.authorId !== ctx.viewer.id) throw new TRPCError({ code: "FORBIDDEN", message: "You can only edit your own comments." });
        const people = await projectPeople(tx, input.projectId);
        const watchers = (await tx.select({ userId: schema.taskWatcher.userId }).from(schema.taskWatcher).where(eq(schema.taskWatcher.taskId, t.id))).map((w) => w.userId);
        const mentions = mentionedIds(input.body, taskReaders(people, t, watchers));
        await tx.update(schema.taskComment).set({ body: input.body, mentions, editedAt: new Date() }).where(eq(schema.taskComment.id, cm.id));
        await audit(tx, c, `${ctx.viewer.name} edited a comment on "${t.title}"`, t.id, { commentId: cm.id });
        const added = mentions.filter((m) => !cm.mentions.includes(m));
        await notify(tx, ctx.viewer.id, added.map((userId) => ({ userId, kind: "mention" as const, title: `${ctx.viewer.name} mentioned you on “${t.title}”`, body: commentPlainText(input.body), projectId: input.projectId, taskId: t.id, href: taskHref(input.projectId, t.id) })));
        return { ok: true };
      });
    }),

  /** Authors remove their own comments; admins and the owner can remove any. The row stays as "removed". */
  deleteComment: projectProcedure()
    .input(z.object({ taskId: z.uuid(), commentId: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      return ctx.db.transaction(async (tx) => {
        const t = await visibleTask(c, tx, input.taskId);
        const [cm] = await tx.select().from(schema.taskComment).where(and(eq(schema.taskComment.id, input.commentId), eq(schema.taskComment.taskId, t.id)));
        if (!cm || cm.deletedAt) throw new TRPCError({ code: "NOT_FOUND", message: "Comment not found" });
        if (cm.authorId !== ctx.viewer.id && !ctx.project.can("project.edit")) throw new TRPCError({ code: "FORBIDDEN", message: "You can only remove your own comments." });
        await tx.update(schema.taskComment).set({ deletedAt: new Date() }).where(eq(schema.taskComment.id, cm.id));
        // The removed text shouldn't live on in people's notifications.
        await tx
          .update(schema.notification)
          .set({ body: "Comment removed." })
          .where(and(eq(schema.notification.taskId, t.id), inArray(schema.notification.kind, ["mention", "comment"]), eq(schema.notification.body, commentPlainText(cm.body))));
        await audit(tx, c, `${ctx.viewer.name} removed a comment on "${t.title}"`, t.id, { commentId: cm.id }, "delete");
        return { ok: true };
      });
    }),

  /** Follow or unfollow a task you can see. */
  watch: projectProcedure()
    .input(z.object({ taskId: z.uuid(), on: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      const t = await visibleTask(c, ctx.db, input.taskId);
      // For outside collaborators a watcher row is a share, and only the team shares or unshares.
      if (!ctx.project.can("task.viewAll")) {
        throw new TRPCError({ code: "FORBIDDEN", message: "The project team decides what's shared with you." });
      }
      if (input.on) await ctx.db.insert(schema.taskWatcher).values({ taskId: t.id, userId: ctx.viewer.id }).onConflictDoNothing();
      else await ctx.db.delete(schema.taskWatcher).where(and(eq(schema.taskWatcher.taskId, t.id), eq(schema.taskWatcher.userId, ctx.viewer.id)));
      return { ok: true };
    }),

  /** Add or remove a watcher. Adding an outside collaborator shares the task with them. */
  setWatcher: projectProcedure("checklist.edit")
    .input(z.object({ taskId: z.uuid(), userId: z.string().min(1).max(64), on: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      return ctx.db.transaction(async (tx) => {
        const t = await visibleTask(c, tx, input.taskId);
        const who = await requirePerson(tx, input.projectId, input.userId);
        if (input.on) {
          const r = await tx.insert(schema.taskWatcher).values({ taskId: t.id, userId: who.id }).onConflictDoNothing().returning({ u: schema.taskWatcher.userId });
          if (r.length) {
            await audit(tx, c, who.external ? `${ctx.viewer.name} shared "${t.title}" with ${who.name}` : `${ctx.viewer.name} added ${who.name} as a watcher on "${t.title}"`, t.id, { watcher: who.id });
            await notify(tx, ctx.viewer.id, [{ userId: who.id, kind: "assigned", title: who.external ? `${ctx.viewer.name} shared “${t.title}” with you` : `${ctx.viewer.name} added you to “${t.title}”`, projectId: input.projectId, taskId: t.id, href: taskHref(input.projectId, t.id) }]);
          }
        } else {
          await tx.delete(schema.taskWatcher).where(and(eq(schema.taskWatcher.taskId, t.id), eq(schema.taskWatcher.userId, who.id)));
          await audit(tx, c, who.external ? `${ctx.viewer.name} unshared "${t.title}" from ${who.name}` : `${ctx.viewer.name} removed ${who.name} as a watcher on "${t.title}"`, t.id, { watcher: who.id, removed: true });
        }
        return { ok: true };
      });
    }),

  /** Bulk: reassign, set one due date, or shift by N days. Done tasks are left alone. */
  bulk: projectProcedure("checklist.edit")
    .input(
      z.object({
        taskIds: z.array(z.uuid()).min(1).max(500),
        action: z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("reassign"), assigneeId: z.string().min(1).max(64).nullable() }),
          z.object({ kind: z.literal("redate"), dueOn: planDate }),
          z.object({ kind: z.literal("shift"), days: z.number().int().min(-365).max(365).refine((n) => n !== 0), unit: z.enum(["business", "calendar"]) }),
        ]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      return ctx.db.transaction(async (tx) => {
        const ids = [...new Set(input.taskIds)];
        // Lock the rows so a concurrent edit waits instead of being overwritten.
        const rows = await tx.select().from(schema.task).where(and(eq(schema.task.projectId, input.projectId), inArray(schema.task.id, ids))).for("update");
        if (rows.length !== ids.length) throw new TRPCError({ code: "BAD_REQUEST", message: "Some of those tasks aren't on this project any more. Refresh and try again." });
        const open = rows.filter((t) => t.status !== "done");
        const a = input.action;
        let changed = 0;
        if (a.kind === "reassign") {
          const who = a.assigneeId ? await requirePerson(tx, input.projectId, a.assigneeId) : null;
          const moving = open.filter((t) => t.assigneeId !== (who?.id ?? null));
          if (moving.length) await tx.update(schema.task).set({ assigneeId: who?.id ?? null, version: sql`${schema.task.version} + 1`, updatedAt: new Date() }).where(inArray(schema.task.id, moving.map((t) => t.id)));
          changed = moving.length;
          if (who && changed) {
            await notify(tx, ctx.viewer.id, [{ userId: who.id, kind: "assigned", title: changed === 1 ? `${ctx.viewer.name} gave you “${moving[0]!.title}”` : `${ctx.viewer.name} gave you ${changed} tasks`, projectId: input.projectId, taskId: changed === 1 ? moving[0]!.id : null, href: changed === 1 ? taskHref(input.projectId, moving[0]!.id) : `/tasks` }]);
          }
          await audit(tx, c, `${ctx.viewer.name} reassigned ${changed} task${changed === 1 ? "" : "s"} to ${who?.name ?? "nobody"}`, input.projectId, { ids: moving.map((t) => t.id), assigneeId: who?.id ?? null }, "update", "checklist");
        } else {
          const moves = open.flatMap((t) => {
            const due = a.kind === "redate" ? a.dueOn : t.dueOn ? shiftDate(t.dueOn, a.days, a.unit) : null;
            return due && due !== t.dueOn ? [{ id: t.id, due }] : [];
          });
          changed = await setDueDates(tx, moves);
          await reschedule(tx, input.projectId);
          const what = a.kind === "redate" ? `re-dated ${changed} task${changed === 1 ? "" : "s"} to ${a.dueOn}` : `moved ${changed} task${changed === 1 ? "" : "s"} ${a.days > 0 ? "later" : "earlier"} by ${Math.abs(a.days)} ${a.unit === "business" ? "business " : ""}day${Math.abs(a.days) === 1 ? "" : "s"}`;
          await audit(tx, c, `${ctx.viewer.name} ${what}`, input.projectId, { ids: open.map((t) => t.id), action: a }, "update", "checklist");
        }
        return { changed, skippedDone: rows.length - open.length };
      });
    }),

  /** Shift every open, dated task in a phase by N days. */
  shiftPhase: projectProcedure("checklist.edit")
    .input(z.object({ phaseKey: z.string().min(1).max(60), days: z.number().int().min(-365).max(365).refine((n) => n !== 0), unit: z.enum(["business", "calendar"]) }))
    .mutation(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      return ctx.db.transaction(async (tx) => {
        const [ph] = await tx.select().from(schema.projectPhase).where(and(eq(schema.projectPhase.projectId, input.projectId), eq(schema.projectPhase.key, input.phaseKey)));
        if (!ph) throw new TRPCError({ code: "BAD_REQUEST", message: "That phase isn't on this project." });
        const rows = await tx.select().from(schema.task).where(and(eq(schema.task.projectId, input.projectId), eq(schema.task.phaseKey, input.phaseKey), ne(schema.task.status, "done"))).for("update");
        const changed = await setDueDates(
          tx,
          rows.flatMap((t) => (t.dueOn ? [{ id: t.id, due: shiftDate(t.dueOn, input.days, input.unit) }] : [])),
        );
        await reschedule(tx, input.projectId);
        await audit(tx, c, `${ctx.viewer.name} moved ${ph.name} ${input.days > 0 ? "later" : "earlier"} by ${Math.abs(input.days)} ${input.unit === "business" ? "business " : ""}day${Math.abs(input.days) === 1 ? "" : "s"} (${changed} tasks)`, input.projectId, input, "update", "checklist");
        return { changed };
      });
    }),

  /**
   * My Tasks: what's mine to do, by section and project. "Awaiting my
   * approval" holds tasks where I'm the approver and still may approve.
   */
  mine: protectedProcedure.query(async ({ ctx }) => {
    const { projectIds, memberships } = await accessibleProjects(ctx);
    const empty = { today: todayET(), sections: MY_TASK_SECTIONS.map((key) => ({ key, groups: [] as never[] })), total: 0 };
    // Investors and lenders have no tasks, whatever the data says.
    if (projectIds.length === 0 || ctx.actor.role === "investor") return empty;
    const me = ctx.actor.userId;
    const rows = await ctx.db
      .select({
        id: schema.task.id,
        projectId: schema.task.projectId,
        title: schema.task.title,
        status: schema.task.status,
        dueOn: schema.task.dueOn,
        assigneeId: schema.task.assigneeId,
        approverId: schema.task.approverId,
        priority: schema.task.priority,
        waitingOn: schema.task.waitingOn,
        blockedReason: schema.task.blockedReason,
        requiresApproval: schema.task.requiresApproval,
        version: schema.task.version,
        phaseKey: schema.task.phaseKey,
        sortOrder: schema.task.sortOrder,
      })
      .from(schema.task)
      .where(and(inArray(schema.task.projectId, projectIds), ne(schema.task.status, "done"), or(eq(schema.task.assigneeId, me), and(eq(schema.task.status, "awaiting_approval"), eq(schema.task.approverId, me)))));
    const today = todayET();
    const canApprove = (pid: string) => canProject(ctx.actor, memberships.get(pid) ?? null, "task.approve");
    const placed = rows
      .map((t) => ({ t, section: myTaskSection({ ...t, status: t.status as TaskStatus }, me, today) }))
      .filter((x): x is { t: (typeof rows)[number]; section: MyTaskSection } => x.section !== null && (x.section !== "approve" || canApprove(x.t.projectId)));
    const pids = [...new Set(placed.map((x) => x.t.projectId))];
    const [projects, hero, blocked] = await Promise.all([
      pids.length ? ctx.db.select({ id: schema.project.id, name: schema.project.name, address: schema.project.address }).from(schema.project).where(inArray(schema.project.id, pids)) : Promise.resolve([]),
      heroes(ctx.db, pids),
      waitingOnPrereqs(ctx.db, placed.map((x) => x.t.id)),
    ]);
    const phaseNames = pids.length
      ? new Map((await ctx.db.select({ projectId: schema.projectPhase.projectId, key: schema.projectPhase.key, name: schema.projectPhase.name }).from(schema.projectPhase).where(inArray(schema.projectPhase.projectId, pids))).map((p) => [`${p.projectId}:${p.key}`, p.name]))
      : new Map<string, string>();
    const sections = MY_TASK_SECTIONS.map((key) => {
      const inSec = placed.filter((x) => x.section === key).sort((a, b) => (a.t.dueOn ?? "9999").localeCompare(b.t.dueOn ?? "9999") || (b.t.priority === "high" ? 1 : 0) - (a.t.priority === "high" ? 1 : 0) || a.t.sortOrder - b.t.sortOrder);
      const byProject = new Map<string, typeof inSec>();
      for (const x of inSec) byProject.set(x.t.projectId, [...(byProject.get(x.t.projectId) ?? []), x]);
      return {
        key,
        groups: [...byProject].map(([pid, items]) => {
          const p = projects.find((q) => q.id === pid)!;
          return {
            project: { id: pid, name: p.name, address: p.address, hero: hero.get(pid) ?? null },
            tasks: items.map(({ t }) => ({ ...t, phaseName: phaseNames.get(`${pid}:${t.phaseKey}`) ?? t.phaseKey, waitingOnPrereqs: blocked.has(t.id), canApprove: key === "approve" })),
          };
        }),
      };
    });
    return { today, sections, total: placed.length };
  }),

  /** The portfolio's Needs-you rail. The team-wide items need full task visibility on the project. */
  needsYou: protectedProcedure.query(async ({ ctx }) => {
    const { projectIds, memberships } = await accessibleProjects(ctx);
    const today = todayET();
    const empty = { counts: { approvals: 0, blocked: 0 }, approvals: [], blocked: [], overdueByPerson: [], keyDates: [], recordAlerts: [] as RailAlert[], expired: [] as RailExpiry[] };
    if (projectIds.length === 0 || ctx.actor.role === "investor") return empty;
    const full = projectIds.filter((id) => canProject(ctx.actor, memberships.get(id) ?? null, "task.viewAll"));
    const approvable = projectIds.filter((id) => canProject(ctx.actor, memberships.get(id) ?? null, "task.approve"));
    const names = new Map((await ctx.db.select({ id: schema.project.id, name: schema.project.name }).from(schema.project).where(inArray(schema.project.id, projectIds))).map((p) => [p.id, p.name]));
    const base = { id: schema.task.id, projectId: schema.task.projectId, title: schema.task.title, dueOn: schema.task.dueOn, version: schema.task.version };
    const countOf = async (projectIds: string[], where: ReturnType<typeof and>) =>
      projectIds.length ? ((await ctx.db.select({ n: sql<number>`count(*)::int` }).from(schema.task).where(and(inArray(schema.task.projectId, projectIds), where)))[0]?.n ?? 0) : 0;
    const [approvalCount, blockedCount] = await Promise.all([
      countOf(approvable, and(eq(schema.task.status, "awaiting_approval"), eq(schema.task.approverId, ctx.actor.userId))),
      countOf(full, eq(schema.task.status, "blocked")),
    ]);
    const [approvals, blocked, overdue, dates] = await Promise.all([
      approvable.length
        ? ctx.db.select({ ...base, assigneeId: schema.task.assigneeId }).from(schema.task).where(and(inArray(schema.task.projectId, approvable), eq(schema.task.status, "awaiting_approval"), eq(schema.task.approverId, ctx.actor.userId))).orderBy(asc(schema.task.approvalRequestedAt)).limit(50)
        : Promise.resolve([]),
      full.length ? ctx.db.select({ ...base, blockedReason: schema.task.blockedReason, assigneeId: schema.task.assigneeId }).from(schema.task).where(and(inArray(schema.task.projectId, full), eq(schema.task.status, "blocked"))).orderBy(asc(schema.task.updatedAt)).limit(50) : Promise.resolve([]),
      full.length
        ? ctx.db
            .select({ assigneeId: schema.task.assigneeId, name: schema.user.name, count: sql<number>`count(*)::int`, oldest: sql<string>`min(${schema.task.dueOn})` })
            .from(schema.task)
            .leftJoin(schema.user, eq(schema.user.id, schema.task.assigneeId))
            .where(and(inArray(schema.task.projectId, full), ne(schema.task.status, "done"), lt(schema.task.dueOn, today)))
            .groupBy(schema.task.assigneeId, schema.user.name)
        : Promise.resolve([]),
      full.length ? ctx.db.select().from(schema.keyDate).where(and(inArray(schema.keyDate.projectId, full), eq(schema.keyDate.done, false), sql`${schema.keyDate.date} >= ${today}`)) : Promise.resolve([]),
    ]);
    // Public-record alerts from the last two weeks (orders in force first) and expired items (Module B).
    const alerts = full.length
      ? await ctx.db
          .select({ id: schema.recordAlert.id, projectId: schema.recordAlert.projectId, title: schema.recordAlert.title, critical: schema.recordAlert.critical, createdAt: schema.recordAlert.createdAt })
          .from(schema.recordAlert)
          .where(and(inArray(schema.recordAlert.projectId, full), isNull(schema.recordAlert.dismissedAt), sql`${schema.recordAlert.createdAt} > now() - interval '14 days'`))
          .orderBy(desc(schema.recordAlert.critical), desc(schema.recordAlert.createdAt))
          .limit(20)
      : [];
    const fin = new Set(full.filter((id) => canProject(ctx.actor, memberships.get(id) ?? null, "financials.view")));
    const expired = full.length
      ? (
          await ctx.db
            .select({ id: schema.expiryItem.id, projectId: schema.expiryItem.projectId, category: schema.expiryItem.category, label: schema.expiryItem.label, vendorName: schema.expiryItem.vendorName, expiresOn: schema.expiryItem.expiresOn })
            .from(schema.expiryItem)
            .where(and(inArray(schema.expiryItem.projectId, full), isNull(schema.expiryItem.closedAt), lt(schema.expiryItem.expiresOn, today)))
            .orderBy(asc(schema.expiryItem.expiresOn))
            .limit(50)
        ).filter((e) => !FINANCIAL_EXPIRY.has(e.category) || fin.has(e.projectId))
      : [];
    const people = new Map<string, string>();
    const ids = [...new Set([...approvals, ...blocked].map((t) => t.assigneeId).filter((x): x is string => !!x))];
    if (ids.length) for (const u of await ctx.db.select({ id: schema.user.id, name: schema.user.name }).from(schema.user).where(inArray(schema.user.id, ids))) people.set(u.id, u.name);
    return {
      counts: { approvals: approvalCount, blocked: blockedCount },
      approvals: approvals.map((t) => ({ ...t, projectName: names.get(t.projectId)!, assigneeName: t.assigneeId ? (people.get(t.assigneeId) ?? null) : null })),
      blocked: blocked.map((t) => ({ ...t, projectName: names.get(t.projectId)!, assigneeName: t.assigneeId ? (people.get(t.assigneeId) ?? null) : null })),
      overdueByPerson: overdue.map((o) => ({ userId: o.assigneeId, name: o.name ?? "Unassigned", count: o.count, oldest: o.oldest })).sort((a, b) => b.count - a.count),
      keyDates: upcomingKeyDates(dates, today, 14).map((d) => ({ id: d.id, projectId: d.projectId, projectName: names.get(d.projectId)!, label: keyDateLabel(d.kind, d.label), date: d.date })),
      recordAlerts: alerts.map((a) => ({ ...a, projectName: names.get(a.projectId)! })) as RailAlert[],
      expired: expired.map((e) => ({ id: e.id, projectId: e.projectId, projectName: names.get(e.projectId)!, label: expiryLabel(e.category, e.vendorName ?? e.label), expiresOn: e.expiresOn })) as RailExpiry[],
    };
  }),
});

/* ------------------------------------------------------------------ */
/* Key dates                                                           */
/* ------------------------------------------------------------------ */

const kindKeys = KEY_DATE_KINDS.map((k) => k.key) as [string, ...string[]];

type RailAlert = { id: string; projectId: string; projectName: string; title: string; critical: boolean; createdAt: Date };
type RailExpiry = { id: string; projectId: string; projectName: string; label: string; expiresOn: string };

export const keyDatesRouter = router({
  list: projectProcedure("task.viewAll").query(async ({ ctx, input }) => {
    const rows = await ctx.db.select().from(schema.keyDate).where(eq(schema.keyDate.projectId, input.projectId)).orderBy(asc(schema.keyDate.date));
    return {
      dates: rows.map((d) => ({ id: d.id, kind: d.kind, label: keyDateLabel(d.kind, d.label), customLabel: d.label, date: d.date, done: d.done, notes: d.notes })),
      canEdit: ctx.project.can("checklist.edit"),
    };
  }),

  save: projectProcedure("checklist.edit")
    .input(z.object({ id: z.uuid().optional(), kind: z.enum(kindKeys), label: z.string().trim().max(120).nullish(), date: planDate, done: z.boolean().default(false), notes: z.string().trim().max(1000).nullish() }))
    .mutation(async ({ ctx, input }) => {
      if (input.kind === "other" && !input.label) throw new TRPCError({ code: "BAD_REQUEST", message: "Name the date." });
      return ctx.db.transaction(async (tx) => {
        const values = { kind: input.kind, label: input.kind === "other" ? input.label! : (input.label ?? null), date: input.date, done: input.done, notes: input.notes ?? null };
        let id = input.id;
        if (id) {
          const r = await tx.update(schema.keyDate).set({ ...values, updatedAt: new Date() }).where(and(eq(schema.keyDate.id, id), eq(schema.keyDate.projectId, input.projectId))).returning({ id: schema.keyDate.id });
          if (!r.length) throw new TRPCError({ code: "NOT_FOUND", message: "That date was removed." });
        } else {
          const [r] = await tx.insert(schema.keyDate).values({ ...values, projectId: input.projectId, createdById: ctx.viewer.id }).returning({ id: schema.keyDate.id });
          id = r!.id;
        }
        await recordAudit(tx, { actorId: ctx.viewer.id, actorName: ctx.viewer.name, action: input.id ? "update" : "create", entityType: "key_date", entityId: id, projectId: input.projectId, summary: `${ctx.viewer.name} ${input.id ? "updated" : "added"} the key date ${keyDateLabel(input.kind, input.label)}: ${input.date}${input.done ? " (done)" : ""}`, ip: ctx.ip });
        return { id };
      });
    }),

  remove: projectProcedure("checklist.edit")
    .input(z.object({ id: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.transaction(async (tx) => {
        const [d] = await tx.delete(schema.keyDate).where(and(eq(schema.keyDate.id, input.id), eq(schema.keyDate.projectId, input.projectId))).returning();
        if (!d) throw new TRPCError({ code: "NOT_FOUND" });
        await recordAudit(tx, { actorId: ctx.viewer.id, actorName: ctx.viewer.name, action: "delete", entityType: "key_date", entityId: d.id, projectId: input.projectId, summary: `${ctx.viewer.name} removed the key date ${keyDateLabel(d.kind, d.label)} (${d.date})`, ip: ctx.ip });
      });
      return { ok: true };
    }),
});

/* ------------------------------------------------------------------ */
/* Notifications (in-app)                                              */
/* ------------------------------------------------------------------ */

export const notificationsRouter = router({
  /** Newest first. Paged on (created time to the millisecond, id) so rows written in the same instant are never skipped. */
  list: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(100).default(30), cursor: z.object({ at: z.string().max(40), id: z.uuid() }).optional() }).optional())
    .query(async ({ ctx, input }) => {
      const limit = input?.limit ?? 30;
      const ms = sql`date_trunc('milliseconds', ${schema.notification.createdAt})`;
      const rows = await ctx.db
        .select({ id: schema.notification.id, kind: schema.notification.kind, title: schema.notification.title, body: schema.notification.body, href: schema.notification.href, readAt: schema.notification.readAt, createdAt: schema.notification.createdAt, actorName: schema.user.name, at: sql<string>`to_char(${ms} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')` })
        .from(schema.notification)
        .leftJoin(schema.user, eq(schema.user.id, schema.notification.actorId))
        .where(and(eq(schema.notification.userId, ctx.actor.userId), input?.cursor ? sql`(${ms}, ${schema.notification.id}) < (${input.cursor.at}::timestamptz, ${input.cursor.id}::uuid)` : undefined))
        .orderBy(desc(ms), desc(schema.notification.id))
        .limit(limit + 1);
      const items = rows.slice(0, limit);
      const last = items.at(-1);
      return { items: items.map((r) => ({ id: r.id, kind: r.kind, title: r.title, body: r.body, href: r.href, readAt: r.readAt, createdAt: r.createdAt, actorName: r.actorName })), next: rows.length > limit && last ? { at: last.at, id: last.id } : null };
    }),

  unreadCount: protectedProcedure.query(async ({ ctx }) => {
    const [r] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(schema.notification).where(and(eq(schema.notification.userId, ctx.actor.userId), isNull(schema.notification.readAt)));
    return { count: r?.n ?? 0 };
  }),

  markRead: protectedProcedure.input(z.object({ ids: z.array(z.uuid()).min(1).max(200) })).mutation(async ({ ctx, input }) => {
    await ctx.db.update(schema.notification).set({ readAt: new Date() }).where(and(eq(schema.notification.userId, ctx.actor.userId), inArray(schema.notification.id, input.ids), isNull(schema.notification.readAt)));
    return { ok: true };
  }),

  markAllRead: protectedProcedure.mutation(async ({ ctx }) => {
    await ctx.db.update(schema.notification).set({ readAt: new Date() }).where(and(eq(schema.notification.userId, ctx.actor.userId), isNull(schema.notification.readAt)));
    return { ok: true };
  }),
});
