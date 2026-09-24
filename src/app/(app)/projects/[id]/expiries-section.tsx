"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { ErrorState } from "@/components/ui/architecture";
import { IconPlus, IconShield } from "@/components/ui/icons";
import { ConfirmDialog, Dialog, useToast } from "@/components/ui/overlay";
import { Button, Field, Input, Select, Skeleton, StatusPill, Textarea } from "@/components/ui/primitives";
import { expiryState, isVendorCoi } from "@/core/expiries";
import { daysBetween, formatIsoDate, todayET } from "@/core/time";
import { cn } from "@/lib/cn";
import { errorMessage, useTRPC, type RouterOutputs } from "@/lib/trpc";

type Data = RouterOutputs["expiries"]["list"];
type Item = Data["items"][number];

/** Module B: every permit, policy, COI, maturity and deadline with an expiry; red once expired. */
export function ExpiriesSection({ projectId }: { projectId: string }) {
  const trpc = useTRPC();
  const q = useQuery(trpc.expiries.list.queryOptions({ projectId }));
  const [editing, setEditing] = useState<Item | "new" | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  if (q.isPending) return <Skeleton className="mt-12 h-40 rounded-card" />;
  if (q.isError) return <ErrorState onRetry={() => q.refetch()} />;
  const { items, coiFlags, canEdit } = q.data;
  const today = todayET();
  const live = items.filter((i) => !i.closedAt);
  const closed = items.filter((i) => i.closedAt);

  return (
    <section aria-labelledby="exp-h" className="mt-14">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 id="exp-h" className="serif text-heading">
            Expiries
          </h2>
          <p className="mt-1 text-[13px] text-muted">Permits, policies, COIs, maturities and deadlines. Reminders at 30, 14 and 7 days, then daily once expired.</p>
        </div>
        {canEdit && (
          <Button variant="secondary" onClick={() => setEditing("new")}>
            <IconPlus size={16} /> Add expiry
          </Button>
        )}
      </div>
      {coiFlags.length > 0 && (
        <p role="alert" className="mb-4 flex items-start gap-2 rounded-panel border border-blocked/40 bg-blocked-tint px-4 py-3 text-sm text-blocked-text">
          <IconShield size={16} className="mt-0.5 shrink-0" />
          <span>
            Expired COI on file for {coiFlags.join(", ")}. Don&apos;t let them on site until a current certificate is in.
          </span>
        </p>
      )}
      {live.length === 0 ? (
        <p className="rounded-card border border-dashed border-border px-6 py-8 text-center text-sm text-muted">Nothing tracked yet. Issued DOB permits appear here automatically once public records are checked.</p>
      ) : (
        <ul className="divide-y divide-border rounded-card border border-border bg-surface">
          {live.map((i) => (
            <ExpiryRow key={i.id} item={i} today={today} canEdit={canEdit} onEdit={() => setEditing(i)} />
          ))}
        </ul>
      )}
      {closed.length > 0 && (
        <div className="mt-4">
          <button type="button" className="text-[13px] text-muted underline underline-offset-4" onClick={() => setShowClosed((v) => !v)} aria-expanded={showClosed}>
            {showClosed ? "Hide" : "Show"} renewed and closed ({closed.length})
          </button>
          {showClosed && (
            <ul className="mt-3 divide-y divide-border rounded-card border border-border bg-surface opacity-80">
              {closed.map((i) => (
                <ExpiryRow key={i.id} item={i} today={today} canEdit={canEdit} onEdit={() => setEditing(i)} />
              ))}
            </ul>
          )}
        </div>
      )}
      {editing && <ExpiryDialog projectId={projectId} item={editing === "new" ? null : editing} categories={q.data.categories} onClose={() => setEditing(null)} />}
    </section>
  );
}

function ExpiryRow({ item: i, today, canEdit, onEdit }: { item: Item; today: string; canEdit: boolean; onEdit: () => void }) {
  const state = i.closedAt ? null : expiryState(i.expiresOn, today);
  const n = daysBetween(today, i.expiresOn);
  const Row = canEdit ? "button" : "div";
  return (
    <li>
      <Row {...(canEdit ? { type: "button" as const, onClick: onEdit } : {})} className={cn("flex w-full items-center gap-4 px-5 py-4 text-left", canEdit && "hover:bg-sunken/60")}>
        <span className="min-w-0 flex-1">
          <span className={cn("block truncate text-[15px] font-medium", state === "expired" && "text-blocked-text", i.closedAt && "text-muted line-through")}>{i.name}</span>
          <span className="num block truncate text-[13px] text-muted">
            {formatIsoDate(i.expiresOn, { month: "short", day: "numeric", year: "numeric" })}
            {i.fromRecords ? " · from public records" : ""}
            {i.notes && !i.fromRecords ? ` · ${i.notes}` : ""}
          </span>
        </span>
        {i.closedAt ? (
          <StatusPill tone="neutral">Closed</StatusPill>
        ) : state === "expired" ? (
          <StatusPill tone="blocked">Expired {-n}d ago</StatusPill>
        ) : state === "soon" ? (
          <StatusPill tone="attention">{n === 0 ? "Today" : `${n} days`}</StatusPill>
        ) : (
          <span className="num shrink-0 text-[13px] text-muted">{n} days</span>
        )}
      </Row>
    </li>
  );
}

function ExpiryDialog({ projectId, item, categories, onClose }: { projectId: string; item: Item | null; categories: Data["categories"]; onClose: () => void }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const toast = useToast();
  const [category, setCategory] = useState(item?.category ?? "gl_policy");
  const [confirm, setConfirm] = useState(false);
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: trpc.expiries.list.queryKey({ projectId }) }), qc.invalidateQueries({ queryKey: trpc.tasks.needsYou.queryKey() }), qc.invalidateQueries({ queryKey: trpc.projects.list.queryKey() })]);
  const onError = (e: unknown) => toast("error", errorMessage(e));
  const done = (msg: string) => async () => {
    toast("success", msg);
    await refresh();
    onClose();
  };
  const save = useMutation(trpc.expiries.save.mutationOptions({ onSuccess: done(item ? "Saved" : "Added"), onError }));
  const close = useMutation(trpc.expiries.close.mutationOptions({ onSuccess: done(item?.closedAt ? "Reopened" : "Closed; reminders stopped"), onError }));
  const remove = useMutation(trpc.expiries.remove.mutationOptions({ onSuccess: done("Removed"), onError }));
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const s = (k: string) => String(f.get(k) ?? "").trim();
    save.mutate({ projectId, id: item?.id, version: item?.version, category: category as never, label: s("label") || null, vendorName: s("vendor") || null, expiresOn: s("expiresOn"), notes: s("notes") || null });
  };
  const coi = isVendorCoi(category);
  return (
    <Dialog
      open
      onClose={onClose}
      title={item ? "Edit expiry" : "Add an expiry"}
      description={item ? "Renewed? Put in the new date: reminders start again from it." : undefined}
      footer={
        <>
          {item && !item.fromRecords && (
            <Button variant="danger" className="mr-auto" onClick={() => setConfirm(true)}>
              Remove
            </Button>
          )}
          {item && (
            <Button variant="ghost" className={item.fromRecords ? "mr-auto" : undefined} loading={close.isPending} onClick={() => close.mutate({ projectId, id: item.id, version: item.version, closed: !item.closedAt })}>
              {item.closedAt ? "Reopen" : "Mark closed"}
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="exp-form" loading={save.isPending}>
            Save
          </Button>
        </>
      }
    >
      <form id="exp-form" onSubmit={submit} className="grid gap-5 sm:grid-cols-2">
        <Field label="What" htmlFor="exp-cat">
          <Select id="exp-cat" value={category} onChange={(e) => setCategory(e.target.value)}>
            {categories.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Expires" htmlFor="exp-date">
          <Input id="exp-date" name="expiresOn" type="date" required defaultValue={item?.expiresOn ?? ""} className="num" />
        </Field>
        {coi ? (
          <Field label="Vendor" htmlFor="exp-vendor" hint="An expired COI flags this vendor on every project they're on." className="sm:col-span-2">
            <Input id="exp-vendor" name="vendor" required maxLength={120} defaultValue={item?.vendorName ?? ""} placeholder="e.g. Acme Concrete" />
          </Field>
        ) : (
          <Field label="Name or number (optional)" htmlFor="exp-label" className="sm:col-span-2">
            <Input id="exp-label" name="label" maxLength={120} defaultValue={item?.label ?? ""} placeholder="e.g. Policy GL-20391" />
          </Field>
        )}
        <Field label="Notes" htmlFor="exp-notes" className="sm:col-span-2">
          <Textarea id="exp-notes" name="notes" rows={2} maxLength={2000} defaultValue={item?.notes ?? ""} />
        </Field>
      </form>
      <ConfirmDialog open={confirm} title="Remove this item?" body="Its reminders stop and it leaves the list. To keep the history, mark it closed instead." confirmLabel="Remove" danger busy={remove.isPending} onCancel={() => setConfirm(false)} onConfirm={() => remove.mutate({ projectId, id: item!.id })} />
    </Dialog>
  );
}
