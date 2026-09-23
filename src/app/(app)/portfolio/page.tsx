import type { Metadata } from "next";
import { requireViewer } from "@/server/session";
import { PortfolioView } from "./portfolio-view";

export const metadata: Metadata = { title: "Portfolio" };

export default async function PortfolioPage() {
  const viewer = await requireViewer();
  return <PortfolioView canCreate={viewer.role === "owner" || viewer.role === "admin"} />;
}
