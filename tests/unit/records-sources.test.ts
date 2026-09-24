/**
 * Every source maps a row shaped like the live data (samples from the
 * 2026-09-24 probe), and ignores rows without their key.
 */
import { afterEach, describe, expect, it } from "vitest";
import { expiryLabel, isVendorCoi } from "@/core/expiries";
import { diffRecords, parseAddress, parseBbl, setRecordsClockForTests, SOURCE_BY_KEY, SOURCES, stageRank, type RecordItem } from "@/core/records";

const ctx = { lot: parseBbl("3017590013")!, address: parseAddress("545 Willoughby Avenue"), bins: [] };

const SAMPLES: Record<string, [Record<string, unknown>, Partial<RecordItem>]> = {
  dobnow_jobs: [{ job_filing_number: "B08048120-P7", filing_status: "Approved", job_type: "Alteration", filing_date: "2025-10-07T00:00:00.000", current_status_date: "2025-10-09T12:56:58.000", bin: "3048818", job_description: "plumbing work" }, { kind: "job", title: "DOB NOW Alteration B08048120-P7", status: "Approved", date: "2025-10-07", open: true }],
  bis_jobs: [{ job__: "302112149", doc__: "01", job_type: "A3", job_status_descrp: "SIGNED OFF", latest_action_date: "05/16/2008", bin__: "3048818" }, { key: "302112149-01", status: "SIGNED OFF", open: false, date: "2008-05-16" }],
  bis_permits: [{ permit_si_no: "3765466", job__: "340733647", permit_status: "ISSUED", permit_type: "EW", issuance_date: "06/17/2020", expiration_date: "02/26/2021", work_type: "OT" }, { kind: "permit", open: true, expiresOn: "2021-02-26", title: "EW permit, job 340733647" }],
  dobnow_permits: [{ work_permit: "B00755883-I1-FN", sequence_number: "5", work_type: "Sidewalk Shed", permit_status: "Permit Issued", issued_date: "2026-03-10T00:00:00.000", expired_date: "2027-03-10T05:00:00.000" }, { key: "B00755883-I1-FN#5", open: true, expiresOn: "2027-03-10", title: "Sidewalk Shed permit B00755883-I1-FN" }],
  dob_violations: [{ isn_dob_bis_viol: "498825", violation_number: "85-0388", violation_category: "V*-DOB VIOLATION - DISMISSED", violation_type: "LANDMK-LANDMARK        NONE", issue_date: "19850116", disposition_date: "20231108" }, { open: false, date: "1985-01-16", detail: { type: "LANDMK-LANDMARK", description: null, bin: null, closedOn: "2023-11-08" } }],
  ecb_violations: [{ ecb_violation_number: "38200385N", ecb_violation_status: "RESOLVE", issue_date: "20090217", hearing_date: "20090413", severity: "CLASS - 3", hearing_status: "CURED/IN-VIO", certification_status: "CURE ACCEPTED" }, { open: false, hearingOn: "2009-04-13", status: "RESOLVE · CURED/IN-VIO · CURE ACCEPTED" }],
  dob_safety: [{ violation_number: "SV1", violation_status: "Active", violation_issue_date: "2026-01-02T00:00:00.000", violation_type: "Facade" }, { open: true, title: "DOB safety violation SV1" }],
  hpd_violations: [{ violationid: "2282679", class: "C", currentstatus: "VIOLATION CLOSED", violationstatus: "Close", novissueddate: "1989-08-01T00:00:00.000" }, { open: false, title: "HPD class C violation 2282679" }],
  hpd_vacate: [{ vacate_order_number: "260021", vacate_type: "Partial", vacate_effective_date: "2025-10-15T00:00:00.000", actual_rescind_date: "2025-01-07T00:00:00.000", primary_vacate_reason: "Fire Damage" }, { critical: false, status: "Rescinded", title: "HPD partial vacate order 260021" }],
  fdny_vacate: [{ description: "Dismissal", vac_date: "1989-04-05T00:00:00.000", bin: "3055182", bbl: "3019270005" }, { key: "3055182-1989-04-05", critical: false, open: false }],
  dob_complaints: [{ complaint_number: "4815606", status: "CLOSED", date_entered: "07/06/2020", disposition_code: "L2", complaint_category: "8A" }, { open: false, critical: false, title: "Stop-work order rescinded (complaint 4815606)" }],
  oath: [{ ticket_number: "0146998482", issuing_agency: "DOB", hearing_status: "HEARING COMPLETED", hearing_result: "DISMISSED", hearing_date: "2006-08-18T00:00:00.000", violation_date: "2006-06-09T00:00:00.000" }, { kind: "hearing", open: false, title: "OATH summons 0146998482 (DOB)" }],
  sr311: [{ unique_key: "47606597", created_date: "2020-09-09T13:10:00.000", complaint_type: "Request Large Bulky Item Collection", descriptor: "Bulky", status: "Closed", agency: "DSNY" }, { kind: "sr311", open: false, title: "311: Request Large Bulky Item Collection (Bulky)" }],
  tax_lien: [{ month: "2019-04-17T00:00:00.000", cycle: "90 Day Notice", block: "27", water_debt_only: "NO" }, { kind: "lien", key: "2019-04-17-90 Day Notice", title: "On the tax lien sale list (90 Day Notice)" }],
  acris_master: [{ document_id: "2023032300318001", doc_type: "DEED", document_date: "2022-12-19T00:00:00.000", recorded_datetime: "2023-03-23T00:00:00.000" }, { kind: "recording", title: "Deed recorded", date: "2023-03-23", status: "DEED" }],
};

describe("every source maps live-shaped rows", () => {
  afterEach(() => setRecordsClockForTests(null));

  for (const s of SOURCES) {
    it(`${s.key} (${s.dataset})`, () => {
      expect(s.columns.length).toBeGreaterThan(2);
      if (s.key === "dof_charges" || s.key === "acris_legals") {
        expect(s.map({}, ctx)).toBeNull();
        return;
      }
      const [row, want] = SAMPLES[s.key]!;
      const got = s.map(row, ctx)!;
      expect(got).toMatchObject(want);
      expect(got.url).toMatch(/^https:\/\//);
      expect(got.title).not.toMatch(/\$/);
      expect(s.map({}, ctx)).toBeNull();
      const query = s.query({ ...ctx, bins: ["1"], documentIds: ["1"] });
      expect(query?.$limit).toBeGreaterThan(0);
    });
  }

  it("311 looks back two years from today", () => {
    setRecordsClockForTests(() => new Date("2026-09-24T12:00:00Z"));
    expect(SOURCE_BY_KEY.get("sr311")!.query(ctx)!.$where).toBe("bbl='3017590013' AND created_date > '2024-09-24T00:00:00'");
  });

  it("new records by kind", () => {
    const base: RecordItem = { key: "n", kind: "job", title: "T", status: "S", date: null, open: true, critical: false, url: "https://x", detail: {} };
    const title = (over: Partial<RecordItem>) => diffRecords(new Map(), [{ ...base, ...over }], "s", false)[0]?.title ?? null;
    expect(title({ kind: "job" })).toBe("New DOB filing: T");
    expect(title({ kind: "permit" })).toBe("Permit issued: T");
    expect(title({ kind: "permit", open: false })).toBeNull();
    expect(title({ kind: "complaint" })).toBe("New DOB complaint: T");
    expect(title({ kind: "sr311" })).toBe("New T");
    expect(title({ kind: "lien" })).toBe("The lot is on the tax lien sale list");
    expect(title({ kind: "tax" })).toBe("Property tax or charges are past due");
    expect(title({ kind: "tax", open: false })).toBeNull();
    expect(title({ kind: "hearing" })).toBe("New OATH summons: T");
    expect(title({ kind: "vacate" })).toBe("Vacate order: T");
    expect(title({ kind: "vacate", open: false })).toBeNull();
    expect(title({ kind: "violation", open: false })).toBeNull();
    expect(stageRank("issued")).toBeLessThan(stageRank("paid"));
  });

  it("expiry labels", () => {
    expect(expiryLabel("gl_policy")).toBe("General liability policy");
    expect(expiryLabel("vendor_coi_wc", "Acme")).toBe("Vendor COI: workers' comp: Acme");
    expect(expiryLabel("mystery")).toBe("mystery");
    expect(isVendorCoi("vendor_coi_db")).toBe(true);
    expect(isVendorCoi("gl_policy")).toBe(false);
  });
});
