import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db, schema } from "@/server/db";
import { storage } from "@/server/storage";
import { addMember, callerFor, companyId, createUser } from "../support/fixtures";

type Caller = Awaited<ReturnType<typeof callerFor>>;

describe("financials", () => {
  let oc: Caller, ac: Caller, finMember: Caller, member: Caller, outsiderFin: Caller, approverAdmin: Caller;
  let projectId: string;

  beforeAll(async () => {
    const owner = await createUser("owner");
    const admin = await createUser("admin");
    const admin2 = await createUser("admin");
    const fm = await createUser("member");
    const m = await createUser("member");
    const x = await createUser("external");
    oc = await callerFor(owner.id);
    ac = await callerFor(admin.id);
    approverAdmin = await callerFor(admin2.id);
    finMember = await callerFor(fm.id);
    member = await callerFor(m.id);
    outsiderFin = await callerFor(x.id);
    projectId = (await oc.projects.create({ name: "Money", address: "1 Money St", type: "ground_up_condo", companyId: await companyId(), bbl: null, toggles: [] })).id;
    await addMember(projectId, admin.id, { canViewFinancials: true, canEditChecklist: true, canApprove: false });
    await addMember(projectId, admin2.id, { canViewFinancials: true, canApprove: true });
    await addMember(projectId, fm.id, { canViewFinancials: true });
    await addMember(projectId, m.id);
    await addMember(projectId, x.id, { canViewFinancials: true });
  });

  it("only people with financial access see the tab; only admins with access edit; owners export", async () => {
    await expect(member.financials.overview({ projectId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const fin = await finMember.financials.overview({ projectId });
    expect(fin.access).toEqual({ canEdit: false, canApprove: false, canExport: false });
    // Admins with financial access edit and approve (admins always approve, brief §4).
    expect((await ac.financials.overview({ projectId })).access).toEqual({ canEdit: true, canApprove: true, canExport: false });
    expect((await approverAdmin.financials.overview({ projectId })).access).toMatchObject({ canEdit: true, canApprove: true });
    expect((await oc.financials.overview({ projectId })).access).toEqual({ canEdit: true, canApprove: true, canExport: true });
    await expect(finMember.financials.saveLine({ projectId, category: "hard", name: "Nope", originalCents: 1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    // An outsider granted financials can read them (brief §4), never edit.
    await outsiderFin.financials.overview({ projectId });
    await expect(outsiderFin.financials.saveLine({ projectId, category: "hard", name: "Nope", originalCents: 1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("budget → commitments → invoices → change orders roll up to the cent, and the headline follows", async () => {
    await ac.financials.saveHeadline({ projectId, purchasePriceCents: 5_000_000_00, totalBudgetCents: 1, projectedSelloutCents: 1, loanAmountCents: 8_000_000_00 });
    const { created } = await ac.financials.startBudget({ projectId });
    expect(created).toBe(7);
    let o = await ac.financials.overview({ projectId });
    const hard = o.lines.find((l) => l.category === "hard")!;
    const soft = o.lines.find((l) => l.category === "soft")!;
    await ac.financials.saveLine({ projectId, id: hard.id, version: hard.version, category: "hard", name: "Construction", originalCents: 9_000_000_00 });
    await ac.financials.saveLine({ projectId, id: soft.id, version: soft.version, category: "soft", name: "Soft costs", originalCents: 1_000_000_00 });
    await expect(ac.financials.saveLine({ projectId, id: hard.id, version: hard.version, category: "hard", name: "Stale", originalCents: 1 })).rejects.toMatchObject({ code: "CONFLICT" });

    const { id: gc } = await ac.financials.saveCommitment({ projectId, budgetLineId: hard.id, vendorName: "Acme GC", amountCents: 8_500_000_00, status: "executed", retainageBps: 1000 });
    await ac.financials.saveCommitment({ projectId, budgetLineId: soft.id, vendorName: "Draft Architect", amountCents: 999_00, status: "draft" });
    const { id: inv1 } = await ac.financials.saveInvoice({ projectId, commitmentId: gc, vendorName: "Acme GC", number: "1", amountCents: 1_000_000_00 });
    const { id: inv2 } = await ac.financials.saveInvoice({ projectId, vendorName: "Surveyor", amountCents: 12_345_67 });
    // Approval (A): viewers can't; uncoded invoices can't be approved; rejections need a note.
    const v = async (id: string) => (await db().select().from(schema.invoice).where(eq(schema.invoice.id, id)))[0]!.version;
    await expect(finMember.financials.decideInvoice({ projectId, id: inv1, version: await v(inv1), decision: "approved" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(approverAdmin.financials.decideInvoice({ projectId, id: inv2, version: await v(inv2), decision: "approved" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(approverAdmin.financials.decideInvoice({ projectId, id: inv2, version: await v(inv2), decision: "rejected" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await approverAdmin.financials.decideInvoice({ projectId, id: inv1, version: await v(inv1), decision: "approved" });
    await expect(approverAdmin.financials.decideInvoice({ projectId, id: inv1, version: await v(inv1), decision: "approved" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(ac.financials.saveInvoice({ projectId, id: inv1, version: await v(inv1), vendorName: "Acme GC", amountCents: 1 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await ac.financials.markPaid({ projectId, id: inv1, version: await v(inv1), paidOn: "2026-09-01" });

    const { id: co } = await ac.financials.saveChangeOrder({ projectId, commitmentId: gc, description: "Rock at 12 ft", amountCents: 250_000_00, scheduleDays: 10 });
    const { id: credit } = await ac.financials.saveChangeOrder({ projectId, budgetLineId: hard.id, description: "Value engineering", amountCents: -50_000_00 });
    const cv = async (id: string) => (await db().select().from(schema.changeOrder).where(eq(schema.changeOrder.id, id)))[0]!.version;
    await oc.financials.decideChangeOrder({ projectId, id: co, version: await cv(co), decision: "approved" });
    await oc.financials.decideChangeOrder({ projectId, id: credit, version: await cv(credit), decision: "approved" });
    await expect(ac.financials.saveChangeOrder({ projectId, id: co, version: await cv(co), description: "x", amountCents: 1 })).rejects.toMatchObject({ code: "BAD_REQUEST" });

    o = await ac.financials.overview({ projectId });
    const h2 = o.lines.find((l) => l.id === hard.id)!.totals;
    expect(h2).toMatchObject({ original: 9_000_000_00, approvedChanges: 200_000_00, revised: 9_200_000_00, committed: 8_500_000_00, invoiced: 1_000_000_00, paid: 1_000_000_00, variance: 0 });
    expect(o.lines.find((l) => l.id === soft.id)!.totals.committed).toBe(0); // draft commitment not counted
    expect(o.budget!.revised).toBe(10_200_000_00);
    expect(o.headline).toMatchObject({ purchasePrice: 5_000_000_00, totalBudget: 10_200_000_00, spentToDate: 1_000_000_00, committed: 8_500_000_00, forecastAtCompletion: 10_200_000_00, equityRequired: 2_200_000_00 });
    expect(o.commitments.find((c) => c.id === gc)!.billedCents).toBe(1_000_000_00);
    expect(o.changeOrders.map((c) => c.number)).toEqual([1, 2]);

    // Portfolio cards follow the budget.
    const card = (await oc.projects.list()).projects.find((p) => p.id === projectId)!;
    expect(card.headline).toEqual({ purchasePriceCents: 5_000_000_00, totalBudgetCents: 10_200_000_00, projectedSelloutCents: 1 });
    // A line with things coded to it can't be removed.
    await expect(ac.financials.deleteLine({ projectId, id: hard.id })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("sales tracker drives projected sellout, profit and margin", async () => {
    await ac.financials.saveUnit({ projectId, unit: "2A", sf: 1000, askCents: 2_000_000_00, status: "available" });
    await ac.financials.saveUnit({ projectId, unit: "3A", sf: 1200, askCents: 2_600_000_00, contractCents: 2_550_000_00, status: "contract" });
    await expect(ac.financials.saveUnit({ projectId, unit: "3a", status: "available" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(ac.financials.saveUnit({ projectId, unit: "PH", status: "closed" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const o = await ac.financials.overview({ projectId });
    expect(o.sales).toMatchObject({ units: 2, inContract: 1, projectedSellout: 4_550_000_00 });
    expect(o.units.find((u) => u.unit === "3A")!.contractPerSf).toBe(2_125_00);
    expect(o.headline.projectedSellout).toBe(4_550_000_00);
    expect(o.headline.profit).toBe(4_550_000_00 - o.headline.forecastAtCompletion!);
  });

  it("draws: approved invoices only, retainage held, waivers and inspector before funding", async () => {
    const o0 = await ac.financials.overview({ projectId });
    const hard = o0.lines.find((l) => l.category === "hard")!;
    const gc = o0.commitments.find((c) => c.vendorName === "Acme GC")!;
    const { id: inv3 } = await ac.financials.saveInvoice({ projectId, commitmentId: gc.id, vendorName: "Acme GC", number: "2", amountCents: 500_000_00 });
    const { id: pending } = await ac.financials.saveInvoice({ projectId, budgetLineId: hard.id, vendorName: "Plumber", amountCents: 10_000_00 });
    const iv = async (id: string) => (await db().select().from(schema.invoice).where(eq(schema.invoice.id, id)))[0]!.version;
    await oc.financials.decideInvoice({ projectId, id: inv3, version: await iv(inv3), decision: "approved" });
    const paid = o0.invoices.find((i) => i.number === "1")!;

    const { id } = await ac.financials.createDraw({ projectId });
    await expect(ac.financials.createDraw({ projectId })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const dv = async () => (await db().select().from(schema.draw).where(eq(schema.draw.id, id)))[0]!.version;
    await expect(ac.financials.updateDraw({ projectId, id, version: await dv(), invoiceIds: [pending] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await ac.financials.updateDraw({ projectId, id, version: await dv(), invoiceIds: [inv3, paid.id] });
    let draw = (await ac.financials.overview({ projectId })).draws.find((x) => x.id === id)!;
    // Retainage from the contract (10%) on both.
    expect(draw.totals).toEqual({ gross: 1_500_000_00, retainage: 150_000_00, net: 1_350_000_00 });
    expect(draw.lienWaivers).toEqual([{ vendor: "Acme GC", received: false }]);
    await expect(ac.financials.advanceDraw({ projectId, id, version: await dv() })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await ac.financials.updateDraw({ projectId, id, version: await dv(), lienWaivers: [{ vendor: "Acme GC", received: true }] });
    await ac.financials.advanceDraw({ projectId, id, version: await dv() });
    await expect(ac.financials.updateDraw({ projectId, id, version: await dv(), invoiceIds: [] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(ac.financials.advanceDraw({ projectId, id, version: await dv() })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await ac.financials.updateDraw({ projectId, id, version: await dv(), inspectorName: "L. Inspector", inspectorSignedOn: "2026-09-20" });
    await ac.financials.advanceDraw({ projectId, id, version: await dv() });
    await ac.financials.advanceDraw({ projectId, id, version: await dv() });
    draw = (await ac.financials.overview({ projectId })).draws.find((x) => x.id === id)!;
    expect(draw.status).toBe("funded");
    // An invoice on one draw can't go on another.
    const { id: second } = await ac.financials.createDraw({ projectId });
    const v2 = (await db().select().from(schema.draw).where(eq(schema.draw.id, second)))[0]!.version;
    await expect(ac.financials.updateDraw({ projectId, id: second, version: v2, invoiceIds: [inv3] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // Drawn invoices can't be deleted.
    await expect(ac.financials.deleteInvoice({ projectId, id: inv3 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("documents must come from the gated Financial folder", async () => {
    const folders = (await oc.files.folders({ projectId })).folders;
    const put = async (folderId: string) => {
      const b = await oc.files.beginUpload({ projectId, folderId, name: "inv.pdf", contentType: "application/pdf", sizeBytes: 5 });
      for (const o of b.objects) await storage().put(o.pathname, new Uint8Array(5), { contentType: o.contentType });
      return (await oc.files.completeUpload({ projectId, uploadId: b.uploadId })).fileId;
    };
    const plain = await put(folders.find((f) => f.name === "Legal")!.id);
    const gated = await put(folders.find((f) => f.gated)!.id);
    await expect(ac.financials.saveInvoice({ projectId, vendorName: "V", amountCents: 1, fileId: plain })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await ac.financials.saveInvoice({ projectId, vendorName: "V", amountCents: 1, fileId: gated });
  });

  it("money never shows in the activity feed without financial access", async () => {
    const act = JSON.stringify(await member.projects.activity({ projectId }));
    expect(act).not.toMatch(/\$|Acme GC|invoice|commitment|draw|CO #/i);
    const actFin = JSON.stringify(await finMember.projects.activity({ projectId }));
    expect(actFin).toMatch(/Acme GC/);
  });
});
