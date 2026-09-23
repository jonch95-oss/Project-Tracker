"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { readProjectForm, ProjectFormFields } from "@/components/project/project-form";
import { SegmentedControl } from "@/components/project/visuals";
import { EmptyState, ErrorState } from "@/components/ui/architecture";
import { IconClose, IconPlus, IconSearch } from "@/components/ui/icons";
import { Dialog, useToast } from "@/components/ui/overlay";
import { Button, Input, PageHeader, Select, Skeleton } from "@/components/ui/primitives";
import { FieldError } from "@/core/forms";
import { PROJECT_TYPE_LABEL, type ProjectTypeKey } from "@/core/labels";
import { DEFAULT_PHASES, FLIP_PHASES, AUCTION_PHASES, currentPhase } from "@/core/phases";
import { activeFilterCount, filterProjects, filtersFromParams, PROJECT_STATUS_LABEL, PROJECT_STATUSES, type PortfolioFilters } from "@/core/portfolio";
import { errorMessage, useTRPC, type RouterOutputs } from "@/lib/trpc";
import { PortfolioCards } from "./portfolio-cards";
import { PortfolioTable } from "./portfolio-table";
import { PortfolioTimeline } from "./portfolio-timeline";

export type PortfolioProject = RouterOutputs["projects"]["list"]["projects"][number];

const PortfolioMap = dynamic(() => import("./portfolio-map").then((m) => m.PortfolioMap), {
  ssr: false,
  loading: () => <Skeleton className="h-[560px] rounded-card" />,
});

const VIEWS = ["cards", "table", "timeline", "map"] as const;
type View = (typeof VIEWS)[number];

/** Every phase name used by any project type, in track order, for the phase filter. */
const PHASE_OPTIONS = (() => {
  const seen = new Map<string, string>();
  for (const list of [DEFAULT_PHASES, AUCTION_PHASES, FLIP_PHASES]) for (const p of list) if (!seen.has(p.key)) seen.set(p.key, p.name);
  return [...seen].map(([key, name]) => ({ key, name }));
})();

export function PortfolioView({ canCreate, isOwner }: { canCreate: boolean; isOwner: boolean }) {
  const trpc = useTRPC();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const archived = params.get("archived") === "1";
  const list = useQuery(trpc.projects.list.queryOptions({ archived }));
  const companies = useQuery(trpc.companies.list.queryOptions());
  const [creating, setCreating] = useState(false);
  const pendingSearch = useRef<string | null>(null);
  const committed = params.toString();
  useEffect(() => {
    // Once the router has caught up (or the user navigated), the URL is the source of truth again.
    if (pendingSearch.current === committed) pendingSearch.current = null;
  }, [committed]);
  useEffect(() => {
    const onPop = () => {
      pendingSearch.current = null;
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const view: View = (VIEWS as readonly string[]).includes(params.get("view") ?? "") ? (params.get("view") as View) : "cards";
  const filters = filtersFromParams((k) => params.get(k));
  const setParam = (patch: Record<string, string | null>) => {
    // Build on the last URL we asked for: router.replace commits asynchronously, so several
    // quick changes (clear, then search) must not rebuild from a stale URL.
    const next = new URLSearchParams(pendingSearch.current ?? window.location.search);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    const qs = next.toString();
    pendingSearch.current = qs;
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  const projects = useMemo(
    () =>
      filterProjects(
        (list.data?.projects ?? []).map((p) => ({ ...p, currentPhaseKey: currentPhase(p.phases)?.key ?? null })),
        filters,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- filters is derived from params
    [list.data, params],
  );

  const total = list.data?.projects.length ?? 0;
  const nFilters = activeFilterCount(filters);
  const newButton = canCreate ? (
    <Button onClick={() => setCreating(true)}>
      <IconPlus size={18} /> New project
    </Button>
  ) : null;

  return (
    <>
      <PageHeader
        eyebrow="Ariel Development · Lian Development"
        title={archived ? "Archived projects" : "Portfolio"}
        description={archived ? "Projects taken off the portfolio. Nothing in them was deleted." : "Every project, where it stands, and what is stuck."}
        actions={total > 0 || archived ? newButton : null}
      />

      {list.isPending ? (
        <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3" aria-busy="true" aria-label="Loading projects">
          {[0, 1, 2].map((i) => (
            <div key={i} className="overflow-hidden rounded-card border border-border bg-surface">
              <Skeleton className="aspect-[4/3] rounded-none sm:aspect-[4/5]" />
              <div className="space-y-3 p-6">
                <Skeleton className="h-5 w-2/3" />
                <Skeleton className="h-4 w-1/3" />
              </div>
            </div>
          ))}
        </div>
      ) : list.isError ? (
        <ErrorState onRetry={() => list.refetch()} />
      ) : total === 0 && !archived ? (
        <EmptyState
          title={canCreate ? "Start your first project" : "No projects yet"}
          body={canCreate ? "Add a property to begin tracking it: its phase, photos, team and key facts." : "When you are added to a project, it will appear here."}
          action={newButton}
        />
      ) : (
        <>
          <Toolbar
            view={view}
            onView={(v) => setParam({ view: v === "cards" ? null : v })}
            filters={filters}
            onFilter={(k, v) => setParam({ [k]: v })}
            onClear={() => setParam({ phase: null, type: null, company: null, person: null, status: null, q: null })}
            companies={companies.data ?? []}
            people={list.data.people}
            nFilters={nFilters}
          />
          <p className="mb-6 text-[13px] text-muted" aria-live="polite">
            {nFilters > 0 ? `${projects.length} of ${total} projects` : `${total} ${total === 1 ? "project" : "projects"}`}
            {(isOwner || canCreate) && (
              <>
                {" · "}
                <button type="button" className="underline underline-offset-4 hover:text-text" onClick={() => setParam({ archived: archived ? null : "1" })}>
                  {archived ? "Back to the portfolio" : "Show archived"}
                </button>
              </>
            )}
          </p>

          {projects.length === 0 ? (
            <EmptyState
              title={archived && total === 0 ? "Nothing archived" : "No projects match"}
              body={archived && total === 0 ? "Archived projects will appear here." : "Try removing a filter."}
              action={
                nFilters > 0 ? (
                  <Button variant="secondary" onClick={() => setParam({ phase: null, type: null, company: null, person: null, status: null, q: null })}>
                    Clear filters
                  </Button>
                ) : null
              }
            />
          ) : view === "table" ? (
            <PortfolioTable projects={projects} />
          ) : view === "timeline" ? (
            <PortfolioTimeline projects={projects} />
          ) : view === "map" ? (
            <PortfolioMap projects={projects} />
          ) : (
            <PortfolioCards projects={projects} />
          )}
        </>
      )}

      {canCreate && <NewProjectDialog open={creating} onClose={() => setCreating(false)} showHeadline={isOwner} />}
    </>
  );
}

function Toolbar({
  view,
  onView,
  filters,
  onFilter,
  onClear,
  companies,
  people,
  nFilters,
}: {
  view: View;
  onView: (v: View) => void;
  filters: PortfolioFilters;
  onFilter: (k: keyof PortfolioFilters, v: string | null) => void;
  onClear: () => void;
  companies: { id: string; shortName: string; name: string }[];
  people: { id: string; name: string }[];
  nFilters: number;
}) {
  const [q, setQ] = useState(filters.q ?? "");
  const [showFilters, setShowFilters] = useState(nFilters > 0 && !filters.q);
  return (
    <div className="mb-4 flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <form
          role="search"
          className="relative min-w-0 flex-1 sm:max-w-sm"
          onSubmit={(e) => {
            e.preventDefault();
            onFilter("q", q.trim() || null);
          }}
        >
          <IconSearch size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <label htmlFor="portfolio-q" className="sr-only">
            Search projects
          </label>
          <Input
            id="portfolio-q"
            type="search"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              if (e.target.value === "") onFilter("q", null);
            }}
            onBlur={() => onFilter("q", q.trim() || null)}
            placeholder="Name, address or BBL"
            className="h-10 pl-9"
          />
        </form>
        <Button variant="secondary" onClick={() => setShowFilters((s) => !s)} aria-expanded={showFilters} aria-controls="portfolio-filters">
          Filters{nFilters - (filters.q ? 1 : 0) > 0 ? ` · ${nFilters - (filters.q ? 1 : 0)}` : ""}
        </Button>
        <SegmentedControl<View>
          label="View"
          value={view}
          onChange={onView}
          className="max-sm:w-full max-sm:[&>button]:flex-1 max-sm:[&>button]:justify-center"
          items={[
            { key: "cards", label: "Cards" },
            { key: "table", label: "Table" },
            { key: "timeline", label: "Timeline" },
            { key: "map", label: "Map" },
          ]}
        />
      </div>
      <div id="portfolio-filters" hidden={!showFilters} className="grid grid-cols-2 gap-3 rounded-panel border border-border bg-surface p-4 sm:grid-cols-3 lg:grid-cols-6">
        <FilterSelect label="Phase" value={filters.phase} onChange={(v) => onFilter("phase", v)} options={PHASE_OPTIONS.map((p) => [p.key, p.name])} />
        <FilterSelect label="Type" value={filters.type} onChange={(v) => onFilter("type", v)} options={Object.entries(PROJECT_TYPE_LABEL) as [ProjectTypeKey, string][]} />
        <FilterSelect label="Company" value={filters.company} onChange={(v) => onFilter("company", v)} options={companies.map((c) => [c.id, c.shortName])} />
        {people.length > 0 && <FilterSelect label="Person" value={filters.person} onChange={(v) => onFilter("person", v)} options={people.map((p) => [p.id, p.name])} />}
        <FilterSelect label="Status" value={filters.status} onChange={(v) => onFilter("status", v)} options={PROJECT_STATUSES.map((s) => [s, PROJECT_STATUS_LABEL[s]])} />
        <div className="flex items-end">
          <Button variant="ghost" onClick={onClear} disabled={nFilters === 0} className="w-full">
            <IconClose size={16} /> Clear
          </Button>
        </div>
      </div>
    </div>
  );
}

function FilterSelect({ label, value, onChange, options }: { label: string; value: string | null | undefined; onChange: (v: string | null) => void; options: [string, string][] }) {
  const id = `filter-${label.toLowerCase()}`;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-[12px] font-medium text-muted">
        {label}
      </label>
      <Select id={id} value={value ?? ""} onChange={(e) => onChange(e.target.value || null)} className="h-10 text-[14px]">
        <option value="">All</option>
        {options.map(([k, v]) => (
          <option key={k} value={k}>
            {v}
          </option>
        ))}
      </Select>
    </div>
  );
}

function NewProjectDialog({ open, onClose, showHeadline }: { open: boolean; onClose: () => void; showHeadline: boolean }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const router = useRouter();
  const toast = useToast();
  const companies = useQuery({ ...trpc.companies.list.queryOptions(), enabled: open });
  const [fieldError, setFieldError] = useState<FieldError | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped after each create so the next open starts with an empty form.
  const [formKey, setFormKey] = useState(0);
  const create = useMutation(
    trpc.projects.create.mutationOptions({
      onSuccess: async ({ id }) => {
        setFormKey((k) => k + 1);
        await qc.invalidateQueries({ queryKey: trpc.projects.list.queryKey() });
        toast("success", "Project created");
        onClose();
        router.push(`/projects/${id}`);
      },
      onError: (e) => setError(errorMessage(e)),
    }),
  );

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setFieldError(null);
    try {
      const v = readProjectForm(e.currentTarget);
      create.mutate({
        name: v.name,
        address: v.address,
        borough: v.borough,
        bbl: v.bbl,
        type: v.type,
        companyId: v.companyId,
        facts: v.facts,
        headline: showHeadline ? v.headline : undefined,
      });
    } catch (err) {
      if (err instanceof FieldError) setFieldError(err);
      else throw err;
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New project"
      description="The property first. Checklists arrive with templates; you can add photos and the team right after."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="new-project" loading={create.isPending}>
            Create project
          </Button>
        </>
      }
    >
      <form key={formKey} id="new-project" onSubmit={onSubmit} noValidate={false}>
        <ProjectFormFields idPrefix="np" mode="create" companies={companies.data} fieldError={fieldError} showHeadline={showHeadline} />
        {error && (
          <p role="alert" className="mt-4 text-[13px] text-blocked-text">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
