import type { Metadata } from "next";
import { requireOwner } from "@/server/session";
import { Prefetch } from "@/server/trpc/prefetch";
import { TeamView } from "./team-view";

export const metadata: Metadata = { title: "Team" };

export default async function TeamPage() {
  const viewer = await requireOwner();
  return (
    <Prefetch load={(trpc, qc) => [qc.prefetchQuery(trpc.users.list.queryOptions()), qc.prefetchQuery(trpc.users.invitations.queryOptions())]}>
      <TeamView viewerId={viewer.id} />
    </Prefetch>
  );
}
