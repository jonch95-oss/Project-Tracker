import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { canGlobal } from "@/core/permissions";
import { requireViewer } from "@/server/session";
import { DirectoryView } from "./directory-view";

export const metadata: Metadata = { title: "Directory" };

export default async function DirectoryPage() {
  const viewer = await requireViewer();
  if (!canGlobal({ userId: viewer.id, role: viewer.role, status: "active" }, "directory.view")) redirect("/");
  return <DirectoryView />;
}
