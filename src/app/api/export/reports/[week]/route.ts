import { TRPCError } from "@trpc/server";
import { formatMoney } from "@/core/money";
import { formatIsoDate } from "@/core/time";
import { authedContextFrom } from "@/server/request-context";
import { recordAudit } from "@/server/services/audit";
import { pdfResponse, renderPdf, type PdfSection } from "@/server/services/pdf";
import type { ReportTask, WeeklyReportData } from "@/server/services/weekly-report";
import { createCaller } from "@/server/trpc/root";

const $ = (c: number | null | undefined) => (c == null ? "-" : formatMoney(c, { whole: true }));
const d = (iso: string | null | undefined) => (iso ? formatIsoDate(iso, { month: "short", day: "numeric" }) : "");
const more = (shown: number, total: number, noun: string) => (total > shown ? [[`+ ${total - shown} ${noun}`, "", ""]] : []);
const rows = (items: ReportTask[], meta: (t: ReportTask) => string) => items.map((t) => [t.title, t.who ?? "", meta(t)]);

/**
 * The weekly owner report as a PDF (brief §7.8): a summary page, then one page
 * per project. `week` is a Monday (YYYY-MM-DD) or "live". Owner only.
 */
export async function GET(req: Request, ctx: RouteContext<"/api/export/reports/[week]">) {
  const { week } = await ctx.params;
  const c = await authedContextFrom(req);
  if (!c) return new Response("Sign in again", { status: 401 });
  const caller = createCaller(c);
  let r: WeeklyReportData;
  try {
    r = week === "live" ? await caller.reports.live() : await caller.reports.get({ weekOf: week });
  } catch (e) {
    if (e instanceof TRPCError) return new Response(e.code === "FORBIDDEN" ? "Only the owner can open the weekly report" : "Not found", { status: e.code === "FORBIDDEN" ? 403 : 404 });
    throw e;
  }

  const sections: PdfSection[] = [
    {
      heading: "This week across the portfolio",
      rows: [
        ["Active projects", String(r.totals.projects)],
        ["Tasks done last week", String(r.totals.completed)],
        ["Blocked now", String(r.totals.blocked)],
        ["Overdue now", String(r.totals.overdue)],
        ["Awaiting approval", String(r.totals.awaitingApproval)],
        ["Behind baseline", String(r.totals.behind)],
      ],
    },
    {
      heading: "Projects",
      table: {
        columns: ["Project", "Phase", "Progress", "Schedule", "Blocked", "Overdue"],
        widths: [150, 120, 55, 90, 44, 45],
        rows: r.projects.map((p) => [p.name, p.phase ?? "-", `${Math.round(p.progressBps / 100)}%`, p.slippageLabel ?? "-", String(p.stuck.blockedCount), String(p.stuck.overdueCount)]),
      },
    },
  ];

  for (const p of r.projects) {
    sections.push({
      heading: p.name,
      breakBefore: true,
      title: { subtitle: [p.address, p.bbl ? `BBL ${p.bbl}` : null, p.company].filter(Boolean).join(" - ") },
      rows: [
        ["Phase", `${p.phase ?? "No phase started"} (${p.phasesDone} of ${p.phasesTotal} phases done)${p.daysInPhase !== null ? `, ${p.daysInPhase} days in phase` : ""}`],
        ["Progress", `${Math.round(p.progressBps / 100)}%`],
        ["Schedule", p.slippageLabel ?? "No baseline yet"],
        ...(p.stuck.openViolations || p.stuck.ordersInForce ? ([["Public records", `${p.stuck.openViolations} open violation(s), ${p.stuck.ordersInForce} order(s) in force`]] as [string, string][]) : []),
      ],
    });
    const moved = [...p.moved.phases.map((x) => [`${x.change === "started" ? "Started" : "Finished"} ${x.name}`, "", d(x.on)]), ...rows(p.moved.completed, (t) => d(t.date)), ...more(p.moved.completed.length, p.moved.completedCount, "more done")];
    sections.push(moved.length ? { heading: "What moved", table: { columns: ["", "Who", "When"], widths: [330, 110, 64], rows: moved } } : { heading: "What moved", paragraphs: ["Nothing finished last week."] });
    const stuck = [
      ...rows(p.stuck.blocked, (t) => `Blocked${t.note ? `: ${t.note}` : ""}`),
      ...more(p.stuck.blocked.length, p.stuck.blockedCount, "more blocked"),
      ...rows(p.stuck.overdue, (t) => `Overdue, due ${d(t.date)}`),
      ...more(p.stuck.overdue.length, p.stuck.overdueCount, "more overdue"),
      ...rows(p.stuck.awaitingApproval, (t) => `Awaiting approval${t.date ? ` since ${d(t.date)}` : ""}`),
    ];
    sections.push(stuck.length ? { heading: "What's stuck", table: { columns: ["", "Who", "Why"], widths: [250, 100, 154], rows: stuck } } : { heading: "What's stuck", paragraphs: ["Nothing blocked or overdue."] });
    const next = [...p.next.keyDates.map((k) => [k.label, "Key date", d(k.date)]), ...rows(p.next.tasks, (t) => d(t.date)), ...more(p.next.tasks.length, p.next.tasksCount, "more due")];
    sections.push(next.length ? { heading: "Next 2 weeks", table: { columns: ["", "Who", "Due"], widths: [330, 110, 64], rows: next } } : { heading: "Next 2 weeks", paragraphs: ["Nothing due in the next two weeks."] });
    if (p.money) {
      sections.push({
        heading: "Headline financials",
        rows: [
          ["Purchase price", $(p.money.purchasePrice)],
          ["Budget", $(p.money.totalBudget)],
          ["Committed", $(p.money.committed)],
          ["Spent to date", $(p.money.spentToDate)],
          ["Forecast at completion", $(p.money.forecastAtCompletion)],
          ["Projected sellout", $(p.money.projectedSellout)],
          ["Profit", `${$(p.money.profit)}${p.money.marginBps != null ? ` (${(p.money.marginBps / 100).toFixed(1)}% margin)` : ""}`],
        ],
      });
    }
  }

  const label = week === "live" ? "So far this week" : `Week of ${formatIsoDate(r.weekOf, { month: "long", day: "numeric", year: "numeric" })}`;
  const bytes = await renderPdf({
    title: "Weekly owner report",
    subtitle: label,
    meta: `${formatIsoDate(r.from, { month: "short", day: "numeric" })} to ${formatIsoDate(r.weekOf, { month: "short", day: "numeric", year: "numeric" })}, and the two weeks after`,
    sections,
    footer: "Project Command - confidential",
  });
  // Every export is on the audit log (brief §4).
  await recordAudit(c.db, { actorId: c.viewer.id, actorName: c.viewer.name, action: "export", entityType: "weekly_report", entityId: r.weekOf, summary: `${c.viewer.name} downloaded the weekly report (${week === "live" ? "so far this week" : `week of ${week}`}) as a PDF`, ip: c.ip }).catch(() => undefined);
  return pdfResponse(bytes, `weekly-report-${week === "live" ? r.weekOf : week}.pdf`);
}
