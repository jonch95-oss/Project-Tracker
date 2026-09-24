"use client";

import { useMutation } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { IconArrowDown, IconArrowUp, IconClose, IconLock, IconPlus } from "@/components/ui/icons";
import { ConfirmDialog, Dialog, useToast } from "@/components/ui/overlay";
import { Button, Field, Input, Select, StatusPill, Switch, Textarea } from "@/components/ui/primitives";
import { toggleLabel } from "@/core/toggles";
import { todayET } from "@/core/time";
import { cn } from "@/lib/cn";
import { errorMessage, useTRPC } from "@/lib/trpc";
import { dueLabel, type Checklist, type ChecklistTask } from "./checklist-tab";
import { Comments, StatusChip, TaskWork, useTaskDetail, Watchers } from "./task-work";

const ROLES = ["PM", "Acquisitions", "Legal", "Finance", "Construction", "Design", "Sales", "Owner", "Partner"];

function ruleText(t: ChecklistTask, all: ChecklistTask[]): string | null {
  const r = t.dueRule;
  if (!r) return null;
  const unit = r.unit === "business" ? "business day" : "day";
  const n = `${r.days} ${unit}${r.days === 1 ? "" : "s"}`;
  if (r.from === "phase_start") return `${n} after the phase starts`;
  const anchor = all.find((x) => x.templateKey === (r.from as { task: string }).task);
  return `${n} after “${anchor?.title ?? "another task"}”`;
}

export function TaskDialog({
  projectId,
  task: t,
  checklist,
  onClose,
  onChanged,
  onToggle,
}: {
  projectId: string;
  task: ChecklistTask;
  checklist: Checklist;
  onClose: () => void;
  onChanged: () => Promise<unknown>;
  onToggle: () => void;
}) {
  const trpc = useTRPC();
  const toast = useToast();
  const canEdit = checklist.access.canEdit;
  const today = todayET();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deps, setDeps] = useState<string[] | null>(null);
  const [depFilter, setDepFilter] = useState("");
  const [requiresApproval, setRequiresApproval] = useState(t.requiresApproval);
  const [formKey, setFormKey] = useState(0);
  const detail = useTaskDetail(projectId, t.id);

  const onError = (e: unknown) => toast("error", errorMessage(e));
  const update = useMutation(trpc.checklist.updateTask.mutationOptions({ onError, onSettled: () => onChanged() }));
  const remove = useMutation(
    trpc.checklist.deleteTask.mutationOptions({
      onSuccess: async () => {
        toast("success", "Task deleted");
        onClose();
        await onChanged();
      },
      onError,
    }),
  );
  const setDependencies = useMutation(
    trpc.checklist.setDependencies.mutationOptions({
      onSuccess: async () => {
        setDeps(null);
        toast("success", "Prerequisites saved");
        await onChanged();
      },
      onError,
    }),
  );
  const reorder = useMutation(trpc.checklist.reorder.mutationOptions({ onError, onSettled: () => onChanged() }));

  const inPhase = checklist.tasks.filter((x) => x.phaseKey === t.phaseKey);
  const idx = inPhase.findIndex((x) => x.id === t.id);
  const move = (d: -1 | 1) => {
    const ids = inPhase.map((x) => x.id);
    const j = idx + d;
    if (j < 0 || j >= ids.length) return;
    [ids[idx], ids[j]] = [ids[j]!, ids[idx]!];
    reorder.mutate({ projectId, phaseKey: t.phaseKey, taskIds: ids });
  };

  function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const str = (k: string) => String(f.get(k) ?? "").trim();
    const due = str("dueOn");
    update.mutate(
      {
        projectId,
        taskId: t.id,
        version: t.version,
        title: str("title"),
        description: str("description") || null,
        role: str("role") || "PM",
        phaseKey: str("phaseKey"),
        ...(due !== (t.dueOn ?? "") ? { dueOn: due || null } : {}),
        requiresApproval,
        approverRole: requiresApproval ? str("approverRole") || "Owner" : null,
        recurrence: str("recurrence") ? { freq: str("recurrence") as "weekly" | "biweekly" | "monthly" } : null,
      },
      {
        onSuccess: () => {
          toast("success", "Task saved");
          setFormKey((k) => k + 1);
        },
      },
    );
  }

  // Adding or removing items is a checklist edit; ticking one is working the task (and can't race).
  const setSubItems = (items: { id: string; text: string; done: boolean }[]) => update.mutate({ projectId, taskId: t.id, version: t.version, subItems: items });
  const tick = useMutation(trpc.checklist.setSubItem.mutationOptions({ onError, onSettled: () => onChanged() }));
  const isDone = t.status === "done";
  const phaseName = checklist.phases.find((p) => p.key === t.phaseKey)?.name ?? t.phaseKey;
  const rule = ruleText(t, checklist.tasks);
  const depSet = new Set(deps ?? t.dependsOn);
  const candidates = checklist.tasks.filter((x) => x.id !== t.id && (!depFilter || x.title.toLowerCase().includes(depFilter.toLowerCase())));

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={t.title}
      description={
        <>
          {phaseName} · {t.role}
          {t.dueOn && <> · due {dueLabel(t.dueOn, today)}</>}
        </>
      }
      footer={
        <>
          {canEdit && (
            <Button variant="danger" onClick={() => setConfirmDelete(true)} className="mr-auto">
              Delete
            </Button>
          )}
          {t.status !== "awaiting_approval" && (
            <Button variant={isDone ? "secondary" : "primary"} onClick={onToggle}>
              {isDone ? "Reopen" : t.requiresApproval && !checklist.access.canApprove ? "Done — send for approval" : "Mark done"}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-6">
        <div className="flex flex-wrap gap-2">
          {isDone ? <StatusPill tone="done">Done{t.completedOn ? ` ${dueLabel(t.completedOn, today)}` : ""}</StatusPill> : <StatusChip status={t.status} />}
          {t.recurrence && <StatusPill tone="neutral" icon={false}>Repeats {t.recurrence.freq === "biweekly" ? "every 2 weeks" : t.recurrence.freq}</StatusPill>}
          {t.killScreen && <StatusPill tone="attention">Kill screen</StatusPill>}
          {t.toggleSource.map((k) => (
            <StatusPill key={k} tone="neutral" icon={false}>
              Added by {toggleLabel(k)}
            </StatusPill>
          ))}
        </div>

        <TaskWork projectId={projectId} taskId={t.id} version={t.version} done={isDone} onChanged={onChanged} />

        {t.waitingOn.length > 0 && !isDone && (
          <p className="flex items-start gap-2 rounded-panel bg-sunken px-4 py-3 text-sm">
            <IconLock size={16} className="mt-0.5 shrink-0" />
            <span>
              Can&apos;t be checked off until {t.waitingOn.map((w) => `“${w.title}”`).join(", ")} {t.waitingOn.length === 1 ? "is" : "are"} done.
            </span>
          </p>
        )}
        {t.requiredAttachment && <p className="text-sm text-muted">Needs an attachment: {t.requiredAttachment}. File attachments arrive with Files.</p>}

        {canEdit ? (
          // Keyed on the task and explicit saves only, so ticking a sub-item doesn't wipe what's being typed.
          <form key={`${t.id}-${formKey}`} id="task-form" onSubmit={save} className="grid gap-5 sm:grid-cols-2">
            <Field label="Title" htmlFor="td-title" className="sm:col-span-2">
              <Input id="td-title" name="title" required maxLength={200} defaultValue={t.title} />
            </Field>
            <Field label="Default role" htmlFor="td-role">
              <Input id="td-role" name="role" list="td-roles" maxLength={60} defaultValue={t.role} />
              <datalist id="td-roles">
                {ROLES.map((r) => (
                  <option key={r} value={r} />
                ))}
              </datalist>
            </Field>
            <Field label="Phase" htmlFor="td-phase">
              <Select id="td-phase" name="phaseKey" defaultValue={t.phaseKey}>
                {checklist.phases.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Due date" htmlFor="td-due" hint={t.dueManual ? "Set by hand. Clear it to go back to the rule." : rule ? `Rule: ${rule}.` : undefined}>
              <Input id="td-due" name="dueOn" type="date" defaultValue={t.dueOn ?? ""} className="num" />
            </Field>
            <Field label="Repeats" htmlFor="td-recur" hint="When it's done, the next one is created automatically.">
              <Select id="td-recur" name="recurrence" defaultValue={t.recurrence?.freq ?? ""}>
                <option value="">Doesn&apos;t repeat</option>
                <option value="weekly">Every week</option>
                <option value="biweekly">Every 2 weeks</option>
                <option value="monthly">Every month</option>
              </Select>
            </Field>
            <div className="flex flex-col justify-end gap-3">
              <Switch id="td-approval" checked={requiresApproval} onChange={setRequiresApproval} label="Requires approval" />
            </div>
            {requiresApproval && (
              <Field label="Approver role" htmlFor="td-approver">
                <Input id="td-approver" name="approverRole" list="td-roles" maxLength={60} defaultValue={t.approverRole ?? "Owner"} />
              </Field>
            )}
            <Field label="Notes" htmlFor="td-desc" className="sm:col-span-2">
              <Textarea id="td-desc" name="description" maxLength={4000} rows={3} defaultValue={t.description ?? ""} />
            </Field>
            <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
              <Button type="submit" loading={update.isPending}>
                Save changes
              </Button>
              <Button variant="ghost" size="sm" onClick={() => move(-1)} disabled={idx <= 0} aria-label="Move up">
                <IconArrowUp size={16} /> Up
              </Button>
              <Button variant="ghost" size="sm" onClick={() => move(1)} disabled={idx === inPhase.length - 1} aria-label="Move down">
                <IconArrowDown size={16} /> Down
              </Button>
            </div>
          </form>
        ) : (
          t.description && <p className="whitespace-pre-line text-[15px] leading-relaxed">{t.description}</p>
        )}

        <SubItems items={t.subItems} canEdit={canEdit} onChange={setSubItems} onTick={(itemId, done) => tick.mutate({ projectId, taskId: t.id, itemId, done })} />

        <section aria-labelledby="td-deps-h">
          <h3 id="td-deps-h" className="mb-2 text-[13px] font-medium">
            Prerequisites
          </h3>
          {!canEdit || deps === null ? (
            <div className="flex flex-wrap items-center gap-2">
              {t.dependsOn.length === 0 ? (
                <p className="text-sm text-muted">None.</p>
              ) : (
                <ul className="flex flex-wrap gap-2">
                  {t.dependsOn.map((id) => {
                    const d = checklist.tasks.find((x) => x.id === id);
                    return (
                      <li key={id} className={cn("rounded-full border border-border px-3 py-1 text-[13px]", d?.status === "done" && "text-muted line-through")}>
                        {d?.title ?? "A task you can't see"}
                      </li>
                    );
                  })}
                </ul>
              )}
              {canEdit && (
                <Button variant="ghost" size="sm" onClick={() => setDeps(t.dependsOn)}>
                  Edit
                </Button>
              )}
            </div>
          ) : (
            <div className="rounded-panel border border-border">
              <div className="border-b border-border p-3">
                <label htmlFor="td-dep-filter" className="sr-only">
                  Filter tasks
                </label>
                <Input id="td-dep-filter" value={depFilter} onChange={(e) => setDepFilter(e.target.value)} placeholder="Find a task" className="h-10" />
              </div>
              <ul className="max-h-64 overflow-y-auto p-2">
                {candidates.map((x) => (
                  <li key={x.id}>
                    <label className="flex min-h-10 cursor-pointer items-center gap-3 rounded-control px-2 text-sm hover:bg-sunken">
                      <input
                        type="checkbox"
                        checked={depSet.has(x.id)}
                        onChange={(e) => setDeps((cur) => (e.target.checked ? [...(cur ?? []), x.id] : (cur ?? []).filter((y) => y !== x.id)))}
                        className="size-4 accent-[var(--accent)]"
                      />
                      <span className="min-w-0 flex-1 truncate">{x.title}</span>
                      <span className="shrink-0 text-[12px] text-muted">{checklist.phases.find((p) => p.key === x.phaseKey)?.name}</span>
                    </label>
                  </li>
                ))}
              </ul>
              <div className="flex justify-end gap-2 border-t border-border p-3">
                <Button variant="ghost" size="sm" onClick={() => setDeps(null)}>
                  Cancel
                </Button>
                <Button size="sm" loading={setDependencies.isPending} onClick={() => setDependencies.mutate({ projectId, taskId: t.id, dependsOnIds: [...depSet] })}>
                  Save prerequisites
                </Button>
              </div>
            </div>
          )}
        </section>

        {detail.data && <Watchers projectId={projectId} taskId={t.id} detail={detail.data} onChanged={onChanged} />}
        {detail.data && <Comments projectId={projectId} taskId={t.id} detail={detail.data} onChanged={onChanged} />}
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title="Delete this task?"
        body={t.status !== "not_started" ? "It has already been worked on. Deleting removes it and its history from the checklist." : "It is removed from this project's checklist. The template isn't changed."}
        confirmLabel="Delete task"
        danger
        busy={remove.isPending}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => remove.mutate({ projectId, taskId: t.id })}
      />
    </Dialog>
  );
}

function SubItems({
  items,
  canEdit,
  onChange,
  onTick,
}: {
  items: { id: string; text: string; done: boolean }[];
  canEdit: boolean;
  onChange: (items: { id: string; text: string; done: boolean }[]) => void;
  onTick: (itemId: string, done: boolean) => void;
}) {
  const [key, setKey] = useState(0);
  if (!canEdit && items.length === 0) return null;
  return (
    <section aria-labelledby="td-sub-h">
      <h3 id="td-sub-h" className="mb-2 text-[13px] font-medium">
        Sub-checklist
      </h3>
      {items.length > 0 && (
        <ul className="mb-3 flex flex-col">
          {items.map((s) => (
            <li key={s.id} className="flex min-h-10 items-center gap-3">
              <input
                type="checkbox"
                id={`sub-${s.id}`}
                checked={s.done}
                onChange={(e) => onTick(s.id, e.target.checked)}
                className="size-4 accent-[var(--accent)]"
              />
              <label htmlFor={`sub-${s.id}`} className={cn("flex-1 text-sm", s.done && "text-muted line-through")}>
                {s.text}
              </label>
              {canEdit && (
                <button type="button" onClick={() => onChange(items.filter((x) => x.id !== s.id))} className="rounded-control p-2 text-muted hover:bg-sunken hover:text-text" aria-label={`Remove ${s.text}`}>
                  <IconClose size={14} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <form
          key={key}
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const text = String(new FormData(e.currentTarget).get("sub") ?? "").trim();
            if (!text) return;
            onChange([...items, { id: crypto.randomUUID().slice(0, 12), text, done: false }]);
            setKey((k) => k + 1);
          }}
        >
          <label htmlFor="td-sub-new" className="sr-only">
            New sub-item
          </label>
          <Input id="td-sub-new" name="sub" placeholder="Add an item" maxLength={200} className="h-10" />
          <Button type="submit" variant="secondary" size="sm">
            <IconPlus size={16} /> Add
          </Button>
        </form>
      )}
    </section>
  );
}
