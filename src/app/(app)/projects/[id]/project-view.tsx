"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useState, type ReactNode } from "react";
import { HeadlineFigures, ProjectImage, pct } from "@/components/project/visuals";
import { EmptyState, ErrorState } from "@/components/ui/architecture";
import { IconArrowLeft } from "@/components/ui/icons";
import { useToast } from "@/components/ui/overlay";
import { Badge, Button, Skeleton, StatusPill } from "@/components/ui/primitives";
import { TabPanel, Tabs } from "@/components/ui/tabs";
import { PROJECT_TYPE_LABEL, type ProjectTypeKey } from "@/core/labels";
import { projectProgressBps } from "@/core/phases";
import { PROJECT_STATUS_LABEL } from "@/core/portfolio";
import { formatIsoDate, todayET } from "@/core/time";
import { errorMessage, useTRPC, type RouterOutputs } from "@/lib/trpc";
import { ActivityTab } from "./activity-tab";
import { ChecklistTab } from "./checklist-tab";
import { FilesTab } from "./files-tab";
import { RecordsTab } from "./records-tab";
import { FieldTab } from "./field/field-tab";
import { UnitsTab } from "./units-tab";
import { FinancialsTab } from "./financials-tab";
import { KeyDatesTab } from "./key-dates-tab";
import { EditProjectDialog } from "./edit-dialog";
import { PhaseStepper } from "./phase-stepper";
import { PhotoGallery } from "./photos";
import { TeamTab } from "./team-tab";

type Project = RouterOutputs["projects"]["get"];
const UNIT_TYPES = new Set(["ground_up_condo", "condo_conversion", "gut_renovation"]);

type TabKey = "overview" | "checklist" | "team" | "dates" | "financials" | "files" | "field" | "units" | "records" | "activity";

export function ProjectView({ projectId, viewerId }: { projectId: string; viewerId: string }) {
  const trpc = useTRPC();
  const project = useQuery(trpc.projects.get.queryOptions({ projectId }));
  // The tab lives in the URL so it survives reloads and can be linked to.
  const params = useSearchParams();
  const pathname = usePathname();
  const [editing, setEditing] = useState(false);
  const requested = params.get("tab");

  if (project.isPending) {
    return (
      <div aria-busy="true">
        <Skeleton className="mb-8 h-[320px] rounded-card sm:h-[440px]" />
        <Skeleton className="h-6 w-1/3" />
      </div>
    );
  }
  if (project.isError) {
    const notFound = project.error.data?.code === "NOT_FOUND";
    return notFound ? (
      <EmptyState
        title="Project not found"
        body="It may have been removed, or you may not have access to it."
        action={
          <Link href="/portfolio" className="text-sm underline underline-offset-4">
            Back to portfolio
          </Link>
        }
      />
    ) : (
      <ErrorState onRetry={() => project.refetch()} />
    );
  }

  const p = project.data;
  const tabs: { key: TabKey; label: string }[] = [
    { key: "overview", label: "Overview" },
    { key: "checklist", label: "Checklist" },
    { key: "team", label: "Team" },
    ...(p.access.canSeeAllTasks ? [{ key: "dates" as const, label: "Dates & Expiries" }] : []),
    ...(p.access.canViewFinancials ? [{ key: "financials" as const, label: "Financials" }] : []),
    { key: "files", label: "Files" },
    { key: "field", label: "Construction" },
    // Module L: condo projects keep a unit schedule (other types can still open it by link).
    ...(p.access.canSeeAllTasks && (UNIT_TYPES.has(p.type) || requested === "units") ? [{ key: "units" as const, label: "Units" }] : []),
    ...(p.access.canSeeAllTasks ? [{ key: "records" as const, label: "Public Records" }] : []),
    ...(p.access.canViewActivity ? [{ key: "activity" as const, label: "Activity" }] : []),
  ];
  const tab: TabKey = tabs.some((t) => t.key === requested) ? (requested as TabKey) : "overview";
  const setTab = (next: TabKey, phase?: string, task?: string) =>
    // Only the browser's address changes (the server doesn't read these): instant, no server call, and it works offline.
    window.history.replaceState(null, "", next === "overview" ? pathname : `${pathname}?tab=${next}${phase ? `&phase=${encodeURIComponent(phase)}` : ""}${task ? `&task=${encodeURIComponent(task)}` : ""}`);
  const openChecklist = (phase: string) => {
    setTab("checklist", phase);
    requestAnimationFrame(() => document.getElementById(`phase-${phase}`)?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  return (
    <article>
      <Link href="/portfolio" className="mb-6 inline-flex items-center gap-2 text-sm text-muted hover:text-text">
        <IconArrowLeft size={16} /> Portfolio
      </Link>

      {p.archivedAt && <ArchivedBanner project={p} />}

      <div className="-mx-4 overflow-hidden border-y border-border sm:mx-0 sm:rounded-card sm:border">
        <ProjectImage photoId={p.hero?.id} address={p.address} borough={p.borough} size="hero" className="h-[320px] sm:h-[480px]" priority alt={`${p.name}, ${p.address}`} />
      </div>

      <header className="mt-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <p className="eyebrow mb-2">{p.companyName}</p>
          <h1 className="serif text-title sm:text-display">{p.name}</h1>
          <p className="mt-2 text-[15px] text-muted">
            {p.address}, {p.borough}
            {p.bbl && <span className="num"> · BBL {p.bbl}</span>}
          </p>
          <p className="mt-1 text-[13px] text-muted">{PROJECT_TYPE_LABEL[p.type as ProjectTypeKey]}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {p.status !== "active" && <StatusPill tone={p.status === "on_hold" ? "attention" : "neutral"}>{PROJECT_STATUS_LABEL[p.status]}</StatusPill>}
          {p.access.projectRole && <Badge>{p.access.projectRole}</Badge>}
          {p.access.canViewFinancials && <StatusPill tone="accent">Financials visible</StatusPill>}
          {p.access.canEdit && (
            <Button variant="secondary" onClick={() => setEditing(true)}>
              Edit project
            </Button>
          )}
        </div>
      </header>

      <PhaseStepper projectId={p.id} phases={p.phases} taskCounts={p.taskCounts} version={p.version} canEdit={p.access.canEdit && !p.archivedAt} onOpenChecklist={openChecklist} />

      <Tabs<TabKey> idBase="project-tabs" label="Project sections" className="mt-10" value={tab} onChange={(k) => setTab(k)} items={tabs} />

      <TabPanel idBase="project-tabs" tab={tab} className="mt-8 focus-visible:outline-offset-8">
        {tab === "overview" ? (
          <Overview project={p} viewerId={viewerId} onOpenTask={(id) => setTab("checklist", undefined, id)} onOpenDates={() => setTab("dates")} />
        ) : tab === "checklist" ? (
          <ChecklistTab
            projectId={projectId}
            canSaveTemplate={p.access.canSaveTemplate}
            focusPhase={params.get("phase")}
            focusTask={params.get("task")}
            focusAttach={params.get("attach") === "1"}
            onFocusTask={(id) => setTab("checklist", params.get("phase") ?? undefined, id ?? undefined)}
          />
        ) : tab === "files" ? (
          <FilesTab projectId={projectId} onOpenPhotos={() => setTab("overview")} focusFolder={params.get("folder")} focusFile={params.get("file")} />
        ) : tab === "dates" ? (
          <KeyDatesTab projectId={projectId} />
        ) : tab === "team" ? (
          <TeamTab projectId={projectId} canManage={p.access.canManageMembers} />
        ) : tab === "financials" && p.access.canViewFinancials ? (
          <FinancialsTab projectId={projectId} />
        ) : tab === "activity" ? (
          <ActivityTab projectId={projectId} />
        ) : tab === "field" ? (
          <FieldTab projectId={projectId} internal={p.access.canSeeAllTasks} onOpenTask={(id) => setTab("checklist", undefined, id)} />
        ) : tab === "units" ? (
          <UnitsTab projectId={projectId} onOpenTask={(id) => setTab("checklist", undefined, id)} />
        ) : tab === "records" ? (
          <RecordsTab projectId={projectId} onOpenTask={(id) => setTab("checklist", undefined, id)} />
        ) : null}
      </TabPanel>

      {p.access.canEdit && <EditProjectDialog project={p} open={editing} onClose={() => setEditing(false)} />}
    </article>
  );
}

function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[12px] text-muted">{label}</dt>
      <dd className="num mt-0.5 truncate text-[15px] font-medium">{value ?? "—"}</dd>
    </div>
  );
}

const n = (v: number | null | undefined, suffix = "") => (v == null ? null : `${v.toLocaleString("en-US")}${suffix}`);
const f2 = (v: number | null | undefined) => (v == null ? null : v.toFixed(2));

function Overview({ project: p, viewerId, onOpenTask, onOpenDates }: { project: Project; viewerId: string; onOpenTask: (id: string) => void; onOpenDates: () => void }) {
  const f = p.facts;
  const today = todayET();
  return (
    <div className="flex flex-col gap-12">
      <section aria-labelledby="facts-h" className="grid gap-8 lg:grid-cols-[2fr_1fr]">
        <div>
          <h2 id="facts-h" className="serif mb-4 text-heading">
            Key facts
          </h2>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-5 rounded-card border border-border bg-surface p-6 sm:grid-cols-4">
            <Fact label="Lot area" value={n(p.lotAreaSqft, " sf")} />
            <Fact label="Lot size" value={p.lotFrontFt && p.lotDepthFt ? `${f2(p.lotFrontFt)} × ${f2(p.lotDepthFt)} ft` : null} />
            <Fact label="Zoning" value={p.zoning} />
            <Fact label="Residential FAR" value={f2(p.residFar)} />
            <Fact label="Built FAR" value={f2(p.builtFar)} />
            <Fact label="Unused ZSF" value={n(p.unusedZsf)} />
            <Fact label="Units" value={n(p.units)} />
            <Fact label="Gross SF" value={n(p.grossSf)} />
            <Fact label="Sellable SF" value={n(p.sellableSf)} />
          </dl>
          {p.description && <p className="mt-6 max-w-2xl whitespace-pre-line text-[15px] leading-relaxed text-muted">{p.description}</p>}
        </div>
        <div>
          <h2 className="serif mb-4 text-heading">Progress</h2>
          <div className="rounded-card border border-border bg-surface p-6">
            <p className="serif num text-display leading-none">{pct(projectProgressBps(p.phases, p.taskCounts))}</p>
            <p className="mt-2 text-[13px] text-muted">Finished phases, plus the share of the current phase&apos;s checklist that&apos;s done.</p>
            {p.headline && <HeadlineFigures headline={p.headline} className="mt-6 border-t border-border pt-5" />}
          </div>
          <h2 className="serif mb-4 mt-8 text-heading">What&apos;s next</h2>
          <div className="flex flex-col gap-4 rounded-card border border-border bg-surface p-6 text-sm">
            {f.nextAction ? (
              <button type="button" onClick={() => onOpenTask(f.nextAction!.id)} className="text-left">
                <span className="block text-[12px] text-muted">Next action</span>
                <span className="mt-0.5 block font-medium underline-offset-4 hover:underline">{f.nextAction.title}</span>
                <span className="block text-[13px] text-muted">
                  {f.nextAction.assigneeName ?? "Unassigned"}
                  {f.nextAction.dueOn ? ` · due ${formatIsoDate(f.nextAction.dueOn, { month: "short", day: "numeric", year: undefined })}` : ""}
                </span>
              </button>
            ) : (
              <p className="text-muted">No open tasks.</p>
            )}
            {(f.blocked > 0 || f.overdue > 0) && (
              <p className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border pt-4">
                {f.blocked > 0 && <span className="num font-medium text-blocked-text">{f.blocked} blocked</span>}
                {f.overdue > 0 && <span className="num font-medium text-attention-text">{f.overdue} overdue</span>}
              </p>
            )}
            {f.nextKeyDate && (
              <button type="button" onClick={onOpenDates} className="border-t border-border pt-4 text-left">
                <span className="block text-[12px] text-muted">Next key date</span>
                <span className="mt-0.5 block font-medium">
                  {f.nextKeyDate.label} · <span className="num">{formatIsoDate(f.nextKeyDate.date, { month: "short", day: "numeric", year: f.nextKeyDate.date.slice(0, 4) === today.slice(0, 4) ? undefined : "numeric" })}</span>
                </span>
              </button>
            )}
          </div>
        </div>
      </section>
      <PhotoGallery
        projectId={p.id}
        heroPhotoId={p.hero?.id ?? null}
        pinnedHeroId={p.heroPhotoId}
        canUpload={p.access.canUploadPhotos && !p.archivedAt}
        canManage={p.access.canManagePhotos}
        viewerId={viewerId}
      />
    </div>
  );
}


function ArchivedBanner({ project }: { project: Project }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const toast = useToast();
  const restore = useMutation(
    trpc.projects.setArchived.mutationOptions({
      onSuccess: async () => {
        toast("success", "Project restored to the portfolio");
        await qc.invalidateQueries({ queryKey: trpc.projects.get.queryKey({ projectId: project.id }) });
        await qc.invalidateQueries({ queryKey: trpc.projects.list.queryKey() });
      },
      onError: (e) => toast("error", errorMessage(e)),
    }),
  );
  return (
    <div role="status" className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-card border border-border bg-sunken px-5 py-4 text-sm">
      <span>This project is archived. It&apos;s hidden from the portfolio; nothing was deleted.</span>
      {project.access.canEdit && (
        <Button variant="secondary" size="sm" loading={restore.isPending} onClick={() => restore.mutate({ projectId: project.id, archived: false })}>
          Restore
        </Button>
      )}
    </div>
  );
}
