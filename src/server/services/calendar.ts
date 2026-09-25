import "server-only";
import { and, eq, gte, inArray, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import { expiryLabel, FINANCIAL_EXPIRY } from "@/core/expiries";
import type { CalendarEvent } from "@/core/ics";
import { isFinancialKeyDate, keyDateLabel } from "@/core/key-dates";
import { canGlobal, canProject, type Actor, type Membership } from "@/core/permissions";
import { addDays, todayET } from "@/core/time";
import { db, schema } from "../db";

/** Key dates about money: only for people who see the project's financials (the feed never carries amounts either way). */

/**
 * Module H: what one person's feed holds, from 30 days back to a year out.
 * Their own tasks everywhere; for the internal team also key dates,
 * inspections, meetings and expiries on their projects; for outside
 * collaborators their RFIs, submittals and punch items. Nothing financial.
 */
export async function calendarEventsFor(actor: Actor, appUrl: string, today = todayET()): Promise<CalendarEvent[]> {
  if (actor.role === "investor" || actor.status !== "active") return [];
  const conn = db();
  const from = addDays(today, -30);
  const to = addDays(today, 365);
  const projects = await conn.select({ id: schema.project.id, name: schema.project.name }).from(schema.project).where(isNull(schema.project.archivedAt));
  const memberships = new Map(
    (
      await conn
        .select({ projectId: schema.projectMember.projectId, projectRole: schema.projectMember.projectRole, canViewFinancials: schema.projectMember.canViewFinancials, canEditChecklist: schema.projectMember.canEditChecklist, canApprove: schema.projectMember.canApprove })
        .from(schema.projectMember)
        .where(eq(schema.projectMember.userId, actor.userId))
    ).map((m) => [m.projectId, m as Membership]),
  );
  const all = canGlobal(actor, "projects.viewAll");
  const mine = projects.filter((p) => all || memberships.has(p.id));
  if (mine.length === 0) return [];
  const name = new Map(mine.map((p) => [p.id, p.name]));
  const ids = mine.map((p) => p.id);
  const can = (projectId: string, action: Parameters<typeof canProject>[2]) => canProject(actor, memberships.get(projectId) ?? null, action);
  const internal = ids.filter((id) => can(id, "task.viewAll"));
  const link = (projectId: string, q: string) => `${appUrl}/projects/${projectId}?${q}`;
  const events: CalendarEvent[] = [];

  // Tasks: my own everywhere; inspections the team should know about on internal projects.
  const tasks = await conn
    .select({ id: schema.task.id, projectId: schema.task.projectId, title: schema.task.title, dueOn: schema.task.dueOn, assigneeId: schema.task.assigneeId })
    .from(schema.task)
    .where(
      and(
        inArray(schema.task.projectId, ids),
        ne(schema.task.status, "done"),
        isNotNull(schema.task.dueOn),
        gte(schema.task.dueOn, from),
        lte(schema.task.dueOn, to),
        or(eq(schema.task.assigneeId, actor.userId), internal.length ? and(inArray(schema.task.projectId, internal), sql`${schema.task.title} ~* 'inspection'`) : sql`false`),
      ),
    );
  for (const t of tasks) {
    events.push({ uid: `task-${t.id}`, date: t.dueOn!, title: t.assigneeId === actor.userId ? `Due: ${t.title}` : t.title, location: name.get(t.projectId), url: link(t.projectId, `tab=checklist&task=${t.id}`) });
  }

  if (internal.length) {
    const keys = await conn.select().from(schema.keyDate).where(and(inArray(schema.keyDate.projectId, internal), gte(schema.keyDate.date, from), lte(schema.keyDate.date, to), eq(schema.keyDate.done, false)));
    for (const k of keys) {
      if (isFinancialKeyDate(k.kind) && !can(k.projectId, "financials.view")) continue;
      events.push({ uid: `key-${k.id}`, date: k.date, title: `${k.label || keyDateLabel(k.kind)}`, location: name.get(k.projectId), url: link(k.projectId, "tab=dates") });
    }
    const meetings = await conn.select().from(schema.meeting).where(and(inArray(schema.meeting.projectId, internal), gte(schema.meeting.heldOn, from), lte(schema.meeting.heldOn, to)));
    for (const m of meetings) {
      events.push({ uid: `meeting-${m.id}`, date: m.heldOn, title: `${m.type.toUpperCase()} meeting #${m.number}${m.title ? `: ${m.title}` : ""}`, location: name.get(m.projectId), url: link(m.projectId, "tab=field&view=meetings") });
    }
    const expiries = await conn.select().from(schema.expiryItem).where(and(inArray(schema.expiryItem.projectId, internal), isNull(schema.expiryItem.closedAt), gte(schema.expiryItem.expiresOn, from), lte(schema.expiryItem.expiresOn, to)));
    for (const x of expiries) {
      if (FINANCIAL_EXPIRY.has(x.category) && !can(x.projectId, "financials.view")) continue;
      events.push({ uid: `expiry-${x.id}`, date: x.expiresOn, title: `Expires: ${expiryLabel(x.category, x.vendorName ?? x.label)}`, location: name.get(x.projectId), url: link(x.projectId, "tab=dates") });
    }
  }

  // Outside collaborators: the paperwork that's theirs to turn around.
  const rfis = await conn
    .select({ id: schema.rfi.id, projectId: schema.rfi.projectId, number: schema.rfi.number, subject: schema.rfi.subject, dueOn: schema.rfi.dueOn })
    .from(schema.rfi)
    .where(and(inArray(schema.rfi.projectId, ids), eq(schema.rfi.toUserId, actor.userId), eq(schema.rfi.status, "open"), isNotNull(schema.rfi.dueOn), gte(schema.rfi.dueOn, from), lte(schema.rfi.dueOn, to)));
  for (const r of rfis) events.push({ uid: `rfi-${r.id}`, date: r.dueOn!, title: `RFI #${r.number} answer due: ${r.subject}`, location: name.get(r.projectId), url: link(r.projectId, "tab=field&view=rfis") });
  const subs = await conn
    .select({ id: schema.submittal.id, projectId: schema.submittal.projectId, number: schema.submittal.number, item: schema.submittal.item, dueOn: schema.submittal.dueOn })
    .from(schema.submittal)
    .where(and(inArray(schema.submittal.projectId, ids), eq(schema.submittal.reviewerId, actor.userId), eq(schema.submittal.status, "pending"), isNotNull(schema.submittal.dueOn), gte(schema.submittal.dueOn, from), lte(schema.submittal.dueOn, to)));
  for (const s of subs) events.push({ uid: `submittal-${s.id}`, date: s.dueOn!, title: `Submittal #${s.number} review due: ${s.item}`, location: name.get(s.projectId), url: link(s.projectId, "tab=field&view=submittals") });
  const punch = await conn
    .select({ id: schema.punchItem.id, projectId: schema.punchItem.projectId, number: schema.punchItem.number, title: schema.punchItem.title, dueOn: schema.punchItem.dueOn })
    .from(schema.punchItem)
    .where(and(inArray(schema.punchItem.projectId, ids), eq(schema.punchItem.assigneeId, actor.userId), ne(schema.punchItem.status, "closed"), isNotNull(schema.punchItem.dueOn), gte(schema.punchItem.dueOn, from), lte(schema.punchItem.dueOn, to)));
  for (const p of punch) events.push({ uid: `punch-${p.id}`, date: p.dueOn!, title: `Punch #${p.number}: ${p.title}`, location: name.get(p.projectId), url: link(p.projectId, "tab=field&view=punch") });

  return events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.uid.localeCompare(b.uid)));
}
