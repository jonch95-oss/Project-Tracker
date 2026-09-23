"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { AddressPlaceholder, EmptyState, ErrorState } from "@/components/ui/architecture";
import { IconPlus } from "@/components/ui/icons";
import { Dialog, useToast } from "@/components/ui/overlay";
import { Badge, Button, Field, Input, PageHeader, Select, Skeleton } from "@/components/ui/primitives";
import { BOROUGHS, PROJECT_TYPE_LABEL, PROJECT_TYPE_SHORT, type ProjectTypeKey } from "@/core/labels";
import { errorMessage, useTRPC } from "@/lib/trpc";

export function PortfolioView({ canCreate }: { canCreate: boolean }) {
  const trpc = useTRPC();
  const projects = useQuery(trpc.projects.list.queryOptions());
  const [creating, setCreating] = useState(false);

  const newButton = canCreate ? (
    <Button onClick={() => setCreating(true)}>
      <IconPlus size={18} /> New project
    </Button>
  ) : null;

  return (
    <>
      <PageHeader
        eyebrow="Ariel Development · Lian Development"
        title="Portfolio"
        description="Every project, where it stands, and what is stuck."
        actions={projects.data && projects.data.length > 0 ? newButton : null}
      />

      {projects.isPending ? (
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
      ) : projects.isError ? (
        <ErrorState onRetry={() => projects.refetch()} />
      ) : projects.data.length === 0 ? (
        <EmptyState
          title={canCreate ? "Start your first project" : "No projects yet"}
          body={
            canCreate
              ? "Add a property to begin tracking it: its phase, checklist, team and key dates."
              : "When you are added to a project, it will appear here."
          }
          action={newButton}
        />
      ) : (
        <ul className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
          {projects.data.map((p) => (
            <li key={p.id}>
              <Link
                href={`/projects/${p.id}`}
                className="group block overflow-hidden rounded-card border border-border bg-surface transition-[transform,box-shadow] duration-200 ease-quiet hover:-translate-y-0.5 hover:shadow-lift"
              >
                <AddressPlaceholder address={p.address} borough={p.borough} className="aspect-[4/3] sm:aspect-[4/5]" />
                <div className="flex items-start justify-between gap-4 border-t border-border p-6">
                  <div className="min-w-0">
                    <h2 className="truncate text-[15px] font-medium">{p.name}</h2>
                    <p className="mt-1 truncate text-[13px] text-muted">
                      {p.companyShort}
                      {p.bbl ? <span className="num"> · BBL {p.bbl}</span> : null}
                    </p>
                  </div>
                  <Badge>{PROJECT_TYPE_SHORT[p.type as ProjectTypeKey]}</Badge>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {canCreate && <NewProjectDialog open={creating} onClose={() => setCreating(false)} />}
    </>
  );
}

function NewProjectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const router = useRouter();
  const toast = useToast();
  const companies = useQuery({ ...trpc.companies.list.queryOptions(), enabled: open });
  const [error, setError] = useState<string | null>(null);
  const create = useMutation(
    trpc.projects.create.mutationOptions({
      onSuccess: async ({ id }) => {
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
    const f = new FormData(e.currentTarget);
    const bbl = String(f.get("bbl") ?? "").replace(/\D/g, "");
    create.mutate({
      name: String(f.get("name")),
      address: String(f.get("address")),
      borough: String(f.get("borough")) as (typeof BOROUGHS)[number],
      bbl: bbl || null,
      type: String(f.get("type")) as ProjectTypeKey,
      companyId: String(f.get("companyId")),
    });
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New project"
      description="Templates, phases and checklists arrive in the next milestone; start with the property itself."
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
      <form id="new-project" onSubmit={onSubmit} className="grid gap-5 sm:grid-cols-2">
        <Field label="Project name" htmlFor="np-name" className="sm:col-span-2">
          <Input id="np-name" name="name" required maxLength={160} placeholder="e.g. Sterling Place Townhouse" />
        </Field>
        <Field label="Address" htmlFor="np-address" className="sm:col-span-2">
          <Input id="np-address" name="address" required maxLength={200} placeholder="412 Sterling Place" autoComplete="off" />
        </Field>
        <Field label="Borough" htmlFor="np-borough">
          <Select id="np-borough" name="borough" defaultValue="Brooklyn">
            {BOROUGHS.map((b) => (
              <option key={b}>{b}</option>
            ))}
          </Select>
        </Field>
        <Field label="BBL" htmlFor="np-bbl" hint="10 digits, e.g. 3011370045. Optional for now.">
          <Input id="np-bbl" name="bbl" inputMode="numeric" pattern="[1-5][0-9]{9}" maxLength={10} className="num" />
        </Field>
        <Field label="Project type" htmlFor="np-type" className="sm:col-span-2">
          <Select id="np-type" name="type" defaultValue="ground_up_condo">
            {Object.entries(PROJECT_TYPE_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Company" htmlFor="np-company" className="sm:col-span-2" error={error}>
          <Select id="np-company" name="companyId" required>
            {companies.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
      </form>
    </Dialog>
  );
}
