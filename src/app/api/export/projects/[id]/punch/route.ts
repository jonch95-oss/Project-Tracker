import { TRPCError } from "@trpc/server";
import { todayET } from "@/core/time";
import { renderPdf, pdfResponse } from "@/server/services/pdf";
import { authedContextFrom } from "@/server/request-context";
import { createCaller } from "@/server/trpc/root";

/** Module K: a punch list PDF per sub (or any filter), open and ready items first. */
export async function GET(req: Request, ctx: RouteContext<"/api/export/projects/[id]/punch">) {
  const { id } = await ctx.params;
  const c = await authedContextFrom(req);
  if (!c) return new Response("Sign in again", { status: 401 });
  const q = new URL(req.url).searchParams;
  const pick = (k: string) => q.get(k) || undefined;
  let data, project;
  try {
    const caller = createCaller(c);
    project = await caller.projects.get({ projectId: id });
    data = await caller.punch.list({ projectId: id, vendor: pick("vendor"), trade: pick("trade"), floor: pick("floor"), unit: pick("unit") });
  } catch (e) {
    if (e instanceof TRPCError) return new Response("Not found", { status: 404 });
    throw e;
  }
  const open = data.items.filter((i) => i.status !== "closed");
  const who = pick("vendor") ?? pick("trade") ?? "All trades";
  const bytes = await renderPdf({
    title: `Punch list: ${who}`,
    subtitle: project.name,
    meta: `${open.length} open or ready · ${data.items.length - open.length} closed`,
    sections: [
      {
        heading: "Items",
        table: {
          columns: ["#", "Item", "Where", "Sheet", "Due", "Status"],
          widths: [30, 200, 90, 60, 64, 60],
          rows: [...open, ...data.items.filter((i) => i.status === "closed")].map((i) => [String(i.number), `${i.title}${i.description ? `: ${i.description}` : ""}`, [i.floor && `Fl ${i.floor}`, i.unit && `Unit ${i.unit}`].filter(Boolean).join(", "), i.sheetNumber ?? "", i.dueOn ?? "", i.status === "ready" ? "Ready" : i.status === "closed" ? "Closed" : "Open"]),
        },
      },
    ],
    footer: `Punch list generated ${todayET()}`,
  });
  return pdfResponse(bytes, `punch-${who}-${todayET()}.pdf`);
}
