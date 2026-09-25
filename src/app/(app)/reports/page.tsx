import type { Metadata } from "next";
import { requireOwner } from "@/server/session";
import { Prefetch } from "@/server/trpc/prefetch";
import { ReportsView } from "./reports-view";

export const metadata: Metadata = { title: "Weekly report" };

export default async function ReportsPage({ searchParams }: PageProps<"/reports">) {
  await requireOwner();
  const chosen = (await searchParams).week;
  const week = typeof chosen === "string" ? chosen : null;
  // The week list and the report on show arrive with the page.
  return (
    <Prefetch
      load={(trpc, qc) => [
        qc.fetchQuery(trpc.reports.list.queryOptions()).then((weeks) => {
          const w = week ?? weeks[0]?.weekOf ?? "live";
          return w === "live" ? qc.prefetchQuery(trpc.reports.live.queryOptions()) : qc.prefetchQuery(trpc.reports.get.queryOptions({ weekOf: w }));
        }),
      ]}
    >
      <ReportsView />
    </Prefetch>
  );
}
