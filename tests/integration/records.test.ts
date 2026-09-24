/**
 * Milestone 8 (brief §10, Module B): the public records sync against a
 * scripted NYC Open Data, alerts and their audience, critical orders,
 * violations to closure, expiries and COI flags.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { SOURCES } from "@/core/records";
import { addDays, todayET } from "@/core/time";
import { db, schema } from "@/server/db";
import { setMailerForTests } from "@/server/services/email";
import { expiryReminderJob } from "@/server/services/expiries";
import { dispatchPending, setPushSenderForTests, type PushSender } from "@/server/services/push";
import { recordsSyncJob, setRecordsClientForTests, syncProjectRecords, type RecordsClient } from "@/server/services/records";
import { addMember, callerFor, companyId, createUser } from "../support/fixtures";

/** Scripted datasets: rows per dataset id, plus columns to drop to simulate a schema change. */
const feed: Record<string, Record<string, unknown>[]> = {};
const dropColumns: Record<string, string[]> = {};
let calls = 0;
const fake: RecordsClient = {
  async meta(dataset) {
    const cols = SOURCES.filter((s) => s.dataset === dataset).flatMap((s) => s.columns);
    return { columns: new Set(cols.filter((c) => !(dropColumns[dataset] ?? []).includes(c))), rowsUpdatedAt: new Date("2026-08-01T00:00:00Z") };
  },
  async rows(dataset) {
    calls++;
    return feed[dataset] ?? [];
  },
};
const defaultClient: RecordsClient = {
  async meta(dataset) {
    return { columns: new Set(SOURCES.filter((s) => s.dataset === dataset).flatMap((s) => s.columns)), rowsUpdatedAt: null };
  },
  async rows() {
    return [];
  },
};

const pushed: string[] = [];
const sender: PushSender = {
  enabled: true,
  async send(_t, msg) {
    pushed.push(msg.title);
    return { ok: true, gone: false };
  },
};

const inbox = (userId: string) => db().select().from(schema.notification).where(eq(schema.notification.userId, userId));
const today = todayET();

describe("public records watch", () => {
  let owner: { id: string }, pm: { id: string }, member: { id: string }, outsider: { id: string };
  let projectId: string;
  let oc: Awaited<ReturnType<typeof callerFor>>;

  beforeAll(async () => {
    setRecordsClientForTests(fake);
    setPushSenderForTests(sender);
    owner = await createUser("owner");
    pm = await createUser("admin");
    member = await createUser("member");
    outsider = await createUser("external");
    oc = await callerFor(owner.id);
    projectId = (await oc.projects.create({ name: `Records ${Date.now()}`, address: "658 Dean Street", type: "gut_renovation", companyId: await companyId(), bbl: "3011370045", toggles: [] })).id;
    await addMember(projectId, pm.id);
    await db().update(schema.projectMember).set({ projectRole: "PM" }).where(and(eq(schema.projectMember.projectId, projectId), eq(schema.projectMember.userId, pm.id)));
    await addMember(projectId, member.id);
    await db().update(schema.projectMember).set({ projectRole: "Construction" }).where(and(eq(schema.projectMember.projectId, projectId), eq(schema.projectMember.userId, member.id)));
    await addMember(projectId, outsider.id);
    await db().update(schema.notification).set({ pushState: "skipped" }).where(eq(schema.notification.pushState, "pending"));
  });
  afterAll(() => {
    setRecordsClientForTests(defaultClient);
    setPushSenderForTests(null);
  });
  afterEach(() => setMailerForTests(null));

  it("first run: records stored quietly, open violations tracked, permits feed expiries; only orders in force alert", async () => {
    feed["3h2n-5cm9"] = [
      { isn_dob_bis_viol: "V1", boro: "3", block: "01137", lot: "00045", issue_date: "20260801", violation_number: "080126C01", violation_category: "V-DOB VIOLATION - ACTIVE", violation_type: "C-CONSTRUCTION     OTHER", description: "Work without a permit", bin: "3029125" },
      { isn_dob_bis_viol: "V0", boro: "3", block: "01137", lot: "00045", issue_date: "19990101", violation_number: "OLD", violation_category: "V*-DOB VIOLATION - DISMISSED" },
    ];
    feed["rbx6-tga4"] = [{ work_permit: "B001-I1-GC", sequence_number: "1", work_type: "General Construction", permit_status: "Permit Issued", issued_date: "2026-03-10T00:00:00.000", expired_date: `${addDays(today, 20)}T05:00:00.000`, bbl: "3011370045" }];
    feed["w9ak-ipjd"] = [{ job_filing_number: "B001-I1", filing_status: "Pending Plan Examination", job_type: "Alteration", filing_date: "2026-02-01T00:00:00.000", bbl: "3011370045", bin: "3029125" }];
    const r = await syncProjectRecords(projectId);
    expect(r.failed).toEqual([]);
    expect(r.alerts).toBe(0);
    const items = await db().select().from(schema.recordItem).where(eq(schema.recordItem.projectId, projectId));
    expect(items.map((i) => i.key).sort()).toEqual(["B001-I1", "B001-I1-GC#1", "V0", "V1", "arrears"]);
    const cases = await db().select().from(schema.violationCase).where(eq(schema.violationCase.projectId, projectId));
    expect(cases.map((c) => c.itemKey)).toEqual(["V1"]);
    const exp = await db().select().from(schema.expiryItem).where(eq(schema.expiryItem.projectId, projectId));
    expect(exp).toHaveLength(1);
    expect(exp[0]).toMatchObject({ category: "dob_permit", expiresOn: addDays(today, 20), recordRef: "dobnow_permits:B001-I1-GC#1" });
    const o = await oc.records.overview({ projectId });
    expect(o.lot?.bbl).toBe("3011370045");
    expect(o.sources.find((s) => s.key === "acris_master")!.dataAsOf).toBeTruthy();
    expect(o.jobs[0]!.url).toContain("w9ak-ipjd");
  });

  it("next run: a new violation, a job status change and a stop-work order; owner and PM hear, the order is critical; re-runs don't repeat", async () => {
    feed["3h2n-5cm9"]!.push({ isn_dob_bis_viol: "V2", boro: "3", block: "01137", lot: "00045", issue_date: "20260920", violation_number: "092026C02", violation_category: "V-DOB VIOLATION - ACTIVE", description: "Failure to maintain" });
    feed["w9ak-ipjd"]![0]!.filing_status = "Approved";
    feed["eabe-havv"] = [{ complaint_number: "C9", status: "ACTIVE", date_entered: "09/22/2026", house_number: "658", house_street: "DEAN STREET", bin: "3029125", complaint_category: "05", disposition_code: "A3" }];
    const r = await syncProjectRecords(projectId);
    expect(r.alerts).toBe(3);
    const alerts = await db().select().from(schema.recordAlert).where(eq(schema.recordAlert.projectId, projectId));
    expect(alerts.map((a) => a.title).sort()).toEqual(["CRITICAL: Full stop-work order (complaint C9)", "DOB NOW Alteration B001-I1: Pending Plan Examination → Approved", "New violation: DOB violation 092026C02"]);
    for (const who of [owner, pm]) {
      const n = (await inbox(who.id)).filter((x) => x.kind === "record_change" && x.projectId === projectId);
      expect(n.filter((x) => x.critical)).toHaveLength(1);
      expect(n.filter((x) => !x.critical)).toHaveLength(1);
      expect(n.find((x) => !x.critical)!.title).toContain("2 public-record changes");
    }
    expect((await inbox(member.id)).filter((x) => x.kind === "record_change")).toHaveLength(0);
    expect((await inbox(outsider.id)).filter((x) => x.kind === "record_change")).toHaveLength(0);

    await syncProjectRecords(projectId);
    expect(await db().select().from(schema.recordAlert).where(eq(schema.recordAlert.projectId, projectId))).toHaveLength(3);
    const cases = await db().select().from(schema.violationCase).where(eq(schema.violationCase.projectId, projectId));
    expect(cases.map((c) => c.itemKey).sort()).toEqual(["V1", "V2"]);
    const o = await oc.records.overview({ projectId });
    expect(o.ordersInForce.map((x) => x.key)).toEqual(["C9"]);
  });

  it("critical orders reach people through quiet hours and switched-off push, and email", async () => {
    const c = await callerFor(pm.id);
    await c.push.subscribe({ endpoint: `https://web.push.apple.com/crit${Date.now()}`, keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA", auth: "tBHItJI5svbpez7KI4CCXg" } });
    await c.notifySettings.save({ prefs: { record_change: { push: false } }, quietStart: "00:00", quietEnd: "23:59", digest: true });
    // Only this person's rows in the queue (the shared test database has many owners with pending rows).
    await db().update(schema.notification).set({ pushState: "skipped" }).where(eq(schema.notification.pushState, "pending"));
    await db().update(schema.notification).set({ pushState: "pending" }).where(and(eq(schema.notification.userId, pm.id), eq(schema.notification.kind, "record_change")));
    pushed.length = 0;
    await dispatchPending(100, new Date(`${today}T16:00:00Z`));
    expect(pushed.filter((t) => t.startsWith("CRITICAL"))).toHaveLength(1);
    expect(pushed.some((t) => t.includes("public-record changes"))).toBe(false);
    const email = (await db().select().from(schema.user).where(eq(schema.user.id, pm.id)))[0]!.email;
    const mail = await db().select().from(schema.emailOutbox).where(eq(schema.emailOutbox.toAddress, email));
    expect(mail.some((m) => m.subject.includes("CRITICAL") && m.category === "system")).toBe(true);
  });

  it("violations move forward with the source; hearings become key dates; closure marks the date done", async () => {
    feed["6bgk-3dad"] = [{ ecb_violation_number: "E77", ecb_violation_status: "ACTIVE", boro: "3", block: "01137", lot: "0045", issue_date: "20260915", hearing_date: addDays(today, 30).replace(/-/g, ""), severity: "CLASS - 2", violation_description: "No site safety plan", hearing_status: "PENDING", certification_status: "" }];
    await syncProjectRecords(projectId);
    let [vc] = await db().select().from(schema.violationCase).where(and(eq(schema.violationCase.projectId, projectId), eq(schema.violationCase.itemKey, "E77")));
    expect(vc).toMatchObject({ stage: "hearing", hearingOn: addDays(today, 30) });
    const [kd] = await db().select().from(schema.keyDate).where(eq(schema.keyDate.id, vc!.keyDateId!));
    expect(kd).toMatchObject({ kind: "oath_hearing", date: addDays(today, 30), done: false });

    // Manual step: fixed. Then the source dismisses it.
    await oc.records.updateViolation({ projectId, id: vc!.id, version: vc!.version, stage: "fixed", notes: "Plan filed" });
    await expect(oc.records.updateViolation({ projectId, id: vc!.id, version: vc!.version, stage: "paid" })).rejects.toMatchObject({ code: "CONFLICT" });
    feed["6bgk-3dad"]![0]!.ecb_violation_status = "RESOLVE";
    feed["6bgk-3dad"]![0]!.hearing_status = "DISMISSED";
    const before = (await db().select().from(schema.recordAlert).where(eq(schema.recordAlert.projectId, projectId))).length;
    await syncProjectRecords(projectId);
    [vc] = await db().select().from(schema.violationCase).where(eq(schema.violationCase.id, vc!.id));
    expect(vc).toMatchObject({ stage: "dismissed", notes: "Plan filed" });
    expect(vc!.closedOn).toBe(today);
    expect((await db().select().from(schema.keyDate).where(eq(schema.keyDate.id, vc!.keyDateId!)))[0]!.done).toBe(true);
    const after = await db().select().from(schema.recordAlert).where(eq(schema.recordAlert.projectId, projectId));
    expect(after.length).toBe(before + 1);
    expect(after.some((a) => a.title === "Resolved: ECB violation E77 (RESOLVE · DISMISSED)")).toBe(true);
  });

  it("create a task from an alert (once), dismiss it; the team only", async () => {
    const [a] = await db().select().from(schema.recordAlert).where(and(eq(schema.recordAlert.projectId, projectId), eq(schema.recordAlert.critical, true)));
    const r1 = await oc.records.createTask({ projectId, alertId: a!.id });
    expect(r1.created).toBe(true);
    const [t] = await db().select().from(schema.task).where(eq(schema.task.id, r1.taskId));
    expect(t).toMatchObject({ title: "Follow up: Full stop-work order (complaint C9)", priority: "high", dueOn: addDays(today, 1) });
    expect(t!.description).toContain("https://");
    expect(await oc.records.createTask({ projectId, alertId: a!.id })).toEqual({ taskId: r1.taskId, created: false });
    await oc.records.dismissAlert({ projectId, alertId: a!.id });
    expect((await oc.records.overview({ projectId })).alerts.find((x) => x.id === a!.id)!.dismissed).toBe(true);

    const xc = await callerFor(outsider.id);
    await expect(xc.records.overview({ projectId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(xc.expiries.list({ projectId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect((await callerFor(member.id)).records.createTask({ projectId, alertId: a!.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("a dataset that changed shape fails loudly: recorded, retried with backoff, admins told once, other sources still sync", async () => {
    dropColumns["wvxf-dwi5"] = ["violationstatus"];
    await db().update(schema.recordSync).set({ lastRunAt: new Date(Date.now() - 48 * 3600_000) }).where(and(eq(schema.recordSync.projectId, projectId), eq(schema.recordSync.source, "_run")));
    const night = new Date(`${today}T07:30:00Z`); // 3:30am New York
    await expect(recordsSyncJob(night)).rejects.toThrow(/hpd_violations/);
    const [s] = await db().select().from(schema.recordSync).where(and(eq(schema.recordSync.projectId, projectId), eq(schema.recordSync.source, "hpd_violations")));
    expect(s).toMatchObject({ failures: 1 });
    expect(s!.error).toContain("Dataset wvxf-dwi5 changed: missing violationstatus");
    const [ok] = await db().select().from(schema.recordSync).where(and(eq(schema.recordSync.projectId, projectId), eq(schema.recordSync.source, "dob_violations")));
    expect(ok!.failures).toBe(0);
    const told = (await inbox(owner.id)).filter((n) => n.kind === "system" && n.title === "Public records sync is failing");
    expect(told).toHaveLength(1);

    // Within the backoff: not retried. After it: retried and, once fixed, healthy again.
    calls = 0;
    await recordsSyncJob(new Date(night.getTime() + 10 * 60_000)).catch(() => undefined);
    const [again] = await db().select().from(schema.recordSync).where(and(eq(schema.recordSync.projectId, projectId), eq(schema.recordSync.source, "hpd_violations")));
    expect(again!.failures).toBe(1);
    expect(calls).toBe(0);
    delete dropColumns["wvxf-dwi5"];
    await recordsSyncJob(new Date(night.getTime() + 2 * 3600_000));
    const [healed] = await db().select().from(schema.recordSync).where(and(eq(schema.recordSync.projectId, projectId), eq(schema.recordSync.source, "hpd_violations")));
    expect(healed).toMatchObject({ failures: 0, error: null });
    expect((await inbox(owner.id)).filter((n) => n.kind === "system" && n.title === "Public records sync is failing")).toHaveLength(1);
  });

  it("check now: admins only, once every 10 minutes; no BBL, no check", async () => {
    await expect((await callerFor(member.id)).records.syncNow({ projectId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await db().update(schema.recordSync).set({ lastRunAt: new Date() }).where(and(eq(schema.recordSync.projectId, projectId), eq(schema.recordSync.source, "_run")));
    await expect(oc.records.syncNow({ projectId })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    const bare = (await oc.projects.create({ name: `No lot ${Date.now()}`, address: "1 Nowhere Ln", type: "gut_renovation", companyId: await companyId(), bbl: null, toggles: [] })).id;
    await expect(oc.records.syncNow({ projectId: bare })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await oc.records.overview({ projectId: bare })).lot).toBeNull();
  });
});

describe("expiries (Module B)", () => {
  let owner: { id: string }, pm: { id: string }, member: { id: string };
  let a: string, b: string;
  let oc: Awaited<ReturnType<typeof callerFor>>;

  beforeAll(async () => {
    owner = await createUser("owner");
    pm = await createUser("admin");
    member = await createUser("member");
    oc = await callerFor(owner.id);
    a = (await oc.projects.create({ name: `Exp A ${Date.now()}`, address: "1 A St", type: "gut_renovation", companyId: await companyId(), bbl: null, toggles: [] })).id;
    b = (await oc.projects.create({ name: `Exp B ${Date.now()}`, address: "2 B St", type: "gut_renovation", companyId: await companyId(), bbl: null, toggles: [] })).id;
    await addMember(a, pm.id, { canViewFinancials: false });
    await addMember(a, member.id, { canEditChecklist: true });
    await db().update(schema.projectMember).set({ projectRole: "Construction" }).where(and(eq(schema.projectMember.projectId, a), eq(schema.projectMember.userId, member.id)));
  });

  it("reminders at 30, 14 and 7 days and daily once expired, to the owner and PM, never twice", async () => {
    const { id } = await oc.expiries.save({ projectId: a, category: "gl_policy", label: "GL-1", expiresOn: addDays(today, 30) });
    const count = async () => (await inbox(pm.id)).filter((n) => n.kind === "expiry").length;
    await expiryReminderJob();
    expect(await count()).toBe(1);
    expect((await inbox(pm.id)).find((n) => n.kind === "expiry")!.title).toBe("General liability policy: GL-1 expires in 30 days");
    await expiryReminderJob();
    expect(await count()).toBe(1);
    expect((await inbox(member.id)).filter((n) => n.kind === "expiry")).toHaveLength(0);

    // Expired: daily.
    const [row] = await db().select().from(schema.expiryItem).where(eq(schema.expiryItem.id, id));
    await oc.expiries.save({ projectId: a, id, version: row!.version, category: "gl_policy", label: "GL-1", expiresOn: addDays(today, -2) });
    await expiryReminderJob();
    await expiryReminderJob(new Date(Date.now() + 86_400_000));
    expect(await count()).toBe(3);
    expect((await inbox(pm.id)).some((n) => n.title === "General liability policy: GL-1 expired 2 days ago")).toBe(true);

    // Closed: silence and no red flags.
    const [r2] = await db().select().from(schema.expiryItem).where(eq(schema.expiryItem.id, id));
    await oc.expiries.close({ projectId: a, id, version: r2!.version, closed: true });
    await expiryReminderJob(new Date(Date.now() + 2 * 86_400_000));
    expect(await count()).toBe(3);
  });

  it("an expired vendor COI flags that vendor on every project they're on; expired items show on cards and the rail", async () => {
    await db().insert(schema.commitment).values({ projectId: b, vendorName: "ACME Concrete, LLC", description: "Foundations", amountCents: 100_000_00 });
    await oc.expiries.save({ projectId: a, category: "vendor_coi_gl", vendorName: "Acme Concrete LLC", expiresOn: addDays(today, -1) });
    await expect(oc.expiries.save({ projectId: a, category: "vendor_coi_wc", expiresOn: addDays(today, 10) })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const cards = (await oc.projects.list({})).projects;
    expect(cards.find((p) => p.id === a)!.facts).toMatchObject({ expired: 1, coiFlags: ["Acme Concrete LLC"] });
    // Project B never mentioned the COI: the vendor's contract there is enough.
    expect(cards.find((p) => p.id === b)!.facts).toMatchObject({ expired: 0, coiFlags: ["Acme Concrete LLC"] });
    const rail = await oc.tasks.needsYou();
    expect(rail.expired.some((e) => e.projectId === a && e.label === "Vendor COI: general liability: Acme Concrete LLC")).toBe(true);
  });

  it("loan and deal deadlines need financial access", async () => {
    await oc.expiries.save({ projectId: a, category: "loan_maturity", label: "Senior loan", expiresOn: addDays(today, 90) });
    const pc = await callerFor(pm.id);
    const list = await pc.expiries.list({ projectId: a });
    expect(list.items.some((i) => i.category === "loan_maturity")).toBe(false);
    expect(list.categories.some((c) => c.key === "loan_maturity")).toBe(false);
    await expect(pc.expiries.save({ projectId: a, category: "rate_cap", expiresOn: addDays(today, 60) })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await oc.expiries.list({ projectId: a })).items.some((i) => i.category === "loan_maturity")).toBe(true);
    await expect((await callerFor(member.id)).expiries.remove({ projectId: a, id: (await oc.expiries.list({ projectId: a })).items.find((i) => i.category === "loan_maturity")!.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
