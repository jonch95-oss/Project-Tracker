"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { EmptyState, ErrorState } from "@/components/ui/architecture";
import { IconArrowLeft, IconPlus } from "@/components/ui/icons";
import { ConfirmDialog, Dialog, useToast } from "@/components/ui/overlay";
import { Button, buttonClass, Field, Input, Select, Skeleton, StatusPill, Textarea } from "@/components/ui/primitives";
import { MEETING_TYPES } from "@/core/field";
import { formatIsoDate, todayET } from "@/core/time";
import { cn } from "@/lib/cn";
import { errorMessage, useTRPC, type RouterOutputs } from "@/lib/trpc";
import { PersonSelect, usePeople } from "./people";

type Detail = RouterOutputs["meetings"]["get"];
type Item = Detail["items"][number];
const typeLabel = (t: string) => MEETING_TYPES.find((m) => m.key === t)?.label ?? t;

/** Module G: OAC, design, lender and partner meetings; open items carry forward; every action item is an assigned task. */
export function MeetingsView({ projectId, meetingId, onMeeting, onOpenTask }: { projectId: string; meetingId: string | null; onMeeting: (id: string | null) => void; onOpenTask: (id: string) => void }) {
  if (meetingId) return <MeetingDetail projectId={projectId} id={meetingId} onBack={() => onMeeting(null)} onOpenTask={onOpenTask} />;
  return <MeetingList projectId={projectId} onOpen={onMeeting} />;
}

function MeetingList({ projectId, onOpen }: { projectId: string; onOpen: (id: string) => void }) {
  const trpc = useTRPC();
  const toast = useToast();
  const q = useQuery(trpc.meetings.list.queryOptions({ projectId }));
  const [type, setType] = useState("oac");
  const [heldOn, setHeldOn] = useState(todayET());
  const [adding, setAdding] = useState(false);
  const create = useMutation(trpc.meetings.create.mutationOptions({ onSuccess: (r) => onOpen(r.id), onError: (e) => toast("error", errorMessage(e)) }));
  if (q.isPending) return <Skeleton className="h-64 rounded-card" />;
  if (q.isError) return <ErrorState onRetry={() => q.refetch()} />;
  return (
    <div>
      <div className="mb-5 flex justify-end">
        <Button size="sm" onClick={() => setAdding(true)}>
          <IconPlus size={16} /> New meeting
        </Button>
      </div>
      {q.data.length === 0 ? (
        <EmptyState title="No meetings yet" body="Start one: attendees and open items from the last meeting of the same type come along." />
      ) : (
        <ul className="divide-y divide-border rounded-card border border-border bg-surface">
          {q.data.map((m) => (
            <li key={m.id}>
              <button type="button" onClick={() => onOpen(m.id)} className="flex w-full items-center gap-4 px-5 py-4 text-left hover:bg-sunken/60">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-medium">
                    {typeLabel(m.type)} #{m.number}
                    {m.title ? `: ${m.title}` : ""}
                  </span>
                  <span className="num block text-[13px] text-muted">
                    {formatIsoDate(m.heldOn, { weekday: "short", month: "short", day: "numeric", year: "numeric" })} · {m.attendees} attendee{m.attendees === 1 ? "" : "s"}
                  </span>
                </span>
                {m.openActions > 0 && <StatusPill tone="attention">{m.openActions} open</StatusPill>}
              </button>
            </li>
          ))}
        </ul>
      )}
      <Dialog
        open={adding}
        onClose={() => setAdding(false)}
        title="New meeting"
        footer={
          <>
            <Button variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button loading={create.isPending} onClick={() => create.mutate({ projectId, type: type as never, heldOn, title: null })}>
              Start
            </Button>
          </>
        }
      >
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Type" htmlFor="mt-type">
            <Select id="mt-type" value={type} onChange={(e) => setType(e.target.value)}>
              {MEETING_TYPES.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Date" htmlFor="mt-date">
            <Input id="mt-date" type="date" value={heldOn} onChange={(e) => setHeldOn(e.target.value)} className="num" />
          </Field>
        </div>
      </Dialog>
    </div>
  );
}

function MeetingDetail({ projectId, id, onBack, onOpenTask }: { projectId: string; id: string; onBack: () => void; onOpenTask: (id: string) => void }) {
  const trpc = useTRPC();
  const q = useQuery(trpc.meetings.get.queryOptions({ projectId, id }));
  if (q.isPending) return <Skeleton className="h-96 rounded-card" />;
  if (q.isError) return <ErrorState onRetry={() => q.refetch()} />;
  const { meeting: m, items, canEdit } = q.data;
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <IconArrowLeft size={16} /> Meetings
        </Button>
        <h2 className="serif min-w-0 flex-1 text-heading">
          {typeLabel(m.type)} #{m.number}
        </h2>
        <a href={`/api/export/projects/${projectId}/meetings/${m.id}`} className={buttonClass("secondary", "sm")}>
          Minutes PDF
        </a>
      </div>
      <MeetingForm key={m.version} projectId={projectId} m={m} canEdit={canEdit} />
      <ItemsSection projectId={projectId} meetingId={m.id} items={items} canEdit={canEdit} onOpenTask={onOpenTask} />
    </div>
  );
}

function MeetingForm({ projectId, m, canEdit }: { projectId: string; m: Detail["meeting"]; canEdit: boolean }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const toast = useToast();
  const people = usePeople(projectId);
  const [attendees, setAttendees] = useState(m.attendees);
  const [extra, setExtra] = useState("");
  const save = useMutation(
    trpc.meetings.update.mutationOptions({
      onSuccess: async () => {
        toast("success", "Minutes saved");
        await qc.invalidateQueries({ queryKey: trpc.meetings.get.queryKey({ projectId, id: m.id }) });
      },
      onError: (e) => toast("error", errorMessage(e)),
    }),
  );
  const toggle = (p: { id: string; name: string; company: string | null }) =>
    setAttendees((a) => (a.some((x) => x.userId === p.id) ? a.filter((x) => x.userId !== p.id) : [...a, { name: p.name, company: p.company, userId: p.id }]));
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const s = (k: string) => String(f.get(k) ?? "").trim() || null;
        save.mutate({ projectId, id: m.id, version: m.version, title: s("title"), heldOn: s("heldOn") ?? m.heldOn, attendees, agenda: s("agenda"), notes: s("notes") });
      }}
      className="grid gap-5 sm:grid-cols-2"
    >
      <fieldset disabled={!canEdit} className="contents">
        <Field label="Title" htmlFor="mf-title">
          <Input id="mf-title" name="title" maxLength={160} defaultValue={m.title ?? ""} placeholder="Optional" />
        </Field>
        <Field label="Date" htmlFor="mf-date">
          <Input id="mf-date" name="heldOn" type="date" required defaultValue={m.heldOn} className="num" />
        </Field>
        <div className="sm:col-span-2">
          <p className="mb-2 text-[13px] font-medium">Attendees</p>
          <div className="flex flex-wrap gap-2">
            {people.map((p) => {
              const on = attendees.some((a) => a.userId === p.id);
              return (
                <button key={p.id} type="button" aria-pressed={on} onClick={() => toggle(p)} className={cn("rounded-full border px-3 py-1 text-[13px]", on ? "border-primary bg-primary text-on-primary" : "border-border bg-surface text-muted")}>
                  {p.name}
                </button>
              );
            })}
            {attendees
              .filter((a) => !a.userId)
              .map((a) => (
                <button key={a.name} type="button" onClick={() => setAttendees((x) => x.filter((y) => y !== a))} className="rounded-full border border-primary bg-primary px-3 py-1 text-[13px] text-on-primary" aria-label={`Remove ${a.name}`}>
                  {a.name}
                  {a.company ? ` (${a.company})` : ""} ✕
                </button>
              ))}
          </div>
          {canEdit && (
            <div className="mt-2 flex gap-2">
              <Input aria-label="Add a guest" placeholder="Guest name, company" value={extra} onChange={(e) => setExtra(e.target.value)} className="max-w-xs" />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={!extra.trim()}
                onClick={() => {
                  const [name, company] = extra.split(",").map((x) => x.trim());
                  setAttendees((a) => [...a, { name: name!, company: company || null, userId: null }]);
                  setExtra("");
                }}
              >
                Add guest
              </Button>
            </div>
          )}
        </div>
        <Field label="Agenda" htmlFor="mf-agenda" className="sm:col-span-2">
          <Textarea id="mf-agenda" name="agenda" rows={3} maxLength={8000} defaultValue={m.agenda ?? ""} />
        </Field>
        <Field label="Discussion" htmlFor="mf-notes" className="sm:col-span-2">
          <Textarea id="mf-notes" name="notes" rows={5} maxLength={20000} defaultValue={m.notes ?? ""} />
        </Field>
      </fieldset>
      {canEdit && (
        <div className="flex justify-end sm:col-span-2">
          <Button type="submit" loading={save.isPending}>
            Save minutes
          </Button>
        </div>
      )}
    </form>
  );
}

function ItemsSection({ projectId, meetingId, items, canEdit, onOpenTask }: { projectId: string; meetingId: string; items: Item[]; canEdit: boolean; onOpenTask: (id: string) => void }) {
  const [editing, setEditing] = useState<Item | "new" | null>(null);
  const actions = items.filter((i) => i.kind === "action");
  const notes = items.filter((i) => i.kind === "note");
  return (
    <section aria-labelledby="mi-h">
      <div className="mb-3 flex items-center justify-between">
        <h3 id="mi-h" className="text-[17px] font-medium">
          Action items and notes
        </h3>
        {canEdit && (
          <Button size="sm" variant="secondary" onClick={() => setEditing("new")}>
            <IconPlus size={16} /> Add item
          </Button>
        )}
      </div>
      {items.length === 0 ? (
        <p className="text-[13px] text-muted">Nothing yet. Every action item gets an owner and a due date, and becomes a task.</p>
      ) : (
        <ul className="divide-y divide-border rounded-card border border-border bg-surface">
          {[...actions, ...notes].map((i) => (
            <li key={i.id} className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center sm:gap-4">
              <button type="button" disabled={!canEdit || i.status === "carried"} onClick={() => setEditing(i)} className="min-w-0 flex-1 text-left">
                <span className={cn("block text-[15px]", i.status === "closed" && "text-muted line-through", i.status === "carried" && "text-muted")}>
                  {i.kind === "note" ? "Note: " : ""}
                  {i.text}
                </span>
                {i.kind === "action" && (
                  <span className="num block text-[13px] text-muted">
                    {i.assigneeName ?? "—"}
                    {i.dueOn ? ` · due ${formatIsoDate(i.dueOn, { month: "short", day: "numeric" })}` : ""}
                    {i.carriedFromId ? " · carried forward" : ""}
                    {i.status === "carried" ? " · moved to the next meeting" : ""}
                  </span>
                )}
              </button>
              {i.taskId && (
                <Button size="sm" variant="ghost" onClick={() => onOpenTask(i.taskId!)}>
                  Task
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {editing && <ItemDialog projectId={projectId} meetingId={meetingId} item={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </section>
  );
}

function ItemDialog({ projectId, meetingId, item, onClose }: { projectId: string; meetingId: string; item: Item | null; onClose: () => void }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const toast = useToast();
  const [kind, setKind] = useState<"action" | "note">(item?.kind ?? "action");
  const [text, setText] = useState(item?.text ?? "");
  const [assignee, setAssignee] = useState<string | null>(item?.assigneeId ?? null);
  const [due, setDue] = useState(item?.dueOn ?? "");
  const [closed, setClosed] = useState(item?.status === "closed");
  const [confirm, setConfirm] = useState(false);
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: trpc.meetings.get.queryKey({ projectId, id: meetingId }) }), qc.invalidateQueries({ queryKey: trpc.meetings.list.queryKey({ projectId }) }), qc.invalidateQueries({ queryKey: trpc.checklist.get.queryKey() })]);
  const onError = (e: unknown) => toast("error", errorMessage(e));
  const save = useMutation(
    trpc.meetings.saveItem.mutationOptions({
      onSuccess: async () => {
        toast("success", kind === "action" && !item ? "Action item added and assigned" : "Saved");
        await refresh();
        onClose();
      },
      onError,
    }),
  );
  const remove = useMutation(trpc.meetings.deleteItem.mutationOptions({ onSuccess: async () => (await refresh(), onClose()), onError }));
  return (
    <Dialog
      open
      onClose={onClose}
      title={item ? "Edit item" : "Add an item"}
      footer={
        <>
          {item && (
            <Button variant="danger" className="mr-auto" onClick={() => setConfirm(true)}>
              Remove
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} disabled={!text.trim() || (kind === "action" && (!assignee || !due))} onClick={() => save.mutate({ projectId, meetingId, id: item?.id, kind, text, assigneeId: assignee, dueOn: due || null, status: closed ? "closed" : "open" })}>
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Kind" htmlFor="mi-kind">
          <Select id="mi-kind" value={kind} onChange={(e) => setKind(e.target.value as "action" | "note")}>
            <option value="action">Action item (becomes a task)</option>
            <option value="note">Note</option>
          </Select>
        </Field>
        <div />
        <Field label="Item" htmlFor="mi-text" className="sm:col-span-2">
          <Textarea id="mi-text" rows={2} maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} />
        </Field>
        {kind === "action" && (
          <>
            <Field label="Who" htmlFor="mi-who">
              <PersonSelect id="mi-who" projectId={projectId} value={assignee} onChange={setAssignee} empty="Choose someone" />
            </Field>
            <Field label="Due" htmlFor="mi-due">
              <Input id="mi-due" type="date" value={due} onChange={(e) => setDue(e.target.value)} className="num" />
            </Field>
            {item && (
              <label className="flex items-center gap-2 text-sm sm:col-span-2">
                <input type="checkbox" checked={closed} onChange={(e) => setClosed(e.target.checked)} className="size-4 accent-[var(--primary)]" /> Done (closes the task too)
              </label>
            )}
          </>
        )}
      </div>
      <ConfirmDialog open={confirm} title="Remove this item?" body="The task it created stays, so assigned work isn't lost." confirmLabel="Remove" danger busy={remove.isPending} onCancel={() => setConfirm(false)} onConfirm={() => remove.mutate({ projectId, id: item!.id })} />
    </Dialog>
  );
}
