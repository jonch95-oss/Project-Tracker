"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { addDays, daysBetween, formatIsoDate, todayET } from "@/core/time";
import { phaseSpans } from "@/core/phases";
import { cn } from "@/lib/cn";
import type { PortfolioProject } from "./portfolio-view";

const DAY_PX = 3;
const LABEL_W = 220;

/**
 * Phase Gantt across all projects (brief §7.1): each row is a project, each
 * bar a phase from the day it started to the day it finished (the current
 * phase runs to today). Planned dates join with the schedule module (M9).
 */
export function PortfolioTimeline({ projects }: { projects: PortfolioProject[] }) {
  const today = todayET();
  const scroller = useRef<HTMLDivElement>(null);
  // Open on today, with the recent past in view.
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [projects]);
  const rows = projects.map((p) => ({ p, spans: phaseSpans(p.phases, today) }));
  const starts = rows.flatMap((r) => r.spans.map((s) => s.start));
  if (starts.length === 0) return null;
  const first = starts.reduce((a, b) => (a < b ? a : b));
  // Start on the first of the month, at least 30 days before today, end two weeks out.
  const minStart = first < addDays(today, -30) ? first : addDays(today, -30);
  const origin = `${minStart.slice(0, 7)}-01`;
  const end = addDays(today, 14);
  const totalDays = daysBetween(origin, end) + 1;
  const width = Math.max(totalDays * DAY_PX, 640);
  const x = (d: string) => (daysBetween(origin, d) / totalDays) * width;

  const months: string[] = [];
  for (let m = origin; m <= end; m = nextMonth(m)) months.push(m);

  return (
    <div className="overflow-hidden rounded-card border border-border bg-surface">
      <div ref={scroller} className="overflow-x-auto" tabIndex={0} role="region" aria-label="Phase timeline, scrolls sideways">
        <div style={{ width: LABEL_W + width }} className="relative">
          {/* Month axis */}
          <div className="sticky top-0 flex border-b border-border text-[11px] text-muted" style={{ paddingLeft: LABEL_W }}>
            <div className="relative h-9" style={{ width }}>
              {months.map((m) => (
                <span key={m} className="absolute top-0 flex h-full items-center border-l border-border pl-2" style={{ left: x(m) }}>
                  {formatIsoDate(m, { month: "short", year: m.endsWith("-01-01") || m === months[0] ? "numeric" : undefined, day: undefined })}
                </span>
              ))}
            </div>
          </div>
          <ul className="relative">
            {/* Today line */}
            <li aria-hidden="true" className="pointer-events-none absolute inset-y-0 z-10 w-px bg-blocked/60" style={{ left: LABEL_W + x(today) }} />
            {rows.map(({ p, spans }) => (
              <li key={p.id} className="flex items-center border-b border-border last:border-0">
                <Link
                  href={`/projects/${p.id}`}
                  className="sticky left-0 z-20 flex h-14 shrink-0 flex-col justify-center border-r border-border bg-surface px-4 hover:underline hover:underline-offset-4"
                  style={{ width: LABEL_W }}
                >
                  <span className="truncate text-[13px] font-medium">{p.name}</span>
                  <span className="truncate text-[11px] text-muted">{p.address}</span>
                </Link>
                <div className="relative h-14" style={{ width }}>
                  {spans.map((s, i) => {
                    const left = x(s.start);
                    const w = Math.max(x(addDays(s.end, 1)) - left, 4);
                    return (
                      <div
                        key={s.key}
                        title={`${s.name}: ${formatIsoDate(s.start)} – ${s.status === "active" ? "today" : formatIsoDate(s.end)}`}
                        className={cn(
                          "absolute top-1/2 flex h-7 -translate-y-1/2 items-center overflow-hidden rounded-[6px] px-2 text-[11px] font-medium",
                          s.status === "active" ? "bg-accent text-on-accent" : i % 2 ? "bg-text/25 text-text" : "bg-text/15 text-text",
                        )}
                        style={{ left, width: w }}
                      >
                        {w > 70 && <span className="truncate">{s.name}</span>}
                      </div>
                    );
                  })}
                  <span className="sr-only">
                    {spans.map((s) => `${s.name} from ${formatIsoDate(s.start)} to ${s.status === "active" ? "today" : formatIsoDate(s.end)}`).join("; ")}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <p className="flex flex-wrap items-center gap-4 border-t border-border px-4 py-3 text-[12px] text-muted">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-4 rounded-[3px] bg-accent" /> Current phase
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-4 rounded-[3px] bg-text/20" /> Finished phase
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-3 w-px bg-blocked/60" /> Today
        </span>
      </p>
    </div>
  );
}

function nextMonth(iso: string): string {
  const [y, m] = iso.split("-").map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
}
