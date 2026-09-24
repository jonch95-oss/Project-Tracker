"use client";

import Link from "next/link";
import { HeadlineFigures, PhaseTrack, ProjectImage, pct } from "@/components/project/visuals";
import { Badge, StatusPill } from "@/components/ui/primitives";
import { PROJECT_TYPE_SHORT, type ProjectTypeKey } from "@/core/labels";
import { daysInPhase, projectProgressBps } from "@/core/phases";
import { PROJECT_STATUS_LABEL } from "@/core/portfolio";
import { todayET } from "@/core/time";
import type { PortfolioProject } from "./portfolio-view";

/** Tall photo cards (brief §7.1). Task-driven fields (next action, blockers, overdue) join in Milestone 4. */
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
                {p.headline && <HeadlineFigures headline={p.headline} className="mt-4 border-t border-border pt-4" />}
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
