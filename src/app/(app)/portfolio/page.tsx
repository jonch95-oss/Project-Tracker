import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireViewer } from "@/server/session";
import { Prefetch } from "@/server/trpc/prefetch";
import { PortfolioView } from "./portfolio-view";

export const metadata: Metadata = { title: "Portfolio" };

export default async function PortfolioPage({ searchParams }: PageProps<"/portfolio">) {
  const viewer = await requireViewer();
  if (viewer.role === "investor") redirect("/portal");
  const archived = (await searchParams).archived === "1";
  // The cards, the "Needs you" rail and the filters arrive with the page, so nothing jumps when data lands.
  return (
    <Prefetch load={(trpc, qc) => [qc.prefetchQuery(trpc.projects.list.queryOptions({ archived })), qc.prefetchQuery(trpc.companies.list.queryOptions()), ...(archived ? [] : [qc.prefetchQuery(trpc.tasks.needsYou.queryOptions())])]}>
      <PortfolioView canCreate={viewer.role === "owner" || viewer.role === "admin"} isOwner={viewer.role === "owner"} />
    </Prefetch>
  );
}
