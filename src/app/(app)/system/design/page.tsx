import type { Metadata } from "next";
import { requireOwner } from "@/server/session";
import { DesignKit } from "./design-kit";

export const metadata: Metadata = { title: "Design system" };

export default async function DesignPage() {
  await requireOwner();
  return <DesignKit />;
}
