import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireViewer } from "@/server/session";
import { TemplatesView } from "./templates-view";

export const metadata: Metadata = { title: "Templates" };

export default async function TemplatesPage() {
  const viewer = await requireViewer();
  if (viewer.role !== "owner" && viewer.role !== "admin") redirect("/");
  return <TemplatesView />;
}
