import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { requireViewer } from "@/server/session";
import { PortalProjectView } from "./portal-project-view";

export const metadata: Metadata = { title: "Investment" };

export default async function PortalProjectPage({ params }: PageProps<"/portal/[id]">) {
  const viewer = await requireViewer();
  if (viewer.role === "external") redirect("/");
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  return <PortalProjectView projectId={id} />;
}
