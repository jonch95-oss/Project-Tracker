import { TRPCError } from "@trpc/server";
import { formatMoney } from "@/core/money";
import { formatIsoDate, todayET } from "@/core/time";
import { quarterBounds, quarterOf, type CapitalAccount } from "@/core/waterfall";
import { authedContextFrom } from "@/server/request-context";
import { pdfResponse, renderPdf, type PdfSection } from "@/server/services/pdf";
import { createCaller } from "@/server/trpc/root";

const $ = (c: number | null | undefined) => (c == null ? "-" : formatMoney(c, { whole: false }));
const d = (iso: string | null | undefined) => (iso ? formatIsoDate(iso, { month: "short", day: "numeric", year: "numeric" }) : "-");

function accountRows(a: CapitalAccount): [string, string][] {
  return [
    ["Committed", $(a.committed)],
    ["Called", $(a.called)],
    ["Contributed", $(a.contributed)],
    ["Unfunded commitment", $(a.unfunded)],
    ["Distributed", `${$(a.distributed)} (capital ${$(a.roc)}, preferred return ${$(a.pref)}, profit ${$(a.profit)})`],
    ["Capital still invested", $(a.unreturned)],
    ...(a.prefOwed !== null ? ([["Preferred return accrued, unpaid", $(a.prefOwed)]] as [string, string][]) : []),
  ];
}

/**
 * Module J: the quarterly investor report (`?quarter=2026-Q3`, default the
 * last full quarter). An investor gets their own account only; someone with
 * financial access gets every investor on the project.
 */
export async function GET(req: Request, ctx: RouteContext<"/api/export/projects/[id]/investor-report">) {
  const { id } = await ctx.params;
  const c = await authedContextFrom(req);
  if (!c) return new Response("Sign in again", { status: 401 });
  const quarter = new URL(req.url).searchParams.get("quarter") ?? quarterOf(todayET(), -1);
  const q = quarterBounds(quarter);
  if (!q) return new Response("Pick a quarter like 2026-Q3", { status: 400 });
  const caller = createCaller(c);
  let view, highlights;
  try {
    view = await caller.portal.project({ projectId: id });
    highlights = await caller.portal.highlights({ projectId: id, from: q.from, to: q.to });
  } catch (e) {
    if (e instanceof TRPCError) return new Response("Not found", { status: 404 });
    throw e;
  }
  // Internal staff with financial access see the whole cap table; everyone else their own account.
  const full = c.actor.role !== "investor" ? await caller.capital.overview({ projectId: id }).catch(() => null) : null;

  const sections: PdfSection[] = [
    {
      heading: "Where the project stands",
      rows: [
        ["Phase", view.phase.current ?? "-"],
        ["Phases complete", `${view.phase.done} of ${view.phase.total}`],
        ["Checklist complete", `${view.progress}%`],
        ["Forecast finish", d(view.schedule.forecastFinish)],
        ["Baseline finish", d(view.schedule.baselineFinish)],
        ["Against baseline", view.schedule.slippage ?? "No baseline yet"],
      ],
    },
    {
      heading: `This quarter (${q.label})`,
      paragraphs: [
        highlights.phases.length ? `Phases begun: ${highlights.phases.map((p) => `${p.name} (${d(p.startedOn)})`).join(", ")}.` : "No new phase began this quarter.",
        highlights.milestones.length ? `Milestones reached: ${highlights.milestones.map((m) => `${m.title} (${d(m.completedOn)})`).join("; ")}.` : "No milestones were completed this quarter.",
        `${highlights.photos} site photo${highlights.photos === 1 ? "" : "s"} added.`,
      ],
    },
  ];

  if (full) {
    sections.push({
      heading: "Capital accounts (all investors)",
      table: {
        columns: ["Investor", "Committed", "Contributed", "Distributed", "Still invested"],
        widths: [150, 90, 90, 90, 84],
        rows: full.accounts.map((a) => [a.investor.name, $(a.account.committed), $(a.account.contributed), $(a.account.distributed), $(a.account.unreturned)]),
      },
    });
    sections.push({ heading: "Distribution waterfall", paragraphs: full.terms.description });
    const calls = full.calls.filter((x) => x.noticeOn >= q.from && x.noticeOn <= q.to);
    const dists = full.distributions.filter((x) => x.paidOn >= q.from && x.paidOn <= q.to);
    sections.push({
      heading: "Capital activity this quarter",
      paragraphs: [
        calls.length ? calls.map((x) => `Capital call #${x.number}: ${$(x.items.reduce((a, i) => a + i.amountCents, 0))}, due ${d(x.dueOn)}.`).join(" ") : "No capital calls.",
        dists.length ? dists.map((x) => `Distribution #${x.number}: ${$(x.totalCents)} on ${d(x.paidOn)}.`).join(" ") : "No distributions.",
      ],
    });
  } else if (view.accounts.length) {
    for (const a of view.accounts) {
      sections.push({ heading: `Your capital account: ${a.investorName}`, rows: accountRows(a.account) });
      const calls = a.calls.filter((x) => x.noticeOn >= q.from && x.noticeOn <= q.to);
      const dists = a.distributions.filter((x) => x.paidOn >= q.from && x.paidOn <= q.to);
      sections.push({
        heading: "Your activity this quarter",
        paragraphs: [
          calls.length ? calls.map((x) => `Capital call #${x.number}: ${$(x.amountCents)} due ${d(x.dueOn)}; received ${$(x.receivedCents)}.`).join(" ") : "No capital calls.",
          dists.length ? dists.map((x) => `Distribution #${x.number} on ${d(x.paidOn)}: ${$(x.rocCents + x.prefCents + x.profitCents)}.`).join(" ") : "No distributions.",
        ],
      });
      sections.push({ heading: "Distribution waterfall", paragraphs: a.waterfall });
    }
  }

  const bytes = await renderPdf({
    title: `Quarterly report · ${q.label}`,
    subtitle: `${view.project.name} · ${view.project.address}, ${view.project.borough}`,
    meta: `Prepared ${d(todayET())}. Figures as of today.`,
    sections,
    footer: "Confidential. Prepared for the investors in this project.",
  });
  return pdfResponse(bytes, `${view.project.name}-${quarter}-report.pdf`);
}
