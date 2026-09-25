import type { Metadata } from "next";
import { requireOwner } from "@/server/session";
import { ReportsView } from "./reports-view";

export const metadata: Metadata = { title: "Weekly report" };

export default async function ReportsPage() {
  await requireOwner();
  return <ReportsView />;
}
