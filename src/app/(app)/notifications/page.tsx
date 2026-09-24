import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/primitives";
import { NotificationsView } from "./notifications-view";

export const metadata: Metadata = { title: "Notifications" };

export default function NotificationsPage() {
  return (
    <>
      <PageHeader title="Notifications" description="Assignments, mentions, approvals, follow-ups and key-date reminders." />
      <NotificationsView />
    </>
  );
}
