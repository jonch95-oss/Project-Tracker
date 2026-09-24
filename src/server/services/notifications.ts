import "server-only";
import { and, eq, inArray, isNotNull, isNull, lt, ne, sql } from "drizzle-orm";
import { canSeeFolder } from "@/core/files";
import { channelOn, overdueNudge, safeOutsideText } from "@/core/notify";
import { canProject } from "@/core/permissions";
import { addDays, formatIsoDate, todayET } from "@/core/time";
import { db, schema, type DbOrTx } from "../db";
import { env } from "../env";
import { renderEmail, sendEmail } from "./email";
import { settingsFor } from "./push";
import { activeOwners, notify, taskHref } from "./tasks";

/**
 * Scheduled notifications (brief §9): due tomorrow, overdue nudges every 2
 * days (the third copies the owner and emails), and the 7:00am digest.
 * Each runs once a New York day from the hourly tick.
 */

const openTaskOnLiveProject = and(ne(schema.task.status, "done"), isNull(schema.project.archivedAt), ne(schema.project.status, "closed"));

/** Tasks due tomorrow, to their assignee. */
export async function dueTomorrowJob(now = new Date()): Promise<{ notified: number }> {
  const tomorrow = addDays(todayET(now), 1);
  return db().transaction(async (tx) => {
    const rows = await tx
      .select({ id: schema.task.id, title: schema.task.title, projectId: schema.task.projectId, assigneeId: schema.task.assigneeId, projectName: schema.project.name })
      .from(schema.task)
      .innerJoin(schema.project, eq(schema.project.id, schema.task.projectId))
      .where(and(eq(schema.task.dueOn, tomorrow), isNotNull(schema.task.assigneeId), openTaskOnLiveProject))
      .limit(2000);
    const notified = await notify(
      tx,
      null,
      rows.map((t) => ({ userId: t.assigneeId!, kind: "due_tomorrow" as const, title: `Due tomorrow: “${t.title}”`, body: t.projectName, projectId: t.projectId, taskId: t.id, href: taskHref(t.projectId, t.id) }))
    );
    return { notified };
  });
}

/**
 * Overdue: every 2 days to the assignee until done or re-dated. The third
 * nudge also goes to the owner, and by email to both (email carries only the
 * third nudge, brief §3).
 */
export async function overdueNudgeJob(now = new Date()): Promise<{ nudged: number; escalated: number }> {
  const today = todayET(now);
  const conn = db();
  const toEmail: { to: string; title: string; body: string; href: string }[] = [];
  const result = await conn.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: schema.task.id,
        title: schema.task.title,
        projectId: schema.task.projectId,
        assigneeId: schema.task.assigneeId,
        dueOn: schema.task.dueOn,
        status: schema.task.status,
        nudgeCount: schema.task.nudgeCount,
        nudgedForDue: schema.task.nudgedForDue,
        lastNudgedOn: schema.task.lastNudgedOn,
        projectName: schema.project.name,
      })
      .from(schema.task)
      .innerJoin(schema.project, eq(schema.project.id, schema.task.projectId))
      .where(and(lt(schema.task.dueOn, today), isNotNull(schema.task.assigneeId), openTaskOnLiveProject))
      .limit(2000);
    const owners = await activeOwners(tx);
    let nudged = 0;
    let escalated = 0;
    for (const t of rows) {
      const n = overdueNudge(t, today);
      if (!n) continue;
      await tx.update(schema.task).set({ nudgeCount: n.count, nudgedForDue: t.dueOn, lastNudgedOn: today }).where(eq(schema.task.id, t.id));
      const due = formatIsoDate(t.dueOn!, { month: "short", day: "numeric" });
      const href = taskHref(t.projectId, t.id);
      const people = [t.assigneeId!, ...(n.copyOwner ? owners.filter((o) => o !== t.assigneeId) : [])];
      const sent = await notify(
        tx,
        null,
        people.map((userId, i) => ({
          userId,
          kind: "overdue" as const,
          title: i === 0 ? `Overdue: “${t.title}”` : `Still overdue after 3 reminders: “${t.title}”`,
          body: `${t.projectName} · was due ${due}`,
          projectId: t.projectId,
          taskId: t.id,
          href,
        }))
      );
      nudged += sent;
      if (n.copyOwner) {
        escalated++;
        const settings = await settingsFor(tx, people);
        const users = await tx.select({ id: schema.user.id, email: schema.user.email }).from(schema.user).where(and(inArray(schema.user.id, people), eq(schema.user.status, "active")));
        for (const u of users) {
          if (channelOn(settings.get(u.id)?.prefs, "overdue", "email")) toEmail.push({ to: u.email, title: `Overdue: “${t.title}”`, body: `${t.projectName} · was due ${due} · 3 reminders so far`, href });
        }
      }
    }
    return { nudged, escalated };
  });
  // Email after the transaction commits: the outbox has its own locking.
  for (const m of toEmail) {
    const content = renderEmail({ preheader: safeOutsideText(m.title), heading: m.title, paragraphs: [m.body], cta: { label: "Open the task", url: `${env().APP_URL}${m.href}` } });
    await sendEmail({ to: m.to, subject: `Project Command: ${safeOutsideText(m.title)}`.slice(0, 200), ...content, category: "nudge", urgent: false });
  }
  return result;
}

export interface DigestCounts {
  overdue: number;
  today: number;
  approvals: number;
  blocked: number;
  top: string[];
}

/** One person's digest numbers: my overdue, due today, approvals waiting on me, my blocked tasks. */
export async function digestFor(conn: DbOrTx, userIds: string[], today: string): Promise<Map<string, DigestCounts>> {
  const out = new Map<string, DigestCounts>();
  if (userIds.length === 0) return out;
  const rows = await conn.execute<{ user_id: string; overdue: number; today: number; blocked: number; approvals: number; top: string[] | null }>(sql`
    with mine as (
      select t.assignee_id as user_id, t.title, t.due_on, t.status
      from task t join project p on p.id = t.project_id
      where t.status <> 'done' and p.archived_at is null and p.status <> 'closed' and t.assignee_id in ${userIds}
    ), approvals as (
      select t.approver_id as user_id, count(*)::int as n
      from task t join project p on p.id = t.project_id
      where t.status = 'awaiting_approval' and p.archived_at is null and t.approver_id in ${userIds}
      group by t.approver_id
    ), counts as (
      select user_id,
        count(*) filter (where due_on < ${today})::int as overdue,
        count(*) filter (where due_on = ${today})::int as today,
        count(*) filter (where status = 'blocked')::int as blocked,
        (array_agg(title order by due_on nulls last) filter (where due_on <= ${today}))[1:3] as top
      from mine group by user_id
    )
    select coalesce(c.user_id, a.user_id) as user_id, coalesce(c.overdue, 0) as overdue, coalesce(c.today, 0) as today,
      coalesce(c.blocked, 0) as blocked, coalesce(a.n, 0) as approvals, c.top
    from counts c full outer join approvals a on a.user_id = c.user_id`);
  for (const r of rows.rows) out.set(r.user_id, { overdue: r.overdue, today: r.today, approvals: r.approvals, blocked: r.blocked, top: r.top ?? [] });
  return out;
}

export function digestTitle(c: DigestCounts): string {
  const parts = [
    c.overdue && `${c.overdue} overdue`,
    c.today && `${c.today} due today`,
    c.approvals && `${c.approvals} approval${c.approvals === 1 ? "" : "s"} waiting`,
    c.blocked && `${c.blocked} blocked`,
  ].filter(Boolean);
  return `Your day: ${parts.join(" · ")}`;
}

/** 7:00am New York: one digest per person who has anything to act on and hasn't switched it off. */
export async function digestJob(now = new Date()): Promise<{ digests: number; emailed: number }> {
  const today = todayET(now);
  const conn = db();
  const users = await conn.select({ id: schema.user.id, email: schema.user.email }).from(schema.user).where(eq(schema.user.status, "active"));
  const settings = await settingsFor(conn, users.map((u) => u.id));
  const wanting = users.filter((u) => settings.get(u.id)!.digest);
  const counts = await digestFor(conn, wanting.map((u) => u.id), today);
  let digests = 0;
  let emailed = 0;
  for (const u of wanting) {
    const c = counts.get(u.id);
    if (!c || c.overdue + c.today + c.approvals + c.blocked === 0) continue;
    const title = digestTitle(c);
    const body = c.top.length ? c.top.map((t) => `“${t}”`).join(" · ") : "Open My Tasks for the list.";
    digests += await notify(conn, null, [{ userId: u.id, kind: "digest", title, body, href: "/tasks" }]);
    if (channelOn(settings.get(u.id)!.prefs, "digest", "email")) {
      const content = renderEmail({
        preheader: title,
        heading: "Good morning",
        paragraphs: [
          `Overdue: ${c.overdue}`,
          `Due today: ${c.today}`,
          `Approvals waiting on you: ${c.approvals}`,
          `Blocked: ${c.blocked}`,
          ...(c.top.length ? [`First up: ${c.top.join("; ")}`] : []),
        ],
        cta: { label: "Open My Tasks", url: `${env().APP_URL}/tasks` },
      });
      const status = await sendEmail({ to: u.email, subject: `Project Command: ${safeOutsideText(title)}`.slice(0, 200), ...content, category: "digest", urgent: false });
      if (status === "sent") emailed++;
    }
  }
  return { digests, emailed };
}

/**
 * A file landed in a folder: tell the people watching it, checked at send
 * time against who may see that folder now (a gated folder needs
 * financials; outsiders need a share).
 */
export async function notifyFileAdded(tx: DbOrTx, actorId: string, input: { projectId: string; folderId: string; fileId: string; name: string; isNewVersion: boolean }): Promise<number> {
  const watchers = await tx
    .select({ userId: schema.folderWatch.userId, role: schema.user.role, status: schema.user.status, canViewFinancials: schema.projectMember.canViewFinancials, member: schema.projectMember.userId })
    .from(schema.folderWatch)
    .innerJoin(schema.user, eq(schema.user.id, schema.folderWatch.userId))
    .leftJoin(schema.projectMember, and(eq(schema.projectMember.userId, schema.folderWatch.userId), eq(schema.projectMember.projectId, input.projectId)))
    .where(and(eq(schema.folderWatch.folderId, input.folderId), ne(schema.folderWatch.userId, actorId)));
  if (watchers.length === 0) return 0;
  const [folder] = await tx.select().from(schema.folder).where(eq(schema.folder.id, input.folderId));
  if (!folder) return 0;
  const shared = new Set(
    (await tx.select({ u: schema.folderShare.userId }).from(schema.folderShare).where(and(eq(schema.folderShare.folderId, input.folderId), inArray(schema.folderShare.userId, watchers.map((w) => w.userId))))).map((r) => r.u),
  );
  const [p] = await tx.select({ name: schema.project.name }).from(schema.project).where(eq(schema.project.id, input.projectId));
  const allowed = watchers.filter((w) => {
    const actor = { userId: w.userId, role: w.role, status: w.status };
    const membership = w.member ? { projectRole: "", canViewFinancials: !!w.canViewFinancials, canEditChecklist: false, canApprove: false } : null;
    if (!canProject(actor, membership, "project.view")) return false;
    return canSeeFolder(folder, { seesAll: canProject(actor, membership, "folder.viewAll"), financials: canProject(actor, membership, "financials.view"), shared: shared.has(w.userId) });
  });
  // A batch upload is one notification, not twenty: fold into an unread one from the last few minutes.
  const folderHref = `/projects/${input.projectId}?tab=files&folder=${input.folderId}`;
  const recent = allowed.length
    ? await tx
        .update(schema.notification)
        .set({ title: `New files in ${folder.name}`, body: `${input.name} and more · ${p?.name ?? ""}`, href: folderHref })
        .where(
          and(
            eq(schema.notification.kind, "file_added"),
            inArray(schema.notification.userId, allowed.map((w) => w.userId)),
            isNull(schema.notification.readAt),
            sql`${schema.notification.createdAt} > now() - interval '15 minutes'`,
            sql`${schema.notification.href} like ${folderHref + "%"}`,
          ),
        )
        .returning({ userId: schema.notification.userId })
    : [];
  const folded = new Set(recent.map((r) => r.userId));
  return notify(
    tx,
    actorId,
    allowed.filter((w) => !folded.has(w.userId)).map((w) => ({
      userId: w.userId,
      kind: "file_added" as const,
      title: `${input.isNewVersion ? "New version of" : "New file in"} ${folder.name}: ${input.name}`,
      body: p?.name ?? null,
      projectId: input.projectId,
      href: `/projects/${input.projectId}?tab=files&folder=${input.folderId}&file=${input.fileId}`,
    })),
  );
}
