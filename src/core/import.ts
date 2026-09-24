/**
 * Module N: Excel / CSV import. Pure: CSV parsing, column mapping, and
 * row-by-row validation shared by the preview (in the browser) and the
 * import itself (on the server), so what the preview accepts is exactly
 * what gets imported. Nothing is dropped silently: every row is either
 * valid or rejected with its reasons.
 */
import { BUDGET_CATEGORIES } from "./financials";
import { BOROUGHS, PROJECT_TYPE_LABEL } from "./labels";
import { MoneyError, parseMoney } from "./money";
import { EXPOSURES, OUTDOOR_TYPES } from "./units";
import { VENDOR_KIND_LABEL } from "./directory";

export const IMPORT_KINDS = [
  "projects",
  "budget",
  "units",
  "vendors",
  "template",
] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

export const IMPORT_KIND_LABEL: Record<ImportKind, string> = {
  projects: "Projects",
  budget: "Budget lines (one project)",
  units: "Unit schedule (one project)",
  vendors: "Vendor directory",
  template: "Checklist template",
};

export const MAX_IMPORT_ROWS = 500;
/** Projects each build a whole checklist, so a project import is smaller (it has to finish inside one request). */
export const MAX_PROJECT_IMPORT_ROWS = 50;
/** The largest upload the parser takes (the platform refuses request bodies over 4.5 MB). */
export const MAX_IMPORT_FILE_BYTES = 4 * 1024 * 1024;
/** An .xlsx is a zip: its unpacked size is capped too, so a tiny file can't unpack into gigabytes. */
export const MAX_XLSX_UNPACKED_BYTES = 60 * 1024 * 1024;

/** One sheet, ready to map: its header, data rows, and each data row's line number in the file. */
export interface ImportSheet {
  name: string;
  headers: string[];
  rows: string[][];
  /** The sheet row number of each entry in `rows` (1-based, as the spreadsheet shows it). */
  rowNumbers: number[];
  /** Data rows in the sheet, even past the import limit. */
  total: number;
}

/**
 * The header and data rows of a grid (row i is sheet row i + 1). Leading
 * blank rows are skipped, the first non-blank row is the header, blank spacer
 * rows are dropped, and rows past the limit are counted but not kept.
 */
export function sheetFromGrid(
  name: string,
  grid: readonly (readonly string[] | undefined)[],
  maxCols = 60,
  limit = MAX_IMPORT_ROWS,
): ImportSheet | null {
  const clean = (r: readonly string[] | undefined) =>
    (r ?? []).slice(0, maxCols).map((c) => c.trim());
  const blank = (r: readonly string[]) => !r.some((c) => c !== "");
  const headerIdx = grid.findIndex((r) => !blank(clean(r)));
  if (headerIdx < 0) return null;
  const rows: string[][] = [];
  const rowNumbers: number[] = [];
  let total = 0;
  for (let i = headerIdx + 1; i < grid.length; i++) {
    const r = clean(grid[i]);
    if (blank(r)) continue;
    total++;
    if (rows.length < limit) {
      rows.push(r);
      rowNumbers.push(i + 1);
    }
  }
  return { name, headers: clean(grid[headerIdx]), rows, rowNumbers, total };
}

/**
 * The total unpacked size of a zip (from its central directory, without
 * unpacking anything); null when it isn't a readable zip. Zip64 archives
 * report Infinity (far too big for a spreadsheet import anyway).
 */
export function zipUnpackedSize(buf: Uint8Array): number | null {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const entries = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (entries === 0xffff || cdOffset === 0xffffffff) return Infinity;
  let at = cdOffset;
  let total = 0;
  for (let n = 0; n < entries; n++) {
    if (at + 46 > buf.length || view.getUint32(at, true) !== 0x02014b50)
      return null;
    const size = view.getUint32(at + 24, true);
    if (size === 0xffffffff) return Infinity;
    total += size;
    at +=
      46 +
      view.getUint16(at + 28, true) +
      view.getUint16(at + 30, true) +
      view.getUint16(at + 32, true);
  }
  return total;
}

/* ------------------------------------------------------------------ */
/* CSV                                                                 */
/* ------------------------------------------------------------------ */

/** RFC 4180 CSV: quoted fields, doubled quotes, commas and newlines inside quotes, CRLF or LF, a leading BOM. Blank lines are dropped. */
export function parseCsv(text: string): string[][] {
  return parseCsvRecords(text).filter((r) => r.some((c) => c.trim() !== ""));
}

/** Every CSV record, blank ones included (so record numbers match the file's rows). */
export function parseCsvRecords(text: string): string[][] {
  const s = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === "") quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/* ------------------------------------------------------------------ */
/* Fields                                                              */
/* ------------------------------------------------------------------ */

type Parsed = { ok: true; value: unknown } | { ok: false; error: string };
const ok = (value: unknown): Parsed => ({ ok: true, value });
const bad = (error: string): Parsed => ({ ok: false, error });

export interface ImportField {
  key: string;
  label: string;
  required?: boolean;
  /** Header words that map to this field without asking. */
  aliases: string[];
  parse: (raw: string) => Parsed;
  hint?: string;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

const text =
  (max: number): ImportField["parse"] =>
  (raw) =>
    raw.length > max ? bad(`longer than ${max} characters`) : ok(raw);
const int =
  (max = 100_000_000): ImportField["parse"] =>
  (raw) => {
    const s = raw.replace(/[,\s]/g, "").replace(/sf$/i, "");
    if (!/^\d+(\.0+)?$/.test(s)) return bad("isn't a whole number");
    const n = Math.round(Number(s));
    return n > max ? bad("looks too large") : ok(n);
  };
const decimal =
  (max: number): ImportField["parse"] =>
  (raw) => {
    const s = raw.replace(/[,\s]/g, "");
    if (!/^\d+(\.\d+)?$/.test(s)) return bad("isn't a number");
    const n = Math.round(Number(s) * 100) / 100;
    return n > max ? bad("looks too large") : ok(n);
  };
const halves = (raw: string): Parsed => {
  const s = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return bad("isn't a number");
  const n = Number(s);
  return n * 2 !== Math.round(n * 2) || n > 20
    ? bad("should be whole or half numbers, up to 20")
    : ok(n);
};
const money = (raw: string): Parsed => {
  try {
    const c = parseMoney(raw.replace(/\s/g, ""));
    return c < 0 ? bad("can't be negative") : ok(c);
  } catch (e) {
    return bad(e instanceof MoneyError ? "isn't an amount" : "isn't an amount");
  }
};
/** Matches a list by key or label, ignoring case and punctuation. */
const oneOf =
  (
    options: readonly { key: string; label: string }[],
    what: string,
  ): ImportField["parse"] =>
  (raw) => {
    const n = norm(raw);
    const hit = options.find((o) => norm(o.key) === n || norm(o.label) === n);
    return hit
      ? ok(hit.key)
      : bad(
          `isn't a known ${what} (${options.map((o) => o.label).join(", ")})`,
        );
  };
const yesNo = (raw: string): Parsed => {
  const n = norm(raw);
  if (["y", "yes", "true", "1", "x"].includes(n)) return ok(true);
  if (["n", "no", "false", "0"].includes(n)) return ok(false);
  return bad("should be yes or no");
};
const email = (raw: string): Parsed =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) && raw.length <= 200
    ? ok(raw.toLowerCase())
    : bad("isn't an email address");
const bbl = (raw: string): Parsed => {
  const d = raw.replace(/\D/g, "");
  return /^[1-5]\d{9}$/.test(d) ? ok(d) : bad("isn't a 10-digit BBL");
};

const PROJECT_TYPES = Object.entries(PROJECT_TYPE_LABEL).map(
  ([key, label]) => ({ key, label }),
);
const BOROUGH_OPTS = BOROUGHS.map((b) => ({ key: b, label: b }));
const CATEGORY_OPTS = BUDGET_CATEGORIES.map((c) => ({
  key: c.key,
  label: c.label,
}));
const VENDOR_KIND_OPTS = Object.entries(VENDOR_KIND_LABEL).map(
  ([key, label]) => ({ key, label }),
);
const opts = (xs: readonly string[]) => xs.map((x) => ({ key: x, label: x }));

export const IMPORT_FIELDS: Record<ImportKind, ImportField[]> = {
  projects: [
    {
      key: "name",
      label: "Project name",
      required: true,
      aliases: ["name", "project", "projectname"],
      parse: text(160),
    },
    {
      key: "address",
      label: "Address",
      required: true,
      aliases: ["address", "streetaddress", "property"],
      parse: text(200),
    },
    {
      key: "borough",
      label: "Borough",
      aliases: ["borough", "boro"],
      parse: oneOf(BOROUGH_OPTS, "borough"),
      hint: "Blank means Brooklyn",
    },
    { key: "bbl", label: "BBL", aliases: ["bbl"], parse: bbl },
    {
      key: "type",
      label: "Project type",
      required: true,
      aliases: ["type", "projecttype", "strategy"],
      parse: oneOf(PROJECT_TYPES, "project type"),
    },
    {
      key: "lotAreaSqft",
      label: "Lot area (sf)",
      aliases: ["lotarea", "lotsf", "lotareasf"],
      parse: int(),
    },
    {
      key: "zoning",
      label: "Zoning",
      aliases: ["zoning", "zone"],
      parse: text(60),
    },
    {
      key: "residFar",
      label: "Residential FAR",
      aliases: ["residfar", "residentialfar", "far"],
      parse: decimal(99),
    },
    {
      key: "builtFar",
      label: "Built FAR",
      aliases: ["builtfar"],
      parse: decimal(99),
    },
    {
      key: "units",
      label: "Units",
      aliases: ["units", "unitcount"],
      parse: int(10_000),
    },
    {
      key: "grossSf",
      label: "Gross SF",
      aliases: ["grosssf", "gsf", "grosssquarefeet"],
      parse: int(),
    },
    {
      key: "sellableSf",
      label: "Sellable SF",
      aliases: ["sellablesf", "ssf", "netsellable"],
      parse: int(),
    },
    {
      key: "description",
      label: "Notes",
      aliases: ["notes", "description"],
      parse: text(2000),
    },
  ],
  budget: [
    {
      key: "category",
      label: "Category",
      required: true,
      aliases: ["category", "type", "costtype"],
      parse: oneOf(CATEGORY_OPTS, "category"),
    },
    {
      key: "name",
      label: "Line",
      required: true,
      aliases: ["line", "name", "item", "description"],
      parse: text(120),
    },
    {
      key: "originalCents",
      label: "Budget amount",
      required: true,
      aliases: ["amount", "budget", "original", "originalbudget"],
      parse: money,
    },
    {
      key: "notes",
      label: "Notes",
      aliases: ["notes", "comment"],
      parse: text(1000),
    },
  ],
  units: [
    {
      key: "unit",
      label: "Unit",
      required: true,
      aliases: ["unit", "unitno", "apt", "apartment"],
      parse: text(40),
    },
    {
      key: "floor",
      label: "Floor",
      aliases: ["floor", "level"],
      parse: text(20),
    },
    {
      key: "sf",
      label: "Square feet",
      aliases: ["sf", "sqft", "squarefeet", "size"],
      parse: int(1_000_000),
    },
    {
      key: "beds",
      label: "Bedrooms",
      aliases: ["beds", "bedrooms", "br"],
      parse: halves,
    },
    {
      key: "baths",
      label: "Bathrooms",
      aliases: ["baths", "bathrooms", "ba"],
      parse: halves,
    },
    {
      key: "exposure",
      label: "Exposure",
      aliases: ["exposure", "facing"],
      parse: oneOf(opts(EXPOSURES), "exposure"),
    },
    {
      key: "outdoorType",
      label: "Outdoor space",
      aliases: ["outdoor", "outdoorspace", "outdoortype"],
      parse: oneOf(opts(OUTDOOR_TYPES), "outdoor space"),
    },
    {
      key: "outdoorSf",
      label: "Outdoor sf",
      aliases: ["outdoorsf", "terracesf"],
      parse: int(100_000),
    },
    {
      key: "askCents",
      label: "Asking price",
      aliases: ["ask", "asking", "askingprice", "price", "list"],
      parse: money,
      hint: "Needs financial edit access",
    },
  ],
  vendors: [
    {
      key: "name",
      label: "Company",
      required: true,
      aliases: ["company", "name", "vendor", "companyname"],
      parse: text(160),
    },
    {
      key: "kind",
      label: "Kind",
      aliases: ["kind", "category"],
      parse: oneOf(VENDOR_KIND_OPTS, "kind"),
      hint: "Blank means Contractor",
    },
    {
      key: "trade",
      label: "Trade",
      aliases: ["trade", "role", "service"],
      parse: text(80),
    },
    {
      key: "phone",
      label: "Phone",
      aliases: ["phone", "tel", "telephone", "mobile"],
      parse: text(40),
    },
    {
      key: "email",
      label: "Email",
      aliases: ["email", "emailaddress"],
      parse: email,
    },
    {
      key: "website",
      label: "Website",
      aliases: ["website", "web", "url"],
      parse: text(200),
    },
    {
      key: "address",
      label: "Address",
      aliases: ["address"],
      parse: text(300),
    },
    {
      key: "rating",
      label: "Rating (1-5)",
      aliases: ["rating", "score"],
      parse: (raw) =>
        /^[1-5]$/.test(raw.trim()) ? ok(Number(raw)) : bad("should be 1 to 5"),
    },
    {
      key: "notes",
      label: "Notes",
      aliases: ["notes", "comments"],
      parse: text(4000),
    },
  ],
  template: [
    {
      key: "phase",
      label: "Phase",
      required: true,
      aliases: ["phase", "stage"],
      parse: text(80),
    },
    {
      key: "title",
      label: "Task",
      required: true,
      aliases: ["task", "title", "item", "step"],
      parse: text(200),
    },
    {
      key: "role",
      label: "Role",
      aliases: ["role", "owner", "responsible"],
      parse: text(60),
      hint: "Blank means PM",
    },
    {
      key: "days",
      label: "Due (days)",
      aliases: ["days", "due", "duedays", "duration"],
      parse: int(3650),
      hint: "From the phase start (or the prerequisite); blank means 5",
    },
    {
      key: "unit",
      label: "Business or calendar",
      aliases: ["unit", "daytype"],
      parse: oneOf(
        [
          { key: "business", label: "business" },
          { key: "calendar", label: "calendar" },
        ],
        "day type",
      ),
    },
    {
      key: "after",
      label: "After task",
      aliases: ["after", "dependson", "prerequisite", "follows"],
      parse: text(200),
      hint: "The title of a task it follows",
    },
    {
      key: "milestone",
      label: "Milestone",
      aliases: ["milestone"],
      parse: yesNo,
    },
    {
      key: "approval",
      label: "Needs approval",
      aliases: ["approval", "requiresapproval", "approve"],
      parse: yesNo,
    },
  ],
};

/** The column (index) each field most likely comes from, by header name; unmatched fields map to null. */
export function guessMapping(
  kind: ImportKind,
  headers: readonly string[],
): Record<string, number | null> {
  const used = new Set<number>();
  const out: Record<string, number | null> = {};
  for (const f of IMPORT_FIELDS[kind]) {
    const idx = headers.findIndex(
      (h, i) =>
        !used.has(i) &&
        (norm(h) === norm(f.label) || f.aliases.includes(norm(h))),
    );
    out[f.key] = idx >= 0 ? idx : null;
    if (idx >= 0) used.add(idx);
  }
  return out;
}

export interface ValidRow {
  /** 1-based row number in the sheet (the header is row 1). */
  row: number;
  values: Record<string, unknown>;
}
export interface RejectedRow {
  row: number;
  reasons: string[];
}

/** Check every data row against the fields; never drops a row without saying why. */
export function validateRows(
  kind: ImportKind,
  rows: readonly (readonly string[])[],
  mapping: Record<string, number | null>,
  rowNumbers?: readonly number[],
): { valid: ValidRow[]; rejected: RejectedRow[] } {
  const fields = IMPORT_FIELDS[kind];
  const valid: ValidRow[] = [];
  const rejected: RejectedRow[] = [];
  rows.forEach((cells, i) => {
    const row = rowNumbers?.[i] ?? i + 2;
    const values: Record<string, unknown> = {};
    const reasons: string[] = [];
    for (const f of fields) {
      const col = mapping[f.key];
      const raw = col == null ? "" : String(cells[col] ?? "").trim();
      if (raw === "") {
        if (f.required) reasons.push(`${f.label} is missing`);
        continue;
      }
      const p = f.parse(raw);
      if (p.ok) values[f.key] = p.value;
      else
        reasons.push(
          `${f.label} "${raw.length > 40 ? `${raw.slice(0, 40)}…` : raw}" ${p.error}`,
        );
    }
    if (reasons.length) rejected.push({ row, reasons });
    else valid.push({ row, values });
  });
  // Duplicates inside the file are rejected too (the second one onwards).
  const dupKey =
    kind === "units"
      ? "unit"
      : kind === "vendors"
        ? "name"
        : kind === "template"
          ? "title"
          : null;
  if (dupKey) {
    const seen = new Map<string, number>();
    for (const v of [...valid]) {
      const k =
        (kind === "template" ? `${norm(String(v.values.phase))}|` : "") +
        norm(String(v.values[dupKey]));
      const first = seen.get(k);
      if (first !== undefined) {
        valid.splice(valid.indexOf(v), 1);
        rejected.push({
          row: v.row,
          reasons: [
            `Same ${IMPORT_FIELDS[kind].find((f) => f.key === dupKey)!.label.toLowerCase()} as row ${first}`,
          ],
        });
      } else seen.set(k, v.row);
    }
  }
  rejected.sort((a, b) => a.row - b.row);
  return { valid, rejected };
}

/* ------------------------------------------------------------------ */
/* Templates                                                           */
/* ------------------------------------------------------------------ */

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 50) || "item";

/** Turn validated template rows into phases and tasks (phases in the order they first appear; "after" links by task title). */
export function buildTemplateParts(rows: readonly ValidRow[]): {
  phases: { key: string; name: string }[];
  tasks: {
    key: string;
    phaseKey: string;
    title: string;
    role: string;
    due: {
      days: number;
      unit: "business" | "calendar";
      from: "phase_start" | { task: string };
    };
    milestone?: boolean;
    requiresApproval?: boolean;
    approverRole?: string;
  }[];
  unresolved: RejectedRow[];
} {
  const phases: { key: string; name: string }[] = [];
  const phaseKey = new Map<string, string>();
  for (const r of rows) {
    const name = String(r.values.phase);
    if (!phaseKey.has(norm(name))) {
      let k = slug(name);
      while (phases.some((p) => p.key === k)) k = `${k}_2`;
      phaseKey.set(norm(name), k);
      phases.push({ key: k, name });
    }
  }
  const taskKeyByTitle = new Map<string, string>();
  const used = new Set<string>();
  const keyed = rows.map((r) => {
    let k = slug(String(r.values.title));
    while (used.has(k)) k = `${k}_2`.slice(-60);
    used.add(k);
    taskKeyByTitle.set(norm(String(r.values.title)), k);
    return { r, k };
  });
  const unresolved: RejectedRow[] = [];
  const tasks = keyed.flatMap(({ r, k }) => {
    const after = r.values.after
      ? taskKeyByTitle.get(norm(String(r.values.after)))
      : undefined;
    if (r.values.after && (!after || after === k)) {
      unresolved.push({
        row: r.row,
        reasons: [
          `After task "${String(r.values.after)}" isn't a task in this file`,
        ],
      });
      return [];
    }
    const due = {
      days: (r.values.days as number | undefined) ?? 5,
      unit: ((r.values.unit as string | undefined) ?? "business") as
        "business" | "calendar",
      from: after ? { task: after } : ("phase_start" as const),
    };
    return [
      {
        key: k,
        phaseKey: phaseKey.get(norm(String(r.values.phase)))!,
        title: String(r.values.title),
        role: (r.values.role as string | undefined) ?? "PM",
        due,
        ...(r.values.milestone ? { milestone: true } : {}),
        ...(r.values.approval
          ? { requiresApproval: true, approverRole: "Owner" }
          : {}),
      },
    ];
  });
  return { phases, tasks, unresolved };
}
