/**
 * Public records watch (brief §10): which NYC Open Data datasets to read for
 * a lot, how each one writes borough / block / lot, how a row becomes a
 * record, and what counts as a change worth an alert. Pure: the server
 * fetches, this decides.
 *
 * Every dataset id and field name here was checked against the live Socrata
 * metadata on 2026-09-24 (see docs/RECORDS.md). The sync re-checks the
 * required columns on every run and fails loudly if a dataset changes.
 */

import { daysBetween } from "./time";

export const BORO_NAME = { "1": "MANHATTAN", "2": "BRONX", "3": "BROOKLYN", "4": "QUEENS", "5": "STATEN ISLAND" } as const;
export type BoroCode = keyof typeof BORO_NAME;

export interface Lot {
  bbl: string;
  boro: BoroCode;
  block: number;
  lot: number;
}

export function parseBbl(bbl: string | null | undefined): Lot | null {
  const m = /^([1-5])(\d{5})(\d{4})$/.exec((bbl ?? "").replace(/\D/g, ""));
  if (!m) return null;
  return { bbl: `${m[1]}${m[2]}${m[3]}`, boro: m[1] as BoroCode, block: Number(m[2]), lot: Number(m[3]) };
}

export const pad = (n: number, width: number) => String(n).padStart(width, "0");

/** "412 Sterling Place, Brooklyn, NY" → { house: "412", street: "STERLING PLACE" } (DOB BIS and complaint lookups go by address). */
export function parseAddress(address: string | null | undefined): { house: string; street: string } | null {
  const first = (address ?? "").split(",")[0]!.trim().replace(/\s+/g, " ");
  const m = /^(\d+[A-Z]?(?:-\d+[A-Z]?)?)\s+(.+)$/i.exec(first);
  if (!m) return null;
  return { house: m[1]!.toUpperCase(), street: m[2]!.toUpperCase() };
}

/** Socrata string literal. */
export const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

export type RecordKind = "job" | "permit" | "violation" | "complaint" | "sr311" | "vacate" | "recording" | "tax" | "lien" | "hearing";

export interface RecordItem {
  /** Unique within its source. */
  key: string;
  kind: RecordKind;
  /** Short label; never a dollar figure (it can reach push text). */
  title: string;
  /** The value whose change is news (job status, violation status…). */
  status: string | null;
  /** ISO date the record is about (filed, issued, recorded…). */
  date: string | null;
  open: boolean;
  /** A stop-work or vacate order in force. */
  critical: boolean;
  url: string;
  /** For violations: the hearing date, if one is set. */
  hearingOn?: string | null;
  /** For permits: when the permit expires (feeds the expiry tracker). */
  expiresOn?: string | null;
  /** Compact detail for the Public Records tab. */
  detail: Record<string, string | number | null>;
}

export interface SourceContext {
  lot: Lot;
  address: { house: string; street: string } | null;
  /** Building ids found by earlier sources this run (DOB complaints are filed by BIN). */
  bins: string[];
  /** ACRIS: document ids found by the Legals step. */
  documentIds?: string[];
}

export interface SourceQuery {
  $where: string;
  $order?: string;
  $limit: number;
  $select?: string;
  /** Stop after this many rows (default: everything, up to the client's cap). */
  maxRows?: number;
}

export interface SourceDef {
  key: string;
  label: string;
  dataset: string;
  /** Columns the mapping reads: checked against live metadata each run. */
  columns: string[];
  /** Null when this lot can't be looked up here (no address, no BINs…). */
  query(ctx: SourceContext): SourceQuery | null;
  map(row: Record<string, unknown>, ctx: SourceContext): RecordItem | null;
}

const s = (v: unknown): string | null => (v === undefined || v === null || v === "" ? null : String(v).trim() || null);

/** "2025-10-07T00:00:00.000", "20090413", "06/17/2020" → "2025-10-07". */
export function isoDate(v: unknown): string | null {
  const t = s(v);
  if (!t) return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(t);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(t);
  if (m) return `${m[3]}-${m[1]}-${m[2]}`;
  return null;
}

/** Whole cents from a Socrata money string ("200.00", "$1,250.00"). */
export function toCents(v: unknown): number {
  const t = s(v)?.replace(/[$,\s]/g, "");
  if (!t || !/^-?\d+(\.\d+)?$/.test(t)) return 0;
  const [whole, frac = ""] = t.replace("-", "").split(".");
  const cents = Number(whole) * 100 + Number((frac + "00").slice(0, 2));
  return t.startsWith("-") ? -cents : cents;
}

const row = (dataset: string, field: string, value: string) => `https://data.cityofnewyork.us/resource/${dataset}.json?${field}=${encodeURIComponent(value)}`;
const bisProfile = (l: Lot) => `https://a810-bisweb.nyc.gov/bisweb/PropertyProfileOverviewServlet?boro=${l.boro}&block=${pad(l.block, 5)}&lot=${pad(l.lot, 5)}`;

/** DOB complaint dispositions that put a stop-work or vacate order in force (from dataset 6v9u-ndjg). */
export const ORDER_IN_FORCE_CODES = new Set(["A3", "L1", "H5", "K4", "Y1", "Y3", "ME", "MF", "MH", "MI"]);
export const ORDER_LABEL: Record<string, string> = {
  A3: "Full stop-work order",
  L1: "Partial stop-work order",
  H5: "Stop all work order",
  K4: "Crane stop-work order",
  Y1: "Full vacate order",
  Y3: "Partial vacate order",
  ME: "Full vacate order",
  MH: "Full vacate order",
  MF: "Partial vacate order",
  MI: "Partial vacate order",
  L2: "Stop-work order rescinded",
  L3: "Stop-work order partly rescinded",
  Y2: "Vacate order rescinded",
  Y4: "Vacate order partly rescinded",
};

/** Recording types worth an alert (brief §10: lis pendens, mortgages, deeds…); others are listed quietly. */
export const NOTABLE_DOC_TYPES: Record<string, string> = {
  DEED: "Deed",
  DEEDO: "Deed",
  MTGE: "Mortgage",
  AGMT: "Mortgage agreement",
  ASST: "Assignment of mortgage",
  SAT: "Satisfaction of mortgage",
  "AL&R": "Assignment of leases and rents",
  LP: "Lis pendens",
  "LP-A": "Lis pendens",
  JUDG: "Judgment",
  FL: "Federal lien",
  MECHANIC: "Mechanic's lien",
  "M&CON": "Mortgage consolidation",
  UCC1: "UCC financing statement",
  RPTT: "Transfer tax return",
};

export const SOURCES: SourceDef[] = [
  {
    key: "dobnow_jobs",
    label: "DOB NOW job filings",
    dataset: "w9ak-ipjd",
    columns: ["job_filing_number", "filing_status", "job_type", "job_description", "filing_date", "current_status_date", "bin", "bbl"],
    query: (c) => ({ $where: `bbl=${q(c.lot.bbl)}`, $order: "filing_date DESC", $limit: 200 }),
    map: (r) => {
      const id = s(r.job_filing_number);
      if (!id) return null;
      return {
        key: id,
        kind: "job",
        title: `DOB NOW ${s(r.job_type) ?? "job"} ${id}`,
        status: s(r.filing_status),
        date: isoDate(r.filing_date),
        open: !/signed off|withdrawn|disapproved/i.test(s(r.filing_status) ?? ""),
        critical: false,
        url: row("w9ak-ipjd", "job_filing_number", id),
        detail: { description: s(r.job_description), bin: s(r.bin), statusDate: isoDate(r.current_status_date) },
      };
    },
  },
  {
    key: "bis_jobs",
    label: "DOB BIS jobs",
    dataset: "ic3t-wcy2",
    columns: ["job__", "doc__", "borough", "house__", "street_name", "job_type", "job_status_descrp", "latest_action_date", "job_description", "bin__"],
    // By address (brief §10): zero-padded block/lot returns nulls here, and the dataset's bbl column is unreliable.
    // Its dates are MM/DD/YYYY text, so rows page in dataset order.
    query: (c) => (c.address ? { $where: `house__=${q(c.address.house)} AND upper(street_name)=${q(c.address.street)} AND borough=${q(BORO_NAME[c.lot.boro])}`, $order: ":id", $limit: 500 } : null),
    map: (r) => {
      const job = s(r.job__);
      if (!job) return null;
      const doc = s(r.doc__) ?? "01";
      return {
        key: `${job}-${doc}`,
        kind: "job",
        title: `DOB ${s(r.job_type) ?? ""} job ${job}`.replace(/\s+/g, " "),
        status: s(r.job_status_descrp),
        date: isoDate(r.latest_action_date),
        open: !/signed off|withdrawn|disapproved/i.test(s(r.job_status_descrp) ?? ""),
        critical: false,
        url: `https://a810-bisweb.nyc.gov/bisweb/JobsQueryByNumberServlet?passjobnumber=${job}&passdocnumber=${doc}`,
        detail: { description: s(r.job_description), bin: s(r.bin__) },
      };
    },
  },
  {
    key: "bis_permits",
    label: "DOB permits (BIS)",
    dataset: "ipu4-2q9a",
    columns: ["permit_si_no", "job__", "borough", "block", "lot", "permit_status", "permit_type", "work_type", "issuance_date", "expiration_date", "bin__"],
    query: (c) => ({ $where: `borough=${q(BORO_NAME[c.lot.boro])} AND block=${q(pad(c.lot.block, 5))} AND lot=${q(pad(c.lot.lot, 5))}`, $order: ":id", $limit: 500 }),
    map: (r) => {
      const id = s(r.permit_si_no);
      if (!id) return null;
      const exp = isoDate(r.expiration_date);
      return {
        key: id,
        kind: "permit",
        title: `${s(r.permit_type) ?? ""} permit, job ${s(r.job__) ?? "?"}`.trim(),
        status: s(r.permit_status),
        date: isoDate(r.issuance_date),
        open: /issued|in process/i.test(s(r.permit_status) ?? ""),
        critical: false,
        url: row("ipu4-2q9a", "permit_si_no", id),
        expiresOn: exp,
        detail: { workType: s(r.work_type), expires: exp, bin: s(r.bin__) },
      };
    },
  },
  {
    key: "dobnow_permits",
    label: "DOB NOW permits",
    dataset: "rbx6-tga4",
    columns: ["work_permit", "sequence_number", "job_filing_number", "work_type", "permit_status", "issued_date", "expired_date", "job_description", "bin", "bbl"],
    query: (c) => ({ $where: `bbl=${q(c.lot.bbl)}`, $order: "issued_date DESC", $limit: 300 }),
    map: (r) => {
      const id = s(r.work_permit);
      if (!id) return null;
      const exp = isoDate(r.expired_date);
      return {
        key: `${id}#${s(r.sequence_number) ?? "0"}`,
        kind: "permit",
        title: `${s(r.work_type) ?? "Work"} permit ${id}`,
        status: s(r.permit_status),
        date: isoDate(r.issued_date),
        open: /issued/i.test(s(r.permit_status) ?? ""),
        critical: false,
        url: row("rbx6-tga4", "work_permit", id),
        expiresOn: exp,
        detail: { description: s(r.job_description), expires: exp, bin: s(r.bin) },
      };
    },
  },
  {
    key: "dob_violations",
    label: "DOB violations",
    dataset: "3h2n-5cm9",
    columns: ["isn_dob_bis_viol", "boro", "block", "lot", "issue_date", "violation_number", "violation_category", "violation_type", "description", "disposition_date", "bin"],
    query: (c) => ({ $where: `boro=${q(c.lot.boro)} AND block=${q(pad(c.lot.block, 5))} AND lot=${q(pad(c.lot.lot, 5))}`, $order: "issue_date DESC", $limit: 300 }),
    map: (r, c) => {
      const id = s(r.isn_dob_bis_viol);
      if (!id) return null;
      const cat = s(r.violation_category) ?? "";
      return {
        key: id,
        kind: "violation",
        title: `DOB violation ${s(r.violation_number) ?? id}`,
        status: cat,
        date: isoDate(r.issue_date),
        open: /ACTIVE/i.test(cat),
        critical: false,
        url: bisProfile(c.lot),
        detail: { type: s(r.violation_type)?.split(/\s{2,}/)[0] ?? null, description: s(r.description), bin: s(r.bin), closedOn: isoDate(r.disposition_date) },
      };
    },
  },
  {
    key: "ecb_violations",
    label: "ECB violations",
    dataset: "6bgk-3dad",
    // Block 5 digits, lot 4 (checked live).
    columns: ["ecb_violation_number", "ecb_violation_status", "boro", "block", "lot", "issue_date", "hearing_date", "severity", "violation_description", "hearing_status", "certification_status", "bin"],
    query: (c) => ({ $where: `boro=${q(c.lot.boro)} AND block=${q(pad(c.lot.block, 5))} AND lot=${q(pad(c.lot.lot, 4))}`, $order: "issue_date DESC", $limit: 300 }),
    map: (r) => {
      const id = s(r.ecb_violation_number);
      if (!id) return null;
      const status = s(r.ecb_violation_status);
      return {
        key: id,
        kind: "violation",
        title: `ECB violation ${id}`,
        status: [status, s(r.hearing_status), s(r.certification_status)].filter(Boolean).join(" · ") || null,
        date: isoDate(r.issue_date),
        open: status === "ACTIVE",
        critical: false,
        url: `https://a810-bisweb.nyc.gov/bisweb/ECBQueryByNumberServlet?ecbin=${id}`,
        hearingOn: isoDate(r.hearing_date),
        detail: { severity: s(r.severity), description: s(r.violation_description), hearing: s(r.hearing_status), certification: s(r.certification_status), bin: s(r.bin) },
      };
    },
  },
  {
    key: "dob_safety",
    label: "DOB safety violations",
    dataset: "855j-jady",
    columns: ["violation_number", "violation_issue_date", "violation_type", "violation_remarks", "violation_status", "bin", "bbl"],
    query: (c) => ({ $where: `bbl=${q(c.lot.bbl)}`, $order: "violation_issue_date DESC", $limit: 200 }),
    map: (r) => {
      const id = s(r.violation_number);
      if (!id) return null;
      return {
        key: id,
        kind: "violation",
        title: `DOB safety violation ${id}`,
        status: s(r.violation_status),
        date: isoDate(r.violation_issue_date),
        open: /active|open/i.test(s(r.violation_status) ?? ""),
        critical: false,
        url: row("855j-jady", "violation_number", id),
        detail: { type: s(r.violation_type), description: s(r.violation_remarks), bin: s(r.bin) },
      };
    },
  },
  {
    key: "hpd_violations",
    label: "HPD violations",
    dataset: "wvxf-dwi5",
    columns: ["violationid", "class", "novdescription", "novissueddate", "currentstatus", "violationstatus", "bin", "bbl"],
    query: (c) => ({ $where: `bbl=${q(c.lot.bbl)}`, $order: "novissueddate DESC", $limit: 300 }),
    map: (r) => {
      const id = s(r.violationid);
      if (!id) return null;
      return {
        key: id,
        kind: "violation",
        title: `HPD class ${s(r.class) ?? "?"} violation ${id}`,
        status: s(r.currentstatus),
        date: isoDate(r.novissueddate),
        open: s(r.violationstatus) === "Open",
        critical: false,
        url: row("wvxf-dwi5", "violationid", id),
        detail: { description: s(r.novdescription), bin: s(r.bin) },
      };
    },
  },
  {
    key: "hpd_vacate",
    label: "HPD vacate orders",
    dataset: "tb8q-a3ar",
    columns: ["vacate_order_number", "primary_vacate_reason", "vacate_type", "vacate_effective_date", "actual_rescind_date", "bin", "bbl"],
    query: (c) => ({ $where: `bbl=${q(c.lot.bbl)}`, $order: ":id", $limit: 50 }),
    map: (r) => {
      const id = s(r.vacate_order_number);
      if (!id) return null;
      const rescinded = isoDate(r.actual_rescind_date);
      return {
        key: id,
        kind: "vacate",
        title: `HPD ${(s(r.vacate_type) ?? "").toLowerCase()} vacate order ${id}`.replace(/\s+/g, " "),
        status: rescinded ? "Rescinded" : "In force",
        date: isoDate(r.vacate_effective_date),
        open: !rescinded,
        critical: !rescinded,
        url: row("tb8q-a3ar", "vacate_order_number", id),
        detail: { reason: s(r.primary_vacate_reason), rescinded, bin: s(r.bin) },
      };
    },
  },
  {
    key: "fdny_vacate",
    label: "FDNY vacate list",
    dataset: "n5xc-7jfa",
    columns: ["description", "vac_date", "status_change_date", "bin", "bbl"],
    query: (c) => ({ $where: `bbl=${q(c.lot.bbl)}`, $order: ":id", $limit: 50 }),
    map: (r) => {
      const vac = isoDate(r.vac_date);
      const bin = s(r.bin);
      if (!vac) return null;
      const desc = s(r.description) ?? "";
      const inForce = !/dismiss|rescind/i.test(desc);
      return {
        key: `${bin ?? "lot"}-${vac}`,
        kind: "vacate",
        title: `FDNY vacate order (${desc || "status unknown"})`,
        status: desc || null,
        date: vac,
        open: inForce,
        critical: inForce,
        url: row("n5xc-7jfa", "bbl", String(r.bbl ?? "")),
        detail: { changed: isoDate(r.status_change_date), bin },
      };
    },
  },
  {
    key: "dob_complaints",
    label: "DOB complaints",
    dataset: "eabe-havv",
    columns: ["complaint_number", "status", "date_entered", "house_number", "house_street", "bin", "complaint_category", "disposition_code", "disposition_date"],
    query: (c) => {
      const parts = [];
      if (c.bins.length) parts.push(`bin in (${c.bins.slice(0, 20).map(q).join(",")})`);
      if (c.address) parts.push(`(house_number=${q(c.address.house)} AND upper(house_street)=${q(c.address.street)})`);
      return parts.length ? { $where: parts.join(" OR "), $order: ":id", $limit: 500 } : null;
    },
    map: (r) => {
      const id = s(r.complaint_number);
      if (!id) return null;
      const code = s(r.disposition_code);
      const order = code ? ORDER_LABEL[code] : undefined;
      return {
        key: id,
        kind: "complaint",
        title: order ? `${order} (complaint ${id})` : `DOB complaint ${id}`,
        status: [s(r.status), code].filter(Boolean).join(" · ") || null,
        date: isoDate(r.date_entered),
        open: s(r.status) !== "CLOSED",
        // A candidate only: resolveComplaintOrders decides whether it's still in force.
        critical: !!code && ORDER_IN_FORCE_CODES.has(code),
        url: `https://a810-bisweb.nyc.gov/bisweb/OverviewForComplaintServlet?complaintno=${id}`,
        detail: { category: s(r.complaint_category), disposition: order ?? code, dispositionCode: code, dispositionDate: isoDate(r.disposition_date), bin: s(r.bin) },
      };
    },
  },
  {
    key: "oath",
    label: "OATH hearings",
    dataset: "jz4z-kudi",
    // Block 5 digits, lot 4 (checked live).
    columns: ["ticket_number", "issuing_agency", "violation_date", "violation_location_borough", "violation_location_block_no", "violation_location_lot_no", "hearing_status", "hearing_result", "hearing_date", "violation_description", "compliance_status"],
    query: (c) => ({
      $where: `violation_location_borough=${q(BORO_NAME[c.lot.boro])} AND violation_location_block_no=${q(pad(c.lot.block, 5))} AND violation_location_lot_no=${q(pad(c.lot.lot, 4))}`,
      $order: "violation_date DESC",
      $limit: 200,
    }),
    map: (r) => {
      const id = s(r.ticket_number);
      if (!id) return null;
      const result = s(r.hearing_result);
      return {
        key: id,
        kind: "hearing",
        title: `OATH summons ${id}${s(r.issuing_agency) ? ` (${s(r.issuing_agency)})` : ""}`,
        status: [s(r.hearing_status), result].filter(Boolean).join(" · ") || null,
        date: isoDate(r.violation_date),
        open: !result || /pending|adjourn|rescheduled/i.test(`${s(r.hearing_status)} ${result}`),
        critical: false,
        url: row("jz4z-kudi", "ticket_number", id),
        hearingOn: isoDate(r.hearing_date),
        detail: { description: s(r.violation_description), compliance: s(r.compliance_status) },
      };
    },
  },
  {
    key: "sr311",
    label: "311 reports",
    dataset: "erm2-nwe9",
    columns: ["unique_key", "created_date", "closed_date", "agency", "complaint_type", "descriptor", "status", "resolution_description", "bbl"],
    // The last two years is plenty for "what's happening at the site".
    query: (c) => ({ $where: `bbl=${q(c.lot.bbl)} AND created_date > '${twoYearsAgo()}'`, $order: "created_date DESC", $limit: 200 }),
    map: (r) => {
      const id = s(r.unique_key);
      if (!id) return null;
      return {
        key: id,
        kind: "sr311",
        title: `311: ${s(r.complaint_type) ?? "report"}${s(r.descriptor) ? ` (${s(r.descriptor)})` : ""}`,
        status: s(r.status),
        date: isoDate(r.created_date),
        open: s(r.status) !== "Closed",
        critical: false,
        url: row("erm2-nwe9", "unique_key", id),
        detail: { agency: s(r.agency), resolution: s(r.resolution_description), closed: isoDate(r.closed_date) },
      };
    },
  },
  {
    key: "tax_lien",
    label: "Tax lien sale list",
    dataset: "9rz4-mjek",
    columns: ["month", "cycle", "borough", "block", "lot", "water_debt_only"],
    query: (c) => ({ $where: `borough=${q(c.lot.boro)} AND block=${q(String(c.lot.block))} AND lot=${q(String(c.lot.lot))}`, $order: "month DESC", $limit: 50 }),
    map: (r) => {
      const month = isoDate(r.month);
      if (!month) return null;
      return {
        key: `${month}-${s(r.cycle) ?? ""}`,
        kind: "lien",
        title: `On the tax lien sale list (${s(r.cycle) ?? "notice"})`,
        status: s(r.cycle),
        date: month,
        open: true,
        critical: false,
        url: row("9rz4-mjek", "block", String(r.block ?? "")),
        detail: { waterDebtOnly: s(r.water_debt_only) },
      };
    },
  },
  {
    key: "dof_charges",
    label: "DOF property charges",
    dataset: "scjx-j6np",
    columns: ["parid", "code", "taxyear", "sum_bal", "due_date", "dt_pd_begin", "dt_pd_end"],
    query: (c) => ({ $where: `parid=${q(c.lot.bbl)} AND sum_bal > 0`, $order: "due_date DESC", $limit: 300 }),
    // Rolled up into one "arrears" record by summarizeCharges (rows are per charge period).
    map: () => null,
  },
  {
    key: "acris_legals",
    label: "ACRIS property records",
    dataset: "8h5j-fqxa",
    columns: ["document_id", "borough", "block", "lot", "good_through_date"],
    // Step 1 of 2 (brief §10): legals by lot (unpadded, borough as a string) → document ids.
    // Document ids start with the recording date, so newest first is stable night to night.
    query: (c) => ({ $where: `borough=${q(c.lot.boro)} AND block=${q(String(c.lot.block))} AND lot=${q(String(c.lot.lot))}`, $order: "document_id DESC", $limit: 60, maxRows: 60 }),
    map: () => null,
  },
  {
    key: "acris_master",
    label: "ACRIS recordings",
    dataset: "bnx9-e6tj",
    columns: ["document_id", "doc_type", "document_date", "recorded_datetime", "good_through_date"],
    // Step 2 of 2: master records for the documents found in step 1.
    query: (c) => (c.documentIds?.length ? { $where: `document_id in (${c.documentIds.slice(0, 60).map(q).join(",")})`, $order: "document_id DESC", $limit: 60 } : null),
    map: (r) => {
      const id = s(r.document_id);
      if (!id) return null;
      const type = s(r.doc_type) ?? "DOC";
      return {
        key: id,
        kind: "recording",
        title: `${NOTABLE_DOC_TYPES[type] ?? type} recorded`,
        status: type,
        date: isoDate(r.recorded_datetime) ?? isoDate(r.document_date),
        open: false,
        critical: false,
        url: `https://a836-acris.nyc.gov/DS/DocumentSearch/DocumentDetail?doc_id=${id}`,
        detail: { docType: type, documentDate: isoDate(r.document_date), goodThrough: isoDate(r.good_through_date) },
      };
    },
  },
];

export const SOURCE_BY_KEY = new Map(SOURCES.map((d) => [d.key, d]));

/** How long an order is presumed in force without a later rescission (older ones are history). */
export const ORDER_MAX_AGE_DAYS = 730;

/**
 * DOB complaints carry the order history of a building: only the latest
 * order event per building counts, it must not have been rescinded since,
 * and it must be recent. Everything else is history, not an order in force.
 */
export function resolveComplaintOrders(items: RecordItem[], today: string): RecordItem[] {
  const latest = new Map<string, { item: RecordItem; when: string }>();
  for (const i of items) {
    const code = String(i.detail.dispositionCode ?? "");
    if (!ORDER_LABEL[code]) continue;
    const bin = String(i.detail.bin ?? "lot");
    const when = String(i.detail.dispositionDate ?? i.date ?? "");
    const cur = latest.get(bin);
    if (!cur || when > cur.when) latest.set(bin, { item: i, when });
  }
  const inForce = new Set(
    [...latest.values()]
      .filter(({ item, when }) => ORDER_IN_FORCE_CODES.has(String(item.detail.dispositionCode)) && !!when && daysBetween(when, today) <= ORDER_MAX_AGE_DAYS)
      .map(({ item }) => item),
  );
  return items.map((i) => ({ ...i, critical: inForce.has(i), open: inForce.has(i) ? true : i.open }));
}

let clock: () => Date = () => new Date();
/** Tests pin "now" for the 311 window. */
export function setRecordsClockForTests(fn: (() => Date) | null) {
  clock = fn ?? (() => new Date());
}
function twoYearsAgo(): string {
  const d = clock();
  return `${d.getUTCFullYear() - 2}-${pad(d.getUTCMonth() + 1, 2)}-${pad(d.getUTCDate(), 2)}T00:00:00`;
}

/** DOF charges: one "arrears" record when anything past due has a balance (the amount stays in the tab, never in alerts). */
export function summarizeCharges(rows: Record<string, unknown>[], today: string, lot: Lot): RecordItem {
  const past = rows.filter((r) => toCents(r.sum_bal) > 0 && (isoDate(r.due_date) ?? "9999") < today);
  const cents = past.reduce((a, r) => a + toCents(r.sum_bal), 0);
  const oldest = past.map((r) => isoDate(r.due_date)!).sort()[0] ?? null;
  return {
    key: "arrears",
    kind: "tax",
    title: cents > 0 ? "Property tax or charges past due" : "No property charges past due",
    status: cents > 0 ? "arrears" : "current",
    date: oldest,
    open: cents > 0,
    critical: false,
    url: `https://a836-pts-access.nyc.gov/care/search/commonsearch.aspx?mode=persprop`,
    detail: { pastDueCents: cents, charges: past.length, oldestDue: oldest, bbl: lot.bbl },
  };
}

export type AlertKind = "new" | "status" | "critical" | "resolved";

export interface RecordAlert {
  kind: AlertKind;
  item: RecordItem;
  critical: boolean;
  title: string;
  /** Stable per change, so a re-run never raises it twice. */
  dedupeKey: string;
  previousStatus?: string | null;
}

export interface KnownRecord {
  key: string;
  status: string | null;
  critical: boolean;
  open: boolean;
}

/** What counts as news, per kind (brief §10). */
function newsworthyNew(i: RecordItem, today?: string): string | null {
  switch (i.kind) {
    case "job":
      return `New DOB filing: ${i.title}`;
    case "permit":
      return i.open ? `Permit issued: ${i.title}` : null;
    case "violation":
      return i.open ? `New violation: ${i.title}` : null;
    case "complaint":
      return `New DOB complaint: ${i.title}`;
    case "sr311":
      return `New ${i.title}`;
    case "recording":
      // Old documents surfacing late (the extract is re-cut) aren't news.
      if (today && i.date && daysBetween(i.date, today) > 365) return null;
      return NOTABLE_DOC_TYPES[i.status ?? ""] ? `New ACRIS recording: ${i.title}` : null;
    case "lien":
      return "The lot is on the tax lien sale list";
    case "tax":
      return i.open ? "Property tax or charges are past due" : null;
    case "hearing":
      return i.open ? `New OATH summons: ${i.title}` : null;
    case "vacate":
      return i.open ? `Vacate order: ${i.title}` : null;
  }
}

/**
 * Compare this run's records with what was stored. On the first run for a
 * source (`baseline`) only orders in force raise alerts: the rest is
 * history, not news.
 */
export function diffRecords(known: Map<string, KnownRecord>, items: RecordItem[], sourceKey: string, baseline: boolean, today?: string): RecordAlert[] {
  const out: RecordAlert[] = [];
  for (const i of items) {
    const prev = known.get(i.key);
    const dk = (suffix: string) => `${sourceKey}:${i.key}:${suffix}`;
    if (i.critical && (!prev || !prev.critical)) {
      out.push({ kind: "critical", item: i, critical: true, title: `CRITICAL: ${i.title}`, dedupeKey: dk(`critical:${i.status ?? ""}:${i.detail.dispositionDate ?? i.date ?? ""}`) });
      continue;
    }
    if (baseline) continue;
    if (!prev) {
      const title = newsworthyNew(i, today);
      if (title) out.push({ kind: "new", item: i, critical: false, title, dedupeKey: dk("new") });
      continue;
    }
    if ((prev.status ?? "") !== (i.status ?? "")) {
      if (prev.open && !i.open && (i.kind === "violation" || i.kind === "vacate" || i.kind === "hearing" || i.kind === "tax")) {
        out.push({ kind: "resolved", item: i, critical: false, title: `Resolved: ${i.title} (${i.status ?? "closed"})`, dedupeKey: dk(`resolved:${i.status ?? ""}`), previousStatus: prev.status });
      } else if (i.kind === "tax" && i.open) {
        out.push({ kind: "new", item: i, critical: false, title: "Property tax or charges are past due", dedupeKey: dk(`arrears:${i.date ?? ""}`), previousStatus: prev.status });
      } else if (i.kind !== "sr311" && i.kind !== "recording") {
        out.push({ kind: "status", item: i, critical: false, title: `${i.title}: ${prev.status ?? "—"} → ${i.status ?? "—"}`, dedupeKey: dk(`status:${i.status ?? ""}`), previousStatus: prev.status });
      }
    }
  }
  return out;
}

/** Violation lifecycle (brief §10): issued → OATH hearing → fixed → certificate of correction → dismissed or paid. */
export const VIOLATION_STAGES = [
  { key: "issued", label: "Issued" },
  { key: "hearing", label: "Hearing scheduled" },
  { key: "fixed", label: "Fixed" },
  { key: "correction_filed", label: "Certificate of correction filed" },
  { key: "dismissed", label: "Dismissed" },
  { key: "paid", label: "Paid" },
  { key: "resolved", label: "Resolved" },
] as const;
export type ViolationStage = (typeof VIOLATION_STAGES)[number]["key"];
export const CLOSED_STAGES: ViolationStage[] = ["dismissed", "paid", "resolved"];

/** Where the source puts a violation now, when it says anything decisive. Manual stages in between are kept. */
export function sourceStage(i: RecordItem): ViolationStage | null {
  if (i.kind !== "violation" && i.kind !== "hearing") return null;
  const text = `${i.status ?? ""} ${Object.values(i.detail).join(" ")}`.toUpperCase();
  if (!i.open) return /DISMISS/.test(text) ? "dismissed" : /PAID|WRITTEN OFF/.test(text) ? "paid" : "resolved";
  if (/CERTIFICATE (ACCEPTED|PENDING)|CURE ACCEPTED/.test(text)) return "correction_filed";
  if (i.hearingOn) return "hearing";
  return null;
}

/** Stage order for "never move backwards on a sync". */
export function stageRank(s: ViolationStage): number {
  return VIOLATION_STAGES.findIndex((x) => x.key === s);
}
