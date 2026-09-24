import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { requireViewer } from "@/server/session";
import { TemplateEditor } from "./template-editor";

export const metadata: Metadata = { title: "Template" };

export default async function TemplatePage({ params }: PageProps<"/templates/[id]">) {
  const viewer = await requireViewer();
  if (viewer.role !== "owner" && viewer.role !== "admin") redirect("/");
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  return <TemplateEditor templateId={id} />;
}
