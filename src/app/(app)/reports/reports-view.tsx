"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import { pct } from "@/components/project/visuals";
import { buttonClass, Meter, PageHeader, Select, Skeleton, StatusPill } from "@/components/ui/primitives";
import { formatMoneyCompact } from "@/core/money";
import { formatDateTimeET, formatIsoDate } from "@/core/time";
import { cn } from "@/lib/cn";
import { errorMessage, useTRPC, type RouterOutputs } from "@/lib/trpc";

type Report = RouterOutputs["reports"]["live"];
type Project = Report["projects"][number];

const day = (iso: string | null | undefined) => (iso ? formatIsoDate(iso, { month: "short", day: "numeric" }) : "");
const longDay = (iso: string) => formatIsoDate(iso, { weekday: "long", month: "long", day: "numeric", year: "numeric" });

/**
 * The weekly owner report (brief §7.8): built every Monday 7am New York and
 * kept as it stood then, with "So far this week" for the live picture. One
 * section per project: phase, progress, what moved, what's stuck, the next
 * two weeks and the headline financials. PDF from the same data.
 */
export function ReportsView() {
  const trpc = useTRPC();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const weeks = useQuery(trpc.reports.list.queryOptions());
  const chosen = params.get("week");
  const week = chosen ?? weeks.data?.[0]?.weekOf ?? "live";
  const isLive = week === "live";
  const live = useQuery({ ...trpc.reports.live.queryOptions(), enabled: weeks.isSuccess && isLive });
  const saved = useQuery({ ...trpc.reports.get.queryOptions({ weekOf: week }), enabled: !isLive });
  const report = isLive ? live : saved;

  const pick = (w: string) => router.replace(`${pathname}?week=${w}`, { scroll: false });
  return (
    <>
      <PageHeader
        eyebrow="Owner"
        title="Weekly report"
        description={isLive ? "As things stand right now: the last seven days and the next two weeks." : `Built ${report.data ? formatDateTimeET(new Date(report.data.generatedAt), { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }) : "on Monday"}. A new one arrives every Monday at 7am.`}
        actions={
          <>
            <label className="sr-only" htmlFor="report-week">
              Week
            </label>
            <Select id="report-week" value={week} onChange={(e) => pick(e.target.value)} className="min-w-52">
              <option value="live">So far this week</option>
              {(weeks.data ?? []).map((w) => (
                <option key={w.weekOf} value={w.weekOf}>
                  Week of {formatIsoDate(w.weekOf, { month: "short", day: "numeric", year: "numeric" })}
                </option>
              ))}
            </Select>
            {report.data && (
              <a href={`/api/export/reports/${week}`} className={buttonClass("secondary", "md")}>
                Download PDF
              </a>
            )}
          </>
        }
      />

      {(weeks.isPending || report.isPending) && !report.isError && (
        <div className="flex flex-col gap-6" aria-busy="true" aria-label="Loading the report">
          <Skeleton className="h-24" />
          <Skeleton className="h-72" />
          <Skeleton className="h-72" />
        </div>
      )}
      {report.isError && (
        <div role="alert" className="rounded-card border border-border bg-surface p-8 text-center">
          <p className="font-medium">The report didn&apos;t load.</p>
          <p className="mt-2 text-sm text-muted">{errorMessage(report.error)}</p>
          <button type="button" onClick={() => void report.refetch()} className={buttonClass("secondary", "sm", "mt-4")}>
            Try again
          </button>
        </div>
      )}
      {report.data && <ReportBody report={report.data} />}
      {weeks.data && weeks.data.length === 0 && isLive && report.data && (
        <p className="mt-8 text-center text-sm text-muted">The first Monday report arrives next Monday at 7am. This is the live version until then.</p>
      )}
    </>
  );
}

function ReportBody({ report }: { report: Report }) {
  const t = report.totals;
  if (report.projects.length === 0) {
    return (
      <div className="rounded-card border border-border bg-surface p-10 text-center">
        <p className="serif text-heading">No active projects</p>
        <p className="mt-2 text-sm text-muted">Once there are projects on the portfolio, each gets a section here.</p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-8">
      <p className="text-[13px] text-muted">
        {longDay(report.from)} to {longDay(report.weekOf)}, and the two weeks after.
      </p>
      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-card border border-border bg-border sm:grid-cols-3 lg:grid-cols-6">
        {(
          [
            ["Projects", t.projects],
            ["Tasks done", t.completed],
            ["Blocked", t.blocked],
            ["Overdue", t.overdue],
            ["Awaiting approval", t.awaitingApproval],
            ["Behind baseline", t.behind],
          ] as const
        ).map(([k, v]) => (
          <div key={k} className="bg-surface px-5 py-4">
            <dt className="text-[12px] text-muted">{k}</dt>
            <dd className="num serif mt-1 text-[28px] leading-8">{v}</dd>
          </div>
        ))}
      </dl>
      {report.projects.map((p) => (
        <ProjectSection key={p.id} p={p} />
      ))}
    </div>
  );
}

function ProjectSection({ p }: { p: Project }) {
  const behind = (p.slippage ?? 0) > 0;
  return (
    <section aria-labelledby={`r-${p.id}`} className="rounded-card border border-border bg-surface">
      <header className="flex flex-col gap-4 border-b border-border px-6 py-5 sm:flex-row sm:items-start sm:justify-between sm:px-8">
        <div className="min-w-0">
          <h2 id={`r-${p.id}`} className="serif text-subheading">
            <Link href={`/projects/${p.id}`} className="hover:underline">
              {p.name}
            </Link>
          </h2>
          <p className="mt-1 text-[13px] text-muted">{[p.address, p.bbl ? `BBL ${p.bbl}` : null, p.company].filter(Boolean).join(" · ")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {p.status !== "active" && <StatusPill tone="neutral">{p.status === "on_hold" ? "On hold" : "Closed"}</StatusPill>}
          {p.slippageLabel && <StatusPill tone={behind ? "attention" : "done"}>{p.slippageLabel}</StatusPill>}
          {p.stuck.ordersInForce > 0 && <StatusPill tone="blocked">{p.stuck.ordersInForce === 1 ? "1 order in force" : `${p.stuck.ordersInForce} orders in force`}</StatusPill>}
        </div>
      </header>
      <div className="grid gap-6 px-6 py-6 sm:px-8">
        <div className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-center">
          <div>
            <p className="text-[15px]">
              <span className="font-medium">{p.phase ?? "No phase started"}</span>
              <span className="text-muted">
                {" "}
                · phase {Math.min(p.phasesDone + 1, p.phasesTotal)} of {p.phasesTotal}
                {p.daysInPhase !== null ? ` · ${p.daysInPhase} day${p.daysInPhase === 1 ? "" : "s"} in phase` : ""}
              </span>
            </p>
            <div className="mt-3 max-w-md">
              <Meter valueBps={p.progressBps} tone="accent" label={`${p.name} progress`} />
            </div>
          </div>
          <p className="num serif text-[32px] leading-none">{pct(p.progressBps)}</p>
        </div>

        <div className="grid gap-6 lg:grid-cols-3">
          <Column title="What moved" empty="Nothing finished last week.">
            {p.moved.phases.map((x) => (
              <Line key={`${x.name}-${x.change}`} title={`${x.change === "started" ? "Started" : "Finished"} ${x.name}`} meta={day(x.on)} />
            ))}
            {p.moved.completed.map((x) => (
              <Line key={x.id} title={x.title} meta={[x.who, day(x.date)].filter(Boolean).join(" · ")} />
            ))}
            <More shown={p.moved.completed.length} total={p.moved.completedCount} noun="more done" />
          </Column>
          <Column title="What's stuck" empty="Nothing blocked or overdue.">
            {p.stuck.blocked.map((x) => (
              <Line key={x.id} tone="blocked" title={x.title} meta={[x.who, x.note].filter(Boolean).join(" · ") || "Blocked"} />
            ))}
            <More shown={p.stuck.blocked.length} total={p.stuck.blockedCount} noun="more blocked" />
            {p.stuck.overdue.map((x) => (
              <Line key={x.id} tone="attention" title={x.title} meta={[x.who, `due ${day(x.date)}`].filter(Boolean).join(" · ")} />
            ))}
            <More shown={p.stuck.overdue.length} total={p.stuck.overdueCount} noun="more overdue" />
            {p.stuck.awaitingApproval.map((x) => (
              <Line key={x.id} title={x.title} meta={`Awaiting approval${x.date ? ` since ${day(x.date)}` : ""}`} />
            ))}
            {p.stuck.openViolations > 0 && <Line tone="attention" title={p.stuck.openViolations === 1 ? "1 open violation" : `${p.stuck.openViolations} open violations`} meta="Public records" />}
          </Column>
          <Column title="Next 2 weeks" empty="Nothing due in the next two weeks.">
            {p.next.keyDates.map((k) => (
              <Line key={`${k.label}-${k.date}`} title={k.label} meta={`Key date · ${day(k.date)}`} />
            ))}
            {p.next.tasks.map((x) => (
              <Line key={x.id} title={x.title} meta={[x.who ?? "Unassigned", day(x.date)].join(" · ")} />
            ))}
            <More shown={p.next.tasks.length} total={p.next.tasksCount} noun="more due" />
          </Column>
        </div>

        {p.money && (
          <dl className="grid grid-cols-2 gap-4 border-t border-border pt-5 sm:grid-cols-4 lg:grid-cols-7">
            {(
              [
                ["Price", p.money.purchasePrice],
                ["Budget", p.money.totalBudget],
                ["Committed", p.money.committed],
                ["Spent", p.money.spentToDate],
                ["Forecast", p.money.forecastAtCompletion],
                ["Sellout", p.money.projectedSellout],
                ["Profit", p.money.profit],
              ] as const
            ).map(([k, v]) => (
              <div key={k} className="min-w-0">
                <dt className="text-[11px] uppercase tracking-[0.08em] text-muted">{k}</dt>
                <dd className="num truncate text-[14px] font-medium">{v == null ? "—" : formatMoneyCompact(v)}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </section>
  );
}

function Column({ title, empty, children }: { title: string; empty: string; children: ReactNode }) {
  const items = (Array.isArray(children) ? children.flat() : [children]).filter(Boolean);
  return (
    <div className="min-w-0">
      <h3 className="eyebrow mb-3">{title}</h3>
      {items.length === 0 ? <p className="text-[13px] text-muted">{empty}</p> : <ul className="flex flex-col gap-2.5">{children}</ul>}
    </div>
  );
}

function Line({ title, meta, tone }: { title: string; meta?: string; tone?: "blocked" | "attention" }) {
  return (
    <li className={cn("min-w-0 border-l-2 pl-3 text-[14px] leading-snug", tone === "blocked" ? "border-blocked" : tone === "attention" ? "border-attention" : "border-border")}>
      <span className="block">
        {tone === "blocked" && <span className="sr-only">Blocked: </span>}
        {tone === "attention" && <span className="sr-only">Needs attention: </span>}
        {title}
      </span>
      {meta && <span className="block text-[12px] text-muted">{meta}</span>}
    </li>
  );
}

function More({ shown, total, noun }: { shown: number; total: number; noun: string }) {
  if (total <= shown) return null;
  return <li className="pl-3.5 text-[12px] text-muted">+ {total - shown} {noun}</li>;
}
