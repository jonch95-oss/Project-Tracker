import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireViewer } from "@/server/session";
import { ProjectView } from "./project-view";

export const metadata: Metadata = { title: "Project" };

export default async function ProjectPage({ params }: PageProps<"/projects/[id]">) {
  await requireViewer();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  return <ProjectView projectId={id} />;
}
