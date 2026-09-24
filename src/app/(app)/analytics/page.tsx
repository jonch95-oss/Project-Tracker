import type { Metadata } from "next";
import { requireOwner } from "@/server/session";
import { AnalyticsView } from "./analytics-view";

export const metadata: Metadata = { title: "Analytics" };

export default async function AnalyticsPage() {
  await requireOwner();
  return <AnalyticsView />;
}
