"use client";

import { useInfiniteQuery, useMutation } from "@tanstack/react-query";
import { useDeferredValue, useState } from "react";
import { EmptyState, ErrorState } from "@/components/ui/architecture";
import { IconSearch, IconShield } from "@/components/ui/icons";
import { useToast } from "@/components/ui/overlay";
import { Button, Input, PageHeader, Select, Skeleton, StatusPill } from "@/components/ui/primitives";
import { AUDIT_ACTIONS, type AuditAction } from "@/core/audit";
import { formatDateTimeET } from "@/core/time";
import { errorMessage, useTRPC } from "@/lib/trpc";

const ACTION_TONE: Partial<Record<string, "done" | "attention" | "blocked" | "neutral" | "accent">> = {
  "login.failed": "blocked",
  "user.deactivate": "blocked",
  "permission.change": "attention",
  "2fa.disable": "attention",
  approve: "done",
  reject: "blocked",
  delete: "blocked",
};

export function AuditView() {
  const trpc = useTRPC();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [action, setAction] = useState<AuditAction | "">("");
  const deferredQ = useDeferredValue(q);
  const list = useInfiniteQuery(
    trpc.audit.list.infiniteQueryOptions(
      { limit: 50, q: deferredQ || undefined, action: action || undefined },
      { getNextPageParam: (last) => last.nextCursor },
    ),
  );
  const verify = useMutation(
    trpc.audit.verify.mutationOptions({
      onSuccess: (r) =>
        r.ok ? toast("success", `Chain intact: ${r.checked.toLocaleString()} entries verified`) : toast("error", `Tampering detected at entry #${r.brokenAtSeq}: ${r.reason}`),
      onError: (e) => toast("error", errorMessage(e)),
    }),
  );
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <>
      <PageHeader
        eyebrow="Owner"
        title="Audit log"
        description="Every create, update, delete, approval, permission change, sign-in and export. Entries are append-only and hash-chained; any edit is detectable."
        actions={
          <Button variant="secondary" onClick={() => verify.mutate()} loading={verify.isPending}>
            <IconShield size={18} /> Verify integrity
          </Button>
        }
      />
      <div className="mb-6 flex flex-col gap-3 sm:flex-row">
        <div className="relative flex-1">
          <IconSearch size={18} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <Input aria-label="Search the audit log" placeholder="Search summaries" value={q} onChange={(e) => setQ(e.target.value)} className="pl-10" />
        </div>
        <div className="sm:w-60">
          <Select aria-label="Filter by action" value={action} onChange={(e) => setAction(e.target.value as AuditAction | "")}>
            <option value="">All actions</option>
            {AUDIT_ACTIONS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {list.isPending ? (
        <Skeleton className="h-96 rounded-card" />
      ) : list.isError ? (
        <ErrorState onRetry={() => list.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState title="Nothing matches" body="Try a different search or action filter." />
      ) : (
        <div className="overflow-hidden rounded-card border border-border bg-surface">
          <ol className="divide-y divide-border">
            {items.map((e) => (
              <li key={e.seq} className="grid gap-1 px-6 py-4 sm:grid-cols-[180px_1fr_auto] sm:items-center sm:gap-6">
                <time className="text-[13px] text-muted">{formatDateTimeET(e.occurredAt)}</time>
                <p className="text-sm">
                  {e.summary}
                  {e.ip && <span className="num ml-2 text-[12px] text-faint">{e.ip}</span>}
                </p>
                <div className="flex items-center gap-3">
                  <StatusPill tone={ACTION_TONE[e.action] ?? "neutral"} icon={false}>
                    {e.action}
                  </StatusPill>
                  <span className="num font-mono text-[11px] text-faint" title={`Entry hash ${e.hash}`}>
                    #{e.seq}
                  </span>
                </div>
              </li>
            ))}
          </ol>
          {list.hasNextPage && (
            <div className="border-t border-border p-4 text-center">
              <Button variant="ghost" onClick={() => list.fetchNextPage()} loading={list.isFetchingNextPage}>
                Load older entries
              </Button>
            </div>
          )}
        </div>
      )}
    </>
  );
}
