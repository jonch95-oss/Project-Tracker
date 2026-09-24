"use client";

import Link from "next/link";
import { ProjectImage, pct } from "@/components/project/visuals";
import { formatMoneyCompact } from "@/core/money";
import { PROJECT_TYPE_SHORT, type ProjectTypeKey } from "@/core/labels";
import { currentPhase, daysInPhase, projectProgressBps } from "@/core/phases";
import { PROJECT_STATUS_LABEL } from "@/core/portfolio";
import { todayET } from "@/core/time";
import type { PortfolioProject } from "./portfolio-view";

export function PortfolioTable({ projects }: { projects: PortfolioProject[] }) {
  const today = todayET();
  const showFin = projects.some((p) => p.headline);
  return (
    <div className="overflow-x-auto rounded-card border border-border bg-surface">
      <table className="w-full min-w-[760px] text-sm">
        <caption className="sr-only">Projects</caption>
        <thead>
          <tr className="border-b border-border text-left text-[12px] text-muted">
            <th scope="col" className="px-4 py-3 font-medium sm:px-6">
              Project
            </th>
            <th scope="col" className="px-3 py-3 font-medium">
              Phase
            </th>
            <th scope="col" className="px-3 py-3 text-right font-medium">
              In phase
            </th>
            <th scope="col" className="px-3 py-3 text-right font-medium">
              Complete
            </th>
            <th scope="col" className="px-3 py-3 font-medium">
              Type
            </th>
            <th scope="col" className="px-3 py-3 font-medium">
              Company
            </th>
            <th scope="col" className="px-3 py-3 text-right font-medium">
              Units
            </th>
            {showFin && (
              <th scope="col" className="px-3 py-3 text-right font-medium">
                Price
              </th>
            )}
            <th scope="col" className="px-3 py-3 font-medium sm:pr-6">
              Status
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {projects.map((p) => {
            const d = daysInPhase(p.phases, today);
            return (
              <tr key={p.id} className="group transition-colors hover:bg-sunken/60">
                <td className="px-4 py-3 sm:px-6">
                  <Link href={`/projects/${p.id}`} className="flex items-center gap-3">
                    <ProjectImage photoId={p.hero?.id} address={p.address} size="thumb" className="size-10 shrink-0 rounded-control" />
                    <span className="min-w-0">
                      <span className="block truncate font-medium group-hover:underline group-hover:underline-offset-4">{p.name}</span>
                      <span className="num block truncate text-[12px] text-muted">
                        {p.address}
                        {p.bbl ? ` · ${p.bbl}` : ""}
                      </span>
                    </span>
                  </Link>
                </td>
                <td className="px-3 py-3">{currentPhase(p.phases)?.name ?? "Complete"}</td>
                <td className="num px-3 py-3 text-right">{d ?? "—"}</td>
                <td className="num px-3 py-3 text-right">{pct(projectProgressBps(p.phases, p.taskCounts))}</td>
                <td className="px-3 py-3">{PROJECT_TYPE_SHORT[p.type as ProjectTypeKey]}</td>
                <td className="px-3 py-3">{p.companyShort}</td>
                <td className="num px-3 py-3 text-right">{p.units ?? "—"}</td>
                {showFin && <td className="num px-3 py-3 text-right">{p.headline?.purchasePriceCents != null ? formatMoneyCompact(p.headline.purchasePriceCents) : "—"}</td>}
                <td className="px-3 py-3 sm:pr-6">{PROJECT_STATUS_LABEL[p.status]}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
