"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import Link from "next/link";
import { ProjectImage } from "@/components/project/visuals";
import { EmptyState, ErrorState } from "@/components/ui/architecture";
import { IconAlert, IconCheck, IconLock } from "@/components/ui/icons";
import { useToast } from "@/components/ui/overlay";
import { Button, Skeleton, StatusPill } from "@/components/ui/primitives";
import { daysOverdue, MY_TASK_SECTION_LABEL, type MyTaskSection } from "@/core/tasks";
import { formatIsoDate } from "@/core/time";
import { cn } from "@/lib/cn";
import { useInvalidateTaskViews } from "@/lib/task-cache";
import { errorMessage, useTRPC, type RouterOutputs } from "@/lib/trpc";

type Mine = RouterOutputs["tasks"]["mine"];
type Item = Mine["sections"][number]["groups"][number]["tasks"][number];

const EMPTY_LINE: Partial<Record<MyTaskSection, string>> = {
  overdue: "Nothing overdue.",
  today: "Nothing due today.",
};

/** Sections this long start folded so the list stays readable; the rest is one tap away. */
const FOLD_AT = 8;

const taskHref = (projectId: string, taskId: string) => `/projects/${projectId}?tab=checklist&task=${taskId}`;

/**
 * My Tasks (brief §7.2): Overdue / Today / This week / Later / Waiting on
 * others / Awaiting my approval, grouped by project with its photo. One tap
 * completes; the title opens the task.
 */
export function MyTasksView() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery(trpc.tasks.mine.queryOptions());
  const [unfolded, setUnfolded] = useState<Record<string, boolean>>({});
  const key = trpc.tasks.mine.queryKey();
  const refresh = useInvalidateTaskViews();
  const done = useMutation(
    trpc.checklist.setDone.mutationOptions({
      onMutate: async (v) => {
        await qc.cancelQueries({ queryKey: key });
        const prev = qc.getQueryData<Mine>(key);
        if (prev) qc.setQueryData<Mine>(key, { ...prev, sections: prev.sections.map((s) => ({ ...s, groups: s.groups.map((g) => ({ ...g, tasks: g.tasks.filter((t) => t.id !== v.taskId) })).filter((g) => g.tasks.length) })) });
        return { prev };
      },
      onSuccess: (r) => toast("success", r.status === "awaiting_approval" ? "Sent for approval" : "Done"),
      onError: (e, _v, ctx) => {
        if (ctx?.prev) qc.setQueryData(key, ctx.prev);
        toast("error", errorMessage(e));
      },
      onSettled: () => refresh(),
    }),
  );
  const decide = useMutation(
    trpc.tasks.decide.mutationOptions({
      onSuccess: () => toast("success", "Approved"),
      onError: (e) => toast("error", errorMessage(e)),
      onSettled: () => refresh(),
    }),
  );

  if (q.isPending)
    return (
      <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading your tasks">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-40 rounded-card" />
        <Skeleton className="h-40 rounded-card" />
      </div>
    );
  if (q.isError) return <ErrorState onRetry={() => q.refetch()} />;
  const m = q.data;
  if (m.total === 0) return <EmptyState title="You're all clear" body="Nothing is assigned to you right now. When it is, it shows here as Overdue, Today, This week and Later." />;

  return (
    <div className="flex flex-col gap-10">
      {m.sections.map((s) => {
        const count = s.groups.reduce((n, g) => n + g.tasks.length, 0);
        if (count === 0 && !EMPTY_LINE[s.key]) return null;
        const folded = count > FOLD_AT && !unfolded[s.key] && s.key !== "overdue" && s.key !== "today" && s.key !== "approve";
        let budget = folded ? FOLD_AT : Infinity;
        const groups = s.groups
          .map((g) => {
            const tasks = g.tasks.slice(0, Math.max(0, budget));
            budget -= tasks.length;
            return { ...g, tasks };
          })
          .filter((g) => g.tasks.length);
        return (
          <section key={s.key} aria-labelledby={`sec-${s.key}`}>
            <h2 id={`sec-${s.key}`} className={cn("mb-3 flex items-baseline gap-2 text-[15px] font-medium", s.key === "overdue" && count > 0 && "text-blocked-text")}>
              {MY_TASK_SECTION_LABEL[s.key]}
              <span className="num text-[13px] font-normal text-muted">{count}</span>
            </h2>
            {count === 0 ? (
              <p className="text-[13px] text-muted">{EMPTY_LINE[s.key]}</p>
            ) : (
              <div className="flex flex-col gap-3">
                {groups.map((g) => (
                  <div key={g.project.id} className="overflow-hidden rounded-card border border-border bg-surface">
                    <Link href={`/projects/${g.project.id}`} className="flex items-center gap-3 border-b border-border px-4 py-3 hover:bg-sunken/60 sm:px-5">
                      <ProjectImage photoId={g.project.hero?.id} address={g.project.address} size="thumb" className="size-9 shrink-0 rounded-control" />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">{g.project.name}</span>
                        <span className="block truncate text-[12px] text-muted">{g.project.address}</span>
                      </span>
                    </Link>
                    <ul className="divide-y divide-border">
                      {g.tasks.map((t) => (
                        <Row
                          key={t.id}
                          t={t}
                          projectId={g.project.id}
                          today={m.today}
                          section={s.key}
                          onDone={() => done.mutate({ projectId: g.project.id, taskId: t.id, done: true, version: t.version })}
                          onApprove={() => decide.mutate({ projectId: g.project.id, taskId: t.id, version: t.version, decision: "approved" })}
                          approving={decide.isPending && decide.variables?.taskId === t.id}
                        />
                      ))}
                    </ul>
                  </div>
                ))}
                {folded && (
                  <Button variant="ghost" size="sm" className="self-start" onClick={() => setUnfolded((u) => ({ ...u, [s.key]: true }))}>
                    Show all {count}
                  </Button>
                )}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function Row({ t, projectId, today, section, onDone, onApprove, approving }: { t: Item; projectId: string; today: string; section: MyTaskSection; onDone: () => void; onApprove: () => void; approving: boolean }) {
  const canTick = section !== "approve" && section !== "waiting" && !t.waitingOnPrereqs;
  const late = t.dueOn && t.dueOn < today ? daysOverdue(t.dueOn, today) : 0;
  return (
    <li className="flex items-start gap-1 px-2 py-1.5 sm:px-3">
      {section === "approve" ? (
        <span className="w-2" />
      ) : (
        <button
          type="button"
          role="checkbox"
          aria-checked={false}
          aria-disabled={!canTick || undefined}
          aria-label={`Complete: ${t.title}${t.waitingOnPrereqs ? " (waiting on other tasks)" : ""}`}
          onClick={() => canTick && onDone()}
          className="flex size-11 shrink-0 items-center justify-center rounded-full"
        >
          <span className={cn("flex size-6 items-center justify-center rounded-full border", canTick ? "border-control hover:border-text" : "border-dashed border-border-strong text-faint")}>
            {!canTick ? <IconLock size={12} /> : <IconCheck size={14} className="opacity-0" />}
          </span>
        </button>
      )}
      <Link href={taskHref(projectId, t.id)} className="min-w-0 flex-1 py-2 pr-2">
        <span className="block text-[15px] leading-snug">{t.title}</span>
        <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted">
          <span>{t.phaseName}</span>
          {t.dueOn && (
            <span className={cn("num inline-flex items-center gap-1", late > 0 && "font-medium text-blocked-text")}>
              {late > 0 && <IconAlert size={12} />}
              {late > 0 ? `${late} day${late === 1 ? "" : "s"} late` : `Due ${formatIsoDate(t.dueOn, { weekday: section === "week" ? "short" : undefined, month: "short", day: "numeric", year: undefined })}`}
            </span>
          )}
          {t.priority === "high" && <span className="font-medium text-attention-text">High priority</span>}
          {t.status === "waiting" && <span>Waiting on {t.waitingOn}</span>}
          {t.status === "awaiting_approval" && section === "waiting" && <StatusPill tone="attention">Awaiting approval</StatusPill>}
          {t.status === "blocked" && <StatusPill tone="blocked">Blocked</StatusPill>}
          {t.status === "blocked" && t.blockedReason && <span className="min-w-0 max-w-full truncate text-blocked-text">{t.blockedReason}</span>}
          {t.waitingOnPrereqs && <span className="inline-flex items-center gap-1"><IconLock size={12} /> Waiting on another task</span>}
        </span>
      </Link>
      {section === "approve" && (
        <div className="flex shrink-0 items-center gap-1 self-center">
          <Button size="sm" loading={approving} onClick={onApprove}>
            Approve
          </Button>
        </div>
      )}
    </li>
  );
}
