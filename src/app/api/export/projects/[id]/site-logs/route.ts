import { TRPCError } from "@trpc/server";
import { manpowerTotal } from "@/core/field";
import { formatIsoDate, isIsoDate, todayET } from "@/core/time";
import { renderPdf, pdfResponse, type PdfSection } from "@/server/services/pdf";
import { authedContextFrom } from "@/server/request-context";
import { createCaller } from "@/server/trpc/root";

/** Module D: daily logs as a dated PDF for lender draws and claims (the project team only). */
export async function GET(req: Request, ctx: RouteContext<"/api/export/projects/[id]/site-logs">) {
  const { id } = await ctx.params;
  const c = await authedContextFrom(req);
  if (!c) return new Response("Sign in again", { status: 401 });
  const url = new URL(req.url);
  const to = url.searchParams.get("to") ?? todayET();
  const from = url.searchParams.get("from") ?? to;
  if (!isIsoDate(from) || !isIsoDate(to)) return new Response("Bad dates", { status: 400 });
  let logs, project;
  try {
    const caller = createCaller(c);
    project = await caller.projects.get({ projectId: id });
    logs = await caller.siteLogs.range({ projectId: id, from, to });
  } catch (e) {
    if (e instanceof TRPCError) return new Response(e.code === "BAD_REQUEST" ? e.message : "Not found", { status: e.code === "BAD_REQUEST" ? 400 : 404 });
    throw e;
  }
  const long = (d: string) => formatIsoDate(d, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const sections: PdfSection[] = logs.length
    ? logs.flatMap((l): PdfSection[] => [
        {
          heading: long(l.date),
          rows: [
            ["Weather", l.weather ? `${l.weather.summary}${l.weather.highF !== null ? `, ${l.weather.highF}°F / ${l.weather.lowF}°F` : ""}${l.weather.precipIn ? `, ${l.weather.precipIn} in precipitation` : ""}${l.weather.windMph ? `, wind ${l.weather.windMph} mph` : ""}` : "-"],
            ["Manpower", `${manpowerTotal(l.manpower)} on site`],
            ["Work performed", l.workPerformed ?? "-"],
            ["Deliveries", l.deliveries ?? "-"],
            ["Visitors", l.visitors ?? "-"],
            ["Safety", l.safety ?? "No incidents recorded"],
            ["Notes", l.notes ?? "-"],
            ["Photos", l.photos ? `${l.photos} on file in Project Command` : "-"],
            ["Filed by", l.author ?? "-"],
          ],
          ...(l.manpower.length ? { table: { columns: ["Trade", "Company", "Count"], widths: [180, 244, 80], rows: l.manpower.map((m) => [m.trade, m.company ?? "", String(m.count)]) } } : {}),
        },
        ...(l.inspections.length ? [{ heading: "Inspections", table: { columns: ["Inspection", "Result", "Notes"], widths: [200, 80, 224], rows: l.inspections.map((i) => [i.what, i.result, i.notes ?? ""]) } }] : []),
        ...(l.delays.length ? [{ heading: "Delays", table: { columns: ["Cause", "Hours", "Notes"], widths: [200, 60, 244], rows: l.delays.map((d) => [d.cause, d.hours === null ? "" : String(d.hours), d.notes ?? ""]) } }] : []),
      ])
    : [{ heading: "No logs", paragraphs: ["No site logs were filed for these dates."] }];
  const bytes = await renderPdf({
    title: `Daily site log: ${project.name}`,
    subtitle: from === to ? long(from) : `${long(from)} to ${long(to)}`,
    meta: `${project.address}${project.bbl ? ` · BBL ${project.bbl}` : ""}`,
    sections,
    footer: `${project.name} site log, generated ${todayET()}`,
  });
  return pdfResponse(bytes, `site-log-${project.name}-${from}${from === to ? "" : `-to-${to}`}.pdf`);
}
