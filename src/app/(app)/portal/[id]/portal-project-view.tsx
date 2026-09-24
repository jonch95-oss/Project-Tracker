"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ErrorState } from "@/components/ui/architecture";
import { IconArrowLeft } from "@/components/ui/icons";
import { Panel, Select, Skeleton, StatusPill } from "@/components/ui/primitives";
import { PROJECT_TYPE_LABEL, type ProjectTypeKey } from "@/core/labels";
import { formatMoney } from "@/core/money";
import { formatIsoDate, todayET } from "@/core/time";
import { quarterBounds, quarterOf } from "@/core/waterfall";
import { cn } from "@/lib/cn";
import { photoUrl } from "@/lib/photo-upload";
import { useTRPC } from "@/lib/trpc";
import { FilesTab } from "../../projects/[id]/files-tab";

const $ = (c: number | null | undefined) => (c == null ? "—" : formatMoney(c, { whole: true }));
const d = (iso: string | null | undefined) => (iso ? formatIsoDate(iso, { month: "short", day: "numeric", year: "numeric" }) : "—");

/** Module J: one project as an investor or lender sees it. */
export function PortalProjectView({ projectId }: { projectId: string }) {
  const trpc = useTRPC();
  const q = useQuery(trpc.portal.project.queryOptions({ projectId }));
  const [quarter, setQuarter] = useState(quarterOf(todayET(), -1));
  const [photo, setPhoto] = useState<string | null>(null);
  useEffect(() => {
    if (!photo) return;
    const close = (e: KeyboardEvent) => e.key === "Escape" && setPhoto(null);
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [photo]);
  if (q.isPending) return <Skeleton className="h-[70vh] rounded-card" />;
  if (q.isError) return <ErrorState onRetry={() => q.refetch()} />;
  const { project: p, phase, progress, schedule, photos, accounts, canSeeAccount } = q.data;
  const quarters = [-1, 0, -2, -3, -4].map((o) => quarterOf(todayET(), o));

  return (
    <>
      <Link href="/portal" className="mb-6 inline-flex items-center gap-2 text-[13px] text-muted hover:text-text">
        <IconArrowLeft size={16} /> Investments
      </Link>
      <header className="mb-10 overflow-hidden rounded-card border border-border bg-surface">
        {p.heroPhotoId && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={photoUrl(p.heroPhotoId, "full")} alt="" className="aspect-[21/9] w-full object-cover" />
        )}
        <div className="flex flex-col gap-4 p-6 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="eyebrow">{p.borough}</p>
            <h1 className="serif mt-1 text-title">{p.name}</h1>
            <p className="text-[14px] text-muted">
              {p.address} · {PROJECT_TYPE_LABEL[p.type as ProjectTypeKey]}
            </p>
          </div>
          <div className="flex items-end gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-[12px] text-muted">Quarterly report</span>
              <Select value={quarter} onChange={(e) => setQuarter(e.target.value)} className="h-9 text-[13px]">
                {quarters.map((x) => (
                  <option key={x} value={x}>
                    {quarterBounds(x)!.label}
                  </option>
                ))}
              </Select>
            </label>
            <a href={`/api/export/projects/${projectId}/investor-report?quarter=${quarter}`} className="inline-flex h-9 items-center rounded-control border border-control px-3 text-[13px] font-medium hover:bg-sunken">
              Download PDF
            </a>
          </div>
        </div>
      </header>

      <div className="grid gap-8 lg:grid-cols-[2fr_1fr]">
        <div className="flex flex-col gap-8">
          <Panel title="Progress" description={`${progress}% of the checklist is done.`}>
            <ol className="flex flex-wrap gap-2">
              {phase.phases.map((x) => (
                <li key={x.name} className={cn("rounded-full border px-3 py-1 text-[13px]", x.status === "active" ? "border-accent bg-accent-tint text-accent-text" : x.status === "done" ? "border-border text-muted" : "border-border text-faint")}>
                  {x.status === "done" ? "✓ " : ""}
                  {x.name}
                </li>
              ))}
            </ol>
          </Panel>

          <Panel title="Photos">
            {photos.length === 0 ? (
              <p className="text-[13px] text-muted">No photos shared yet.</p>
            ) : (
              <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                {photos.map((ph) => (
                  <li key={ph.id}>
                    <button type="button" onClick={() => setPhoto(ph.id)} className="block aspect-square w-full overflow-hidden rounded-control bg-sunken" aria-label={ph.caption ?? `Photo from ${d((ph.takenAt ?? ph.createdAt).toString().slice(0, 10))}`}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={photoUrl(ph.id)} alt="" className="size-full object-cover" loading="lazy" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <section>
            <h2 className="serif mb-4 text-heading">Documents</h2>
            <FilesTab projectId={projectId} onOpenPhotos={() => undefined} />
          </section>
        </div>

        <aside className="flex flex-col gap-8">
          <Panel title="Schedule">
            <dl className="num flex flex-col gap-3 text-[14px]">
              <div className="flex justify-between gap-3">
                <dt className="text-muted">Forecast finish</dt>
                <dd className="font-medium">{d(schedule.forecastFinish)}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted">Baseline finish</dt>
                <dd>{d(schedule.baselineFinish)}</dd>
              </div>
              {schedule.slippage && (
                <div className="flex justify-between gap-3">
                  <dt className="text-muted">Against baseline</dt>
                  <dd>
                    <StatusPill tone={schedule.slippage.includes("behind") ? "attention" : "done"}>{schedule.slippage}</StatusPill>
                  </dd>
                </div>
              )}
            </dl>
          </Panel>

          {canSeeAccount &&
            (accounts.length === 0 ? (
              <Panel title="Your capital account">
                <p className="text-[13px] text-muted">The sponsor hasn&apos;t linked your account on this project yet.</p>
              </Panel>
            ) : (
              accounts.map((a) => (
                <Panel key={a.investorName} title="Your capital account" description={a.investorName}>
                  <dl className="num flex flex-col gap-2 text-[14px]">
                    {(
                      [
                        ["Committed", a.account.committed],
                        ["Contributed", a.account.contributed],
                        ["Unfunded", a.account.unfunded],
                        ["Distributed", a.account.distributed],
                        ["Still invested", a.account.unreturned],
                        ...(a.account.prefOwed !== null ? [["Pref accrued, unpaid", a.account.prefOwed] as [string, number]] : []),
                      ] as [string, number][]
                    ).map(([k, v]) => (
                      <div key={k} className="flex justify-between gap-3">
                        <dt className="text-muted">{k}</dt>
                        <dd className="font-medium">{$(v)}</dd>
                      </div>
                    ))}
                  </dl>
                  {a.calls.length > 0 && (
                    <>
                      <h3 className="eyebrow mb-2 mt-6">Capital calls</h3>
                      <ul className="num flex flex-col gap-1 text-[13px]">
                        {a.calls.map((x) => (
                          <li key={x.number} className="flex justify-between gap-2">
                            <span>
                              #{x.number} · due {d(x.dueOn)}
                            </span>
                            <span className={x.receivedCents >= x.amountCents ? "text-done-text" : x.dueOn < todayET() ? "text-blocked-text" : "text-muted"}>
                              {$(x.receivedCents)} / {$(x.amountCents)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                  {a.distributions.length > 0 && (
                    <>
                      <h3 className="eyebrow mb-2 mt-6">Distributions</h3>
                      <ul className="num flex flex-col gap-1 text-[13px]">
                        {a.distributions.map((x) => (
                          <li key={x.number} className="flex justify-between gap-2">
                            <span>
                              #{x.number} · {d(x.paidOn)}
                            </span>
                            <span>{$(x.rocCents + x.prefCents + x.profitCents)}</span>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                  <h3 className="eyebrow mb-2 mt-6">Waterfall</h3>
                  <ol className="list-decimal space-y-1 pl-5 text-[13px] text-muted">
                    {a.waterfall.map((t) => (
                      <li key={t}>{t}</li>
                    ))}
                  </ol>
                </Panel>
              ))
            ))}
        </aside>
      </div>

      {photo && (
        <div role="dialog" aria-modal="true" aria-label="Photo" className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={() => setPhoto(null)}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={photoUrl(photo, "full")} alt="" className="max-h-full max-w-full rounded-control object-contain" />
        </div>
      )}
    </>
  );
}
