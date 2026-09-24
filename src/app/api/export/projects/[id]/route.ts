import ExcelJS from "exceljs";
import { TRPCError } from "@trpc/server";
import { canGlobal } from "@/core/permissions";
import { categoryLabel, DRAW_STATUS_LABEL, UNIT_STATUS_LABEL } from "@/core/financials";
import { recordAudit } from "@/server/services/audit";
import { authedContextFrom } from "@/server/request-context";
import { createCaller } from "@/server/trpc/root";

/** Cents to a number of dollars for a spreadsheet cell (display only; all math stays in cents). */
const usd = (cents: number | null | undefined) => (cents == null ? null : cents / 100);
const MONEY = '"$"#,##0.00;[Red]-"$"#,##0.00';

/**
 * Excel export of one project's financials — owner only (brief §8).
 * Sheets: Summary, Budget, Commitments, Invoices, Change orders, Draws, Sales.
 */
export async function GET(req: Request, ctx: RouteContext<"/api/export/projects/[id]">) {
  const { id } = await ctx.params;
  const c = await authedContextFrom(req);
  if (!c) return new Response("Sign in again", { status: 401 });
  if (!canGlobal(c.actor, "export.excel")) return new Response("Not found", { status: 404 });
  let data;
  let project;
  try {
    const caller = createCaller(c);
    data = await caller.financials.overview({ projectId: id });
    project = await caller.projects.get({ projectId: id });
  } catch (e) {
    if (e instanceof TRPCError) return new Response("Not found", { status: 404 });
    throw e;
  }
  const wb = new ExcelJS.Workbook();
  wb.creator = "Project Command";
  wb.created = new Date();
  const sheet = (name: string, cols: { header: string; key: string; width?: number; money?: boolean }[], rows: Record<string, unknown>[]) => {
    const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
    ws.columns = cols.map((col) => ({ header: col.header, key: col.key, width: col.width ?? (col.money ? 16 : 22), style: col.money ? { numFmt: MONEY } : {} }));
    ws.getRow(1).font = { bold: true };
    for (const r of rows) ws.addRow(r);
    return ws;
  };
  const h = data.headline;
  sheet(
    "Summary",
    [
      { header: "Figure", key: "k", width: 30 },
      { header: "Value", key: "v", width: 20 },
    ],
    [
      { k: "Project", v: project.name },
      { k: "Address", v: `${project.address}, ${project.borough ?? ""}` },
      { k: "BBL", v: project.bbl ?? "" },
      { k: "Purchase price", v: usd(h.purchasePrice) },
      { k: "Total project budget", v: usd(h.totalBudget) },
      { k: "Spent to date", v: usd(h.spentToDate) },
      { k: "Committed", v: usd(h.committed) },
      { k: "Forecast at completion", v: usd(h.forecastAtCompletion) },
      { k: "Projected sellout", v: usd(h.projectedSellout) },
      { k: "Profit", v: usd(h.profit) },
      { k: "Margin", v: h.marginBps == null ? null : h.marginBps / 10_000 },
      { k: "Equity required", v: usd(h.equityRequired) },
      { k: "Equity multiple", v: h.equityMultipleMilli == null ? null : h.equityMultipleMilli / 1000 },
    ],
  ).eachRow((row, n) => {
    const label = String(row.getCell(1).value);
    if (n > 1 && !["Project", "Address", "BBL", "Margin", "Equity multiple"].includes(label)) row.getCell(2).numFmt = MONEY;
    if (label === "Margin") row.getCell(2).numFmt = "0.0%";
    if (label === "Equity multiple") row.getCell(2).numFmt = '0.00"x"';
  });
  const m = { money: true };
  sheet(
    "Budget",
    [{ header: "Category", key: "cat" }, { header: "Line", key: "name", width: 30 }, { header: "Original", key: "original", ...m }, { header: "Approved changes", key: "approvedChanges", ...m }, { header: "Revised", key: "revised", ...m }, { header: "Committed", key: "committed", ...m }, { header: "Invoiced", key: "invoiced", ...m }, { header: "Paid", key: "paid", ...m }, { header: "Forecast", key: "forecast", ...m }, { header: "Variance", key: "variance", ...m }],
    data.lines.map((l) => ({ cat: categoryLabel(l.category), name: l.name, original: usd(l.totals.original), approvedChanges: usd(l.totals.approvedChanges), revised: usd(l.totals.revised), committed: usd(l.totals.committed), invoiced: usd(l.totals.invoiced), paid: usd(l.totals.paid), forecast: usd(l.totals.forecast), variance: usd(l.totals.variance) })),
  );
  sheet(
    "Commitments",
    [{ header: "Vendor", key: "vendor" }, { header: "Description", key: "desc", width: 36 }, { header: "Budget line", key: "line", width: 30 }, { header: "Status", key: "status" }, { header: "Signed", key: "signed" }, { header: "Amount", key: "amount", ...m }, { header: "Billed", key: "billed", ...m }, { header: "Retainage %", key: "ret" }],
    data.commitments.map((x) => ({ vendor: x.vendorName, desc: x.description ?? "", line: x.lineName ?? "", status: x.status, signed: x.signedOn ?? "", amount: usd(x.amountCents), billed: usd(x.billedCents), ret: x.retainageBps / 100 })),
  );
  sheet(
    "Invoices",
    [{ header: "Vendor", key: "vendor" }, { header: "Number", key: "num" }, { header: "Date", key: "date" }, { header: "Budget line", key: "line", width: 30 }, { header: "Amount", key: "amount", ...m }, { header: "Status", key: "status" }, { header: "Paid on", key: "paid" }, { header: "Draw", key: "draw" }],
    data.invoices.map((x) => ({ vendor: x.vendorName, num: x.number ?? "", date: x.invoiceDate ?? "", line: x.lineName ?? "", amount: usd(x.amountCents), status: x.status, paid: x.paidOn ?? "", draw: data.draws.find((d) => d.id === x.drawId)?.number ?? "" })),
  );
  sheet(
    "Change orders",
    [{ header: "#", key: "n", width: 6 }, { header: "Description", key: "desc", width: 40 }, { header: "Budget line", key: "line", width: 30 }, { header: "Amount", key: "amount", ...m }, { header: "Schedule days", key: "days" }, { header: "Status", key: "status" }],
    data.changeOrders.map((x) => ({ n: x.number, desc: x.description, line: x.lineName ?? "", amount: usd(x.amountCents), days: x.scheduleDays, status: x.status })),
  );
  sheet(
    "Draws",
    [{ header: "#", key: "n", width: 6 }, { header: "Period end", key: "period" }, { header: "Status", key: "status" }, { header: "Gross", key: "gross", ...m }, { header: "Retainage", key: "ret", ...m }, { header: "Net requested", key: "net", ...m }, { header: "Funded", key: "funded", ...m }, { header: "Lien waivers", key: "waivers" }, { header: "Inspector", key: "insp" }],
    data.draws.map((d) => ({ n: d.number, period: d.periodEnd ?? "", status: DRAW_STATUS_LABEL[d.status], gross: usd(d.totals.gross), ret: usd(d.totals.retainage), net: usd(d.totals.net), funded: usd(d.fundedCents), waivers: `${d.lienWaivers.filter((w) => w.received).length}/${d.lienWaivers.length}`, insp: d.inspectorSignedOn ? `${d.inspectorName ?? ""} ${d.inspectorSignedOn}`.trim() : "" })),
  );
  sheet(
    "Sales",
    [{ header: "Unit", key: "unit", width: 10 }, { header: "Floor", key: "floor", width: 8 }, { header: "SF", key: "sf", width: 8 }, { header: "Beds", key: "beds", width: 8 }, { header: "Baths", key: "baths", width: 8 }, { header: "Ask", key: "ask", ...m }, { header: "Ask $/sf", key: "askSf", ...m }, { header: "Contract", key: "contract", ...m }, { header: "Contract $/sf", key: "cSf", ...m }, { header: "Status", key: "status" }, { header: "Closing", key: "closing" }],
    data.units.map((u) => ({ unit: u.unit, floor: u.floor ?? "", sf: u.sf, beds: u.beds, baths: u.baths, ask: usd(u.askCents), askSf: usd(u.askPerSf), contract: usd(u.contractCents), cSf: usd(u.contractPerSf), status: UNIT_STATUS_LABEL[u.status], closing: u.closingOn ?? "" })),
  );
  const buf = await wb.xlsx.writeBuffer();
  await recordAudit(c.db, { actorId: c.viewer.id, actorName: c.viewer.name, action: "export", entityType: "project_headline", entityId: id, projectId: id, summary: `${c.viewer.name} exported the financials to Excel`, ip: c.ip }).catch(() => undefined);
  const name = `${project.name.replace(/[^\w\- ]+/g, "").trim() || "project"} financials.xlsx`;
  return new Response(buf as ArrayBuffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      "Cache-Control": "private, no-store",
    },
  });
}
