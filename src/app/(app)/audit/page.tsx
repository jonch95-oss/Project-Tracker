import type { Metadata } from "next";
import { requireOwner } from "@/server/session";
import { AuditView } from "./audit-view";

export const metadata: Metadata = { title: "Audit log" };

export default async function AuditPage() {
  await requireOwner();
  return <AuditView />;
}
