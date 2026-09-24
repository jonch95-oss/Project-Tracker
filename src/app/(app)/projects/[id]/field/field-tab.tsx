"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { TabPanel, Tabs } from "@/components/ui/tabs";
import { DrawingsView } from "./drawings";
import { MeetingsView } from "./meetings";
import { PunchView } from "./punch";
import { RfisView } from "./rfis";
import { ScheduleView } from "./schedule";
import { SiteLogView } from "./site-log";
import { SubmittalsView } from "./submittals";

export type FieldView = "log" | "schedule" | "rfis" | "submittals" | "drawings" | "punch" | "meetings";

/**
 * Construction (Modules D, E, F, G, K): the daily log, schedule, RFIs,
 * submittals, drawings, punch and meetings. Outside collaborators see the
 * RFIs, submittals, drawings and punch items that involve them.
 */
export function FieldTab({ projectId, internal, onOpenTask }: { projectId: string; internal: boolean; onOpenTask: (taskId: string) => void }) {
  const params = useSearchParams();
  const pathname = usePathname();
  const items: { key: FieldView; label: string }[] = internal
    ? [
        { key: "log", label: "Daily log" },
        { key: "schedule", label: "Schedule" },
        { key: "rfis", label: "RFIs" },
        { key: "submittals", label: "Submittals" },
        { key: "drawings", label: "Drawings" },
        { key: "punch", label: "Punch" },
        { key: "meetings", label: "Meetings" },
      ]
    : [
        { key: "rfis", label: "RFIs" },
        { key: "submittals", label: "Submittals" },
        { key: "drawings", label: "Drawings" },
        { key: "punch", label: "Punch" },
      ];
  const requested = params.get("view");
  const view: FieldView = items.some((i) => i.key === requested) ? (requested as FieldView) : items[0]!.key;
  const go = (v: FieldView, extra: Record<string, string> = {}) => {
    const q = new URLSearchParams({ tab: "field", view: v, ...extra });
    // Only the browser's address changes: no server call, and it works offline.
    window.history.replaceState(null, "", `${pathname}?${q}`);
  };
  return (
    <div>
      <Tabs<FieldView> idBase="field-tabs" label="Construction sections" value={view} onChange={(k) => go(k)} items={items} className="mb-8" />
      <TabPanel idBase="field-tabs" tab={view}>
        {view === "log" ? (
          <SiteLogView projectId={projectId} date={params.get("date")} onDate={(d) => go("log", { date: d })} />
        ) : view === "schedule" ? (
          <ScheduleView projectId={projectId} onOpenTask={onOpenTask} />
        ) : view === "rfis" ? (
          <RfisView projectId={projectId} />
        ) : view === "submittals" ? (
          <SubmittalsView projectId={projectId} />
        ) : view === "drawings" ? (
          <DrawingsView projectId={projectId} sheetId={params.get("sheet")} onSheet={(id) => go("drawings", id ? { sheet: id } : {})} />
        ) : view === "punch" ? (
          <PunchView projectId={projectId} onOpenSheet={(id) => go("drawings", { sheet: id })} />
        ) : (
          <MeetingsView projectId={projectId} meetingId={params.get("meeting")} onMeeting={(id) => go("meetings", id ? { meeting: id } : {})} onOpenTask={onOpenTask} />
        )}
      </TabPanel>
    </div>
  );
}
