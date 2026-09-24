/**
 * Milestone 9 (Modules D, E, F, G, K): the daily log, schedule and baseline,
 * meetings, RFIs, submittals, drawing sets and punch lists, and their PDFs.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { PDFDocument } from "pdf-lib";
import { addDays, todayET } from "@/core/time";
import { db, schema } from "@/server/db";
import { setWeatherForTests, siteLogNudgeJob } from "@/server/services/field";
import { storage } from "@/server/storage";
import { addMember, callerFor, companyId, contextFor, createUser } from "../support/fixtures";

let as: string | null = null;
vi.mock("@/server/request-context", () => ({
  authedContextFrom: async () => {
    const c = await contextFor(as);
    return c.viewer ? c : null;
  },
}));
const { GET: logPdf } = await import("@/app/api/export/projects/[id]/site-logs/route");
const { GET: minutesPdf } = await import("@/app/api/export/projects/[id]/meetings/[meetingId]/route");
const { GET: punchPdf } = await import("@/app/api/export/projects/[id]/punch/route");

type Caller = Awaited<ReturnType<typeof callerFor>>;
const today = todayET();
const inbox = (userId: string) => db().select().from(schema.notification).where(eq(schema.notification.userId, userId));

async function tinyPdf(): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  d.addPage([612, 792]);
  return d.save();
}

describe("field and construction", () => {
  let owner: { id: string }, admin: { id: string }, member: { id: string }, architect: { id: string }, sub: { id: string }, stranger: { id: string };
  let oc: Caller, ac: Caller, mc: Caller, xc: Caller, sc: Caller, zc: Caller;
  let projectId: string;

  beforeAll(async () => {
    setWeatherForTests(async () => ({ summary: "Rain", highF: 61, lowF: 52, precipIn: 0.3, windMph: 12, source: "open-meteo" }));
    owner = await createUser("owner");
    admin = await createUser("admin");
    member = await createUser("member");
    architect = await createUser("external");
    sub = await createUser("external");
    stranger = await createUser("external");
    oc = await callerFor(owner.id);
    ac = await callerFor(admin.id);
    mc = await callerFor(member.id);
    xc = await callerFor(architect.id);
    sc = await callerFor(sub.id);
    zc = await callerFor(stranger.id);
    projectId = (await oc.projects.create({ name: `Field ${Date.now()}`, address: "10 Site Ave", type: "gut_renovation", companyId: await companyId(), bbl: null, toggles: [] })).id;
    await addMember(projectId, admin.id, { canEditChecklist: true, canViewFinancials: true });
    await addMember(projectId, member.id);
    await db().update(schema.projectMember).set({ projectRole: "Construction" }).where(and(eq(schema.projectMember.projectId, projectId), eq(schema.projectMember.userId, member.id)));
    await addMember(projectId, architect.id);
    await addMember(projectId, sub.id);
    await addMember(projectId, stranger.id);
    await db().update(schema.project).set({ latitude: 40.67, longitude: -73.97 }).where(eq(schema.project.id, projectId));
  });
  afterAll(() => setWeatherForTests(null));

  describe("daily log (D)", () => {
    it("the team files a day's log with weather filled in; one per day; versions guard edits", async () => {
      const r = await mc.siteLogs.save({ projectId, date: today, manpower: [{ trade: "Concrete", company: "Stone Co", count: 6 }], workPerformed: "Poured the cellar slab", inspections: [{ what: "DOB concrete", result: "pass", notes: null }], delays: [], deliveries: null, visitors: null, safety: null, notes: null });
      const got = await mc.siteLogs.get({ projectId, date: today });
      expect(got.log).toMatchObject({ workPerformed: "Poured the cellar slab", weather: { summary: "Rain", source: "open-meteo" } });
      await mc.siteLogs.save({ projectId, date: today, version: r.version, manpower: [{ trade: "Concrete", company: null, count: 7 }], inspections: [], delays: [{ cause: "Rain", hours: 2, notes: null }], workPerformed: "Poured", deliveries: null, visitors: null, safety: null, notes: null });
      await expect(mc.siteLogs.save({ projectId, date: today, version: r.version, manpower: [], inspections: [], delays: [] })).rejects.toMatchObject({ code: "CONFLICT" });
      await expect(mc.siteLogs.save({ projectId, date: addDays(today, 1), manpower: [], inspections: [], delays: [] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(xc.siteLogs.get({ projectId, date: today })).rejects.toMatchObject({ code: "FORBIDDEN" });
      const list = await mc.siteLogs.list({ projectId, limit: 10 });
      expect(list[0]).toMatchObject({ date: today, crew: 7, delays: 1 });
      // Tomorrow's form offers today's crew.
      const yesterday = addDays(today, -1);
      await mc.siteLogs.save({ projectId, date: yesterday, manpower: [{ trade: "Masonry", company: null, count: 3 }], inspections: [], delays: [] });
      expect((await mc.siteLogs.get({ projectId, date: today })).previousManpower).toEqual([{ trade: "Masonry", company: null, count: 3 }]);
    });

    it("photos attach to the day's log (only a log on this project)", async () => {
      const [log] = await db().select().from(schema.siteLog).where(and(eq(schema.siteLog.projectId, projectId), eq(schema.siteLog.date, today)));
      const b = await mc.photos.beginUpload({ projectId, contentType: "image/webp", fullBytes: 5, thumbBytes: 5, width: 2, height: 2, siteLogId: log!.id });
      for (const o of b.objects) await storage().put(o.pathname, new Uint8Array(5), { contentType: "image/webp" });
      await mc.photos.completeUpload({ projectId, uploadId: b.uploadId });
      expect((await mc.siteLogs.get({ projectId, date: today })).photos).toHaveLength(1);
      const other = (await oc.projects.create({ name: `Other ${Date.now()}`, address: "1 Other", type: "gut_renovation", companyId: await companyId(), bbl: null, toggles: [] })).id;
      const b2 = await oc.photos.beginUpload({ projectId: other, contentType: "image/webp", fullBytes: 5, thumbBytes: 5, width: 2, height: 2, siteLogId: log!.id });
      for (const o of b2.objects) await storage().put(o.pathname, new Uint8Array(5), { contentType: "image/webp" });
      const p = await oc.photos.completeUpload({ projectId: other, uploadId: b2.uploadId });
      expect((await db().select().from(schema.projectPhoto).where(eq(schema.projectPhoto.id, p.id)))[0]!.siteLogId).toBeNull();
    });

    it("a dated PDF for draws and claims", async () => {
      as = member.id;
      const res = await logPdf(new Request(`http://t/api/export/projects/${projectId}/site-logs?from=${addDays(today, -1)}&to=${today}`), { params: Promise.resolve({ id: projectId }) } as never);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/pdf");
      const bytes = new Uint8Array(await res.arrayBuffer());
      expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
      expect((await PDFDocument.load(bytes)).getPageCount()).toBeGreaterThan(0);
      as = architect.id;
      expect((await logPdf(new Request(`http://t/x?from=${today}&to=${today}`), { params: Promise.resolve({ id: projectId }) } as never)).status).toBe(404);
    });

    it("5pm nudge on active construction weekdays when no log is in", async () => {
      const busy = (await oc.projects.create({ name: `Busy ${Date.now()}`, address: "2 Busy", type: "gut_renovation", companyId: await companyId(), bbl: null, toggles: [] })).id;
      await addMember(busy, member.id);
      await db().update(schema.projectMember).set({ projectRole: "Construction" }).where(and(eq(schema.projectMember.projectId, busy), eq(schema.projectMember.userId, member.id)));
      await db().update(schema.projectPhase).set({ status: "pending" }).where(eq(schema.projectPhase.projectId, busy));
      await db().update(schema.projectPhase).set({ status: "active" }).where(and(eq(schema.projectPhase.projectId, busy), eq(schema.projectPhase.key, "construction")));
      const thursday = new Date("2026-09-24T21:30:00Z");
      await siteLogNudgeJob(thursday);
      expect((await inbox(member.id)).filter((n) => n.projectId === busy && n.title.includes("site log"))).toHaveLength(1);
      await siteLogNudgeJob(new Date("2026-09-26T21:30:00Z")); // Saturday
      expect((await inbox(member.id)).filter((n) => n.projectId === busy && n.title.includes("site log"))).toHaveLength(1);
    });
  });

  describe("schedule and baseline (E)", () => {
    it("planned dates, the critical path, a baseline that locks on Pre-Construction, and days behind", async () => {
      const [t1] = await db().insert(schema.task).values({ projectId, phaseKey: "construction", title: "Excavate", startOn: addDays(today, 1), dueOn: addDays(today, 10) }).returning();
      const [t2] = await db().insert(schema.task).values({ projectId, phaseKey: "construction", title: "Foundation", startOn: addDays(today, 11), dueOn: addDays(today, 25) }).returning();
      await db().insert(schema.taskDependency).values({ taskId: t2!.id, dependsOnId: t1!.id });
      const s0 = await ac.schedule.get({ projectId });
      expect(s0.tasks.find((t) => t.id === t2!.id)).toMatchObject({ critical: true });
      expect(s0.baseline).toBeNull();

      // Entering Pre-Construction locks the first baseline.
      const p = await oc.projects.get({ projectId });
      await oc.projects.setPhase({ projectId, key: "pre_construction", version: p.version });
      const s1 = await ac.schedule.get({ projectId });
      expect(s1.baseline).toMatchObject({ number: 1, finishOn: s1.forecastFinish });
      expect(s1.slippage).toBe(0);
      await expect(ac.schedule.lock({ projectId, reason: null })).rejects.toMatchObject({ code: "BAD_REQUEST" });

      // A slip on the critical path shows as days behind, on the card too.
      // Push the foundation past the whole project's forecast finish: that's the new finish.
      const t2now = s1.tasks.find((t) => t.id === t2!.id)!;
      await ac.schedule.setDates({ projectId, taskId: t2!.id, version: t2now.version, startOn: t2now.startOn, dueOn: addDays(s1.forecastFinish!, 4) });
      const s2 = await ac.schedule.get({ projectId });
      expect(s2.slippage).toBe(4);
      expect((await oc.projects.list({})).projects.find((x) => x.id === projectId)!.facts.slippage).toBe(4);
      await expect(ac.schedule.setDates({ projectId, taskId: t2!.id, version: t2now.version, startOn: null, dueOn: today })).rejects.toMatchObject({ code: "CONFLICT" });
      await expect(ac.schedule.setDates({ projectId, taskId: t1!.id, version: t1!.version, startOn: addDays(today, 5), dueOn: today })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });

    it("re-baselining needs the owner: request, approve (history kept), decline", async () => {
      const r = await ac.schedule.requestRebaseline({ projectId, reason: "Approved CO adds rock removal" });
      expect(r.approved).toBe(false);
      expect((await inbox(owner.id)).some((n) => n.title.startsWith("Re-baseline the schedule"))).toBe(true);
      await expect(ac.schedule.requestRebaseline({ projectId, reason: "Again" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(ac.schedule.decideRebaseline({ projectId, id: r.id, approve: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await oc.schedule.decideRebaseline({ projectId, id: r.id, approve: true });
      const s = await ac.schedule.get({ projectId });
      expect(s.baseline).toMatchObject({ number: 2 });
      expect(s.slippage).toBe(0);
      expect(s.history.map((h) => h.status)).toEqual(["current", "superseded"]);
      const r2 = await ac.schedule.requestRebaseline({ projectId, reason: "Not really" });
      await oc.schedule.decideRebaseline({ projectId, id: r2.id, approve: false });
      expect((await ac.schedule.get({ projectId })).baseline!.number).toBe(2);
      // An owner's own re-baseline is approved as it's made.
      expect((await oc.schedule.requestRebaseline({ projectId, reason: "Owner reset" })).approved).toBe(true);
      await expect(mc.schedule.lock({ projectId, reason: null })).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("starting work records the actual start", async () => {
      const [t] = await db().insert(schema.task).values({ projectId, phaseKey: "construction", title: "Frame", dueOn: addDays(today, 40) }).returning();
      await ac.tasks.setStatus({ projectId, taskId: t!.id, version: t!.version, status: "in_progress" });
      expect((await db().select().from(schema.task).where(eq(schema.task.id, t!.id)))[0]!.startedOn).toBe(today);
    });
  });

  describe("meetings (G)", () => {
    it("action items become assigned tasks; open ones carry into the next meeting of the same type; minutes as a PDF", async () => {
      const { id } = await ac.meetings.create({ projectId, type: "oac", heldOn: today, title: "Weekly OAC" });
      await expect(ac.meetings.saveItem({ projectId, meetingId: id, kind: "action", text: "No owner", assigneeId: null, dueOn: null })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(ac.meetings.saveItem({ projectId, meetingId: id, kind: "action", text: "Outsider", assigneeId: (await createUser("member")).id, dueOn: today })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      const a = await ac.meetings.saveItem({ projectId, meetingId: id, kind: "action", text: "Send revised window schedule", assigneeId: architect.id, dueOn: addDays(today, 7) });
      const b = await ac.meetings.saveItem({ projectId, meetingId: id, kind: "action", text: "Confirm crane date", assigneeId: member.id, dueOn: addDays(today, 3) });
      await ac.meetings.saveItem({ projectId, meetingId: id, kind: "note", text: "Rain delays expected", assigneeId: null, dueOn: null });
      const m = await ac.meetings.get({ projectId, id });
      const item = m.items.find((i) => i.id === a.id)!;
      expect(item.taskId).toBeTruthy();
      const [task] = await db().select().from(schema.task).where(eq(schema.task.id, item.taskId!));
      expect(task).toMatchObject({ title: "Send revised window schedule", assigneeId: architect.id, dueOn: addDays(today, 7) });
      expect((await inbox(architect.id)).some((n) => n.kind === "assigned" && n.taskId === task!.id)).toBe(true);
      // Close one: its task is done.
      await ac.meetings.saveItem({ projectId, meetingId: id, id: b.id, kind: "action", text: "Confirm crane date", assigneeId: member.id, dueOn: addDays(today, 3), status: "closed" });
      const bTask = (await ac.meetings.get({ projectId, id })).items.find((i) => i.id === b.id)!.taskId!;
      expect((await db().select().from(schema.task).where(eq(schema.task.id, bTask)))[0]!.status).toBe("done");

      const next = await ac.meetings.create({ projectId, type: "oac", heldOn: addDays(today, 7), title: null });
      const n = await ac.meetings.get({ projectId, id: next.id });
      expect(n.meeting.number).toBe(2);
      expect(n.items.map((i) => i.text)).toEqual(["Send revised window schedule"]);
      expect(n.items[0]).toMatchObject({ carriedFromId: a.id, taskId: item.taskId });
      expect((await ac.meetings.create({ projectId, type: "lender", heldOn: today, title: null })).id).toBeTruthy();

      as = admin.id;
      const res = await minutesPdf(new Request("http://t/"), { params: Promise.resolve({ id: projectId, meetingId: id }) } as never);
      expect(res.headers.get("content-type")).toBe("application/pdf");
      await expect(xc.meetings.list({ projectId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
  });

  describe("RFIs and submittals (F)", () => {
    it("an RFI goes to the architect, who answers; outsiders see only their own; cost is for financial eyes; one click to a change order", async () => {
      const r = await ac.rfis.save({ projectId, subject: "Beam depth at grid C", question: "Is W12 acceptable?", fromUserId: admin.id, fromName: null, toUserId: architect.id, toName: null, dueOn: addDays(today, 5), costImpactCents: 1_250_000, scheduleImpactDays: 3 });
      expect(r.number).toBe(1);
      expect((await inbox(architect.id)).some((n) => n.title.startsWith("RFI #1 needs your answer"))).toBe(true);
      const mine = await xc.rfis.list({ projectId });
      expect(mine.rfis.map((x) => x.number)).toEqual([1]);
      expect(mine.rfis[0]!.costImpactCents).toBeNull();
      expect((await zc.rfis.list({ projectId })).rfis).toEqual([]);
      await expect(zc.rfis.answer({ projectId, id: r.id, version: 1, answer: "No" })).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(ac.rfis.toChangeOrder({ projectId, id: r.id })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await xc.rfis.answer({ projectId, id: r.id, version: 1, answer: "Use W14x22 instead." });
      expect((await inbox(admin.id)).some((n) => n.title === "RFI #1 answered: Beam depth at grid C")).toBe(true);
      await expect(mc.rfis.toChangeOrder({ projectId, id: r.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
      const co = await ac.rfis.toChangeOrder({ projectId, id: r.id });
      expect(co.created).toBe(true);
      const [row] = await db().select().from(schema.changeOrder).where(eq(schema.changeOrder.id, co.changeOrderId));
      expect(row).toMatchObject({ amountCents: 1_250_000, scheduleDays: 3, status: "pending", description: "RFI #1: Beam depth at grid C" });
      expect((await ac.rfis.toChangeOrder({ projectId, id: r.id })).created).toBe(false);
      const r2 = await ac.rfis.save({ projectId, subject: "Second", question: "?", fromUserId: null, fromName: "GC", toUserId: null, toName: "Engineer", dueOn: null, costImpactCents: null, scheduleImpactDays: null });
      expect(r2.number).toBe(2);
    });

    it("submittals: the reviewer decides; revise and resubmit keeps every revision", async () => {
      const s = await ac.submittals.create({ projectId, specSection: "08 41 13", item: "Storefront shop drawings", submittedBy: "Glass Co", reviewerId: architect.id, reviewerName: null, dueOn: null, fileId: null });
      expect((await zc.submittals.list({ projectId })).submittals).toEqual([]);
      const list = await xc.submittals.list({ projectId });
      expect(list.submittals[0]!.canDecide).toBe(true);
      await xc.submittals.decide({ projectId, id: s.id, version: 1, decision: "revise_resubmit", notes: "Mullion depth" });
      await expect(xc.submittals.decide({ projectId, id: s.id, version: 2, decision: "approved", notes: null })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await ac.submittals.resubmit({ projectId, id: s.id, version: 2, fileId: null });
      await xc.submittals.decide({ projectId, id: s.id, version: 3, decision: "approved_as_noted", notes: null });
      const done = (await ac.submittals.list({ projectId })).submittals[0]!;
      expect(done.status).toBe("approved_as_noted");
      expect(done.revisions.map((r) => [r.revision, r.decision])).toEqual([
        [1, "approved_as_noted"],
        [0, "revise_resubmit"],
      ]);
    });
  });

  describe("drawings and punch (F, K)", () => {
    let sheetId: string;
    it("issuing a set makes it current and stamps the discipline's old set superseded; sheets follow folder access", async () => {
      const folders = (await ac.files.folders({ projectId })).folders;
      const design = folders.find((f) => f.name === "Design")!;
      const upload = async (name: string) => {
        const bytes = await tinyPdf();
        const b = await ac.files.beginUpload({ projectId, folderId: design.id, name, contentType: "application/pdf", sizeBytes: bytes.length });
        for (const o of b.objects) await storage().put(o.pathname, bytes, { contentType: o.contentType });
        return (await ac.files.completeUpload({ projectId, uploadId: b.uploadId })).fileId;
      };
      const f1 = await upload("A-101 Floor plans.pdf");
      const f2 = await upload("A-100 Cover.pdf");
      const set1 = await ac.drawings.createSet({ projectId, discipline: "A", name: "Permit set", issuedOn: today, fileIds: [f1, f2] });
      let list = await ac.drawings.list({ projectId });
      expect(list.sets[0]!.sheets.map((s) => s.number)).toEqual(["A-100", "A-101"]);
      sheetId = list.sets[0]!.sheets[1]!.id;
      const f3 = await upload("A-101 Floor plans rev 2.pdf");
      await ac.drawings.createSet({ projectId, discipline: "A", name: "Bid set", issuedOn: today, fileIds: [f3] });
      list = await ac.drawings.list({ projectId });
      expect(list.sets.filter((s) => s.current).map((s) => s.name)).toEqual(["Bid set"]);
      expect(list.sets.find((s) => s.id === set1.id)!.current).toBe(false);
      expect((await ac.drawings.sheet({ projectId, sheetId })).superseded).toBe(true);
      // Outsiders see drawings only through a shared folder.
      expect((await xc.drawings.list({ projectId })).sets).toEqual([]);
      await oc.files.shareFolder({ projectId, folderId: design.id, userId: architect.id, on: true });
      expect((await xc.drawings.list({ projectId })).sets.length).toBeGreaterThan(0);
      await expect(ac.drawings.createSet({ projectId, discipline: "S", name: "x", issuedOn: null, fileIds: [(await ac.files.folders({ projectId })).folders[0]!.id] })).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("pins become punch items; filters and facets; the sub marks ready, the team closes; a PDF per sub", async () => {
      const p1 = await mc.punch.create({ projectId, sheetId, page: 1, x: 0.4, y: 1.7, title: "Chipped tile", description: null, trade: "Tile", vendorName: "Tile Co", assigneeId: sub.id, floor: "2", unit: "2A", dueOn: addDays(today, 5), photoId: null });
      await mc.punch.create({ projectId, sheetId: null, page: 1, x: null, y: null, title: "Paint touch-up", description: null, trade: "Paint", vendorName: "Paint Co", assigneeId: null, floor: "3", unit: "3B", dueOn: null, photoId: null });
      const pin = (await ac.drawings.sheet({ projectId, sheetId })).pins[0]!;
      expect(pin).toMatchObject({ number: p1.number, x: 0.4, y: 1 });
      expect((await ac.punch.list({ projectId, floor: "2" })).items.map((i) => i.title)).toEqual(["Chipped tile"]);
      expect((await ac.punch.list({ projectId })).facets).toMatchObject({ trades: ["Paint", "Tile"], vendors: ["Paint Co", "Tile Co"] });
      const subList = await sc.punch.list({ projectId });
      expect(subList.items.map((i) => i.title)).toEqual(["Chipped tile"]);
      await expect(sc.punch.update({ projectId, id: p1.id, version: 1, status: "closed" })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(sc.punch.update({ projectId, id: p1.id, version: 1, title: "Nothing wrong" })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await sc.punch.update({ projectId, id: p1.id, version: 1, status: "ready" });
      expect((await inbox(member.id)).some((n) => n.title.startsWith(`Punch #${p1.number} ready for review`))).toBe(true);
      await mc.punch.update({ projectId, id: p1.id, version: 2, status: "closed" });
      await expect(zc.punch.update({ projectId, id: p1.id, version: 3, status: "open" })).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(sc.punch.create({ projectId, sheetId: null, page: 1, x: null, y: null, title: "x", description: null, trade: null, vendorName: null, assigneeId: null, floor: null, unit: null, dueOn: null, photoId: null })).rejects.toMatchObject({ code: "FORBIDDEN" });

      as = admin.id;
      const res = await punchPdf(new Request(`http://t/?vendor=Tile%20Co`), { params: Promise.resolve({ id: projectId }) } as never);
      expect(res.headers.get("content-type")).toBe("application/pdf");
      expect(res.headers.get("content-disposition")).toContain("punch-Tile-Co");
    });
  });
});
