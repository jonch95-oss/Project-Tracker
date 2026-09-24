"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { EmptyState, ErrorState } from "@/components/ui/architecture";
import { Dialog, useToast } from "@/components/ui/overlay";
import { Button, Field, Input, Skeleton, StatusPill, Textarea } from "@/components/ui/primitives";
import { slippageLabel } from "@/core/schedule";
import { addDays, daysBetween, formatDateTimeET, formatIsoDate } from "@/core/time";
import { cn } from "@/lib/cn";
import { errorMessage, useTRPC, type RouterOutputs } from "@/lib/trpc";

type Data = RouterOutputs["schedule"]["get"];
type Row = Data["tasks"][number];

const DAY_PX = 6;
const d = (iso: string | null) => (iso ? formatIsoDate(iso, { month: "short", day: "numeric", year: "numeric" }) : "—");

/** Module E: planned and forecast bars against the locked baseline, the critical path, and days ahead or behind. */
export function ScheduleView({ projectId, onOpenTask }: { projectId: string; onOpenTask: (taskId: string) => void }) {
  const trpc = useTRPC();
  const q = useQuery(trpc.schedule.get.queryOptions({ projectId }));
  const [editing, setEditing] = useState<Row | null>(null);
  const [rebaseline, setRebaseline] = useState(false);
  if (q.isPending) return <Skeleton className="h-96 rounded-card" />;
  if (q.isError) return <ErrorState onRetry={() => q.refetch()} />;
  const data = q.data;
  const pending = data.history.find((h) => h.status === "requested");

  return (
    <div className="flex flex-col gap-8">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Planned finish" value={d(data.plannedFinish)} />
        <Stat label="Forecast finish" value={d(data.forecastFinish)} />
        <Stat label="Baseline finish" value={data.baseline ? d(data.baseline.finishOn) : "Not locked"} note={data.baseline ? `#${data.baseline.number}, locked ${data.baseline.lockedAt ? formatDateTimeET(data.baseline.lockedAt, { month: "short", day: "numeric", year: "numeric" }) : ""}` : "Locks when Pre-Construction starts"} />
        <Stat label="Against baseline" value={slippageLabel(data.slippage) ?? "—"} tone={data.slippage === null ? undefined : data.slippage > 0 ? "attention" : "done"} />
      </div>

      <BaselineControls projectId={projectId} data={data} pending={pending ?? null} onRequest={() => setRebaseline(true)} />

      {data.tasks.length === 0 ? (
        <EmptyState title="No dated tasks yet" body="Give checklist tasks a due date (and a start, for longer work) and they appear here with the critical path." />
      ) : (
        <Gantt data={data} onEdit={data.access.canEdit ? setEditing : undefined} onOpenTask={onOpenTask} />
      )}
      {editing && <DatesDialog projectId={projectId} row={editing} onClose={() => setEditing(null)} />}
      {rebaseline && <RebaselineDialog projectId={projectId} onClose={() => setRebaseline(false)} owner={data.access.canApprove} />}
    </div>
  );
}

function Stat({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: "attention" | "done" }) {
  return (
    <div className="rounded-card border border-border bg-surface px-5 py-4">
      <p className="text-[12px] text-muted">{label}</p>
      <p className={cn("num mt-1 text-[20px] font-medium", tone === "attention" && "text-attention-text", tone === "done" && "text-done")}>{value}</p>
      {note && <p className="mt-0.5 text-[12px] text-muted">{note}</p>}
    </div>
  );
}

function BaselineControls({ projectId, data, pending, onRequest }: { projectId: string; data: Data; pending: Data["history"][number] | null; onRequest: () => void }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const toast = useToast();
  const refresh = () => qc.invalidateQueries({ queryKey: trpc.schedule.get.queryKey({ projectId }) });
  const onError = (e: unknown) => toast("error", errorMessage(e));
  const lock = useMutation(trpc.schedule.lock.mutationOptions({ onSuccess: () => toast("success", "Baseline locked"), onError, onSettled: refresh }));
  const decide = useMutation(trpc.schedule.decideRebaseline.mutationOptions({ onSuccess: (_r, v) => toast("success", v.approve ? "Re-baseline approved" : "Re-baseline declined"), onError, onSettled: refresh }));
  if (!data.access.canLock && !(pending && data.access.canApprove)) return null;
  return (
    <div className="flex flex-wrap items-center gap-3">
      {!data.baseline && data.access.canLock && (
        <Button variant="secondary" loading={lock.isPending} onClick={() => lock.mutate({ projectId, reason: null })}>
          Lock baseline now
        </Button>
      )}
      {data.baseline && data.access.canLock && !pending && (
        <Button variant="secondary" onClick={onRequest}>
          {data.access.canApprove ? "Re-baseline" : "Request a re-baseline"}
        </Button>
      )}
      {pending && (
        <div className="flex flex-1 flex-wrap items-center gap-3 rounded-panel border border-attention/40 bg-attention-tint px-4 py-3 text-sm">
          <span className="min-w-0 flex-1">
            Re-baseline requested: <span className="font-medium">{pending.reason}</span>
          </span>
          {data.access.canApprove ? (
            <>
              <Button size="sm" loading={decide.isPending && decide.variables?.approve} onClick={() => decide.mutate({ projectId, id: pending.id, approve: true })}>
                Approve
              </Button>
              <Button size="sm" variant="ghost" loading={decide.isPending && !decide.variables?.approve} onClick={() => decide.mutate({ projectId, id: pending.id, approve: false })}>
                Decline
              </Button>
            </>
          ) : (
            <span className="text-muted">Waiting for the owner</span>
          )}
        </div>
      )}
    </div>
  );
}

function Gantt({ data, onEdit, onOpenTask }: { data: Data; onEdit?: (r: Row) => void; onOpenTask: (id: string) => void }) {
  // Phases with every task done fold away so the chart shows the work still ahead.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const phases = data.phases.filter((p) => data.tasks.some((t) => t.phaseKey === p.key));
  const finished = new Set(phases.filter((p) => data.tasks.every((t) => t.phaseKey !== p.key || t.status === "done")).map((p) => p.key));
  const shown = (key: string | null) => !key || !finished.has(key) || expanded.has(key);
  const dates = data.tasks.filter((t) => shown(t.phaseKey)).flatMap((t) => [t.planned?.start, t.planned?.finish, t.forecast?.start, t.forecast?.finish, t.baseline?.start, t.baseline?.finish].filter((x): x is string => !!x));
  const start = addDays(dates.reduce((a, b) => (a < b ? a : b), data.today), -3);
  const end = addDays(dates.reduce((a, b) => (a > b ? a : b), data.today), 7);
  const span = daysBetween(start, end) + 1;
  const x = (iso: string) => daysBetween(start, iso) * DAY_PX;
  const w = (a: string, b: string) => Math.max((daysBetween(a, b) + 1) * DAY_PX, 4);
  const months: { label: string; left: number }[] = [];
  for (let m = start.slice(0, 7); m <= end.slice(0, 7); ) {
    const first = `${m}-01`;
    months.push({ label: formatIsoDate(first, { month: "short", year: m.endsWith("-01") || months.length === 0 ? "2-digit" : undefined }), left: Math.max(0, x(first)) });
    const [y, mo] = m.split("-").map(Number) as [number, number];
    m = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`;
  }
  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-x-5 gap-y-1 text-[12px] text-muted" aria-hidden="true">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-6 rounded-sm bg-text/70" /> Planned
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-6 rounded-sm bg-blocked" /> Critical path
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-1 w-6 rounded-sm border border-dashed border-attention-text" /> Forecast
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-1 w-6 rounded-sm bg-border" /> Baseline
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-3 w-px bg-accent" /> Today
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-6 rounded-sm bg-text/70 opacity-40" /> Projected (phase not started)
        </span>
      </div>
      <div className="overflow-x-auto rounded-card border border-border bg-surface">
        <div style={{ width: 220 + span * DAY_PX }} className="relative">
          <div className="sticky top-0 flex h-8 border-b border-border text-[11px] text-muted">
            <div className="sticky left-0 z-10 w-[220px] shrink-0 border-r border-border bg-surface" />
            <div className="relative flex-1">
              {months.map((m) => (
                <span key={m.left} className="absolute top-2 border-l border-border pl-1" style={{ left: m.left }}>
                  {m.label}
                </span>
              ))}
            </div>
          </div>
          <div className="pointer-events-none absolute bottom-0 top-8 w-px bg-accent" style={{ left: 220 + x(data.today) }} aria-hidden="true" />
          {phases.map((p) => (
            <div key={p.key}>
              {finished.has(p.key) ? (
                <button
                  type="button"
                  aria-expanded={expanded.has(p.key)}
                  onClick={() => setExpanded((e) => { const n = new Set(e); if (n.has(p.key)) n.delete(p.key); else n.add(p.key); return n; })}
                  className="sticky left-0 flex w-[220px] items-center justify-between border-b border-border bg-sunken/60 px-3 py-1.5 text-left text-[12px] font-medium hover:bg-sunken"
                >
                  <span className="truncate">{p.name}</span>
                  <span className="shrink-0 font-normal text-muted">{expanded.has(p.key) ? "Hide" : `${data.tasks.filter((t) => t.phaseKey === p.key).length} done`}</span>
                </button>
              ) : (
                <div className="sticky left-0 w-[220px] border-b border-border bg-sunken/60 px-3 py-1.5 text-[12px] font-medium">{p.name}</div>
              )}
              {data.tasks
                .filter((t) => t.phaseKey === p.key && shown(p.key))
                .map((t) => (
                  <div key={t.id} className="group flex h-9 items-center border-b border-border last:border-0">
                    <button
                      type="button"
                      onClick={() => (onEdit ? onEdit(t) : onOpenTask(t.id))}
                      className={cn("sticky left-0 z-10 flex h-full w-[220px] shrink-0 items-center border-r border-border bg-surface px-3 text-left text-[13px] hover:bg-sunken", t.status === "done" && "text-muted line-through")}
                      title={`${t.title}: ${d(t.planned?.start ?? null)} – ${d(t.planned?.finish ?? null)}${t.projected ? " (projected: its phase hasn't started)" : ""}${t.slack !== null ? `, ${t.slack} days slack` : ""}`}
                    >
                      <span className="truncate">{t.title}</span>
                    </button>
                    <div className="relative h-full flex-1">
                      {t.baseline?.start && t.baseline.finish && <span className="absolute top-[26px] h-1 rounded-sm bg-border" style={{ left: x(t.baseline.start), width: w(t.baseline.start, t.baseline.finish) }} />}
                      {t.planned && (
                        <span
                          className={cn("absolute top-2.5 h-3 rounded-sm", t.status === "done" ? "bg-done/60" : t.critical ? "bg-blocked" : "bg-text/70", t.projected && "opacity-40", t.milestone && "h-3 rotate-45 rounded-none")}
                          style={t.milestone ? { left: x(t.planned.finish) - 2, width: 12 } : { left: x(t.planned.start), width: w(t.planned.start, t.planned.finish) }}
                        />
                      )}
                      {t.forecast && t.status !== "done" && t.planned && t.forecast.finish !== t.planned.finish && (
                        <span className="absolute top-[22px] h-1 rounded-sm border border-dashed border-attention-text" style={{ left: x(t.forecast.start), width: w(t.forecast.start, t.forecast.finish) }} />
                      )}
                    </div>
                  </div>
                ))}
            </div>
          ))}
        </div>
      </div>
      <p className="mt-2 text-[12px] text-muted">Critical path: the chain of dependent tasks with no slack. Tap a task to set its planned dates.</p>
    </div>
  );
}

function DatesDialog({ projectId, row, onClose }: { projectId: string; row: Row; onClose: () => void }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const toast = useToast();
  const [start, setStart] = useState(row.startOn ?? "");
  const [finish, setFinish] = useState(row.dueOn ?? "");
  const save = useMutation(
    trpc.schedule.setDates.mutationOptions({
      onSuccess: async () => {
        toast("success", "Dates saved");
        await qc.invalidateQueries({ queryKey: trpc.schedule.get.queryKey({ projectId }) });
        await qc.invalidateQueries({ queryKey: trpc.checklist.get.queryKey() });
        onClose();
      },
      onError: (e) => toast("error", errorMessage(e)),
    }),
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={row.title}
      description={row.critical ? "On the critical path: any slip moves the finish." : row.slack !== null ? `${row.slack} days of slack.` : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} onClick={() => save.mutate({ projectId, taskId: row.id, version: row.version, startOn: start || null, dueOn: finish || null })}>
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Planned start" htmlFor="sd-start">
          <Input id="sd-start" type="date" value={start} max={finish || undefined} onChange={(e) => setStart(e.target.value)} className="num" />
        </Field>
        <Field label="Planned finish (due)" htmlFor="sd-finish">
          <Input id="sd-finish" type="date" value={finish} min={start || undefined} onChange={(e) => setFinish(e.target.value)} className="num" />
        </Field>
      </div>
      <p className="mt-4 text-[13px] text-muted">
        Actual: {row.startedOn ? `started ${d(row.startedOn)}` : "not started"}
        {row.completedOn ? `, finished ${d(row.completedOn)}` : ""}
        {row.baseline ? ` · baseline ${d(row.baseline.start)} – ${d(row.baseline.finish)}` : ""}
      </p>
      {row.status === "done" && (
        <StatusPill tone="done" className="mt-3">
          Done
        </StatusPill>
      )}
    </Dialog>
  );
}

function RebaselineDialog({ projectId, onClose, owner }: { projectId: string; onClose: () => void; owner: boolean }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const toast = useToast();
  const [reason, setReason] = useState("");
  const req = useMutation(
    trpc.schedule.requestRebaseline.mutationOptions({
      onSuccess: async (r) => {
        toast("success", r.approved ? "New baseline locked" : "Sent to the owner for approval");
        await qc.invalidateQueries({ queryKey: trpc.schedule.get.queryKey({ projectId }) });
        onClose();
      },
      onError: (e) => toast("error", errorMessage(e)),
    }),
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={owner ? "Re-baseline the schedule" : "Request a re-baseline"}
      description={owner ? "Today's planned dates become the new baseline. The old one stays in the history." : "The owner approves re-baselines. The current baseline stays until then."}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={req.isPending} disabled={reason.trim().length < 3} onClick={() => req.mutate({ projectId, reason })}>
            {owner ? "Re-baseline" : "Send request"}
          </Button>
        </>
      }
    >
      <Field label="Why" htmlFor="rb-reason">
        <Textarea id="rb-reason" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Approved change order #4 adds 3 weeks of foundation work" />
      </Field>
    </Dialog>
  );
}
