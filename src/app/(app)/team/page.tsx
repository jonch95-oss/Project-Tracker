import type { Metadata } from "next";
import { requireOwner } from "@/server/session";
import { TeamView } from "./team-view";

export const metadata: Metadata = { title: "Team" };

export default async function TeamPage() {
  const viewer = await requireOwner();
  return <TeamView viewerId={viewer.id} />;
}
