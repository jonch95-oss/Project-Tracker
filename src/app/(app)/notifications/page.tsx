import type { Metadata } from "next";
import Link from "next/link";
import { buttonClass, PageHeader } from "@/components/ui/primitives";
import { NotificationsView } from "./notifications-view";

export const metadata: Metadata = { title: "Notifications" };

export default function NotificationsPage() {
  return (
    <>
      <PageHeader
        title="Notifications"
        description="Assignments, mentions, approvals, reminders and your daily digest."
        actions={
          <Link href="/settings#notifications" className={buttonClass("secondary", "sm")}>
            Preferences
          </Link>
        }
      />
      <NotificationsView />
    </>
  );
}
