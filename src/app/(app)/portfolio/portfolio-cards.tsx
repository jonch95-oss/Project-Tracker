"use client";

import Link from "next/link";
import { HeadlineFigures, PhaseTrack, ProjectImage, pct } from "@/components/project/visuals";
import { Badge, StatusPill } from "@/components/ui/primitives";
import { PROJECT_TYPE_SHORT, type ProjectTypeKey } from "@/core/labels";
import { daysInPhase, projectProgressBps } from "@/core/phases";
import { PROJECT_STATUS_LABEL } from "@/core/portfolio";
import { formatIsoDate, todayET } from "@/core/time";
import { slippageLabel } from "@/core/schedule";
import { IconAlert, IconBlocked, IconCalendar, IconClock, IconFlag, IconShield } from "@/components/ui/icons";
import type { PortfolioProject } from "./portfolio-view";

/** Tall photo cards (brief §7.1). */
export function PortfolioCards({ projects }: { projects: PortfolioProject[] }) {
  const today = todayET();
  return (
    <ul className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
      {projects.map((p, i) => {
        const days = daysInPhase(p.phases, today);
        return (
          <li key={p.id} className="h-full">
            <Link
              href={`/projects/${p.id}`}
              className="group block h-full overflow-hidden rounded-card border border-border bg-surface transition-[transform,box-shadow] duration-200 ease-quiet hover:-translate-y-0.5 hover:shadow-lift focus-visible:-translate-y-0.5"
            >
              <div className="relative">
                <ProjectImage photoId={p.hero?.id} address={p.address} borough={p.borough} className="aspect-[4/3] sm:aspect-[4/5]" priority={i < 3} />
                {p.status !== "active" && (
                  <StatusPill tone={p.status === "on_hold" ? "attention" : "neutral"} className="absolute left-4 top-4 shadow-sm">
                    {PROJECT_STATUS_LABEL[p.status]}
                  </StatusPill>
                )}
              </div>
              <div className="border-t border-border p-6">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <h2 className="truncate text-[15px] font-medium">{p.name}</h2>
                    <p className="mt-1 truncate text-[13px] text-muted">
                      {p.address}
                      {p.bbl ? <span className="num"> · BBL {p.bbl}</span> : null}
                    </p>
                  </div>
                  <Badge>{PROJECT_TYPE_SHORT[p.type as ProjectTypeKey]}</Badge>
                </div>
                <PhaseTrack phases={p.phases} className="mt-5" />
                <dl className="mt-4 grid grid-cols-3 gap-3 text-[13px]">
                  <div>
                    <dt className="text-muted">Complete</dt>
                    <dd className="num font-medium">{pct(projectProgressBps(p.phases, p.taskCounts))}</dd>
                  </div>
                  <div>
                    <dt className="text-muted">In phase</dt>
                    <dd className="num font-medium">{days == null ? "—" : `${days} ${days === 1 ? "day" : "days"}`}</dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-muted">Company</dt>
                    <dd className="truncate font-medium">{p.companyShort}</dd>
                  </div>
                </dl>
                <div className="mt-4 border-t border-border pt-4 text-[13px]">
                  <p className="text-muted">Next action</p>
                  {p.facts.nextAction ? (
                    <p className="mt-0.5 line-clamp-2 font-medium leading-snug">
                      {p.facts.nextAction.title}
                      <span className="font-normal text-muted"> · {p.facts.nextAction.assigneeName ?? "Unassigned"}</span>
                    </p>
                  ) : (
                    <p className="mt-0.5 text-muted">Nothing open</p>
                  )}
                  {(p.facts.blocked > 0 || p.facts.overdue > 0 || p.facts.nextKeyDate || p.facts.expired > 0 || p.facts.ordersInForce > 0 || p.facts.coiFlags.length > 0 || p.facts.openViolations > 0 || (p.facts.slippage !== null && p.facts.slippage !== 0)) && (
                    <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
                      {p.facts.ordersInForce > 0 && (
                        <span className="inline-flex items-center gap-1 font-semibold text-blocked-text">
                          <IconAlert size={14} /> {p.facts.ordersInForce === 1 ? "Stop-work or vacate order" : `${p.facts.ordersInForce} stop-work / vacate orders`}
                        </span>
                      )}
                      {p.facts.slippage !== null && p.facts.slippage !== 0 && (
                        <span className={`num inline-flex items-center gap-1 font-medium ${p.facts.slippage > 0 ? "text-attention-text" : "text-done"}`}>
                          <IconCalendar size={14} /> {slippageLabel(p.facts.slippage)}
                        </span>
                      )}
                      {p.facts.expired > 0 && (
                        <span className="num inline-flex items-center gap-1 font-medium text-blocked-text">
                          <IconClock size={14} /> {p.facts.expired} expired
                        </span>
                      )}
                      {p.facts.coiFlags.length > 0 && (
                        <span className="inline-flex items-center gap-1 font-medium text-blocked-text" title={p.facts.coiFlags.join(", ")}>
                          <IconShield size={14} /> COI expired: {p.facts.coiFlags.slice(0, 2).join(", ")}
                          {p.facts.coiFlags.length > 2 ? ` +${p.facts.coiFlags.length - 2}` : ""}
                        </span>
                      )}
                      {p.facts.openViolations > 0 && (
                        <span className="num inline-flex items-center gap-1 text-attention-text">
                          <IconFlag size={14} /> {p.facts.openViolations} open violation{p.facts.openViolations === 1 ? "" : "s"}
                        </span>
                      )}
                      {p.facts.blocked > 0 && (
                        <span className="num inline-flex items-center gap-1 font-medium text-blocked-text">
                          <IconBlocked size={14} /> {p.facts.blocked} blocked
                        </span>
                      )}
                      {p.facts.overdue > 0 && (
                        <span className="num inline-flex items-center gap-1 font-medium text-attention-text">
                          <IconAlert size={14} /> {p.facts.overdue} overdue
                        </span>
                      )}
                      {p.facts.nextKeyDate && (
                        <span className="inline-flex items-center gap-1 text-muted">
                          <IconCalendar size={14} /> {p.facts.nextKeyDate.label} <span className="num">{formatIsoDate(p.facts.nextKeyDate.date, { month: "short", day: "numeric", year: p.facts.nextKeyDate.date.slice(0, 4) === today.slice(0, 4) ? undefined : "numeric" })}</span>
                        </span>
                      )}
                    </p>
                  )}
                </div>
                {p.headline && <HeadlineFigures headline={p.headline} className="mt-4 border-t border-border pt-4" />}
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
