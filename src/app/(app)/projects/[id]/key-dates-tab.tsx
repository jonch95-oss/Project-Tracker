"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { EmptyState, ErrorState } from "@/components/ui/architecture";
import { IconPlus } from "@/components/ui/icons";
import { ConfirmDialog, Dialog, useToast } from "@/components/ui/overlay";
import { Button, Field, Input, Select, Skeleton, StatusPill, Switch, Textarea } from "@/components/ui/primitives";
import { KEY_DATE_KINDS } from "@/core/key-dates";
import { daysBetween, formatIsoDate, todayET } from "@/core/time";
import { cn } from "@/lib/cn";
import { useInvalidateTaskViews } from "@/lib/task-cache";
import { errorMessage, useTRPC, type RouterOutputs } from "@/lib/trpc";
import { ExpiriesSection } from "./expiries-section";

type KeyDate = RouterOutputs["keyDates"]["list"]["dates"][number];

/** Key dates (brief §6): DD expiry, closing, TOE, TCO expiry, loan maturity, 1031 deadlines, auction. */
export function KeyDatesTab({ projectId }: { projectId: string }) {
  const trpc = useTRPC();
  const q = useQuery(trpc.keyDates.list.queryOptions({ projectId }));
  const [editing, setEditing] = useState<KeyDate | "new" | null>(null);
  const refresh = useInvalidateTaskViews();

  if (q.isPending) return <Skeleton className="h-64 rounded-card" />;
  if (q.isError) return <ErrorState onRetry={() => q.refetch()} />;
  const { dates, canEdit } = q.data;
  const today = todayET();
  const upcoming = dates.filter((d) => !d.done && d.date >= today);
  const past = dates.filter((d) => d.done || d.date < today);

  return (
    <section aria-labelledby="dates-h">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 id="dates-h" className="serif text-heading">
            Key dates
          </h2>
          <p className="mt-1 text-[13px] text-muted">The team gets a reminder 14, 7 and 1 day before each one.</p>
        </div>
        {canEdit && (
          <Button variant="secondary" onClick={() => setEditing("new")}>
            <IconPlus size={16} /> Add date
          </Button>
        )}
      </div>
      {dates.length === 0 ? (
        <EmptyState title="No key dates yet" body={canEdit ? "Add the dates that matter: DD expiry, closing, TOE, loan maturity, 1031 deadlines, the auction." : "Dates the team adds will show here."} />
      ) : (
        <div className="flex flex-col gap-8">
          <DateList dates={upcoming} today={today} canEdit={canEdit} onEdit={setEditing} />
          {past.length > 0 && (
            <div>
              <h3 className="mb-3 text-[13px] font-medium text-muted">Past and done</h3>
              <DateList dates={past} today={today} canEdit={canEdit} onEdit={setEditing} />
            </div>
          )}
        </div>
      )}
      <ExpiriesSection projectId={projectId} />
      {editing && <KeyDateDialog projectId={projectId} date={editing === "new" ? null : editing} onClose={() => setEditing(null)} onChanged={refresh} />}
    </section>
  );
}

function DateList({ dates, today, canEdit, onEdit }: { dates: KeyDate[]; today: string; canEdit: boolean; onEdit: (d: KeyDate) => void }) {
  if (dates.length === 0) return <p className="text-[13px] text-muted">Nothing coming up.</p>;
  return (
    <ul className="divide-y divide-border rounded-card border border-border bg-surface">
      {dates.map((d) => {
        const n = daysBetween(today, d.date);
        const soon = !d.done && n >= 0 && n <= 14;
        const Row = canEdit ? "button" : "div";
        return (
          <li key={d.id}>
            <Row {...(canEdit ? { type: "button" as const, onClick: () => onEdit(d) } : {})} className={cn("flex w-full items-center gap-4 px-5 py-4 text-left", canEdit && "hover:bg-sunken/60")}>
              <span className={cn("flex size-12 shrink-0 flex-col items-center justify-center rounded-control border text-center leading-none", soon ? "border-attention/50 bg-attention-tint" : "border-border bg-sunken")}>
                <span className="text-[10px] uppercase tracking-wide text-muted">{formatIsoDate(d.date, { month: "short", day: undefined, year: undefined })}</span>
                <span className="num mt-1 text-[17px] font-medium">{Number(d.date.slice(8))}</span>
              </span>
              <span className="min-w-0 flex-1">
                <span className={cn("block truncate text-[15px] font-medium", d.done && "text-muted line-through")}>{d.label}</span>
                <span className="num block text-[13px] text-muted">
                  {formatIsoDate(d.date, { weekday: "short", month: "short", day: "numeric" })}
                  {d.notes ? ` · ${d.notes}` : ""}
                </span>
              </span>
              {d.done ? <StatusPill tone="done">Done</StatusPill> : n < 0 ? <StatusPill tone="neutral">Passed</StatusPill> : <span className={cn("num shrink-0 text-[13px]", soon ? "font-medium text-attention-text" : "text-muted")}>{n === 0 ? "Today" : n === 1 ? "Tomorrow" : `${n} days`}</span>}
            </Row>
          </li>
        );
      })}
    </ul>
  );
}

function KeyDateDialog({ projectId, date, onClose, onChanged }: { projectId: string; date: KeyDate | null; onClose: () => void; onChanged: () => Promise<unknown> }) {
  const trpc = useTRPC();
  const toast = useToast();
  const [kind, setKind] = useState(date?.kind ?? "closing");
  const [done, setDone] = useState(date?.done ?? false);
  const [confirm, setConfirm] = useState(false);
  const onError = (e: unknown) => toast("error", errorMessage(e));
  const save = useMutation(
    trpc.keyDates.save.mutationOptions({
      onSuccess: async () => {
        toast("success", date ? "Date saved" : "Date added");
        await onChanged();
        onClose();
      },
      onError,
    }),
  );
  const remove = useMutation(
    trpc.keyDates.remove.mutationOptions({
      onSuccess: async () => {
        toast("success", "Date removed");
        await onChanged();
        onClose();
      },
      onError,
    }),
  );
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const s = (k: string) => String(f.get(k) ?? "").trim();
    save.mutate({ projectId, id: date?.id, kind: kind as never, label: s("label") || null, date: s("date"), done, notes: s("notes") || null });
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={date ? "Edit key date" : "Add a key date"}
      footer={
        <>
          {date && (
            <Button variant="danger" className="mr-auto" onClick={() => setConfirm(true)}>
              Remove
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="kd-form" loading={save.isPending}>
            Save
          </Button>
        </>
      }
    >
      <form id="kd-form" onSubmit={submit} className="grid gap-5 sm:grid-cols-2">
        <Field label="What" htmlFor="kd-kind">
          <Select id="kd-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
            {KEY_DATE_KINDS.map((k) => (
              <option key={k.key} value={k.key}>
                {k.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Date" htmlFor="kd-date">
          <Input id="kd-date" name="date" type="date" required defaultValue={date?.date ?? ""} className="num" />
        </Field>
        {kind === "other" && (
          <Field label="Name" htmlFor="kd-label" className="sm:col-span-2">
            <Input id="kd-label" name="label" required maxLength={120} defaultValue={date?.customLabel ?? ""} placeholder="e.g. Board interview" />
          </Field>
        )}
        <Field label="Notes" htmlFor="kd-notes" className="sm:col-span-2">
          <Textarea id="kd-notes" name="notes" rows={2} maxLength={1000} defaultValue={date?.notes ?? ""} />
        </Field>
        {date && <Switch id="kd-done" checked={done} onChange={setDone} label="Done (no more reminders)" />}
      </form>
      <ConfirmDialog open={confirm} title="Remove this date?" body="Its reminders stop too." confirmLabel="Remove" danger busy={remove.isPending} onCancel={() => setConfirm(false)} onConfirm={() => remove.mutate({ projectId, id: date!.id })} />
    </Dialog>
  );
}
