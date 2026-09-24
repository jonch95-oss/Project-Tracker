"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { EmptyState, ErrorState } from "@/components/ui/architecture";
import { IconPlus, IconSearch } from "@/components/ui/icons";
import { Badge, Button, Input, PageHeader, Select, Skeleton, StatusPill } from "@/components/ui/primitives";
import { VENDOR_KIND_LABEL } from "@/core/directory";
import { useTRPC } from "@/lib/trpc";
import { VendorDialog } from "./vendor-dialog";

type Kind = keyof typeof VENDOR_KIND_LABEL;

/** Module C: every company the business works with, with its trade, rating, paperwork and projects. */
export function DirectoryView() {
  const trpc = useTRPC();
  const router = useRouter();
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<Kind | "">("");
  const [archived, setArchived] = useState(false);
  const [adding, setAdding] = useState(false);
  const list = useQuery(trpc.directory.list.queryOptions({ q: q.trim() || undefined, kind: (kind || undefined) as never, archived }));

  return (
    <>
      <PageHeader
        eyebrow="Directory"
        title="Vendors & contacts"
        description="GCs, subs, consultants and lenders: licenses and COIs with their expiry dates, W-9s, people, and every project they're on."
        actions={
          list.data?.canEdit && (
            <Button onClick={() => setAdding(true)}>
              <IconPlus size={18} /> Add a company
            </Button>
          )
        }
      />
      <div className="mb-6 flex flex-wrap items-end gap-3">
        <label className="relative min-w-0 flex-1 sm:max-w-sm">
          <span className="sr-only">Search the directory</span>
          <IconSearch size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or trade" className="pl-9" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[12px] text-muted">Kind</span>
          <Select value={kind} onChange={(e) => setKind(e.target.value as Kind | "")} className="h-10 min-w-36">
            <option value="">All</option>
            {Object.entries(VENDOR_KIND_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex h-10 items-center gap-2 text-[13px] text-muted">
          <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} className="size-4 accent-[var(--accent)]" />
          Archived
        </label>
      </div>

      {list.isPending ? (
        <div className="space-y-3">
          <Skeleton className="h-20 rounded-card" />
          <Skeleton className="h-20 rounded-card" />
        </div>
      ) : list.isError ? (
        <ErrorState onRetry={() => list.refetch()} />
      ) : list.data.vendors.length === 0 ? (
        <EmptyState
          title={q || kind ? "Nothing matches" : archived ? "Nothing archived" : "The directory is empty"}
          body={q || kind ? "Try another name or trade." : "Add the companies you work with. Contracts and invoices typed under the same name link up by themselves."}
        />
      ) : (
        <ul className="divide-y divide-border rounded-card border border-border bg-surface">
          {list.data.vendors.map((v) => (
            <li key={v.id}>
              <Link href={`/directory/${v.id}`} className="flex flex-col gap-2 px-5 py-4 transition-colors hover:bg-sunken/60 sm:flex-row sm:items-center sm:gap-6 sm:px-6">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{v.name}</p>
                  <p className="truncate text-[13px] text-muted">
                    {[VENDOR_KIND_LABEL[v.kind], v.trade, v.phone].filter(Boolean).join(" · ")}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {v.rating != null && (
                    <span className="num text-[13px] text-muted" aria-label={`Rated ${v.rating} of 5`}>
                      {"★".repeat(v.rating)}
                      <span className="opacity-25">{"★".repeat(5 - v.rating)}</span>
                    </span>
                  )}
                  {v.lapsedCoi && <StatusPill tone="blocked">COI expired</StatusPill>}
                  {!v.lapsedCoi && v.expired > 0 && <StatusPill tone="blocked">{v.expired} expired</StatusPill>}
                  {v.expiringSoon > 0 && <StatusPill tone="attention">{v.expiringSoon} expiring</StatusPill>}
                  {v.hasW9 && <Badge>W-9</Badge>}
                  <Badge>
                    {v.projects} project{v.projects === 1 ? "" : "s"}
                  </Badge>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {adding && <VendorDialog vendor={null} onClose={() => setAdding(false)} onSaved={(id) => router.push(`/directory/${id}`)} />}
    </>
  );
}
