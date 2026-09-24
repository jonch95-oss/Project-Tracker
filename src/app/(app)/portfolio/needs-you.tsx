"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import type { ReactNode } from "react";
import { IconAlert, IconBlocked, IconCalendar, IconCheckCircle, IconClock, IconFlag } from "@/components/ui/icons";
import { useToast } from "@/components/ui/overlay";
import { Button } from "@/components/ui/primitives";
import { daysBetween, formatIsoDate, todayET } from "@/core/time";
import { useInvalidateTaskViews } from "@/lib/task-cache";
import { errorMessage, useTRPC } from "@/lib/trpc";

const taskHref = (projectId: string, taskId: string) => `/projects/${projectId}?tab=checklist&task=${taskId}`;

/**
 * "Needs you" (brief §7.1): approvals waiting on me, blocked tasks, overdue
 * by person, public-record alerts and key dates in the next 14 days. Only
 * sections with something in them are shown; nothing at all shows a calm line.
 */
export function NeedsYouRail() {
  const trpc = useTRPC();
  const invalidate = useInvalidateTaskViews();
  const toast = useToast();
  const q = useQuery(trpc.tasks.needsYou.queryOptions());
  const decide = useMutation(
    trpc.tasks.decide.mutationOptions({
      onSuccess: () => toast("success", "Approved"),
      onError: (e) => toast("error", errorMessage(e)),
      onSettled: () => invalidate(),
    }),
  );
  if (!q.data) return null;
  const d = q.data;
  const today = todayET();
  const empty = !d.approvals.length && !d.blocked.length && !d.overdueByPerson.length && !d.keyDates.length && !d.recordAlerts.length && !d.expired.length;
  if (empty) {
    return (
      <p className="mb-8 flex items-center gap-2 text-[13px] text-muted">
        <IconCheckCircle size={16} className="text-done" /> Nothing needs you right now.
      </p>
    );
  }
  return (
    <section aria-labelledby="needs-you-h" className="mb-10">
      <h2 id="needs-you-h" className="serif mb-4 text-heading">
        Needs you
      </h2>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {d.recordAlerts.length > 0 && (
          <Box title="Public records" count={d.recordAlerts.length} icon={<IconFlag size={16} className={d.recordAlerts.some((a) => a.critical) ? "text-blocked-text" : undefined} />}>
            {d.recordAlerts.slice(0, 5).map((a) => (
              <li key={a.id} className="py-2">
                <Link href={`/projects/${a.projectId}?tab=records`} className="block">
                  <span className={`block truncate text-sm font-medium ${a.critical ? "text-blocked-text" : ""}`}>{a.title}</span>
                  <span className="block truncate text-[12px] text-muted">{a.projectName}</span>
                </Link>
              </li>
            ))}
          </Box>
        )}
        {d.expired.length > 0 && (
          <Box title="Expired" count={d.expired.length} icon={<IconClock size={16} className="text-blocked-text" />}>
            {d.expired.slice(0, 5).map((e) => (
              <li key={e.id} className="py-2">
                <Link href={`/projects/${e.projectId}?tab=dates`} className="flex items-center justify-between gap-3">
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-blocked-text">{e.label}</span>
                    <span className="block truncate text-[12px] text-muted">{e.projectName}</span>
                  </span>
                  <span className="num shrink-0 text-[12px] text-blocked-text">{daysBetween(e.expiresOn, today)}d ago</span>
                </Link>
              </li>
            ))}
          </Box>
        )}
        {d.approvals.length > 0 && (
          <Box title="Waiting on your approval" count={d.counts.approvals} icon={<IconCheckCircle size={16} />}>
            {d.approvals.slice(0, 5).map((t) => (
              <li key={t.id} className="flex items-center gap-2 py-2">
                <Link href={taskHref(t.projectId, t.id)} className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{t.title}</span>
                  <span className="block truncate text-[12px] text-muted">
                    {t.projectName}
                    {t.assigneeName ? ` · ${t.assigneeName}` : ""}
                  </span>
                </Link>
                <Button size="sm" variant="secondary" loading={decide.isPending && decide.variables?.taskId === t.id} onClick={() => decide.mutate({ projectId: t.projectId, taskId: t.id, version: t.version, decision: "approved" })}>
                  Approve
                </Button>
              </li>
            ))}
          </Box>
        )}
        {d.blocked.length > 0 && (
          <Box title="Blocked" count={d.counts.blocked} icon={<IconBlocked size={16} className="text-blocked-text" />}>
            {d.blocked.slice(0, 5).map((t) => (
              <li key={t.id} className="py-2">
                <Link href={taskHref(t.projectId, t.id)} className="block">
                  <span className="block truncate text-sm font-medium">{t.title}</span>
                  <span className="block truncate text-[12px] text-muted">
                    {t.projectName} · {t.blockedReason}
                  </span>
                </Link>
              </li>
            ))}
          </Box>
        )}
        {d.overdueByPerson.length > 0 && (
          <Box title="Overdue, by person" count={d.overdueByPerson.reduce((s, o) => s + o.count, 0)} icon={<IconAlert size={16} className="text-attention-text" />}>
            {d.overdueByPerson.slice(0, 6).map((o) => (
              <li key={o.userId ?? "none"} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span className="truncate">{o.name}</span>
                <span className="num shrink-0 text-muted">
                  <span className="font-medium text-attention-text">{o.count}</span> · oldest {daysBetween(o.oldest, today)}d
                </span>
              </li>
            ))}
          </Box>
        )}
        {d.keyDates.length > 0 && (
          <Box title="Key dates, next 14 days" count={d.keyDates.length} icon={<IconCalendar size={16} />}>
            {d.keyDates.slice(0, 5).map((k) => {
              const n = daysBetween(today, k.date);
              return (
                <li key={k.id} className="py-2">
                  <Link href={`/projects/${k.projectId}?tab=dates`} className="flex items-center justify-between gap-3">
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{k.label}</span>
                      <span className="block truncate text-[12px] text-muted">{k.projectName}</span>
                    </span>
                    <span className="num shrink-0 text-right text-[12px]">
                      <span className="block font-medium">{formatIsoDate(k.date, { month: "short", day: "numeric", year: undefined })}</span>
                      <span className="block text-muted">{n === 0 ? "today" : n === 1 ? "tomorrow" : `in ${n} days`}</span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </Box>
        )}
      </div>
    </section>
  );
}

function Box({ title, count, icon, children }: { title: string; count: number; icon: ReactNode; children: ReactNode }) {
  return (
    <div className="min-w-0 rounded-card border border-border bg-surface px-5 py-4">
      <h3 className="mb-1 flex items-center gap-2 text-[13px] font-medium">
        {icon}
        {title}
        <span className="num ml-auto text-muted">{count}</span>
      </h3>
      <ul className="divide-y divide-border">{children}</ul>
    </div>
  );
}
