"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type FormEvent } from "react";
import { EmptyState, ErrorState } from "@/components/ui/architecture";
import { IconPlus } from "@/components/ui/icons";
import { ConfirmDialog, Dialog, useToast } from "@/components/ui/overlay";
import { Button, buttonClass, Field, Input, Select, Skeleton, StatusPill, Textarea, type Tone } from "@/components/ui/primitives";
import { PUNCH_STATUSES } from "@/core/field";
import { formatIsoDate } from "@/core/time";
import { photoUrl, uploadPhotos } from "@/lib/photo-upload";
import { errorMessage, useTRPC, useTRPCClient, type RouterOutputs } from "@/lib/trpc";
import { PersonSelect } from "./people";

type List = RouterOutputs["punch"]["list"];
type Item = List["items"][number];
type Pin = RouterOutputs["drawings"]["sheet"]["pins"][number];

export interface PunchDraft {
  sheetId: string | null;
  page: number;
  x: number | null;
  y: number | null;
  item?: Item | Pin;
}

const TONE: Record<string, Tone> = { open: "blocked", ready: "attention", closed: "done" };
const label = (s: string) => PUNCH_STATUSES.find((p) => p.key === s)?.label ?? s;

/** Module K: punch items (pinned on sheets or not), filtered by floor, unit, trade or sub, with a PDF per sub. */
export function PunchView({ projectId, onOpenSheet }: { projectId: string; onOpenSheet: (sheetId: string) => void }) {
  const trpc = useTRPC();
  const [filter, setFilter] = useState<{ floor?: string; unit?: string; trade?: string; vendor?: string; status?: "open" | "ready" | "closed" }>({});
  const q = useQuery(trpc.punch.list.queryOptions({ projectId, ...filter }));
  const [draft, setDraft] = useState<PunchDraft | null>(null);
  if (q.isPending) return <Skeleton className="h-80 rounded-card" />;
  if (q.isError) return <ErrorState onRetry={() => q.refetch()} />;
  const { items, facets, canEdit } = q.data;
  const pick = (k: keyof typeof filter, v: string) => setFilter((f) => ({ ...f, [k]: v || undefined }));
  const exportUrl = `/api/export/projects/${projectId}/punch?${new URLSearchParams(Object.entries(filter).filter(([, v]) => v) as [string, string][])}`;
  return (
    <div>
      <div className="mb-5 flex flex-wrap items-end gap-3">
        {canEdit && (
          <>
            <FacetSelect label="Floor" value={filter.floor} options={facets.floors} onChange={(v) => pick("floor", v)} />
            <FacetSelect label="Unit" value={filter.unit} options={facets.units} onChange={(v) => pick("unit", v)} />
            <FacetSelect label="Trade" value={filter.trade} options={facets.trades} onChange={(v) => pick("trade", v)} />
            <FacetSelect label="Sub" value={filter.vendor} options={facets.vendors} onChange={(v) => pick("vendor", v)} />
          </>
        )}
        <FacetSelect label="Status" value={filter.status} options={PUNCH_STATUSES.map((s) => s.key)} labels={Object.fromEntries(PUNCH_STATUSES.map((s) => [s.key, s.label]))} onChange={(v) => pick("status", v)} />
        <div className="ml-auto flex gap-2">
          <a href={exportUrl} className={buttonClass("secondary", "sm")}>
            PDF{filter.vendor ? ` for ${filter.vendor}` : ""}
          </a>
          {canEdit && (
            <Button size="sm" onClick={() => setDraft({ sheetId: null, page: 1, x: null, y: null })}>
              <IconPlus size={16} /> Add item
            </Button>
          )}
        </div>
      </div>
      {items.length === 0 ? (
        <EmptyState title="No punch items" body={canEdit ? "Open a sheet under Drawings and drop a pin, or add an item here." : "Items assigned to you show here."} />
      ) : (
        <ul className="divide-y divide-border rounded-card border border-border bg-surface">
          {items.map((i) => (
            <li key={i.id} className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center sm:gap-4">
              <button type="button" onClick={() => setDraft({ sheetId: i.sheetId, page: i.page, x: i.x, y: i.y, item: i })} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                {i.photoId && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={photoUrl(i.photoId)} alt="" className="size-12 shrink-0 rounded-control object-cover" loading="lazy" />
                )}
                <span className="min-w-0">
                  <span className="block truncate text-[15px] font-medium">
                    <span className="num text-muted">#{i.number}</span> {i.title}
                  </span>
                  <span className="block truncate text-[13px] text-muted">
                    {[i.floor && `Floor ${i.floor}`, i.unit && `Unit ${i.unit}`, i.trade, i.vendorName, i.assigneeName, i.dueOn && `due ${formatIsoDate(i.dueOn, { month: "short", day: "numeric" })}`].filter(Boolean).join(" · ") || "—"}
                  </span>
                </span>
              </button>
              <span className="flex shrink-0 items-center gap-3">
                {i.sheetId && (
                  <button type="button" className="num text-[13px] underline underline-offset-4" onClick={() => onOpenSheet(i.sheetId!)}>
                    {i.sheetNumber}
                  </button>
                )}
                <StatusPill tone={TONE[i.status]!}>{label(i.status)}</StatusPill>
              </span>
            </li>
          ))}
        </ul>
      )}
      {draft && <PunchDialog projectId={projectId} draft={draft} team={canEdit} onClose={() => setDraft(null)} />}
    </div>
  );
}

function FacetSelect({ label: l, value, options, labels, onChange }: { label: string; value?: string; options: string[]; labels?: Record<string, string>; onChange: (v: string) => void }) {
  const id = `punch-${l.toLowerCase()}`;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-[12px] text-muted">
        {l}
      </label>
      <Select id={id} value={value ?? ""} onChange={(e) => onChange(e.target.value)} className="h-9 min-w-28 text-[13px]">
        <option value="">All</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {labels?.[o] ?? o}
          </option>
        ))}
      </Select>
    </div>
  );
}

/** Create or edit a punch item: pinned (from the sheet viewer) or free; photo straight from the camera. */
export function PunchDialog({ projectId, draft, team, onClose }: { projectId: string; draft: PunchDraft; team: boolean; onClose: () => void }) {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const qc = useQueryClient();
  const toast = useToast();
  const item = draft.item;
  // A sub can mark their item ready; once the team closes it, it's theirs to reopen, not the sub's.
  const readOnly = !!item && !team && item.status === "closed";
  const [assignee, setAssignee] = useState<string | null>(item?.assigneeId ?? null);
  const [status, setStatus] = useState<string>(item?.status ?? "open");
  const [photoId, setPhotoId] = useState<string | null>(item?.photoId ?? null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const camera = useRef<HTMLInputElement>(null);
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: trpc.punch.list.queryKey() }), qc.invalidateQueries({ queryKey: trpc.drawings.sheet.queryKey() }), qc.invalidateQueries({ queryKey: trpc.drawings.list.queryKey() })]);
  const onError = (e: unknown) => toast("error", errorMessage(e));
  const done = (msg: string) => async () => {
    toast("success", msg);
    await refresh();
    onClose();
  };
  const create = useMutation(trpc.punch.create.mutationOptions({ onSuccess: (r) => done(`Punch #${r.number} added`)(), onError }));
  const update = useMutation(trpc.punch.update.mutationOptions({ onSuccess: () => done("Saved")(), onError }));
  const remove = useMutation(trpc.punch.remove.mutationOptions({ onSuccess: () => done("Removed")(), onError }));

  async function takePhoto(files: File[]) {
    setPhotoBusy(true);
    const r = await uploadPhotos(client, projectId, files.slice(0, 1));
    setPhotoBusy(false);
    for (const e of r.errors) toast("error", e);
    if (r.ids[0]) setPhotoId(r.ids[0]);
  }

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const s = (k: string) => String(f.get(k) ?? "").trim() || null;
    if (item && !team) return update.mutate({ projectId, id: item.id, version: item.version, status: status as never });
    const fields = { title: s("title") ?? "", description: s("description"), trade: s("trade"), vendorName: s("vendor"), assigneeId: assignee, floor: s("floor"), unit: s("unit"), dueOn: s("due"), photoId };
    if (item) update.mutate({ projectId, id: item.id, version: item.version, ...fields, status: status as never });
    else create.mutate({ projectId, sheetId: draft.sheetId, page: draft.page, x: draft.x, y: draft.y, ...fields });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={item ? `Punch #${item.number}` : draft.sheetId ? "New punch item at this spot" : "New punch item"}
      footer={
        <>
          {item && team && (
            <Button variant="danger" className="mr-auto" onClick={() => setConfirm(true)}>
              Remove
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {!readOnly && (
            <Button type="submit" form="punch-form" loading={create.isPending || update.isPending}>
              Save
            </Button>
          )}
        </>
      }
    >
      <form id="punch-form" onSubmit={submit} className="grid gap-5 sm:grid-cols-2">
        {team || !item ? (
          <>
            <Field label="What needs fixing" htmlFor="pi-title" className="sm:col-span-2">
              <Input id="pi-title" name="title" required maxLength={200} defaultValue={item?.title ?? ""} placeholder="e.g. Chipped tile at the bath threshold" />
            </Field>
            <Field label="Floor" htmlFor="pi-floor">
              <Input id="pi-floor" name="floor" maxLength={20} defaultValue={item?.floor ?? ""} />
            </Field>
            <Field label="Unit" htmlFor="pi-unit">
              <Input id="pi-unit" name="unit" maxLength={20} defaultValue={item?.unit ?? ""} />
            </Field>
            <Field label="Trade" htmlFor="pi-trade">
              <Input id="pi-trade" name="trade" maxLength={60} defaultValue={item?.trade ?? ""} placeholder="e.g. Tile" />
            </Field>
            <Field label="Sub / vendor" htmlFor="pi-vendor">
              <Input id="pi-vendor" name="vendor" maxLength={120} defaultValue={item?.vendorName ?? ""} />
            </Field>
            <Field label="Assigned to" htmlFor="pi-assignee">
              <PersonSelect id="pi-assignee" projectId={projectId} value={assignee} onChange={setAssignee} />
            </Field>
            <Field label="Due" htmlFor="pi-due">
              <Input id="pi-due" name="due" type="date" defaultValue={item?.dueOn ?? ""} className="num" />
            </Field>
            <Field label="Details" htmlFor="pi-desc" className="sm:col-span-2">
              <Textarea id="pi-desc" name="description" rows={2} maxLength={2000} defaultValue={item?.description ?? ""} />
            </Field>
          </>
        ) : (
          <p className="text-[15px] sm:col-span-2">{item.title}</p>
        )}
        {readOnly && <p className="text-[13px] text-muted sm:col-span-2">Closed by the team. Ask them to reopen it if the work needs another look.</p>}
        {item && !readOnly && (
          <Field label="Status" htmlFor="pi-status">
            <Select id="pi-status" value={status} onChange={(e) => setStatus(e.target.value)}>
              {PUNCH_STATUSES.filter((s) => team || s.key !== "closed").map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {(team || !item) && (
          <div className="flex items-center gap-3 sm:col-span-2">
            {photoId && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={photoUrl(photoId)} alt="Punch photo" className="size-16 rounded-control object-cover" />
            )}
            <input
              ref={camera}
              type="file"
              accept="image/*"
              capture="environment"
              className="sr-only"
              tabIndex={-1}
              aria-hidden="true"
              onChange={(e) => {
                const files = [...(e.target.files ?? [])];
                e.target.value = "";
                if (files.length) void takePhoto(files);
              }}
            />
            <Button type="button" variant="secondary" size="sm" loading={photoBusy} onClick={() => camera.current?.click()}>
              {photoId ? "Retake photo" : "Add photo"}
            </Button>
          </div>
        )}
      </form>
      <ConfirmDialog open={confirm} title="Remove this punch item?" body="It leaves the list and the drawing." confirmLabel="Remove" danger busy={remove.isPending} onCancel={() => setConfirm(false)} onConfirm={() => remove.mutate({ projectId, id: item!.id })} />
    </Dialog>
  );
}
