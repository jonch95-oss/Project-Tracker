import { describe, expect, it } from "vitest";
import { expiryReminderMark, expiryState, vendorKey } from "@/core/expiries";
import { diffRecords, isoDate, parseAddress, parseBbl, SOURCE_BY_KEY, sourceStage, summarizeCharges, toCents, type RecordItem } from "@/core/records";

const lot = parseBbl("3011370045")!;
const ctx = { lot, address: parseAddress("658 Dean Street, Brooklyn"), bins: ["3029125"] };
const item = (over: Partial<RecordItem> = {}): RecordItem => ({ key: "k1", kind: "violation", title: "DOB violation 1", status: "ACTIVE", date: "2026-09-01", open: true, critical: false, url: "https://x", detail: {}, ...over });

describe("lots, addresses and dates", () => {
  it("parses a BBL and an address", () => {
    expect(lot).toEqual({ bbl: "3011370045", boro: "3", block: 1137, lot: 45 });
    expect(parseBbl("3-01137-0045")).toEqual(lot);
    expect(parseBbl("6011370045")).toBeNull();
    expect(parseBbl(null)).toBeNull();
    expect(parseAddress("658 Dean Street, Brooklyn, NY")).toEqual({ house: "658", street: "DEAN STREET" });
    expect(parseAddress("89-21 169th Street")).toEqual({ house: "89-21", street: "169TH STREET" });
    expect(parseAddress("Corner lot")).toBeNull();
  });

  it("reads every date format the datasets use", () => {
    expect(isoDate("2025-10-07T00:00:00.000")).toBe("2025-10-07");
    expect(isoDate("20090413")).toBe("2009-04-13");
    expect(isoDate("06/17/2020")).toBe("2020-06-17");
    expect(isoDate("")).toBeNull();
    expect(isoDate("soon")).toBeNull();
    expect(toCents("1,250.5")).toBe(125050);
    expect(toCents("$200.00")).toBe(20000);
    expect(toCents("-3.1")).toBe(-310);
    expect(toCents("n/a")).toBe(0);
  });

  it("queries each dataset the way it writes borough, block and lot (checked live)", () => {
    const where = (k: string) => SOURCE_BY_KEY.get(k)!.query(ctx)!.$where;
    expect(where("dob_violations")).toBe("boro='3' AND block='01137' AND lot='00045'");
    expect(where("ecb_violations")).toBe("boro='3' AND block='01137' AND lot='0045'");
    expect(where("bis_permits")).toBe("borough='BROOKLYN' AND block='01137' AND lot='00045'");
    expect(where("oath")).toContain("violation_location_block_no='01137' AND violation_location_lot_no='0045'");
    expect(where("acris_legals")).toBe("borough='3' AND block='1137' AND lot='45'");
    expect(where("tax_lien")).toBe("borough='3' AND block='1137' AND lot='45'");
    expect(where("bis_jobs")).toBe("house__='658' AND upper(street_name)='DEAN STREET' AND borough='BROOKLYN'");
    expect(where("hpd_violations")).toBe("bbl='3011370045'");
    expect(where("dof_charges")).toBe("parid='3011370045' AND sum_bal > 0");
    expect(where("dob_complaints")).toBe("bin in ('3029125') OR (house_number='658' AND upper(house_street)='DEAN STREET')");
    expect(SOURCE_BY_KEY.get("bis_jobs")!.query({ ...ctx, address: null })).toBeNull();
    expect(SOURCE_BY_KEY.get("dob_complaints")!.query({ ...ctx, address: null, bins: [] })).toBeNull();
    expect(SOURCE_BY_KEY.get("acris_master")!.query(ctx)).toBeNull();
    expect(SOURCE_BY_KEY.get("acris_master")!.query({ ...ctx, documentIds: ["a'b"] })!.$where).toBe("document_id in ('a''b')");
  });

  it("maps a stop-work complaint as critical, and a rescinded one as not", () => {
    const m = SOURCE_BY_KEY.get("dob_complaints")!.map;
    const swo = m({ complaint_number: "1", status: "ACTIVE", disposition_code: "A3", date_entered: "09/01/2026" }, ctx)!;
    expect(swo).toMatchObject({ critical: true, title: "Full stop-work order (complaint 1)", date: "2026-09-01" });
    expect(m({ complaint_number: "1", status: "CLOSED", disposition_code: "L2" }, ctx)!.critical).toBe(false);
    const vacate = SOURCE_BY_KEY.get("hpd_vacate")!.map({ vacate_order_number: "9", vacate_type: "Partial", vacate_effective_date: "2026-09-02T00:00:00.000" }, ctx)!;
    expect(vacate).toMatchObject({ critical: true, open: true, status: "In force" });
    expect(SOURCE_BY_KEY.get("hpd_vacate")!.map({ vacate_order_number: "9", actual_rescind_date: "2026-09-10T00:00:00.000" }, ctx)!.critical).toBe(false);
    expect(SOURCE_BY_KEY.get("dob_violations")!.map({ isn_dob_bis_viol: null }, ctx)).toBeNull();
  });
});

describe("what counts as news", () => {
  it("first run: only orders in force; after that: new, changed and resolved", () => {
    const known = new Map();
    expect(diffRecords(known, [item()], "s", true)).toEqual([]);
    const crit = diffRecords(known, [item({ key: "c", kind: "complaint", critical: true, title: "Full stop-work order" })], "s", true);
    expect(crit).toHaveLength(1);
    expect(crit[0]).toMatchObject({ kind: "critical", critical: true, title: "CRITICAL: Full stop-work order" });

    expect(diffRecords(known, [item()], "s", false)[0]).toMatchObject({ kind: "new", title: "New violation: DOB violation 1", dedupeKey: "s:k1:new" });
    const k = new Map([["k1", { key: "k1", status: "ACTIVE", critical: false, open: true }]]);
    expect(diffRecords(k, [item()], "s", false)).toEqual([]);
    expect(diffRecords(k, [item({ status: "DISMISSED", open: false })], "s", false)[0]).toMatchObject({ kind: "resolved", title: "Resolved: DOB violation 1 (DISMISSED)" });
    const job = new Map([["j", { key: "j", status: "Filed", critical: false, open: true }]]);
    expect(diffRecords(job, [item({ key: "j", kind: "job", title: "Job 1", status: "Approved" })], "s", false)[0]).toMatchObject({ kind: "status", title: "Job 1: Filed → Approved" });
    // 311 status churn and quiet document types aren't news.
    expect(diffRecords(new Map([["r", { key: "r", status: "Open", critical: false, open: true }]]), [item({ key: "r", kind: "sr311", status: "Closed" })], "s", false)).toEqual([]);
    expect(diffRecords(new Map(), [item({ key: "d", kind: "recording", status: "MISC" })], "s", false)).toEqual([]);
    expect(diffRecords(new Map(), [item({ key: "d", kind: "recording", status: "LP", title: "Lis pendens recorded" })], "s", false)[0]!.title).toBe("New ACRIS recording: Lis pendens recorded");
    // An order already known stays quiet.
    expect(diffRecords(new Map([["c", { key: "c", status: "x", critical: true, open: true }]]), [item({ key: "c", critical: true, status: "x" })], "s", false)).toEqual([]);
  });

  it("tax arrears: one record, no amount in the alert", () => {
    const today = "2026-09-24";
    const rows = [{ sum_bal: "200.00", due_date: "2026-07-01T00:00:00.000" }, { sum_bal: "50.25", due_date: "2026-01-01T00:00:00.000" }, { sum_bal: "999.00", due_date: "2027-01-01T00:00:00.000" }];
    const t = summarizeCharges(rows, today, lot);
    expect(t).toMatchObject({ key: "arrears", open: true, status: "arrears", date: "2026-01-01", detail: { pastDueCents: 25025, charges: 2 } });
    expect(summarizeCharges([], today, lot)).toMatchObject({ open: false, status: "current" });
    const a = diffRecords(new Map([["arrears", { key: "arrears", status: "current", critical: false, open: false }]]), [t], "dof", false);
    expect(a[0]!.title).toBe("Property tax or charges are past due");
    expect(a[0]!.title).not.toMatch(/\$/);
  });

  it("violation stages follow the source without moving backwards", () => {
    expect(sourceStage(item({ open: false, status: "RESOLVE · DISMISSED" }))).toBe("dismissed");
    expect(sourceStage(item({ open: false, status: "RESOLVE · IN VIOLATION · paid in full" }))).toBe("paid");
    expect(sourceStage(item({ open: false, status: "Close" }))).toBe("resolved");
    expect(sourceStage(item({ status: "ACTIVE · PENDING · CERTIFICATE PENDING" }))).toBe("correction_filed");
    expect(sourceStage(item({ hearingOn: "2026-10-01" }))).toBe("hearing");
    expect(sourceStage(item())).toBeNull();
    expect(sourceStage(item({ kind: "job" }))).toBeNull();
  });
});

describe("expiries", () => {
  it("state and reminder marks: 30, 14, 7, then daily; a missed day catches up once", () => {
    expect(expiryState("2026-12-01", "2026-09-24")).toBe("ok");
    expect(expiryState("2026-10-10", "2026-09-24")).toBe("soon");
    expect(expiryState("2026-09-23", "2026-09-24")).toBe("expired");
    expect(expiryReminderMark("2026-12-01", "2026-09-24", new Set())).toBeNull();
    expect(expiryReminderMark("2026-10-24", "2026-09-24", new Set())).toBe("30");
    expect(expiryReminderMark("2026-10-24", "2026-09-25", new Set(["30"]))).toBeNull();
    expect(expiryReminderMark("2026-10-05", "2026-09-24", new Set(["30"]))).toBe("14");
    expect(expiryReminderMark("2026-09-28", "2026-09-24", new Set())).toBe("7");
    expect(expiryReminderMark("2026-09-20", "2026-09-24", new Set())).toBe("expired:2026-09-24");
    expect(expiryReminderMark("2026-09-20", "2026-09-24", new Set(["expired:2026-09-24"]))).toBeNull();
  });

  it("one vendor however it's typed", () => {
    expect(vendorKey("ACME Builders, LLC")).toBe(vendorKey("Acme Builders LLC"));
    expect(vendorKey("Acme Builders Inc.")).toBe("acme builders");
    expect(vendorKey(null)).toBe("");
  });
});

describe("review regressions", () => {
  it("only the latest, unrescinded, recent order per building is in force", async () => {
    const { resolveComplaintOrders, SOURCE_BY_KEY: S } = await import("@/core/records");
    const m = (row: Record<string, unknown>) => S.get("dob_complaints")!.map(row, ctx)!;
    const old = m({ complaint_number: "1", status: "CLOSED", disposition_code: "A3", disposition_date: "03/01/2015", bin: "B1" });
    const lifted = m({ complaint_number: "2", status: "CLOSED", disposition_code: "L2", disposition_date: "03/10/2015", bin: "B1" });
    const recent = m({ complaint_number: "3", status: "CLOSED", disposition_code: "L1", disposition_date: "09/01/2026", bin: "B2" });
    const stale = m({ complaint_number: "4", status: "CLOSED", disposition_code: "Y1", disposition_date: "01/01/2020", bin: "B3" });
    const out = resolveComplaintOrders([old, lifted, recent, stale], "2026-09-24");
    expect(out.map((i) => i.critical)).toEqual([false, false, true, false]);
    expect(out[2]!.open).toBe(true);
    // A re-imposed order on the same complaint is new news.
    const again = diffRecords(new Map([["3", { key: "3", status: "CLOSED · L1", critical: false, open: false }]]), [out[2]!], "c", false);
    expect(again[0]!.dedupeKey).toBe("c:3:critical:CLOSED · L1:2026-09-01");
  });

  it("old recordings surfacing late aren't news; ACRIS legals come newest first", () => {
    const rec = item({ key: "d", kind: "recording", status: "MTGE", title: "Mortgage recorded", date: "1998-02-01" });
    expect(diffRecords(new Map(), [rec], "a", false, "2026-09-24")).toEqual([]);
    expect(diffRecords(new Map(), [{ ...rec, date: "2026-09-01" }], "a", false, "2026-09-24")).toHaveLength(1);
    expect(SOURCE_BY_KEY.get("acris_legals")!.query(ctx)).toMatchObject({ $order: "document_id DESC", maxRows: 60 });
    for (const k of ["bis_jobs", "bis_permits", "dob_complaints"]) expect(SOURCE_BY_KEY.get(k)!.query(ctx)!.$order).toBe(":id");
  });
});
