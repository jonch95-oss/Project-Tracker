import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireViewer } from "@/server/session";
import { SearchScreen } from "./search-screen";

export const metadata: Metadata = { title: "Search" };

export default async function SearchPage() {
  const viewer = await requireViewer();
  // Investors and lenders have their portal, not the team's search.
  if (viewer.role === "investor") redirect("/portal");
  return <SearchScreen role={viewer.role} />;
}
