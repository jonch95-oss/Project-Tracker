"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { ErrorState } from "@/components/ui/architecture";
import { Meter, PageHeader, Panel, Skeleton, StatusPill, type Tone } from "@/components/ui/primitives";
import { formatBytes, formatUsage, type UsageLevel } from "@/core/freeTier";
import { formatDateTimeET } from "@/core/time";
import { useTRPC } from "@/lib/trpc";

const LEVEL: Record<UsageLevel, { tone: Tone; label: string }> = {
  ok: { tone: "done", label: "Within limit" },
  warn: { tone: "attention", label: "Over 70%" },
  critical: { tone: "blocked", label: "Over 90%" },
  exceeded: { tone: "blocked", label: "At limit" },
};

export function SystemView() {
  const trpc = useTRPC();
  const q = useQuery({ ...trpc.system.overview.queryOptions(), refetchInterval: 60_000 });

  return (
    <>
      <PageHeader
        eyebrow="Owner"
        title="System"
        description="No added monthly cost: free tiers plus what Vercel Pro already includes. Anything past 70% of a limit shows below, and nothing upgrades automatically."
      />
      {q.isPending ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-28 rounded-card" />
          ))}
        </div>
      ) : q.isError ? (
        <ErrorState onRetry={() => q.refetch()} />
      ) : (
        <div className="flex flex-col gap-8">
          <section aria-labelledby="alerts-h">
            <h2 id="alerts-h" className="serif mb-4 text-heading">
              Needs attention
            </h2>
            {q.data.alerts.length === 0 ? (
              <p className="flex items-center gap-2 rounded-card border border-border bg-surface px-6 py-5 text-sm text-muted">
                <StatusPill tone="done">All clear</StatusPill> Every service is within its limits, jobs are running and backups are current.
              </p>
            ) : (
              <ul className="divide-y divide-border overflow-hidden rounded-card border border-border bg-surface">
                {q.data.alerts.map((a) => (
                  <li key={a.title} className="flex flex-col gap-1 px-6 py-4 sm:flex-row sm:items-start sm:gap-4">
                    <StatusPill tone={a.tone}>{a.tone === "blocked" ? "Action needed" : "Watch"}</StatusPill>
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{a.title}</p>
                      <p className="text-[13px] text-muted">{a.detail}</p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="usage-h">
            <h2 id="usage-h" className="serif mb-4 text-heading">
              Free-tier usage
            </h2>
            <ul className="grid gap-6 sm:grid-cols-2">
              {q.data.usage.map((u) => {
                const lvl = u.used === null ? { tone: "neutral" as Tone, label: "Not connected" } : LEVEL[u.level];
                return (
                  <li key={u.key} className="rounded-card border border-border bg-surface p-6">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="eyebrow">{u.service}</p>
                        <p className="mt-1 text-[15px] font-medium">{u.metric}</p>
                      </div>
                      <StatusPill tone={lvl.tone}>{lvl.label}</StatusPill>
                    </div>
                    {u.used === null ? (
                      <p className="mt-4 text-sm text-muted">
                        Limit {formatUsage(u.limit, u.unit)}. {u.note ?? "Not measured yet."}
                      </p>
                    ) : (
                      <p className="num mt-4 text-sm">
                        <span className="serif text-heading">{formatUsage(u.used, u.unit)}</span>
                        <span className="text-muted"> of {formatUsage(u.limit, u.unit)}</span>
                      </p>
                    )}
                    <div className="mt-3">
                      <Meter valueBps={u.bps} tone={lvl.tone} label={`${u.service} ${u.metric}`} />
                    </div>
                    {u.used !== null && u.note && <p className="mt-3 text-[12px] text-muted">{u.note}</p>}
                    <p className="mt-3 text-[12px] text-faint">
                      {u.period === "total" ? "Total" : u.period === "day" ? "Resets daily (UTC)" : "Resets monthly"} ·{" "}
                      <a href={u.source} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
                        limit source
                      </a>
                    </p>
                  </li>
                );
              })}
            </ul>
          </section>

          <div className="grid gap-6 xl:grid-cols-2">
            <Panel title="Scheduled jobs" description="Vercel Cron runs the hourly tick; GitHub Actions runs CI and the nightly backup. Failures appear here and under Needs attention.">
              {q.data.jobs.length === 0 ? (
                <p className="text-sm text-muted">No job runs recorded yet.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-[12px] text-muted">
                      <th className="pb-2 font-medium">Job</th>
                      <th className="pb-2 font-medium">When</th>
                      <th className="pb-2 text-right font-medium">Min</th>
                      <th className="pb-2 text-right font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {q.data.jobs.map((j) => (
                      <tr key={j.id}>
                        <td className="py-2.5 pr-2">{j.job}</td>
                        <td className="py-2.5 pr-2 text-muted">{formatDateTimeET(j.startedAt)}</td>
                        <td className="py-2.5 text-right">{j.billableMinutes}</td>
                        <td className="py-2.5 text-right">
                          <StatusPill tone={j.status === "succeeded" ? "done" : j.status === "failed" ? "blocked" : "attention"}>{j.status}</StatusPill>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Panel>

            <Panel title="Errors, last 7 days" description="Grouped by cause, from server requests, API calls and jobs.">
              {q.data.errors.length === 0 ? (
                <p className="text-sm text-muted">No errors recorded. </p>
              ) : (
                <ul className="divide-y divide-border">
                  {q.data.errors.map((e) => (
                    <li key={e.fingerprint} className="py-3">
                      <p className="text-sm font-medium">
                        <span className="num">{e.count}×</span> {e.message}
                      </p>
                      <p className="text-[12px] text-muted">
                        {e.source}
                        {e.path ? ` · ${e.path}` : ""} · last {e.lastAt ? formatDateTimeET(new Date(e.lastAt)) : "—"}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <Panel
              title="Email"
              description={
                q.data.emailEnabled
                  ? "100 per UTC day (midnight–midnight UTC), 3,000/month; sent and received mail both count. Above 80 in a UTC day, non-urgent mail is held for the next digest; stop-work and vacate alerts always send."
                  : "On hold: no sender is configured yet. Invitations and password resets are shared as on-screen links; notifications will go by push and in-app. Messages that would have been emailed are listed as skipped."
              }
              actions={q.data.emailEnabled ? <StatusPill tone="done">On</StatusPill> : <StatusPill tone="neutral">On hold</StatusPill>}
            >
              <dl className="grid grid-cols-4 gap-4 text-center">
                {(q.data.emailEnabled ? (["sent", "queued", "held", "failed"] as const) : (["skipped", "sent", "held", "failed"] as const)).map((s) => (
                  <div key={s}>
                    <dt className="text-[12px] capitalize text-muted">{s}</dt>
                    <dd className="serif num text-heading">{q.data.outbox[s] ?? 0}</dd>
                  </div>
                ))}
              </dl>
              {q.data.heldEmails.length > 0 && (
                <ul className="mt-6 divide-y divide-border border-t border-border">
                  {q.data.heldEmails.map((m) => (
                    <li key={m.id} className="py-3 text-sm">
                      <StatusPill tone={m.status === "failed" ? "blocked" : "attention"}>{m.status}</StatusPill> <span className="ml-2">{m.subject}</span>
                      <p className="text-[12px] text-muted">
                        to {m.to} · {formatDateTimeET(m.createdAt)}
                        {m.error ? ` · ${m.error}` : ""}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <Panel
              title="Backups"
              description={
                <>
                  Nightly encrypted pg_dump to a separate private Vercel Blob store, 30 kept. Neon&apos;s free restore window is only 6 hours, so these are the real backups.{" "}
                  {q.data.lastRestoreDrill ? `Last restore drill: ${formatDateTimeET(new Date(q.data.lastRestoreDrill))}.` : "No restore drill recorded yet."}
                </>
              }
            >
              {q.data.backups.length === 0 ? (
                <p className="text-sm text-muted">No backups reported yet. The nightly workflow starts once the production database and Blob store are connected.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {q.data.backups.map((b) => (
                    <li key={b.id} className="flex justify-between py-2.5 text-sm">
                      <span>{formatDateTimeET(b.createdAt)}</span>
                      <span className="num text-muted">
                        {formatBytes(b.sizeBytes)} · {b.kind}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>

          <p className="text-[13px] text-muted">
            Updated {formatDateTimeET(q.data.generatedAt)} ·{" "}
            <Link href="/system/design" className="underline underline-offset-2">
              Design system
            </Link>
          </p>
        </div>
      )}
    </>
  );
}
