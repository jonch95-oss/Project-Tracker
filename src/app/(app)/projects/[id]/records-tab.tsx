"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { EmptyState, ErrorState } from "@/components/ui/architecture";
import { IconAlert, IconChevronDown, IconFlag } from "@/components/ui/icons";
import { Dialog, useToast } from "@/components/ui/overlay";
import { Button, Field, Input, Select, Skeleton, StatusPill, Textarea } from "@/components/ui/primitives";
import { WhatsAppShare } from "@/components/whatsapp-share";
import { formatMoney } from "@/core/money";
import { VIOLATION_STAGES } from "@/core/records";
import { formatDateTimeET, formatIsoDate } from "@/core/time";
import { cn } from "@/lib/cn";
import { errorMessage, useTRPC, type RouterOutputs } from "@/lib/trpc";

type Data = RouterOutputs["records"]["overview"];
type Item = Data["jobs"][number];
type Violation = Data["violations"][number];

const d = (iso: string | null) => (iso ? formatIsoDate(iso, { month: "short", day: "numeric", year: "numeric" }) : "—");

/**
 * Public Records (brief §10): orders in force, alerts with "create task from
 * this", violations tracked to closure, and the lot's DOB jobs, permits,
 * complaints, 311, OATH, ACRIS and tax records, each with a source link.
 */
export function RecordsTab({ projectId, onOpenTask }: { projectId: string; onOpenTask: (taskId: string) => void }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery(trpc.records.overview.queryOptions({ projectId }));
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: trpc.records.overview.queryKey({ projectId }) }), qc.invalidateQueries({ queryKey: trpc.tasks.needsYou.queryKey() })]);
  const onError = (e: unknown) => toast("error", errorMessage(e));
  const sync = useMutation(
    trpc.records.syncNow.mutationOptions({
      onSuccess: (r) => toast(r.failed.length ? "error" : "success", r.failed.length ? `Checked; ${r.failed.length} source(s) failed and will retry.` : r.alerts ? `Checked: ${r.alerts} change(s).` : "Checked: nothing new."),
      onError,
      onSettled: refresh,
    }),
  );
  const [editing, setEditing] = useState<Violation | null>(null);

  if (q.isPending) return <Skeleton className="h-96 rounded-card" />;
  if (q.isError) return <ErrorState onRetry={() => q.refetch()} />;
  const data = q.data;
  if (!data.lot) return <EmptyState title="No BBL on this project" body="Add the BBL (Edit project) and the nightly check starts watching DOB, HPD, ECB, OATH, 311, ACRIS and tax records for the lot." />;
  const openViolations = data.violations.filter((v) => !v.closed);
  const closedViolations = data.violations.filter((v) => v.closed);
  const liveAlerts = data.alerts.filter((a) => !a.dismissed);

  return (
    <div className="flex flex-col gap-10">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h2 className="serif text-heading">Public records</h2>
          <p className="num mt-1 text-[13px] text-muted">
            BBL {data.lot.bbl} · {data.lastRun?.at ? `last checked ${formatDateTimeET(data.lastRun.at, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : "not checked yet: the first check runs tonight"}
            {data.lastRun && !data.lastRun.ok ? " · some sources failed and will retry" : ""}
          </p>
        </div>
        {data.access.canSync && (
          <Button variant="secondary" loading={sync.isPending} onClick={() => sync.mutate({ projectId })}>
            Check now
          </Button>
        )}
      </header>

      {data.ordersInForce.length > 0 && (
        <div role="alert" className="rounded-card border border-blocked/50 bg-blocked-tint px-5 py-4">
          <p className="flex items-center gap-2 text-[15px] font-semibold text-blocked-text">
            <IconAlert size={18} /> {data.ordersInForce.length === 1 ? "An order is in force on this lot" : `${data.ordersInForce.length} orders are in force on this lot`}
          </p>
          <ul className="mt-2 flex flex-col gap-1 text-sm">
            {data.ordersInForce.map((o) => (
              <li key={o.id}>
                <a href={o.url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">
                  {o.title}
                </a>{" "}
                <span className="text-muted">· {d(o.date)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <Section title="Alerts" count={liveAlerts.length} empty="No changes need attention.">
        {liveAlerts.map((a) => (
          <AlertRow key={a.id} projectId={projectId} alert={a} canEdit={data.access.canEdit} onOpenTask={onOpenTask} onChanged={refresh} />
        ))}
      </Section>

      <Section title="Violations" count={openViolations.length} empty="No open violations." note="Each one is tracked to closure: issued → hearing → fixed → certificate of correction → dismissed or paid. Hearings go on the key dates.">
        {openViolations.map((v) => (
          <ViolationRow key={v.id} v={v} canEdit={data.access.canEdit} onEdit={() => setEditing(v)} />
        ))}
        {closedViolations.length > 0 && <Collapsed label={`Closed (${closedViolations.length})`}>{closedViolations.map((v) => <ViolationRow key={v.id} v={v} canEdit={data.access.canEdit} onEdit={() => setEditing(v)} />)}</Collapsed>}
      </Section>

      <RecordList title="DOB jobs" items={data.jobs} empty="No DOB filings found for this lot." />
      <RecordList title="Permits" items={data.permits} empty="No permits found." extra={(i) => (i.detail.expires ? `expires ${d(String(i.detail.expires))}` : null)} />
      <RecordList title="Complaints and 311" items={data.complaints} empty="No DOB complaints or 311 reports." />
      <RecordList title="OATH summonses" items={data.hearings} empty="No OATH summonses." extra={(i) => (i.hearingOn ? `hearing ${d(i.hearingOn)}` : null)} />
      <RecordList
        title="ACRIS recordings"
        items={data.recordings}
        empty="No recorded documents found."
        note={`ACRIS open data lags the live system by one to two months${data.acrisAsOf ? `: data as of ${formatDateTimeET(data.acrisAsOf, { month: "short", day: "numeric", year: "numeric" })}` : ""}.`}
      />
      <Section title="Tax" count={data.tax.filter((t) => t.open).length} empty="No tax records yet.">
        {data.tax.map((t) => (
          <li key={t.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
            <span className="min-w-0">
              <span className={cn("block text-[15px] font-medium", t.open && "text-attention-text")}>{t.title}</span>
              <span className="num block text-[13px] text-muted">
                {t.kind === "tax" && typeof t.detail.pastDueCents === "number" && t.detail.pastDueCents > 0 ? `${formatMoney(t.detail.pastDueCents)} past due · ` : ""}
                {t.date ? d(t.date) : ""}
              </span>
            </span>
            <a href={t.url} target="_blank" rel="noopener noreferrer" className="text-[13px] underline underline-offset-4">
              Source
            </a>
          </li>
        ))}
      </Section>

      <ul className="rounded-card border border-border bg-surface">
      <Collapsed label={`Sources checked (${data.sources.length})`}>
        {data.sources.map((s) => (
          <li key={s.key} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-[13px]">
            <span className="font-medium">{s.label}</span>
            <span className={cn("num text-muted", s.error && "text-blocked-text")}>
              {s.error ? `Failed: ${s.error}` : s.lastSuccessAt ? `${s.rows} record${s.rows === 1 ? "" : "s"} · data as of ${s.dataAsOf ? formatDateTimeET(s.dataAsOf, { month: "short", day: "numeric" }) : "—"}` : "Not checked yet"}
            </span>
          </li>
        ))}
      </Collapsed>
      </ul>

      {editing && <ViolationDialog projectId={projectId} v={editing} onClose={() => setEditing(null)} onChanged={refresh} />}
    </div>
  );
}

function Section({ title, count, empty, note, children }: { title: string; count: number; empty: string; note?: string; children: ReactNode }) {
  const has = Array.isArray(children) ? children.flat().some(Boolean) : !!children;
  return (
    <section aria-label={title}>
      <h3 className="mb-1 flex items-baseline gap-2 text-[17px] font-medium">
        {title} <span className="num text-[13px] font-normal text-muted">{count}</span>
      </h3>
      {note && <p className="mb-3 text-[13px] text-muted">{note}</p>}
      {has ? <ul className="mt-3 divide-y divide-border rounded-card border border-border bg-surface">{children}</ul> : <p className="mt-2 text-[13px] text-muted">{empty}</p>}
    </section>
  );
}

function Collapsed({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="list-none">
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-5 py-3 text-left text-[13px] text-muted hover:text-text">
        <IconChevronDown size={14} className={cn("transition-transform", !open && "-rotate-90")} /> {label}
      </button>
      {open && <ul className="divide-y divide-border border-t border-border">{children}</ul>}
    </li>
  );
}

function RecordList({ title, items, empty, note, extra }: { title: string; items: Item[]; empty: string; note?: string; extra?: (i: Item) => string | null }) {
  const open = items.filter((i) => i.open);
  const rest = items.filter((i) => !i.open);
  const row = (i: Item) => (
    <li key={i.id} className="flex flex-wrap items-start justify-between gap-3 px-5 py-4">
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-medium">{i.title}</span>
        <span className="num block text-[13px] text-muted">
          {[i.status, d(i.date), extra?.(i)].filter(Boolean).join(" · ")}
        </span>
        {i.detail.description ? <span className="mt-1 block line-clamp-2 text-[13px] text-muted">{String(i.detail.description)}</span> : null}
      </span>
      <a href={i.url} target="_blank" rel="noopener noreferrer" className="shrink-0 text-[13px] underline underline-offset-4">
        Source
      </a>
    </li>
  );
  return (
    <Section title={title} count={items.length} empty={empty} note={note}>
      {(open.length ? open : rest.slice(0, 10)).map(row)}
      {open.length > 0 && rest.length > 0 && <Collapsed label={`Older and closed (${rest.length})`}>{rest.map(row)}</Collapsed>}
      {!open.length && rest.length > 10 && <Collapsed label={`${rest.length - 10} more`}>{rest.slice(10).map(row)}</Collapsed>}
    </Section>
  );
}

function AlertRow({ projectId, alert: a, canEdit, onOpenTask, onChanged }: { projectId: string; alert: Data["alerts"][number]; canEdit: boolean; onOpenTask: (id: string) => void; onChanged: () => Promise<unknown> }) {
  const trpc = useTRPC();
  const toast = useToast();
  const onError = (e: unknown) => toast("error", errorMessage(e));
  const createTask = useMutation(
    trpc.records.createTask.mutationOptions({
      onSuccess: async (r) => {
        toast("success", r.created ? "Task created" : "Opening the task");
        await onChanged();
        onOpenTask(r.taskId);
      },
      onError,
    }),
  );
  const dismiss = useMutation(trpc.records.dismissAlert.mutationOptions({ onSuccess: onChanged, onError }));
  return (
    <li className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center">
      <span className="min-w-0 flex-1">
        <span className={cn("flex items-center gap-2 text-[15px] font-medium", a.critical && "text-blocked-text")}>
          {a.critical ? <IconAlert size={16} /> : <IconFlag size={16} className="text-muted" />}
          <span className="min-w-0">{a.title}</span>
        </span>
        <span className="num block text-[13px] text-muted">
          {formatDateTimeET(a.createdAt, { month: "short", day: "numeric" })} ·{" "}
          <a href={a.url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">
            source
          </a>
        </span>
      </span>
      <span className="flex shrink-0 flex-wrap items-center gap-1 sm:justify-end">
        <WhatsAppShare compact text={a.title} href={`/projects/${projectId}?tab=records`} />
        {a.taskId ? (
          <Button size="sm" variant="secondary" onClick={() => onOpenTask(a.taskId!)}>
            Open task
          </Button>
        ) : (
          canEdit && (
            <Button size="sm" variant="secondary" loading={createTask.isPending} onClick={() => createTask.mutate({ projectId, alertId: a.id })}>
              Create task
            </Button>
          )
        )}
        {canEdit && (
          <Button size="sm" variant="ghost" loading={dismiss.isPending} onClick={() => dismiss.mutate({ projectId, alertId: a.id, dismissed: true })}>
            Dismiss
          </Button>
        )}
      </span>
    </li>
  );
}

function ViolationRow({ v, canEdit, onEdit }: { v: Violation; canEdit: boolean; onEdit: () => void }) {
  const stage = VIOLATION_STAGES.find((s) => s.key === v.stage)!;
  const idx = VIOLATION_STAGES.findIndex((s) => s.key === v.stage);
  return (
    <li className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center">
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-medium">{v.title}</span>
        <span className="num block text-[13px] text-muted">
          Issued {d(v.issuedOn)}
          {v.hearingOn ? ` · hearing ${d(v.hearingOn)}` : ""}
        </span>
        {v.description && <span className="mt-1 block line-clamp-2 text-[13px] text-muted">{v.description}</span>}
        {!v.closed && (
          <span className="mt-2 flex gap-1" aria-hidden="true">
            {VIOLATION_STAGES.slice(0, 5).map((s, i) => (
              <span key={s.key} className={cn("h-1 w-8 rounded-full", i <= Math.min(idx, 4) ? "bg-accent" : "bg-border")} />
            ))}
          </span>
        )}
      </span>
      <span className="flex shrink-0 flex-wrap items-center gap-3">
        <StatusPill tone={v.closed ? "done" : v.stage === "issued" ? "attention" : "neutral"}>{stage.label}</StatusPill>
        <a href={v.url} target="_blank" rel="noopener noreferrer" className="text-[13px] underline underline-offset-4">
          Source
        </a>
        {canEdit && (
          <Button size="sm" variant="ghost" onClick={onEdit}>
            Update
          </Button>
        )}
      </span>
    </li>
  );
}

function ViolationDialog({ projectId, v, onClose, onChanged }: { projectId: string; v: Violation; onClose: () => void; onChanged: () => Promise<unknown> }) {
  const trpc = useTRPC();
  const toast = useToast();
  const [stage, setStage] = useState<string>(v.stage);
  const [hearingOn, setHearingOn] = useState(v.hearingOn ?? "");
  const [notes, setNotes] = useState(v.notes ?? "");
  const save = useMutation(
    trpc.records.updateViolation.mutationOptions({
      onSuccess: async () => {
        toast("success", "Violation updated");
        await onChanged();
        onClose();
      },
      onError: (e) => toast("error", errorMessage(e)),
    }),
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={v.title}
      description="Setting a hearing date puts it on the key dates, with reminders."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} onClick={() => save.mutate({ projectId, id: v.id, version: v.version, stage: stage as never, hearingOn: hearingOn || null, notes: notes || null })}>
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Stage" htmlFor="vc-stage">
          <Select id="vc-stage" value={stage} onChange={(e) => setStage(e.target.value)}>
            {VIOLATION_STAGES.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="OATH hearing" htmlFor="vc-hearing">
          <Input id="vc-hearing" type="date" value={hearingOn} onChange={(e) => setHearingOn(e.target.value)} className="num" />
        </Field>
        <Field label="Notes" htmlFor="vc-notes" className="sm:col-span-2">
          <Textarea id="vc-notes" rows={3} maxLength={4000} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Who's handling it, what was filed, what the hearing officer said…" />
        </Field>
      </div>
    </Dialog>
  );
}
