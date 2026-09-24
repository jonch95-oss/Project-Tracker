import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import { addBusinessDays } from "@/core/calendar";
import { KEY_DATE_REMINDERS, keyDateLabel } from "@/core/key-dates";
import { nextOccurrence, type RecurrenceFreq } from "@/core/tasks";
import type { Recurrence } from "@/core/templates";
import { addDays, daysBetween, formatIsoDate, todayET } from "@/core/time";
import { db, schema, type DbOrTx } from "../db";
import { reschedule } from "./checklist";

type TaskRow = typeof schema.task.$inferSelect;
type NotificationKind = (typeof schema.NOTIFICATION_KINDS)[number];

/** Business days between automatic follow-ups on a task waiting on a third party. */
export const FOLLOW_UP_DAYS = 2;

export function taskHref(projectId: string, taskId: string): string {
  return `/projects/${projectId}?tab=checklist&task=${taskId}`;
}

/* ------------------------------------------------------------------ */
/* Visibility                                                          */
/* ------------------------------------------------------------------ */

/**
 * Task ids on a project an outside collaborator can see beyond their own:
 * those shared with them as a watcher, and any waiting on their approval.
 */
export async function sharedTaskIds(conn: DbOrTx, projectId: string, userId: string): Promise<Set<string>> {
  const rows = await conn
    .select({ id: schema.taskWatcher.taskId })
    .from(schema.taskWatcher)
    .innerJoin(schema.task, eq(schema.task.id, schema.taskWatcher.taskId))
    .where(and(eq(schema.task.projectId, projectId), eq(schema.taskWatcher.userId, userId)));
  const approving = await conn
    .select({ id: schema.task.id })
    .from(schema.task)
    .where(and(eq(schema.task.projectId, projectId), eq(schema.task.approverId, userId), eq(schema.task.status, "awaiting_approval")));
  return new Set([...rows, ...approving].map((r) => r.id));
}

/* ------------------------------------------------------------------ */
/* Notifications                                                       */
/* ------------------------------------------------------------------ */

export interface NotifyInput {
  userId: string;
  kind: NotificationKind;
  title: string;
  body?: string | null;
  projectId?: string | null;
  taskId?: string | null;
  href?: string | null;
}

/**
 * In-app notification rows. The actor never notifies themselves, and one
 * person gets one row per event even if they qualify twice (assignee and
 * watcher, say). Deactivated people are skipped.
 */
export async function notify(tx: DbOrTx, actorId: string | null, rows: NotifyInput[]): Promise<number> {
  const seen = new Set<string>();
  const out = rows.filter((r) => r.userId && r.userId !== actorId && !seen.has(r.userId) && seen.add(r.userId));
  if (out.length === 0) return 0;
  const users = await tx.select({ id: schema.user.id, role: schema.user.role }).from(schema.user).where(and(inArray(schema.user.id, out.map((r) => r.userId)), eq(schema.user.status, "active")));
  const active = new Map(users.map((u) => [u.id, u.role]));
  // Project news only reaches people still on the project (or the owner): removal cuts it off at once.
  const projectIds = [...new Set(out.map((r) => r.projectId).filter((x): x is string => !!x))];
  const members = projectIds.length
    ? new Set(
        (await tx.select({ p: schema.projectMember.projectId, u: schema.projectMember.userId }).from(schema.projectMember).where(and(inArray(schema.projectMember.projectId, projectIds), inArray(schema.projectMember.userId, [...active.keys()])))).map(
          (m) => `${m.p}:${m.u}`,
        ),
      )
    : new Set<string>();
  const values = out
    .filter((r) => active.has(r.userId) && (!r.projectId || active.get(r.userId) === "owner" || members.has(`${r.projectId}:${r.userId}`)))
    .map((r) => ({ userId: r.userId, kind: r.kind, title: r.title.slice(0, 300), body: r.body?.slice(0, 1000) ?? null, projectId: r.projectId ?? null, taskId: r.taskId ?? null, href: r.href ?? null, actorId }));
  if (values.length) await tx.insert(schema.notification).values(values);
  return values.length;
}

/** Everyone who should hear about activity on a task: assignee and watchers. */
export async function taskAudience(tx: DbOrTx, t: Pick<TaskRow, "id" | "assigneeId">): Promise<string[]> {
  const w = await tx.select({ userId: schema.taskWatcher.userId }).from(schema.taskWatcher).where(eq(schema.taskWatcher.taskId, t.id));
  return [...new Set([...(t.assigneeId ? [t.assigneeId] : []), ...w.map((r) => r.userId)])];
}

async function projectName(tx: DbOrTx, projectId: string): Promise<string> {
  const [p] = await tx.select({ name: schema.project.name }).from(schema.project).where(eq(schema.project.id, projectId));
  return p?.name ?? "a project";
}

/* ------------------------------------------------------------------ */
/* Approvals                                                           */
/* ------------------------------------------------------------------ */

async function activeOwners(tx: DbOrTx): Promise<string[]> {
  const rows = await tx.select({ id: schema.user.id }).from(schema.user).where(and(eq(schema.user.role, "owner"), eq(schema.user.status, "active"))).orderBy(schema.user.createdAt);
  return rows.map((r) => r.id);
}

/**
 * Who approves a task, worked out fresh at each request from its approver
 * role: for "Owner", the owner; else an active project member in that role
 * who may approve; else the owner. The result is stored on the task while
 * the request is open and cleared when it is decided or withdrawn.
 */
export async function resolveApprover(tx: DbOrTx, t: Pick<TaskRow, "projectId" | "approverRole">): Promise<string | null> {
  const role = (t.approverRole ?? "Owner").trim();
  if (role.toLowerCase() !== "owner") {
    const [m] = await tx
      .select({ userId: schema.projectMember.userId })
      .from(schema.projectMember)
      .innerJoin(schema.user, eq(schema.user.id, schema.projectMember.userId))
      .where(
        and(
          eq(schema.projectMember.projectId, t.projectId),
          sql`lower(${schema.projectMember.projectRole}) = lower(${role})`,
          eq(schema.user.status, "active"),
          sql`(${schema.projectMember.canApprove} or ${schema.user.role} in ('owner','admin'))`,
        ),
      )
      .orderBy(schema.projectMember.createdAt)
      .limit(1);
    if (m) return m.userId;
  }
  return (await activeOwners(tx))[0] ?? null;
}

/* ------------------------------------------------------------------ */
/* Completion                                                          */
/* ------------------------------------------------------------------ */

/**
 * After a task is marked done: roll a recurring task forward, re-date the
 * tasks that hang off it, and tell the people whose tasks it was holding up.
 */
export async function afterCompleted(tx: DbOrTx, t: TaskRow, actorId: string, completedOn: string): Promise<{ nextId: string | null }> {
  let nextId: string | null = null;
  const rec = t.recurrence as Recurrence | null;
  if (rec && t.dueOn) {
    nextId = randomUUID();
    const due = nextOccurrence(t.dueOn, rec.freq as RecurrenceFreq, completedOn);
    await tx.insert(schema.task).values({
      id: nextId,
      projectId: t.projectId,
      phaseKey: t.phaseKey,
      templateKey: null,
      title: t.title,
      description: t.description,
      role: t.role,
      assigneeId: t.assigneeId,
      priority: t.priority,
      dueOn: due,
      dueManual: true,
      requiresApproval: t.requiresApproval,
      approverRole: t.approverRole,
      requiredAttachment: t.requiredAttachment,
      subItems: t.subItems.map((s) => ({ ...s, done: false })),
      recurrence: t.recurrence,
      seriesId: t.seriesId ?? t.id,
      sortOrder: t.sortOrder,
      createdById: actorId,
    });
    const w = await tx.select({ userId: schema.taskWatcher.userId }).from(schema.taskWatcher).where(eq(schema.taskWatcher.taskId, t.id));
    if (w.length) await tx.insert(schema.taskWatcher).values(w.map((r) => ({ taskId: nextId!, userId: r.userId })));
    await tx.update(schema.task).set({ nextOccurrenceId: nextId }).where(eq(schema.task.id, t.id));
  }
  await reschedule(tx, t.projectId);
  await notifyUnblocked(tx, t, actorId);
  return { nextId };
}

/** Undo the automatic next occurrence when a recurring task is reopened: exactly the one it created, and only if nobody has touched it. */
export async function undoRecurrence(tx: DbOrTx, t: TaskRow): Promise<void> {
  if (!t.nextOccurrenceId) return;
  await tx.delete(schema.task).where(and(eq(schema.task.id, t.nextOccurrenceId), eq(schema.task.status, "not_started"), eq(schema.task.version, 1)));
  await tx.update(schema.task).set({ nextOccurrenceId: null }).where(eq(schema.task.id, t.id));
}

/**
 * Someone leaves a project: their task and folder shares go, their open tasks
 * are unassigned, and approvals waiting on them are re-routed.
 */
export async function releaseFromProject(tx: DbOrTx, projectId: string, userId: string, actorId: string | null): Promise<void> {
  const taskIds = tx.select({ id: schema.task.id }).from(schema.task).where(eq(schema.task.projectId, projectId));
  await tx.delete(schema.taskWatcher).where(and(eq(schema.taskWatcher.userId, userId), inArray(schema.taskWatcher.taskId, taskIds)));
  const folderIds = tx.select({ id: schema.folder.id }).from(schema.folder).where(eq(schema.folder.projectId, projectId));
  await tx.delete(schema.folderShare).where(and(eq(schema.folderShare.userId, userId), inArray(schema.folderShare.folderId, folderIds)));
  await tx.update(schema.task).set({ assigneeId: null, version: sql`${schema.task.version} + 1`, updatedAt: new Date() }).where(and(eq(schema.task.projectId, projectId), eq(schema.task.assigneeId, userId), ne(schema.task.status, "done")));
  await rerouteApprovals(tx, userId, actorId, projectId);
}

/** Approvals waiting on someone who can no longer act go to whoever should approve now. */
export async function rerouteApprovals(tx: DbOrTx, fromUserId: string, actorId: string | null, projectId?: string): Promise<number> {
  const waiting = await tx
    .select()
    .from(schema.task)
    .where(and(eq(schema.task.status, "awaiting_approval"), eq(schema.task.approverId, fromUserId), projectId ? eq(schema.task.projectId, projectId) : undefined));
  for (const t of waiting) {
    const to = await resolveApprover(tx, t);
    if (to === fromUserId) continue; // still the right person
    await tx.update(schema.task).set({ approverId: to, version: sql`${schema.task.version} + 1`, updatedAt: new Date() }).where(eq(schema.task.id, t.id));
    if (to) await notify(tx, actorId, [{ userId: to, kind: "approval_requested", title: `“${t.title}” needs your approval`, body: await projectName(tx, t.projectId), projectId: t.projectId, taskId: t.id, href: taskHref(t.projectId, t.id) }]);
  }
  return waiting.length;
}

/** May this person decide an approval? The approver it's waiting on, or the owner. */
export function canDecideApproval(t: Pick<TaskRow, "approverId">, viewer: { id: string; role: string }): boolean {
  return viewer.role === "owner" || t.approverId === viewer.id;
}

/** Tasks whose last unfinished prerequisite was `done`: tell their assignees they can start. */
async function notifyUnblocked(tx: DbOrTx, done: TaskRow, actorId: string): Promise<void> {
  const dependents = await tx
    .select({ id: schema.task.id, title: schema.task.title, assigneeId: schema.task.assigneeId, status: schema.task.status })
    .from(schema.taskDependency)
    .innerJoin(schema.task, eq(schema.task.id, schema.taskDependency.taskId))
    .where(eq(schema.taskDependency.dependsOnId, done.id));
  const open = dependents.filter((d) => d.status !== "done" && d.assigneeId);
  if (open.length === 0) return;
  const stillWaiting = new Set(
    (
      await tx
        .select({ taskId: schema.taskDependency.taskId })
        .from(schema.taskDependency)
        .innerJoin(schema.task, eq(schema.task.id, schema.taskDependency.dependsOnId))
        .where(and(inArray(schema.taskDependency.taskId, open.map((d) => d.id)), ne(schema.task.status, "done")))
    ).map((r) => r.taskId),
  );
  const name = await projectName(tx, done.projectId);
  for (const d of open) {
    if (stillWaiting.has(d.id)) continue;
    await notify(tx, actorId, [{ userId: d.assigneeId!, kind: "unblocked", title: `You can start “${d.title}”`, body: `“${done.title}” is done · ${name}`, projectId: done.projectId, taskId: d.id, href: taskHref(done.projectId, d.id) }]);
  }
}

/* ------------------------------------------------------------------ */
/* Daily: follow-ups and key-date reminders                            */
/* ------------------------------------------------------------------ */

/**
 * "Waiting on third party" follows up by itself: every FOLLOW_UP_DAYS
 * business days the assignee (or, with nobody assigned, the owner) gets a
 * nudge naming who they are waiting on.
 */
export async function followUpJob(now = new Date()): Promise<{ nudged: number }> {
  const today = todayET(now);
  return db().transaction(async (tx) => {
    const due = await tx
      .select()
      .from(schema.task)
      .innerJoin(schema.project, eq(schema.project.id, schema.task.projectId))
      .where(and(eq(schema.task.status, "waiting"), lte(schema.task.followUpOn, today), isNull(schema.project.archivedAt)))
      .limit(500);
    const owners = await activeOwners(tx);
    let nudged = 0;
    for (const { task: t, project: p } of due) {
      const to = t.assigneeId ?? owners[0];
      if (to) {
        nudged += await notify(tx, null, [
          {
            userId: to,
            kind: "follow_up",
            title: `Follow up with ${t.waitingOn ?? "the third party"}`,
            body: `“${t.title}” · ${p.name} · waiting since ${t.waitingSince ? formatIsoDate(t.waitingSince, { month: "short", day: "numeric" }) : "earlier"}`,
            projectId: t.projectId,
            taskId: t.id,
            href: taskHref(t.projectId, t.id),
          },
        ]);
      }
      await tx.update(schema.task).set({ followUpOn: addBusinessDays(today, FOLLOW_UP_DAYS) }).where(eq(schema.task.id, t.id));
    }
    return { nudged };
  });
}

/**
 * Key-date reminders at 14, 7 and 1 days out to the project's internal team.
 * Each (date, threshold) is logged once, so a re-run never double-sends; a
 * missed day is caught up (one message, marking every threshold it covers).
 */
export async function keyDateReminderJob(now = new Date()): Promise<{ reminded: number }> {
  const today = todayET(now);
  return db().transaction(async (tx) => {
    const dates = await tx
      .select({ id: schema.keyDate.id, projectId: schema.keyDate.projectId, kind: schema.keyDate.kind, label: schema.keyDate.label, date: schema.keyDate.date, projectName: schema.project.name })
      .from(schema.keyDate)
      .innerJoin(schema.project, eq(schema.project.id, schema.keyDate.projectId))
      .where(and(eq(schema.keyDate.done, false), sql`${schema.keyDate.date} >= ${today}`, sql`${schema.keyDate.date} <= ${addDays(today, KEY_DATE_REMINDERS[0])}`, isNull(schema.project.archivedAt)));
    if (dates.length === 0) return { reminded: 0 };
    const sent = await tx.select().from(schema.keyDateReminder).where(inArray(schema.keyDateReminder.keyDateId, dates.map((d) => d.id)));
    const owners = await activeOwners(tx);
    const projectIds = [...new Set(dates.map((d) => d.projectId))];
    const members = await tx
      .select({ projectId: schema.projectMember.projectId, userId: schema.projectMember.userId })
      .from(schema.projectMember)
      .innerJoin(schema.user, eq(schema.user.id, schema.projectMember.userId))
      .where(and(inArray(schema.projectMember.projectId, projectIds), ne(schema.user.role, "external")));
    let reminded = 0;
    for (const d of dates) {
      const n = daysBetween(today, d.date);
      const due = KEY_DATE_REMINDERS.filter((th) => n <= th && !sent.some((x) => x.keyDateId === d.id && x.date === d.date && x.threshold === th));
      if (due.length === 0) continue;
      // Claim the thresholds first; if another run got there, send nothing.
      const claimed = await tx.insert(schema.keyDateReminder).values(due.map((threshold) => ({ keyDateId: d.id, date: d.date, threshold }))).onConflictDoNothing().returning();
      if (claimed.length === 0) continue;
      const people = [...new Set([...owners, ...members.filter((m) => m.projectId === d.projectId).map((m) => m.userId)])];
      reminded += await notify(
        tx,
        null,
        people.map((userId) => ({
          userId,
          kind: "key_date" as const,
          title: `${keyDateLabel(d.kind, d.label)} ${n === 0 ? "is today" : n === 1 ? "is tomorrow" : `in ${n} days`}`,
          body: `${d.projectName} · ${formatIsoDate(d.date, { weekday: "short", month: "short", day: "numeric" })}`,
          projectId: d.projectId,
          href: `/projects/${d.projectId}?tab=dates`,
        })),
      );
    }
    return { reminded };
  });
}
