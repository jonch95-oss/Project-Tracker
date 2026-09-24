/**
 * Milestone 7 (brief §9): push dispatch with preferences and quiet hours,
 * device registration, the daily jobs (due tomorrow, 2-day overdue nudges,
 * the digest), folder watches and approval email.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { addDays, todayET } from "@/core/time";
import { db, schema } from "@/server/db";
import { setMailerForTests } from "@/server/services/email";
import { digestFor, digestJob, dueTomorrowJob, overdueNudgeJob } from "@/server/services/notifications";
import { dispatchPending, releaseHeld, setPushSenderForTests, type PushMessage, type PushSender } from "@/server/services/push";
import { notify } from "@/server/services/tasks";
import { storage } from "@/server/storage";
import { addMember, callerFor, companyId, createUser } from "../support/fixtures";

type Caller = Awaited<ReturnType<typeof callerFor>>;

const sent: { endpoint: string; msg: PushMessage }[] = [];
const gone = new Set<string>();
const fakeSender: PushSender = {
  enabled: true,
  async send(target, msg) {
    if (gone.has(target.endpoint)) return { ok: false, gone: true };
    sent.push({ endpoint: target.endpoint, msg });
    return { ok: true, gone: false };
  },
};

let seq = 0;
const endpoint = () => `https://web.push.apple.com/QP${Date.now()}${++seq}`;
const keys = { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" };

const inbox = (userId: string) => db().select().from(schema.notification).where(eq(schema.notification.userId, userId));
const pushedTo = (ep: string) => sent.filter((s) => s.endpoint === ep);

async function addTask(projectId: string, extra: Partial<typeof schema.task.$inferInsert> = {}) {
  const [t] = await db()
    .insert(schema.task)
    .values({ projectId, phaseKey: "pipeline", title: `Task ${Math.random().toString(36).slice(2, 7)}`, ...extra })
    .returning();
  return t!;
}

describe("notifications (Milestone 7)", () => {
  let owner: { id: string }, member: { id: string }, other: { id: string };
  let oc: Caller, mc: Caller;
  let projectId: string;

  beforeAll(async () => {
    setPushSenderForTests(fakeSender);
    owner = await createUser("owner");
    member = await createUser("member");
    other = await createUser("member");
    oc = await callerFor(owner.id);
    mc = await callerFor(member.id);
    projectId = (await oc.projects.create({ name: `Notify ${Date.now()}`, address: "7 Bell St", type: "gut_renovation", companyId: await companyId(), bbl: null, toggles: [] })).id;
    await addMember(projectId, member.id);
    await addMember(projectId, other.id);
    // Clear anything earlier test files left pending, so each dispatch here sees only this file's rows.
    await db().update(schema.notification).set({ pushState: "skipped" }).where(eq(schema.notification.pushState, "pending"));
  });
  afterAll(() => setPushSenderForTests(null));
  afterEach(() => {
    sent.length = 0;
    setMailerForTests(null);
  });

  describe("devices", () => {
    it("only real browser push services are accepted", async () => {
      await expect(mc.push.subscribe({ endpoint: "https://evil.example.com/push", keys })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(mc.push.subscribe({ endpoint: "http://web.push.apple.com/x", keys })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(mc.push.subscribe({ endpoint: "https://169.254.169.254/latest", keys })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await mc.push.subscribe({ endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys, label: "Mac · Chrome" });
      expect((await mc.push.devices()).map((d) => d.label)).toContain("Mac · Chrome");
      expect((await mc.push.config()).publicKey).toBeTruthy();
    });

    it("a device that changes hands moves to whoever signs in; people only remove their own", async () => {
      const ep = endpoint();
      await mc.push.subscribe({ endpoint: ep, keys, label: "Shared iPad" });
      const pc = await callerFor(other.id);
      await pc.push.subscribe({ endpoint: ep, keys, label: "Shared iPad" });
      expect((await mc.push.devices()).some((d) => d.endpoint === ep)).toBe(false);
      const mine = (await pc.push.devices()).find((d) => d.endpoint === ep)!;
      await mc.push.removeDevice({ id: mine.id });
      expect((await pc.push.devices()).some((d) => d.endpoint === ep)).toBe(true);
      await pc.push.unsubscribe({ endpoint: ep });
      expect((await pc.push.devices()).some((d) => d.endpoint === ep)).toBe(false);
    });

    it("the app's re-check refreshes a known device but never brings back one removed in Settings", async () => {
      const u = await createUser("member");
      const c = await callerFor(u.id);
      const ep = endpoint();
      await c.push.subscribe({ endpoint: ep, keys });
      expect(await c.push.subscribe({ endpoint: ep, keys, label: "iPhone", refreshOnly: true })).toEqual({ ok: true });
      const d = (await c.push.devices())[0]!;
      expect(d.label).toBe("iPhone");
      await c.push.removeDevice({ id: d.id });
      expect(await c.push.subscribe({ endpoint: ep, keys, refreshOnly: true })).toEqual({ ok: false });
      expect(await c.push.devices()).toHaveLength(0);
    });

    it("keeps at most ten devices per person", async () => {
      const u = await createUser("member");
      const c = await callerFor(u.id);
      for (let i = 0; i < 12; i++) await c.push.subscribe({ endpoint: endpoint(), keys });
      expect(await c.push.devices()).toHaveLength(10);
    });

    it("test push reaches this person's devices, and says so when there are none", async () => {
      const u = await createUser("member");
      const c = await callerFor(u.id);
      await expect(c.push.test()).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
      const ep = endpoint();
      await c.push.subscribe({ endpoint: ep, keys });
      expect(await c.push.test()).toEqual({ devices: 1 });
      expect(pushedTo(ep)).toHaveLength(1);
    });
  });

  describe("dispatch", () => {
    it("pushes new notifications once, without dollar figures, and drops devices that unsubscribed", async () => {
      const u = await createUser("member");
      const c = await callerFor(u.id);
      const ep1 = endpoint();
      const ep2 = endpoint();
      await c.push.subscribe({ endpoint: ep1, keys });
      await c.push.subscribe({ endpoint: ep2, keys });
      gone.add(ep2);
      await notify(db(), null, [{ userId: u.id, kind: "approval_requested", title: "Approve the $48,500.00 invoice from Acme", href: "/projects/x" }]);
      await dispatchPending();
      expect(pushedTo(ep1)).toHaveLength(1);
      expect(pushedTo(ep1)[0]!.msg.title).toBe("Approve the an amount invoice from Acme");
      expect(pushedTo(ep1)[0]!.msg.url).toMatch(/^https?:\/\/.+\/projects\/x$/);
      expect((await c.push.devices()).map((d) => d.endpoint)).toEqual([ep1]);
      const [n] = await inbox(u.id);
      expect(n!.pushState).toBe("sent");
      await dispatchPending();
      expect(pushedTo(ep1)).toHaveLength(1);
    });

    it("two dispatchers at once push each notification exactly once", async () => {
      const u = await createUser("member");
      const c = await callerFor(u.id);
      const ep = endpoint();
      await c.push.subscribe({ endpoint: ep, keys });
      await notify(db(), null, [{ userId: u.id, kind: "assigned", title: "Only once" }]);
      await Promise.all([dispatchPending(), dispatchPending(), dispatchPending()]);
      expect(pushedTo(ep)).toHaveLength(1);
      expect((await inbox(u.id))[0]!.pushState).toBe("sent");
    });

    it("a burst (a morning of overdue reminders) is one summary push, not one per task", async () => {
      const u = await createUser("member");
      const c = await callerFor(u.id);
      const ep = endpoint();
      await c.push.subscribe({ endpoint: ep, keys });
      for (let i = 0; i < 6; i++) await notify(db(), null, [{ userId: u.id, kind: "overdue", title: `Overdue ${i}`, taskId: null }]);
      await dispatchPending();
      expect(pushedTo(ep)).toHaveLength(1);
      expect(pushedTo(ep)[0]!.msg.title).toBe("6 new notifications");
      expect((await inbox(u.id)).every((n) => n.pushState === "sent")).toBe(true);
    });

    it("a held file notice isn't pushed after the reader loses access to the folder", async () => {
      const u = await createUser("member");
      const c = await callerFor(u.id);
      const ep = endpoint();
      await c.push.subscribe({ endpoint: ep, keys });
      const p = (await oc.projects.create({ name: `Held ${Date.now()}`, address: "9 Held St", type: "gut_renovation", companyId: await companyId(), bbl: null, toggles: [] })).id;
      await addMember(p, u.id, { canViewFinancials: true });
      const financial = (await oc.files.folders({ projectId: p })).folders.find((f) => f.name === "Financial")!;
      await c.files.watchFolder({ projectId: p, folderId: financial.id, on: true });
      await c.notifySettings.save({ prefs: {}, quietStart: "00:00", quietEnd: "23:59", digest: true });
      const b = await oc.files.beginUpload({ projectId: p, folderId: financial.id, name: "payoff-letter.pdf", contentType: "application/pdf", sizeBytes: 5 });
      for (const o of b.objects) await storage().put(o.pathname, new Uint8Array(5), { contentType: o.contentType });
      await oc.files.completeUpload({ projectId: p, uploadId: b.uploadId });
      await dispatchPending(100, new Date(`${todayET()}T16:00:00Z`));
      expect((await inbox(u.id)).find((n) => n.kind === "file_added")!.pushState).toBe("held");
      await db().update(schema.projectMember).set({ canViewFinancials: false }).where(and(eq(schema.projectMember.projectId, p), eq(schema.projectMember.userId, u.id)));
      await c.notifySettings.save({ prefs: {}, quietStart: null, quietEnd: null, digest: true });
      await releaseHeld();
      expect(pushedTo(ep)).toHaveLength(0);
      expect((await inbox(u.id)).find((n) => n.kind === "file_added")!.pushState).toBe("skipped");
    });

    it("no device, or push switched off for that event: skipped (still in the Inbox)", async () => {
      const u = await createUser("member");
      await notify(db(), null, [{ userId: u.id, kind: "assigned", title: "No device" }]);
      await dispatchPending();
      expect((await inbox(u.id))[0]!.pushState).toBe("skipped");

      const c = await callerFor(u.id);
      const ep = endpoint();
      await c.push.subscribe({ endpoint: ep, keys });
      await c.notifySettings.save({ prefs: { comment: { push: false } }, quietStart: null, quietEnd: null, digest: true });
      await notify(db(), null, [{ userId: u.id, kind: "comment", title: "Muted" }]);
      await notify(db(), null, [{ userId: u.id, kind: "mention", title: "Loud" }]);
      await dispatchPending();
      expect(pushedTo(ep).map((s) => s.msg.title)).toEqual(["Loud"]);
      expect((await inbox(u.id)).find((n) => n.title === "Muted")!.pushState).toBe("skipped");
    });

    it("quiet hours hold push, then release it as one summary when they end", async () => {
      const u = await createUser("member");
      const c = await callerFor(u.id);
      const ep = endpoint();
      await c.push.subscribe({ endpoint: ep, keys });
      await c.notifySettings.save({ prefs: {}, quietStart: "00:00", quietEnd: "23:59", digest: true });
      await notify(db(), null, [{ userId: u.id, kind: "assigned", title: "One" }]);
      await notify(db(), null, [{ userId: u.id, kind: "assigned", title: "Two" }]);
      await dispatchPending(100, new Date(`${todayET()}T16:00:00Z`));
      expect(pushedTo(ep)).toHaveLength(0);
      expect((await inbox(u.id)).every((n) => n.pushState === "held")).toBe(true);
      await releaseHeld(new Date(`${todayET()}T16:00:00Z`));
      expect(pushedTo(ep)).toHaveLength(0);

      await c.notifySettings.save({ prefs: {}, quietStart: null, quietEnd: null, digest: true });
      await releaseHeld();
      expect(pushedTo(ep)).toHaveLength(1);
      expect(pushedTo(ep)[0]!.msg.title).toBe("2 notifications while you were off");
      expect((await inbox(u.id)).every((n) => n.pushState === "sent")).toBe(true);
    });

    it("held notifications read in the meantime are not pushed", async () => {
      const u = await createUser("member");
      const c = await callerFor(u.id);
      const ep = endpoint();
      await c.push.subscribe({ endpoint: ep, keys });
      await c.notifySettings.save({ prefs: {}, quietStart: "00:00", quietEnd: "23:59", digest: true });
      await notify(db(), null, [{ userId: u.id, kind: "assigned", title: "Read on desktop" }]);
      await dispatchPending(100, new Date(`${todayET()}T16:00:00Z`));
      await c.notifications.markAllRead();
      await c.notifySettings.save({ prefs: {}, quietStart: null, quietEnd: null, digest: true });
      await releaseHeld();
      expect(pushedTo(ep)).toHaveLength(0);
      expect((await inbox(u.id))[0]!.pushState).toBe("skipped");
    });

    it("approval requests are emailed (recorded as skipped while email is on hold), with no amount in the subject", async () => {
      const u = await createUser("member");
      await notify(db(), null, [{ userId: u.id, kind: "approval_requested", title: "Approve the $1.2M change order" }]);
      await dispatchPending();
      const [row] = await db().select().from(schema.emailOutbox).where(eq(schema.emailOutbox.toAddress, (await db().select().from(schema.user).where(eq(schema.user.id, u.id)))[0]!.email));
      expect(row).toMatchObject({ category: "approval", status: "skipped" });
      expect(row!.subject).not.toMatch(/\$/);

      const v = await createUser("member");
      await (await callerFor(v.id)).notifySettings.save({ prefs: { approval_requested: { email: false } }, quietStart: null, quietEnd: null, digest: true });
      await notify(db(), null, [{ userId: v.id, kind: "approval_requested", title: "Approve" }]);
      await dispatchPending();
      const vEmail = (await db().select().from(schema.user).where(eq(schema.user.id, v.id)))[0]!.email;
      expect(await db().select().from(schema.emailOutbox).where(eq(schema.emailOutbox.toAddress, vEmail))).toHaveLength(0);
    });
  });

  describe("preferences", () => {
    it("validates quiet hours and keeps email only for emailed events", async () => {
      await expect(mc.notifySettings.save({ prefs: {}, quietStart: "22:00", quietEnd: null, digest: true })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(mc.notifySettings.save({ prefs: {}, quietStart: "25:00", quietEnd: "07:00", digest: true })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(mc.notifySettings.save({ prefs: {}, quietStart: "07:00", quietEnd: "07:00", digest: true })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(mc.notifySettings.save({ prefs: { nonsense: { push: false } } as never, quietStart: null, quietEnd: null, digest: true })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await mc.notifySettings.save({ prefs: { assigned: { push: false, email: true }, digest: { email: false } }, quietStart: "21:30", quietEnd: "06:45", digest: false });
      const s = await mc.notifySettings.get();
      expect(s).toMatchObject({ prefs: { assigned: { push: false }, digest: { email: false } }, quietStart: "21:30", quietEnd: "06:45", digest: false });
      expect(s.prefs.assigned).not.toHaveProperty("email");
      await mc.notifySettings.save({ prefs: {}, quietStart: null, quietEnd: null, digest: true });
    });
  });

  describe("daily jobs", () => {
    it("due tomorrow: one per task to the assignee, none for done tasks or archived projects", async () => {
      const today = todayET();
      const a = await addTask(projectId, { assigneeId: member.id, dueOn: addDays(today, 1), title: "Pour footings" });
      const b = await addTask(projectId, { assigneeId: member.id, dueOn: addDays(today, 1), title: "Order rebar" });
      const done = await addTask(projectId, { assigneeId: member.id, dueOn: addDays(today, 1), status: "done", title: "Already done" });
      await dueTomorrowJob();
      const mine = (await inbox(member.id)).filter((n) => n.kind === "due_tomorrow");
      expect(mine.map((n) => n.taskId).sort()).toEqual([a.id, b.id].sort());
      expect(mine.some((n) => n.taskId === done.id)).toBe(false);
    });

    it("overdue: every 2 days; the third nudge copies the owner and emails; re-dating starts over", async () => {
      const due = "2026-03-02";
      const t = await addTask(projectId, { assigneeId: member.id, dueOn: due, title: "Submit PW1" });
      const on = (d: string) => new Date(`${d}T15:00:00Z`);
      const nudges = async () => (await inbox(member.id)).filter((n) => n.kind === "overdue" && n.taskId === t.id);
      const ownerCopies = async () => (await inbox(owner.id)).filter((n) => n.kind === "overdue" && n.taskId === t.id);

      await overdueNudgeJob(on("2026-03-03"));
      expect(await nudges()).toHaveLength(1);
      await overdueNudgeJob(on("2026-03-04"));
      expect(await nudges()).toHaveLength(1);
      await overdueNudgeJob(on("2026-03-05"));
      expect(await nudges()).toHaveLength(2);
      expect(await ownerCopies()).toHaveLength(0);
      await overdueNudgeJob(on("2026-03-07"));
      expect(await nudges()).toHaveLength(3);
      expect(await ownerCopies()).toHaveLength(1);
      const memberEmail = (await db().select().from(schema.user).where(eq(schema.user.id, member.id)))[0]!.email;
      const emails = await db().select().from(schema.emailOutbox).where(and(eq(schema.emailOutbox.toAddress, memberEmail), eq(schema.emailOutbox.category, "nudge")));
      expect(emails).toHaveLength(1);

      // Re-dated: the count restarts for the new date.
      await db().update(schema.task).set({ dueOn: "2026-03-10" }).where(eq(schema.task.id, t.id));
      await overdueNudgeJob(on("2026-03-11"));
      const [r] = await db().select().from(schema.task).where(eq(schema.task.id, t.id));
      expect(r).toMatchObject({ nudgeCount: 1, nudgedForDue: "2026-03-10", lastNudgedOn: "2026-03-11" });
      expect(await nudges()).toHaveLength(4);

      // Done: silence.
      await db().update(schema.task).set({ status: "done" }).where(eq(schema.task.id, t.id));
      await overdueNudgeJob(on("2026-03-20"));
      expect(await nudges()).toHaveLength(4);
    });

    it("digest: my overdue, due today, approvals waiting and blocked; nothing when there's nothing, or when it's off", async () => {
      const today = todayET();
      const u = await createUser("member");
      await addMember(projectId, u.id);
      await addTask(projectId, { assigneeId: u.id, dueOn: addDays(today, -3), title: "Late one" });
      await addTask(projectId, { assigneeId: u.id, dueOn: today, title: "Today one" });
      await addTask(projectId, { assigneeId: u.id, status: "blocked", blockedReason: "x", title: "Stuck" });
      await addTask(projectId, { approverId: u.id, status: "awaiting_approval", title: "Sign off" });
      const idle = await createUser("member");
      const counts = await digestFor(db(), [u.id, idle.id], today);
      expect(counts.get(u.id)).toMatchObject({ overdue: 1, today: 1, approvals: 1, blocked: 1 });
      expect(counts.get(u.id)!.top[0]).toBe("Late one");
      expect(counts.has(idle.id)).toBe(false);

      await digestJob();
      const d = (await inbox(u.id)).filter((n) => n.kind === "digest");
      expect(d).toHaveLength(1);
      expect(d[0]!.title).toBe("Your day: 1 overdue · 1 due today · 1 approval waiting · 1 blocked");
      expect((await inbox(idle.id)).filter((n) => n.kind === "digest")).toHaveLength(0);
      // A re-run the same day (after a failure partway through) never sends a second digest.
      await digestJob();
      expect((await inbox(u.id)).filter((n) => n.kind === "digest")).toHaveLength(1);

      const off = await createUser("member");
      await addMember(projectId, off.id);
      await addTask(projectId, { assigneeId: off.id, dueOn: today });
      await (await callerFor(off.id)).notifySettings.save({ prefs: {}, quietStart: null, quietEnd: null, digest: false });
      await digestJob();
      expect((await inbox(off.id)).filter((n) => n.kind === "digest")).toHaveLength(0);
    });
  });

  describe("folder watch", () => {
    it("watchers hear about new files and versions; batches fold; the gated folder and unshared outsiders stay silent", async () => {
      const fin = await createUser("member");
      const outsider = await createUser("external");
      const sharedOutsider = await createUser("external");
      const p = (await oc.projects.create({ name: `Watch ${Date.now()}`, address: "8 Watch St", type: "gut_renovation", companyId: await companyId(), bbl: null, toggles: [] })).id;
      await addMember(p, member.id);
      await addMember(p, fin.id, { canViewFinancials: true });
      await addMember(p, outsider.id);
      await addMember(p, sharedOutsider.id);
      const folders = (await oc.files.folders({ projectId: p })).folders;
      const design = folders.find((f) => f.name === "Design")!;
      const financial = folders.find((f) => f.name === "Financial")!;
      await oc.files.shareFolder({ projectId: p, folderId: design.id, userId: sharedOutsider.id, on: true });

      // Outsiders can't watch folders they can't see.
      await expect((await callerFor(outsider.id)).files.watchFolder({ projectId: p, folderId: design.id, on: true })).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect((await callerFor(member.id)).files.watchFolder({ projectId: p, folderId: financial.id, on: true })).rejects.toMatchObject({ code: "NOT_FOUND" });
      await (await callerFor(member.id)).files.watchFolder({ projectId: p, folderId: design.id, on: true });
      await (await callerFor(sharedOutsider.id)).files.watchFolder({ projectId: p, folderId: design.id, on: true });
      await (await callerFor(fin.id)).files.watchFolder({ projectId: p, folderId: financial.id, on: true });
      expect((await (await callerFor(member.id)).files.folders({ projectId: p })).folders.find((f) => f.id === design.id)!.watching).toBe(true);

      const up = async (folderId: string, name: string) => {
        const b = await oc.files.beginUpload({ projectId: p, folderId, name, contentType: "application/pdf", sizeBytes: 5 });
        for (const o of b.objects) await storage().put(o.pathname, new Uint8Array(5), { contentType: o.contentType });
        return oc.files.completeUpload({ projectId: p, uploadId: b.uploadId });
      };
      await up(design.id, "A-101.pdf");
      let m = (await inbox(member.id)).filter((n) => n.kind === "file_added" && n.projectId === p);
      expect(m).toHaveLength(1);
      expect(m[0]!.title).toBe("New file in Design: A-101.pdf");
      await up(design.id, "A-102.pdf");
      m = (await inbox(member.id)).filter((n) => n.kind === "file_added" && n.projectId === p);
      expect(m).toHaveLength(1);
      expect(m[0]!.title).toBe("New files in Design");
      expect((await inbox(sharedOutsider.id)).filter((n) => n.kind === "file_added")).toHaveLength(1);

      // Sharing ends: the watch goes quiet even though the row remains.
      await oc.files.shareFolder({ projectId: p, folderId: design.id, userId: sharedOutsider.id, on: false });
      await db().update(schema.notification).set({ readAt: new Date() }).where(eq(schema.notification.userId, sharedOutsider.id));
      await up(design.id, "A-103.pdf");
      expect((await inbox(sharedOutsider.id)).filter((n) => n.kind === "file_added")).toHaveLength(1);

      // Financial access removed: the gated folder goes quiet too.
      await up(financial.id, "wire.pdf");
      expect((await inbox(fin.id)).filter((n) => n.kind === "file_added")).toHaveLength(1);
      await db().update(schema.projectMember).set({ canViewFinancials: false }).where(and(eq(schema.projectMember.projectId, p), eq(schema.projectMember.userId, fin.id)));
      await db().update(schema.notification).set({ readAt: new Date() }).where(eq(schema.notification.userId, fin.id));
      await up(financial.id, "wire-2.pdf");
      expect((await inbox(fin.id)).filter((n) => n.kind === "file_added")).toHaveLength(1);

      // Leaving the project ends the watch.
      await oc.members.remove({ projectId: p, userId: member.id });
      expect(await db().select().from(schema.folderWatch).where(eq(schema.folderWatch.userId, member.id))).toHaveLength(0);

      // The uploader never hears about their own upload.
      await oc.files.watchFolder({ projectId: p, folderId: design.id, on: true });
      await up(design.id, "A-104.pdf");
      expect((await inbox(owner.id)).filter((n) => n.kind === "file_added" && n.projectId === p)).toHaveLength(0);
    });
  });
});
