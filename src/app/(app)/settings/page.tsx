import type { Metadata } from "next";
import { requireViewer } from "@/server/session";
import { SettingsView } from "./settings-view";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage({ searchParams }: PageProps<"/settings">) {
  const viewer = await requireViewer();
  const sp = await searchParams;
  return (
    <SettingsView
      welcome={sp.welcome === "1"}
      viewer={{ name: viewer.name, email: viewer.email, title: viewer.title, twoFactorEnabled: viewer.twoFactorEnabled, role: viewer.role }}
    />
  );
}
