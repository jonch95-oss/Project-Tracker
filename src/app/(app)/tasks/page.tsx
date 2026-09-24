import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/primitives";
import { formatIsoDate, todayET } from "@/core/time";
import { redirect } from "next/navigation";
import { requireViewer } from "@/server/session";
import { MyTasksView } from "./my-tasks-view";

export const metadata: Metadata = { title: "My Tasks" };

export default async function TasksPage() {
  const viewer = await requireViewer();
  if (viewer.role === "investor") redirect("/portal");
  const firstName = viewer.name.split(" ")[0];
  return (
    <>
      <PageHeader eyebrow={formatIsoDate(todayET(), { weekday: "long", month: "long", day: "numeric", year: undefined })} title="My Tasks" description={`Good to see you, ${firstName}. This is everything you need to do, in order.`} />
      <MyTasksView />
    </>
  );
}
