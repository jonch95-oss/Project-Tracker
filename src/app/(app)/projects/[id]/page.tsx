import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { requireViewer } from "@/server/session";
import { Prefetch } from "@/server/trpc/prefetch";
import { ProjectView } from "./project-view";

export const metadata: Metadata = { title: "Project" };

export default async function ProjectPage({ params }: PageProps<"/projects/[id]">) {
  const viewer = await requireViewer();
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  // Investors and lenders read the project through their portal.
  if (viewer.role === "investor") redirect(`/portal/${id}`);
  // The header, hero and key facts arrive with the page.
  return (
    <Prefetch load={(trpc, qc) => [qc.prefetchQuery(trpc.projects.get.queryOptions({ projectId: id }))]}>
      <ProjectView projectId={id} viewerId={viewer.id} />
    </Prefetch>
  );
}
