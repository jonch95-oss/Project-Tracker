import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireViewer } from "@/server/session";
import { ImportView } from "./import-view";

export const metadata: Metadata = { title: "Import" };

export default async function ImportPage() {
  const viewer = await requireViewer();
  if (viewer.role !== "owner" && viewer.role !== "admin") redirect("/");
  return <ImportView />;
}
