import type { Metadata } from "next";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { requireViewer } from "@/server/session";
import { PortfolioView } from "./portfolio-view";

export const metadata: Metadata = { title: "Portfolio" };

export default async function PortfolioPage() {
  const viewer = await requireViewer();
  if (viewer.role === "investor") redirect("/portal");
  return (
    <Suspense>
      <PortfolioView canCreate={viewer.role === "owner" || viewer.role === "admin"} isOwner={viewer.role === "owner"} />
    </Suspense>
  );
}
