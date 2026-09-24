import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireViewer } from "@/server/session";
import { PortalView } from "./portal-view";

export const metadata: Metadata = { title: "Investments" };

export default async function PortalPage() {
  const viewer = await requireViewer();
  if (viewer.role === "external") redirect("/");
  return <PortalView firstName={viewer.name.split(" ")[0] ?? ""} />;
}
