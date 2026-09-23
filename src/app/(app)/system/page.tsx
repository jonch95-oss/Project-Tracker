import type { Metadata } from "next";
import { requireOwner } from "@/server/session";
import { SystemView } from "./system-view";

export const metadata: Metadata = { title: "System" };

export default async function SystemPage() {
  await requireOwner();
  return <SystemView />;
}
