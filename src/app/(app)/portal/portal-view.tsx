"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { EmptyState, ErrorState } from "@/components/ui/architecture";
import { PageHeader, Skeleton, StatusPill } from "@/components/ui/primitives";
import { PROJECT_TYPE_LABEL, type ProjectTypeKey } from "@/core/labels";
import { formatMoney } from "@/core/money";
import { photoUrl } from "@/lib/photo-upload";
import { useTRPC } from "@/lib/trpc";

const $ = (c: number) => formatMoney(c, { whole: true });

/** Module J: an investor's or lender's projects, read-only. */
export function PortalView({ firstName }: { firstName: string }) {
  const trpc = useTRPC();
  const q = useQuery(trpc.portal.list.queryOptions());
  return (
    <>
      <PageHeader eyebrow="Investments" title={`Welcome, ${firstName}`} description="Where each project stands, its photos and schedule, the documents shared with you, and your capital account." />
      {q.isPending ? (
        <div className="grid gap-6 sm:grid-cols-2">
          <Skeleton className="h-72 rounded-card" />
          <Skeleton className="h-72 rounded-card" />
        </div>
      ) : q.isError ? (
        <ErrorState onRetry={() => q.refetch()} />
      ) : q.data.length === 0 ? (
        <EmptyState title="No projects yet" body="Projects appear here once the sponsor gives you access." />
      ) : (
        <ul className="grid gap-6 sm:grid-cols-2">
          {q.data.map((p) => (
            <li key={p.id}>
              <Link href={`/portal/${p.id}`} className="group block overflow-hidden rounded-card border border-border bg-surface transition-colors hover:border-text/30">
                <div className="aspect-[16/9] bg-sunken">
                  {p.heroPhotoId && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={photoUrl(p.heroPhotoId)} alt="" className="size-full object-cover" loading="lazy" />
                  )}
                </div>
                <div className="p-5">
                  <p className="eyebrow">{p.borough}</p>
                  <h2 className="serif mt-1 text-[24px] leading-tight">{p.name}</h2>
                  <p className="text-[13px] text-muted">
                    {p.address} · {PROJECT_TYPE_LABEL[p.type as ProjectTypeKey]}
                  </p>
                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    {p.phase.current && <StatusPill tone="accent">{p.phase.current}</StatusPill>}
                    <span className="num text-[13px] text-muted">
                      {p.phase.done} of {p.phase.total} phases done
                    </span>
                    {p.slippage && <StatusPill tone={p.slippage.includes("behind") ? "attention" : "done"}>{p.slippage}</StatusPill>}
                  </div>
                  {p.capital && (
                    <dl className="num mt-4 grid grid-cols-3 gap-2 border-t border-border pt-4 text-[13px]">
                      <div>
                        <dt className="text-muted">Committed</dt>
                        <dd className="font-medium">{$(p.capital.committed)}</dd>
                      </div>
                      <div>
                        <dt className="text-muted">Contributed</dt>
                        <dd className="font-medium">{$(p.capital.contributed)}</dd>
                      </div>
                      <div>
                        <dt className="text-muted">Distributed</dt>
                        <dd className="font-medium">{$(p.capital.distributed)}</dd>
                      </div>
                    </dl>
                  )}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
