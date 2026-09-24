import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { canGlobal } from "@/core/permissions";
import { requireViewer } from "@/server/session";
import { VendorView } from "./vendor-view";

export const metadata: Metadata = { title: "Directory" };

export default async function VendorPage({ params }: PageProps<"/directory/[id]">) {
  const viewer = await requireViewer();
  if (!canGlobal({ userId: viewer.id, role: viewer.role, status: "active" }, "directory.view")) redirect("/");
  const { id } = await params;
  return <VendorView id={id} />;
}
