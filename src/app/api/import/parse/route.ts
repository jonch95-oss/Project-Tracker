import { MAX_IMPORT_ROWS, parseCsv } from "@/core/import";
import { authedContextFrom } from "@/server/request-context";

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_COLS = 60;
const MAX_SHEETS = 10;

type Sheet = { name: string; headers: string[]; rows: string[][]; total: number };

/** One cell as plain text: numbers unformatted, dates as YYYY-MM-DD, formulas as their result. */
function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "string") return v;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    const o = v as { result?: unknown; richText?: { text: string }[]; text?: string; hyperlink?: string };
    if ("result" in o) return cellText(o.result);
    if (o.richText) return o.richText.map((r) => r.text).join("");
    if (typeof o.text === "string") return o.text;
  }
  return String(v);
}

function sheetOf(name: string, grid: string[][]): Sheet | null {
  const rows = grid.map((r) => r.slice(0, MAX_COLS).map((c) => c.trim()));
  const headerIdx = rows.findIndex((r) => r.some((c) => c !== ""));
  if (headerIdx < 0) return null;
  const headers = rows[headerIdx]!;
  const body = rows.slice(headerIdx + 1).filter((r) => r.some((c) => c !== ""));
  return { name, headers, rows: body.slice(0, MAX_IMPORT_ROWS), total: body.length };
}

/**
 * Module N, step 1: read an uploaded .xlsx or .csv and hand back each
 * sheet's header row and data rows as plain text (nothing is saved). The
 * mapping, preview and import happen next, with counts at every step.
 */
export async function POST(req: Request) {
  const c = await authedContextFrom(req);
  if (!c) return Response.json({ error: "Sign in again" }, { status: 401 });
  if (c.actor.role !== "owner" && c.actor.role !== "admin") return Response.json({ error: "Imports are for owners and admins." }, { status: 403 });
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return Response.json({ error: "Choose a file." }, { status: 400 });
  if (file.size > MAX_BYTES) return Response.json({ error: "That file is over 5 MB. Split it, or save just the sheet you need." }, { status: 400 });
  const name = file.name.toLowerCase();
  try {
    let sheets: Sheet[] = [];
    if (name.endsWith(".csv") || file.type === "text/csv") {
      const s = sheetOf(file.name.replace(/\.csv$/i, ""), parseCsv(await file.text()));
      sheets = s ? [s] : [];
    } else if (name.endsWith(".xlsx")) {
      const { default: ExcelJS } = await import("exceljs");
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(Buffer.from(await file.arrayBuffer()) as never);
      for (const ws of wb.worksheets.slice(0, MAX_SHEETS)) {
        const grid: string[][] = [];
        ws.eachRow({ includeEmpty: true }, (row, n) => {
          if (n > MAX_IMPORT_ROWS + 50) return;
          const cells: string[] = [];
          const values = row.values as unknown[];
          for (let i = 1; i < Math.min(values.length, MAX_COLS + 1); i++) cells.push(cellText(values[i]));
          grid[n - 1] = cells;
        });
        const s = sheetOf(ws.name, Array.from(grid, (r) => r ?? []));
        if (s) sheets.push(s);
      }
    } else {
      return Response.json({ error: "Use an Excel .xlsx or a .csv file. (Older .xls files: open and save as .xlsx first.)" }, { status: 400 });
    }
    if (sheets.length === 0) return Response.json({ error: "That file has no rows." }, { status: 400 });
    return Response.json({ fileName: file.name, sheets }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Couldn't read that file. Is it a real .xlsx or .csv?" }, { status: 400 });
  }
}
