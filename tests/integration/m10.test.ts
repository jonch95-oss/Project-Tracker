/**
 * Milestone 10 (Modules A, C, J, L): BBL auto-fill, the vendor directory,
 * investors and capital with the investor portal, and the condo unit tracker.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { addDays, todayET } from "@/core/time";
import { db, schema } from "@/server/db";
import { directoryReminderJob } from "@/server/services/directory";
import { expiredCoiFlags } from "@/server/services/expiries";
import { setLotLookupForTests } from "@/server/services/pluto";
import { takeSnapshotQueue } from "@/server/services/records";
import { storage } from "@/server/storage";
import { addMember, callerFor, companyId, contextFor, createUser } from "../support/fixtures";

let as: string | null = null;
vi.mock("@/server/request-context", () => ({
  authedContextFrom: async () => {
    const c = await contextFor(as);
    return c.viewer ? c : null;
  },
}));
const { GET: directoryMedia } = await import("@/app/api/media/directory/[id]/route");
const { GET: investorReport } = await import("@/app/api/export/projects/[id]/investor-report/route");

type Caller = Awaited<ReturnType<typeof callerFor>>;
const today = todayET();
const inbox = (userId: string) => db().select().from(schema.notification).where(eq(schema.notification.userId, userId));

describe("Milestone 10", () => {
  let owner: { id: string }, admin: { id: string }, member: { id: string }, editor: { id: string }, lp: { id: string }, lp2: { id: string };
  let oc: Caller, ac: Caller, mc: Caller, ec: Caller, lc: Caller, l2c: Caller;
  let projectId: string;

  beforeAll(async () => {
    setLotLookupForTests(async (bbl) =>
      bbl === "3017590013"
        ? { bbl, address: "543 WILLOUGHBY AVENUE", zoning: "R6A", lotAreaSqft: 97000, lotFrontFt: 420, lotDepthFt: 200, residFar: 3, builtFar: 1.46, unusedZsf: 149380, buildingSqft: 141246, yearBuilt: 1965, floors: 3, residentialUnits: 0, landmark: null, historicDistrict: null, version: "26v2" }
        : null,
    );
    owner = await createUser("owner");
    admin = await createUser("admin");
    member = await createUser("member");
    editor = await createUser("member");
    lp = await createUser("investor");
    lp2 = await createUser("investor");
    oc = await callerFor(owner.id);
    ac = await callerFor(admin.id);
    mc = await callerFor(member.id);
    ec = await callerFor(editor.id);
    lc = await callerFor(lp.id);
    l2c = await callerFor(lp2.id);
    projectId = (await oc.projects.create({ name: `M10 ${Date.now()}`, address: "88 Bergen Street", type: "ground_up_condo", companyId: await companyId(), bbl: "3003920021", toggles: [] })).id;
    await addMember(projectId, admin.id, { canEditChecklist: true, canViewFinancials: true });
    await addMember(projectId, member.id);
    await addMember(projectId, editor.id, { canEditChecklist: true });
  });
  afterAll(() => setLotLookupForTests(null));

  describe("BBL auto-fill (A)", () => {
    it("looks the lot up in PLUTO by BBL; says why when it can't", async () => {
      const r = await ac.projects.lookupLot({ bbl: "3017590013", borough: "Brooklyn" });
      expect(r).toMatchObject({ status: "found", bbl: "3017590013", facts: { zoning: "R6A", residFar: 3, unusedZsf: 149380 } });
      expect(await ac.projects.lookupLot({ bbl: "3000010001", borough: "Brooklyn" })).toMatchObject({ status: "not_found" });
      expect(await ac.projects.lookupLot({ bbl: "1000010001", borough: "Brooklyn" })).toMatchObject({ status: "wrong_borough" });
      await expect(mc.projects.lookupLot({ bbl: "3017590013", borough: "Brooklyn" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("a project created with a BBL pulls its first records snapshot right away; a new BBL does too", async () => {
      takeSnapshotQueue();
      const p = await oc.projects.create({ name: `Snapshot ${Date.now()}`, address: "1 Lot St", type: "gut_renovation", companyId: await companyId(), bbl: "3017590013", toggles: [], facts: { lotFrontFt: 420, lotDepthFt: 200 } });
      expect(takeSnapshotQueue()).toEqual([p.id]);
      const got = await oc.projects.get({ projectId: p.id });
      expect(got).toMatchObject({ lotFrontFt: 420, lotDepthFt: 200 });
      const none = await oc.projects.create({ name: `No lot ${Date.now()}`, address: "2 Lot St", type: "gut_renovation", companyId: await companyId(), bbl: null, toggles: [] });
      expect(takeSnapshotQueue()).not.toContain(none.id);
    });
  });

  describe("condo unit tracker (L)", () => {
    let unitId: string;
    it("the unit schedule: layout for the team, prices only with financial access", async () => {
      unitId = (await ac.units.saveUnit({ projectId, unit: "4B", floor: "4", sf: 1150, beds: 2, baths: 2, exposure: "SE", outdoorType: "Terrace", outdoorSf: 120, askCents: 1_650_000_00 })).id;
      await expect(ec.units.saveUnit({ projectId, unit: "5A", askCents: 1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await ec.units.saveUnit({ projectId, unit: "5A", sf: 900 });
      await expect(ec.units.saveUnit({ projectId, unit: "4b" })).rejects.toMatchObject({ code: "CONFLICT" });
      const mine = await ac.units.list({ projectId });
      expect(mine.units.find((u) => u.unit === "4B")).toMatchObject({ askCents: 1_650_000_00, askPsfCents: 1_434_78, exposure: "SE", outdoorSf: 120 });
      const theirs = await mc.units.list({ projectId });
      expect(theirs.units.find((u) => u.unit === "4B")).toMatchObject({ askCents: null, askPsfCents: null, sf: 1150 });
      // The same rows are the sales tracker.
      expect((await db().select().from(schema.saleUnit).where(eq(schema.saleUnit.id, unitId)))[0]).toMatchObject({ exposure: "SE", askCents: 1_650_000_00 });
    });

    it("a selection gives the GC a task that waits on the buyer's sign-off, then goes live", async () => {
      const due = addDays(today, 10);
      const { id } = await ac.units.saveSelection({ projectId, unitId, category: "Kitchen", choice: "Calacatta quartz, waterfall island", upgradeCents: 18_500_00, signOffBy: due, assigneeId: editor.id });
      let list = await ac.units.list({ projectId });
      const sel = list.units.find((u) => u.id === unitId)!.selections[0]!;
      expect(sel).toMatchObject({ state: "pending", upgradeCents: 18_500_00, taskStatus: "waiting", assigneeId: editor.id });
      const [task] = await db().select().from(schema.task).where(eq(schema.task.id, sel.taskId!));
      expect(task).toMatchObject({ title: "Unit 4B · Kitchen: Calacatta quartz, waterfall island", status: "waiting", waitingOn: "Buyer sign-off", dueOn: due, phaseKey: "construction" });
      expect((await inbox(editor.id)).some((n) => n.taskId === task!.id && n.kind === "assigned")).toBe(true);
      expect((await mc.units.list({ projectId })).units.find((u) => u.id === unitId)!.selections[0]).toMatchObject({ upgradeCents: null, isUpgrade: true });
      await expect(ec.units.saveSelection({ projectId, id, version: sel.version, unitId, category: "Kitchen", choice: "x", upgradeCents: 1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(ac.units.signOff({ projectId, id, version: sel.version, signedOffOn: addDays(today, 1), signedOffName: "Buyer" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await ac.units.signOff({ projectId, id, version: sel.version, signedOffOn: today, signedOffName: "Dana Buyer" });
      list = await ac.units.list({ projectId });
      expect(list.units.find((u) => u.id === unitId)!.selections[0]).toMatchObject({ state: "signed", signedOffName: "Dana Buyer", taskStatus: "not_started" });
      expect((await inbox(editor.id)).some((n) => n.title.startsWith("Signed off: Unit 4B"))).toBe(true);
      // A standard finish with a past deadline shows as overdue.
      await ac.units.saveSelection({ projectId, unitId, category: "Paint", choice: "Benjamin Moore Chantilly Lace", signOffBy: addDays(today, -1) });
      expect((await ac.units.list({ projectId })).summary).toMatchObject({ overdue: 1 });
      const second = (await ac.units.list({ projectId })).units.find((u) => u.id === unitId)!.selections.find((s) => s.category === "Paint")!;
      await ac.units.deleteSelection({ projectId, id: second.id, version: second.version });
      expect(await db().select().from(schema.task).where(eq(schema.task.id, second.taskId!))).toEqual([]);
    });
  });

  describe("vendor directory (C)", () => {
    let vendorId: string;
    it("companies link to contracts typed under their name; duplicates are refused; members read, admins edit", async () => {
      await oc.financials.saveCommitment({ projectId, vendorName: "Brick & Beam Builders, LLC", amountCents: 1_000_000_00, status: "executed", retainageBps: 1000, budgetLineId: null, description: null, signedOn: null, fileId: null });
      vendorId = (await ac.directory.saveVendor({ name: "Brick & Beam Builders LLC", kind: "contractor", trade: "GC", rating: 4, notes: "Good super" })).id;
      const [com] = await db().select().from(schema.commitment).where(eq(schema.commitment.projectId, projectId));
      expect(com!.vendorId).toBe(vendorId);
      await expect(ac.directory.saveVendor({ name: "brick and beam builders llc", kind: "contractor" })).resolves.toBeTruthy();
      await expect(ac.directory.saveVendor({ name: "Brick & Beam Builders, L.L.C", kind: "contractor" })).rejects.toMatchObject({ code: "CONFLICT" });
      await expect(mc.directory.saveVendor({ name: "Nope", kind: "other" })).rejects.toMatchObject({ code: "FORBIDDEN" });
      const got = await mc.directory.get({ id: vendorId });
      expect(got.vendor).toMatchObject({ rating: 4, trade: "GC" });
      // A member without financial access doesn't see a contract link; the owner does.
      expect(got.projects).toEqual([]);
      expect((await oc.directory.get({ id: vendorId })).projects).toEqual([expect.objectContaining({ id: projectId, via: ["commitment"] })]);
      await expect((await callerFor((await createUser("external")).id)).directory.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("a lapsed COI flags the vendor on every project it's on; a renewal clears it; W-9s are for owners and admins", async () => {
      const lapsed = await ac.directory.saveDocument({ vendorId, kind: "coi", category: "vendor_coi_gl", number: "GL-1", expiresOn: addDays(today, -3) });
      expect((await expiredCoiFlags(db(), [projectId])).get(projectId)).toEqual(["Brick & Beam Builders LLC"]);
      await ac.directory.saveDocument({ vendorId, kind: "coi", category: "vendor_coi_gl", number: "GL-2", expiresOn: addDays(today, 200) });
      expect((await expiredCoiFlags(db(), [projectId])).get(projectId)).toBeUndefined();
      const list = await ac.directory.list();
      expect(list.vendors.find((v) => v.id === vendorId)).toMatchObject({ lapsedCoi: false, projects: 1 });
      await expect(ac.directory.saveDocument({ vendorId, kind: "license", category: "gc_license" })).rejects.toMatchObject({ code: "BAD_REQUEST" });

      const w9 = await ac.directory.saveDocument({ vendorId, kind: "w9", category: "w9", number: "2026" });
      const b = await ac.directory.beginDocUpload({ documentId: w9.id, name: "W-9.pdf", contentType: "application/pdf", sizeBytes: 12 });
      for (const o of b.objects) await storage().put(o.pathname, new Uint8Array(12), { contentType: "application/pdf" });
      await ac.directory.completeDocUpload({ uploadId: b.uploadId });
      expect((await mc.directory.get({ id: vendorId })).documents.some((d) => d.kind === "w9")).toBe(false);
      expect((await ac.directory.get({ id: vendorId })).documents.find((d) => d.id === w9.id)).toMatchObject({ hasFile: true, originalName: "W-9.pdf" });
      as = member.id;
      expect((await directoryMedia(new Request("http://t/"), { params: Promise.resolve({ id: w9.id }) } as never)).status).toBe(404);
      as = admin.id;
      expect((await directoryMedia(new Request("http://t/"), { params: Promise.resolve({ id: w9.id }) } as never)).status).toBeLessThan(400);
      void lapsed;
    });

    it("licenses remind the owners at 30/14/7 days, once each", async () => {
      await ac.directory.saveDocument({ vendorId, kind: "license", category: "gc_license", number: "GC-9", expiresOn: addDays(today, 6) });
      const first = await directoryReminderJob();
      expect(first.reminded).toBeGreaterThan(0);
      expect((await inbox(owner.id)).some((n) => n.title === "Brick & Beam Builders LLC: GC license expires in 6 days")).toBe(true);
      expect((await directoryReminderJob()).reminded).toBe(0);
    });

    it("a task given to the company links it to the project", async () => {
      const [t] = await db().select().from(schema.task).where(and(eq(schema.task.projectId, projectId), eq(schema.task.phaseKey, "construction"))).limit(1);
      await ac.checklist.updateTask({ projectId, taskId: t!.id, version: t!.version, vendorId });
      const got = await mc.directory.get({ id: vendorId });
      expect(got.projects).toEqual([expect.objectContaining({ id: projectId, via: ["task"] })]);
      expect((await ac.checklist.get({ projectId })).tasks.find((x) => x.id === t!.id)).toMatchObject({ vendorId, vendorName: "Brick & Beam Builders LLC" });
    });
  });

  describe("investors, capital and the portal (J)", () => {
    let harbor: string, pine: string;
    it("investors, commitments, a call split by commitment, receipts", async () => {
      harbor = (await ac.capital.saveInvestor({ projectId, name: "Harbor Capital LP", kind: "equity", userId: lp.id, committedCents: 600_000_00 })).investorId;
      pine = (await ac.capital.saveInvestor({ projectId, name: "Pine Street Partners", kind: "jv_partner", userId: lp2.id, committedCents: 400_000_00 })).investorId;
      await expect(ac.capital.saveInvestor({ projectId, name: "Bad link", kind: "equity", userId: member.id, committedCents: 1 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      // Portal logins: Harbor's with the capital flag, Pine's without.
      await oc.members.upsert({ projectId, userId: lp.id, projectRole: "Investor", canViewFinancials: true, canEditChecklist: false, canApprove: false });
      await oc.members.upsert({ projectId, userId: lp2.id, projectRole: "Investor", canViewFinancials: false, canEditChecklist: false, canApprove: false });
      await expect(oc.members.upsert({ projectId, userId: lp2.id, projectRole: "Investor", canViewFinancials: false, canEditChecklist: false, canApprove: true })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      const call = await ac.capital.createCall({ projectId, noticeOn: "2025-01-01", dueOn: "2025-01-01", totalCents: 1_000_000_00 });
      expect(call.number).toBe(1);
      expect((await inbox(lp.id)).some((n) => n.title.startsWith("Capital call #1"))).toBe(true);
      expect((await inbox(lp2.id)).some((n) => n.title.startsWith("Capital call #1"))).toBe(false);
      const ov = await ac.capital.overview({ projectId });
      const items = ov.calls[0]!.items;
      expect(items.map((i) => [i.investorName, i.amountCents])).toEqual(expect.arrayContaining([["Harbor Capital LP", 600_000_00], ["Pine Street Partners", 400_000_00]]));
      for (const i of items) await ac.capital.recordReceipt({ projectId, itemId: i.id, version: i.version, receivedCents: i.amountCents, receivedOn: "2025-01-01" });
      await expect(ac.capital.deleteCall({ projectId, id: ov.calls[0]!.id })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(mc.capital.overview({ projectId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("a distribution is split by the waterfall and recorded exactly as previewed", async () => {
      const preview = await ac.capital.previewDistribution({ projectId, amountCents: 1_500_000_00, paidOn: "2026-01-01" });
      expect(preview.shares.find((s) => s.investorId === harbor)).toMatchObject({ pref: 48_000_00, roc: 600_000_00, profit: 201_600_00 });
      expect(preview.gp).toBe(84_000_00);
      const d = await ac.capital.recordDistribution({ projectId, amountCents: 1_500_000_00, paidOn: "2026-01-01" });
      await expect(ac.capital.recordDistribution({ projectId, amountCents: 1_00, paidOn: "2025-06-01" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      const ov = await ac.capital.overview({ projectId });
      expect(ov.totals).toMatchObject({ committed: 1_000_000_00, contributed: 1_000_000_00, distributed: 1_500_000_00, promote: 84_000_00 });
      expect(ov.accounts.find((a) => a.investor.id === pine)!.account).toMatchObject({ roc: 400_000_00, pref: 32_000_00, profit: 134_400_00, unreturned: 0 });
      const second = await ac.capital.recordDistribution({ projectId, amountCents: 10_000_00, paidOn: "2026-02-01" });
      await expect(ac.capital.deleteDistribution({ projectId, id: d.id })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await ac.capital.deleteDistribution({ projectId, id: second.id });
      await expect(ac.capital.saveTerms({ projectId, version: 0, tiers: [{ kind: "return_of_capital" }] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });

    it("the portal: progress, schedule and photos for investors; each sees only their own account, and only with the flag", async () => {
      const list = await lc.portal.list();
      expect(list.find((p) => p.id === projectId)).toMatchObject({ capital: { committed: 600_000_00, contributed: 600_000_00, distributed: 849_600_00 } });
      const view = await lc.portal.project({ projectId });
      expect(view.accounts.map((a) => a.investorName)).toEqual(["Harbor Capital LP"]);
      expect(view.accounts[0]!.account.distributed).toBe(849_600_00);
      expect(view.phase.total).toBeGreaterThan(0);
      const other = await l2c.portal.project({ projectId });
      expect(other).toMatchObject({ canSeeAccount: false, accounts: [] });
      // Photos are shared with investors from the start.
      const photos = await db().select().from(schema.folder).where(and(eq(schema.folder.projectId, projectId), eq(schema.folder.isPhotos, true)));
      expect(await db().select().from(schema.folderShare).where(and(eq(schema.folderShare.folderId, photos[0]!.id), eq(schema.folderShare.userId, lp.id)))).toHaveLength(1);
      // Nothing else: tasks, team, financials and field work are closed to them.
      await expect(lc.checklist.get({ projectId })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(lc.members.list({ projectId })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(lc.financials.overview({ projectId })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(lc.capital.overview({ projectId })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(lc.rfis.list({ projectId })).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect((await lc.files.folders({ projectId })).folders.map((f) => f.isPhotos)).toEqual([true]);
    });

    it("the quarterly report: the investor's own account; the whole table for financial staff", async () => {
      as = lp.id;
      const mine = await investorReport(new Request("http://t/?quarter=2026-Q1"), { params: Promise.resolve({ id: projectId }) } as never);
      expect(mine.status).toBe(200);
      expect(mine.headers.get("content-type")).toBe("application/pdf");
      as = admin.id;
      const full = await investorReport(new Request("http://t/?quarter=2026-Q1"), { params: Promise.resolve({ id: projectId }) } as never);
      expect(full.status).toBe(200);
      expect((await investorReport(new Request("http://t/?quarter=2026-Q9"), { params: Promise.resolve({ id: projectId }) } as never)).status).toBe(400);
      as = (await createUser("external")).id;
      expect((await investorReport(new Request("http://t/"), { params: Promise.resolve({ id: projectId }) } as never)).status).toBe(404);
    });
  });
});
