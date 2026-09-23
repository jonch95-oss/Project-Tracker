import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { z } from "zod";
import { requireViewer } from "@/server/session";
import { ProjectView } from "./project-view";

export const metadata: Metadata = { title: "Project" };

export default async function ProjectPage({ params }: PageProps<"/projects/[id]">) {
  await requireViewer();
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  return (
    <Suspense>
      <ProjectView projectId={id} />
    </Suspense>
  );
}
