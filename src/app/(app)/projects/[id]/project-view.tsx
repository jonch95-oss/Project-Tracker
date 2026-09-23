"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AddressPlaceholder, EmptyState, ErrorState } from "@/components/ui/architecture";
import { IconArrowLeft } from "@/components/ui/icons";
import { Badge, Skeleton, StatusPill } from "@/components/ui/primitives";
import { TabPanel, Tabs } from "@/components/ui/tabs";
import { PROJECT_TYPE_LABEL, type ProjectTypeKey } from "@/core/labels";
import { useTRPC } from "@/lib/trpc";
import { TeamTab } from "./team-tab";

type TabKey = "overview" | "team";

export function ProjectView({ projectId }: { projectId: string }) {
  const trpc = useTRPC();
  const project = useQuery(trpc.projects.get.queryOptions({ projectId }));
  // The tab lives in the URL so it survives reloads and can be linked to.
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const tab: TabKey = params.get("tab") === "team" ? "team" : "overview";
  const setTab = (next: TabKey) => router.replace(next === "overview" ? pathname : `${pathname}?tab=${next}`, { scroll: false });

  if (project.isPending) {
    return (
      <div aria-busy="true">
        <Skeleton className="mb-8 h-[320px] rounded-card sm:h-[420px]" />
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
  return (
    <article>
      <Link href="/portfolio" className="mb-6 inline-flex items-center gap-2 text-sm text-muted hover:text-text">
        <IconArrowLeft size={16} /> Portfolio
      </Link>

      <div className="-mx-4 overflow-hidden border-y border-border sm:mx-0 sm:rounded-card sm:border">
        <AddressPlaceholder address={p.address} borough={p.borough} size="hero" className="h-[320px] sm:h-[440px]" />
      </div>

      <header className="mt-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <p className="eyebrow mb-2">{p.companyName}</p>
          <h1 className="serif text-title sm:text-display">{p.name}</h1>
          <p className="mt-2 text-[15px] text-muted">
            {PROJECT_TYPE_LABEL[p.type as ProjectTypeKey]}
            {p.bbl && <span className="num"> · BBL {p.bbl}</span>}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {p.access.projectRole && <Badge>{p.access.projectRole}</Badge>}
          {p.access.canViewFinancials && <StatusPill tone="accent">Financials visible</StatusPill>}
        </div>
      </header>

      <Tabs<TabKey>
        idBase="project-tabs"
        label="Project sections"
        className="mt-10"
        value={tab}
        onChange={setTab}
        items={[
          { key: "overview", label: "Overview" },
          { key: "team", label: "Team" },
        ]}
      />

      <TabPanel idBase="project-tabs" tab={tab} className="mt-8 focus-visible:outline-offset-8">
        {tab === "overview" ? (
          <EmptyState
            title="The project is set up"
            body="Phases, checklists, key dates and the rest of the project page arrive in the next milestones. Add the team now so everyone is ready."
          />
        ) : (
          <TeamTab projectId={projectId} canManage={p.access.canManageMembers} />
        )}
      </TabPanel>
    </article>
  );
}
