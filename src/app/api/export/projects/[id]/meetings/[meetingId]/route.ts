import { TRPCError } from "@trpc/server";
import { formatIsoDate, todayET } from "@/core/time";
import { renderPdf, pdfResponse } from "@/server/services/pdf";
import { authedContextFrom } from "@/server/request-context";
import { recordAudit } from "@/server/services/audit";
import { createCaller } from "@/server/trpc/root";

/** Module G: meeting minutes as a PDF (a download link, so it never costs the email budget). */
export async function GET(req: Request, ctx: RouteContext<"/api/export/projects/[id]/meetings/[meetingId]">) {
  const { id, meetingId } = await ctx.params;
  const c = await authedContextFrom(req);
  if (!c) return new Response("Sign in again", { status: 401 });
  let data, project;
  try {
    const caller = createCaller(c);
    project = await caller.projects.get({ projectId: id });
    data = await caller.meetings.get({ projectId: id, id: meetingId });
  } catch (e) {
    if (e instanceof TRPCError) return new Response("Not found", { status: 404 });
    throw e;
  }
  const m = data.meeting;
  const actions = data.items.filter((i) => i.kind === "action");
  const notes = data.items.filter((i) => i.kind === "note");
  const title = `${m.type.toUpperCase()} meeting #${m.number}${m.title ? `: ${m.title}` : ""}`;
  const bytes = await renderPdf({
    title,
    subtitle: `${project.name} · ${formatIsoDate(m.heldOn, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}`,
    meta: project.address,
    sections: [
      { heading: "Attendees", paragraphs: [m.attendees.length ? m.attendees.map((a) => (a.company ? `${a.name} (${a.company})` : a.name)).join(", ") : "-"] },
      ...(m.agenda ? [{ heading: "Agenda", paragraphs: [m.agenda] }] : []),
      ...(m.notes || notes.length ? [{ heading: "Notes", paragraphs: [...(m.notes ? [m.notes] : []), ...notes.map((n) => `- ${n.text}`)] }] : []),
      {
        heading: "Action items",
        ...(actions.length
          ? { table: { columns: ["Item", "Who", "Due", "Status"], widths: [250, 110, 80, 64], rows: actions.map((a) => [`${a.carriedFromId ? "(carried) " : ""}${a.text}`, a.assigneeName ?? "", a.dueOn ?? "", a.status === "closed" ? "Done" : a.status === "carried" ? "Carried" : "Open"]) } }
          : { paragraphs: ["None."] }),
      },
    ],
    footer: `Minutes generated ${todayET()}`,
  });
  // Every export is on the audit log (brief §4).
  await recordAudit(c.db, { actorId: c.viewer.id, actorName: c.viewer.name, action: "export", entityType: "meeting", entityId: m.id, projectId: id, summary: `${c.viewer.name} downloaded meeting minutes as a PDF`, ip: c.ip }).catch(() => undefined);
  return pdfResponse(bytes, `minutes-${m.type}-${m.number}-${m.heldOn}.pdf`);
}
