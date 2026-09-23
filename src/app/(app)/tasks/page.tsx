import type { Metadata } from "next";
import { EmptyState } from "@/components/ui/architecture";
import { PageHeader } from "@/components/ui/primitives";
import { formatIsoDate, todayET } from "@/core/time";
import { requireViewer } from "@/server/session";

export const metadata: Metadata = { title: "My Tasks" };

export default async function TasksPage() {
  const viewer = await requireViewer();
  const firstName = viewer.name.split(" ")[0];
  return (
    <>
      <PageHeader eyebrow={formatIsoDate(todayET(), { weekday: "long", month: "long", day: "numeric", year: undefined })} title="My Tasks" description={`Good to see you, ${firstName}. This is everything you need to do, in order.`} />
      <EmptyState title="Nothing on your list" body="When tasks are assigned to you, they appear here grouped as Overdue, Today, This week and Later." />
    </>
  );
}
