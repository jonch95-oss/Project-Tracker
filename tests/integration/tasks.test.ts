import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { addBusinessDays, nextBusinessDay } from "@/core/calendar";
import { mentionToken } from "@/core/mentions";
import { addDays, todayET } from "@/core/time";
import { db, schema } from "@/server/db";
import { followUpJob, keyDateReminderJob } from "@/server/services/tasks";
import { addMember, callerFor, companyId, createUser } from "../support/fixtures";

type Caller = Awaited<ReturnType<typeof callerFor>>;

async function newProject(c: Caller, name = `Tasks ${Math.random().toString(36).slice(2, 7)}`) {
  return c.projects.create({ name, address: "5 Task Lane", type: "gut_renovation", companyId: await companyId(), bbl: null, toggles: [] });
}

async function addTask(projectId: string, extra: Partial<typeof schema.task.$inferInsert> = {}) {
  const [t] = await db()
    .insert(schema.task)
    .values({ projectId, phaseKey: "pipeline", title: `Task ${Math.random().toString(36).slice(2, 7)}`, ...extra })
    .returning();
  return t!;
}

const row = async (id: string) => (await db().select().from(schema.task).where(eq(schema.task.id, id)))[0]!;
const inbox = async (userId: string) => db().select().from(schema.notification).where(eq(schema.notification.userId, userId));

describe("tasks", () => {
  let owner: Awaited<ReturnType<typeof createUser>>;
  let admin: Awaited<ReturnType<typeof createUser>>;
  let member: Awaited<ReturnType<typeof createUser>>;
  let legal: Awaited<ReturnType<typeof createUser>>;
  let outsider: Awaited<ReturnType<typeof createUser>>;
  let stranger: Awaited<ReturnType<typeof createUser>>;
  let oc: Caller, ac: Caller, mc: Caller, lc: Caller, xc: Caller;
  let projectId: string;

  beforeAll(async () => {
    owner = await createUser("owner", { name: "Olivia Owner" });
    admin = await createUser("admin", { name: "Adam Admin" });
    member = await createUser("member", { name: "Mia Member" });
    legal = await createUser("member", { name: "Lee Legal" });
    outsider = await createUser("external", { name: "Ed Expediter" });
    stranger = await createUser("member", { name: "Sam Stranger" });
    oc = await callerFor(owner.id);
    ac = await callerFor(admin.id);
    mc = await callerFor(member.id);
    lc = await callerFor(legal.id);
    xc = await callerFor(outsider.id);
    projectId = (await newProject(oc)).id;
    await addMember(projectId, admin.id, { canEditChecklist: true, canApprove: true });
    await addMember(projectId, member.id);
    await addMember(projectId, legal.id, { canApprove: true });
    await db().update(schema.projectMember).set({ projectRole: "Legal" }).where(and(eq(schema.projectMember.projectId, projectId), eq(schema.projectMember.userId, legal.id)));
    await addMember(projectId, outsider.id);
  });

  it("assigning notifies the assignee; only people on the project can be assigned", async () => {
    const t = await addTask(projectId);
    await ac.tasks.assign({ projectId, taskId: t.id, version: 1, assigneeId: member.id });
    expect((await row(t.id)).assigneeId).toBe(member.id);
    const n = (await inbox(member.id)).filter((x) => x.taskId === t.id);
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ kind: "assigned", actorId: admin.id, href: `/projects/${projectId}?tab=checklist&task=${t.id}` });
    await expect(ac.tasks.assign({ projectId, taskId: t.id, version: 2, assigneeId: stranger.id })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // Stale version
    await expect(ac.tasks.assign({ projectId, taskId: t.id, version: 1, assigneeId: null })).rejects.toMatchObject({ code: "CONFLICT" });
    // Members without the checklist flag can't assign.
    await expect(mc.tasks.assign({ projectId, taskId: t.id, version: 2, assigneeId: null })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("waiting on a third party records who and schedules a follow-up every 2 business days", async () => {
    const t = await addTask(projectId, { assigneeId: member.id });
    await expect(mc.tasks.setStatus({ projectId, taskId: t.id, version: 1, status: "waiting" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await mc.tasks.setStatus({ projectId, taskId: t.id, version: 1, status: "waiting", waitingOn: "Expediter — DOB plan exam" });
    const today = todayET();
    let r = await row(t.id);
    expect(r).toMatchObject({ status: "waiting", waitingOn: "Expediter — DOB plan exam", waitingSince: today, followUpOn: addBusinessDays(today, 2) });

    // Two business days later the job nudges the assignee and re-arms.
    const later = new Date(`${addBusinessDays(today, 2)}T14:00:00Z`);
    await followUpJob(later);
    const nudges = (await inbox(member.id)).filter((x) => x.taskId === t.id && x.kind === "follow_up");
    expect(nudges).toHaveLength(1);
    expect(nudges[0]!.title).toContain("Expediter — DOB plan exam");
    r = await row(t.id);
    expect(r.followUpOn).toBe(addBusinessDays(addBusinessDays(today, 2), 2));
    await followUpJob(later); // idempotent the same day
    expect((await inbox(member.id)).filter((x) => x.taskId === t.id && x.kind === "follow_up")).toHaveLength(1);

    // Moving on clears it.
    await mc.tasks.setStatus({ projectId, taskId: t.id, version: r.version, status: "in_progress" });
    expect(await row(t.id)).toMatchObject({ status: "in_progress", waitingOn: null, followUpOn: null, waitingSince: null });
  });

  it("blocked needs a reason; done and awaiting-approval can't be set directly", async () => {
    const t = await addTask(projectId, { assigneeId: member.id });
    await expect(mc.tasks.setStatus({ projectId, taskId: t.id, version: 1, status: "blocked" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await mc.tasks.setStatus({ projectId, taskId: t.id, version: 1, status: "blocked", blockedReason: "Neighbor won't sign the access agreement" });
    expect((await row(t.id)).blockedReason).toBe("Neighbor won't sign the access agreement");
    await expect(mc.tasks.setStatus({ projectId, taskId: t.id, version: 2, status: "done" as never })).rejects.toBeTruthy();
  });

  it("approval: a member's tick goes to the approver named by role, who approves or sends back with a note", async () => {
    const t = await addTask(projectId, { assigneeId: member.id, requiresApproval: true, approverRole: "Legal" });
    const sent = await mc.checklist.setDone({ projectId, taskId: t.id, done: true, version: 1 });
    expect(sent.status).toBe("awaiting_approval");
    let r = await row(t.id);
    expect(r.approverId).toBe(legal.id);
    expect(r.approvalRequestedAt).toBeInstanceOf(Date);
    expect((await inbox(legal.id)).some((n) => n.taskId === t.id && n.kind === "approval_requested")).toBe(true);

    // My Tasks: approver sees it under "Awaiting my approval", the assignee under "Waiting on others".
    const lm = await lc.tasks.mine();
    expect(lm.sections.find((s) => s.key === "approve")!.groups.flatMap((g) => g.tasks).some((x) => x.id === t.id)).toBe(true);
    const mm = await mc.tasks.mine();
    expect(mm.sections.find((s) => s.key === "waiting")!.groups.flatMap((g) => g.tasks).some((x) => x.id === t.id)).toBe(true);
    const ny = await lc.tasks.needsYou();
    expect(ny.approvals.some((x) => x.id === t.id)).toBe(true);

    // Only approvers decide; sending back needs a note.
    await expect(mc.tasks.decide({ projectId, taskId: t.id, version: r.version, decision: "approved" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(lc.tasks.decide({ projectId, taskId: t.id, version: r.version, decision: "rejected" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await lc.tasks.decide({ projectId, taskId: t.id, version: r.version, decision: "rejected", note: "Wrong entity on the deed" });
    r = await row(t.id);
    expect(r).toMatchObject({ status: "in_progress", approvalDecision: "rejected", approvalNote: "Wrong entity on the deed", approvalDecidedById: legal.id });
    expect((await inbox(member.id)).some((n) => n.taskId === t.id && n.kind === "approval_decided" && n.body === "Wrong entity on the deed")).toBe(true);

    // Resubmit and approve.
    await mc.checklist.setDone({ projectId, taskId: t.id, done: true, version: r.version });
    r = await row(t.id);
    await lc.tasks.decide({ projectId, taskId: t.id, version: r.version, decision: "approved" });
    r = await row(t.id);
    expect(r).toMatchObject({ status: "done", approvalDecision: "approved", completedOn: todayET() });
    // A second decision on the same request is refused.
    await expect(lc.tasks.decide({ projectId, taskId: t.id, version: r.version, decision: "approved" })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("recurring tasks roll forward on completion, and reopening removes the untouched next one", async () => {
    const today = todayET();
    const t = await addTask(projectId, { assigneeId: member.id, dueOn: today, recurrence: { freq: "weekly" }, subItems: [{ id: "a", text: "Photos", done: true }] });
    await db().insert(schema.taskWatcher).values({ taskId: t.id, userId: admin.id });
    const out = await mc.checklist.setDone({ projectId, taskId: t.id, done: true, version: 1 });
    expect(out.status).toBe("done");
    const series = await db().select().from(schema.task).where(eq(schema.task.seriesId, t.id));
    expect(series).toHaveLength(1);
    expect(series[0]).toMatchObject({ title: t.title, status: "not_started", assigneeId: member.id, dueOn: nextBusinessDay(addDays(today, 7)) });
    expect(series[0]!.subItems[0]!.done).toBe(false);
    expect(await db().select().from(schema.taskWatcher).where(eq(schema.taskWatcher.taskId, series[0]!.id))).toHaveLength(1);

    // Undo: the untouched next occurrence goes away.
    await mc.checklist.setDone({ projectId, taskId: t.id, done: false, version: (await row(t.id)).version });
    expect(await db().select().from(schema.task).where(eq(schema.task.seriesId, t.id))).toHaveLength(0);
  });

  it("completing the last prerequisite tells the dependent task's assignee they can start", async () => {
    const a = await addTask(projectId, { assigneeId: admin.id });
    const b = await addTask(projectId, { assigneeId: member.id });
    const c = await addTask(projectId, { assigneeId: admin.id });
    await oc.checklist.setDependencies({ projectId, taskId: b.id, dependsOnIds: [a.id, c.id] });
    await ac.checklist.setDone({ projectId, taskId: a.id, done: true, version: 1 });
    expect((await inbox(member.id)).some((n) => n.taskId === b.id && n.kind === "unblocked")).toBe(false);
    await ac.checklist.setDone({ projectId, taskId: c.id, done: true, version: 1 });
    expect((await inbox(member.id)).some((n) => n.taskId === b.id && n.kind === "unblocked")).toBe(true);
  });

  it("comments: @mentions notify only people who can see the task; watchers and the assignee hear about comments", async () => {
    const t = await addTask(projectId, { assigneeId: member.id });
    await ac.tasks.setWatcher({ projectId, taskId: t.id, userId: legal.id, on: true });
    const body = `Can ${mentionToken({ id: admin.id, name: "Adam Admin" })} and ${mentionToken({ id: outsider.id, name: "Ed Expediter" })} look at this?`;
    const { id } = await mc.tasks.addComment({ projectId, taskId: t.id, body });
    const [cm] = await db().select().from(schema.taskComment).where(eq(schema.taskComment.id, id));
    // The outsider can't see this task, so their mention is ignored.
    expect(cm!.mentions).toEqual([admin.id]);
    expect((await inbox(admin.id)).filter((n) => n.taskId === t.id).map((n) => n.kind)).toEqual(["mention"]);
    expect((await inbox(outsider.id)).some((n) => n.taskId === t.id)).toBe(false);
    expect((await inbox(legal.id)).some((n) => n.taskId === t.id && n.kind === "comment" && n.body === "Can @Adam Admin and @Ed Expediter look at this?")).toBe(true);
    expect((await inbox(member.id)).some((n) => n.taskId === t.id && n.kind === "comment")).toBe(false); // not to yourself

    // Only the author edits; admins can remove.
    await expect(ac.tasks.editComment({ projectId, taskId: t.id, commentId: id, body: "hijack" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(lc.tasks.deleteComment({ projectId, taskId: t.id, commentId: id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await oc.tasks.deleteComment({ projectId, taskId: t.id, commentId: id });
    const d = await mc.tasks.detail({ projectId, taskId: t.id });
    expect(d.comments[0]).toMatchObject({ body: "" });
    expect(d.comments[0]!.deletedAt).toBeInstanceOf(Date);
  });

  it("sharing a task with an outsider (as a watcher) lets them see and work only that task", async () => {
    const t = await addTask(projectId, { title: "Shared with expediter" });
    const hidden = await addTask(projectId, { title: "Internal only" });
    const before = await xc.checklist.get({ projectId });
    expect(before.tasks.some((x) => x.id === t.id)).toBe(false);
    await expect(xc.tasks.detail({ projectId, taskId: t.id })).rejects.toMatchObject({ code: "NOT_FOUND" });

    await ac.tasks.setWatcher({ projectId, taskId: t.id, userId: outsider.id, on: true });
    const after = await xc.checklist.get({ projectId });
    expect(after.tasks.some((x) => x.id === t.id)).toBe(true);
    expect(after.tasks.some((x) => x.id === hidden.id)).toBe(false);
    const d = await xc.tasks.detail({ projectId, taskId: t.id });
    // They see only people who can see the task: the internal team and themselves, never other outside parties.
    expect(d.people.map((p) => p.id).sort()).toEqual(d.mentionable.map((p) => p.id).sort());
    expect(d.people.every((p) => !p.external || p.id === outsider.id)).toBe(true);
    await xc.tasks.addComment({ projectId, taskId: t.id, body: "Plan exam booked for Tuesday" });
    // Watchers who aren't the assignee can comment but not change status.
    await expect(xc.tasks.setStatus({ projectId, taskId: t.id, version: (await row(t.id)).version, status: "in_progress" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    // They can't drop the share themselves.
    await expect(xc.tasks.watch({ projectId, taskId: t.id, on: false })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const p = await xc.projects.get({ projectId });
    const total = Object.values(p.taskCounts).reduce((s, x) => s + x.total, 0);
    expect(total).toBe(1);

    await ac.tasks.setWatcher({ projectId, taskId: t.id, userId: outsider.id, on: false });
    expect((await xc.checklist.get({ projectId })).tasks.some((x) => x.id === t.id)).toBe(false);
  });

  it("bulk: reassign, re-date and shift skip done tasks; shifting a phase moves its open dated tasks", async () => {
    const today = todayET();
    const a = await addTask(projectId, { phaseKey: "due_diligence", dueOn: addBusinessDays(today, 3) });
    const b = await addTask(projectId, { phaseKey: "due_diligence", dueOn: addBusinessDays(today, 5) });
    const done = await addTask(projectId, { phaseKey: "due_diligence", dueOn: today, status: "done", completedOn: today });
    const r1 = await ac.tasks.bulk({ projectId, taskIds: [a.id, b.id, done.id], action: { kind: "reassign", assigneeId: member.id } });
    expect(r1).toEqual({ changed: 2, skippedDone: 1 });
    expect((await row(done.id)).assigneeId).toBeNull();
    expect((await inbox(member.id)).some((n) => n.title.includes("gave you 2 tasks"))).toBe(true);

    await ac.tasks.bulk({ projectId, taskIds: [a.id, b.id], action: { kind: "shift", days: 2, unit: "business" } });
    expect((await row(a.id)).dueOn).toBe(addBusinessDays(addBusinessDays(today, 3), 2));
    expect((await row(a.id)).dueManual).toBe(true);

    await ac.tasks.bulk({ projectId, taskIds: [a.id], action: { kind: "redate", dueOn: "2031-06-02" } });
    expect((await row(a.id)).dueOn).toBe("2031-06-02");

    const bBefore = (await row(b.id)).dueOn!;
    await ac.tasks.shiftPhase({ projectId, phaseKey: "due_diligence", days: -1, unit: "business" });
    expect((await row(b.id)).dueOn).toBe(addBusinessDays(bBefore, -1));
    expect((await row(done.id)).dueOn).toBe(today);

    // Tasks from another project are refused.
    const other = await newProject(oc);
    const foreign = await addTask(other.id);
    await expect(ac.tasks.bulk({ projectId, taskIds: [foreign.id], action: { kind: "redate", dueOn: today } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("My Tasks sorts my open tasks into Overdue / Today / This week / Later, grouped by project", async () => {
    const me = await createUser("member");
    const c = await callerFor(me.id);
    await addMember(projectId, me.id);
    const today = todayET();
    await addTask(projectId, { assigneeId: me.id, dueOn: addDays(today, -3), title: "Late one" });
    await addTask(projectId, { assigneeId: me.id, dueOn: today, title: "Today one" });
    await addTask(projectId, { assigneeId: me.id, dueOn: addDays(today, 40), title: "Later one" });
    await addTask(projectId, { assigneeId: me.id, status: "waiting", waitingOn: "Lender", title: "Waiting one" });
    await addTask(projectId, { assigneeId: me.id, status: "done", title: "Done one" });
    const m = await c.tasks.mine();
    const titles = (k: string) => m.sections.find((s) => s.key === k)!.groups.flatMap((g) => g.tasks.map((t) => t.title));
    expect(titles("overdue")).toEqual(["Late one"]);
    expect(titles("today")).toEqual(["Today one"]);
    expect(titles("later")).toEqual(["Later one"]);
    expect(titles("waiting")).toEqual(["Waiting one"]);
    expect(m.total).toBe(4);
    expect(m.sections.find((s) => s.key === "overdue")!.groups[0]!.project.id).toBe(projectId);

    // Removed from the project: nothing shows.
    await db().delete(schema.projectMember).where(and(eq(schema.projectMember.projectId, projectId), eq(schema.projectMember.userId, me.id)));
    expect((await c.tasks.mine()).total).toBe(0);
  });

  it("key dates: editors add them; they show on cards, the rail and drive 14/7/1-day reminders", async () => {
    const today = todayET();
    await expect(mc.keyDates.save({ projectId, kind: "closing", date: addDays(today, 7) })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(xc.keyDates.list({ projectId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const { id } = await ac.keyDates.save({ projectId, kind: "closing", date: addDays(today, 7) });
    await ac.keyDates.save({ projectId, kind: "other", label: "Board interview", date: addDays(today, 30) });
    await expect(ac.keyDates.save({ projectId, kind: "other", date: today })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const list = await mc.keyDates.list({ projectId });
    expect(list.dates.map((d) => d.label)).toEqual(["Closing", "Board interview"]);
    expect(list.canEdit).toBe(false);

    const cards = await oc.projects.list();
    expect(cards.projects.find((p) => p.id === projectId)!.facts.nextKeyDate).toEqual({ label: "Closing", date: addDays(today, 7) });
    const outsiderCard = await xc.projects.list();
    expect(outsiderCard.projects.find((p) => p.id === projectId)!.facts.nextKeyDate).toBeNull();
    const rail = await oc.tasks.needsYou();
    expect(rail.keyDates.some((d) => d.id === id)).toBe(true);

    await keyDateReminderJob(new Date(`${today}T15:00:00Z`));
    const got = (await inbox(member.id)).filter((n) => n.kind === "key_date" && n.projectId === projectId);
    expect(got).toHaveLength(1);
    expect(got[0]!.title).toBe("Closing in 7 days");
    expect((await inbox(outsider.id)).some((n) => n.kind === "key_date")).toBe(false);

    await ac.keyDates.save({ id, projectId, kind: "closing", date: addDays(today, 7), done: true });
    expect((await oc.projects.list()).projects.find((p) => p.id === projectId)!.facts.nextKeyDate!.label).toBe("Board interview");
    await ac.keyDates.remove({ projectId, id });
  });

  it("cards show the next action and its owner, and blocked and overdue counts", async () => {
    const c = await callerFor(owner.id);
    const p = await newProject(c);
    const today = todayET();
    await db().update(schema.task).set({ status: "done" }).where(eq(schema.task.projectId, p.id));
    const first = await addTask(p.id, { phaseKey: "pipeline", title: "First up", assigneeId: member.id, dueOn: addDays(today, -2) });
    const held = await addTask(p.id, { phaseKey: "pipeline", title: "Held", dueOn: addDays(today, -5) });
    await c.checklist.setDependencies({ projectId: p.id, taskId: held.id, dependsOnIds: [first.id] });
    await addTask(p.id, { phaseKey: "pipeline", title: "Stuck", status: "blocked", blockedReason: "x" });
    const card = (await c.projects.list()).projects.find((x) => x.id === p.id)!;
    expect(card.facts.nextAction).toMatchObject({ title: "First up", assigneeName: "Mia Member" });
    expect(card.facts.blocked).toBe(1);
    expect(card.facts.overdue).toBe(2);
    const rail = await c.tasks.needsYou();
    expect(rail.blocked.some((t) => t.title === "Stuck")).toBe(true);
    expect(rail.overdueByPerson.find((o) => o.userId === member.id)!.count).toBeGreaterThanOrEqual(1);
  });

  it("notifications: list, unread count and mark read are per person", async () => {
    const u = await createUser("member");
    const c = await callerFor(u.id);
    await addMember(projectId, u.id);
    const t = await addTask(projectId);
    await ac.tasks.assign({ projectId, taskId: t.id, version: 1, assigneeId: u.id });
    expect((await c.notifications.unreadCount()).count).toBe(1);
    const l = await c.notifications.list();
    expect(l.items[0]).toMatchObject({ kind: "assigned", actorName: "Adam Admin" });
    // Someone else can't mark my notifications.
    await mc.notifications.markRead({ ids: [l.items[0]!.id] });
    expect((await c.notifications.unreadCount()).count).toBe(1);
    await c.notifications.markRead({ ids: [l.items[0]!.id] });
    expect((await c.notifications.unreadCount()).count).toBe(0);
  });
});
