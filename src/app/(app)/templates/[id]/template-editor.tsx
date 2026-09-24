"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useMemo, useState, type DragEvent } from "react";
import { EmptyState, ErrorState } from "@/components/ui/architecture";
import { IconArrowDown, IconArrowLeft, IconArrowUp, IconClose, IconFlag, IconGrip, IconPlus, IconRepeat } from "@/components/ui/icons";
import { ConfirmDialog, Dialog, useToast } from "@/components/ui/overlay";
import { Badge, Button, Field, Input, Select, Skeleton, StatusPill, Switch, Textarea } from "@/components/ui/primitives";
import { wouldCreateCycle } from "@/core/deps";
import { PROJECT_TYPE_LABEL } from "@/core/labels";
import { DEFAULT_FOLDERS } from "@/core/seed-library";
import { RECURRENCE_FREQS, slugKey, validateTemplate, type TemplateDef, type TemplatePhaseDef, type TemplateTaskDef } from "@/core/templates";
import { describeConditions, TOGGLES, toggleLabel } from "@/core/toggles";
import { formatIsoDate, todayET } from "@/core/time";
import { cn } from "@/lib/cn";
import { errorMessage, useTRPC } from "@/lib/trpc";
import { DiffSummary } from "../../projects/[id]/checklist-extras";

const RECUR_LABEL: Record<string, string> = { weekly: "Weekly", biweekly: "Every 2 weeks", monthly: "Monthly" };
const ROLES = ["PM", "Acquisitions", "Legal", "Finance", "Construction", "Design", "Sales", "Owner", "Partner"];

function move<T>(list: T[], from: number, to: number): T[] {
  const out = [...list];
  const [x] = out.splice(from, 1);
  out.splice(to, 0, x!);
  return out;
}

export function TemplateEditor({ templateId }: { templateId: string }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery(trpc.templates.get.queryOptions({ templateId }));
  const [draft, setDraft] = useState<TemplateDef | null>(null);
  const [baseVersion, setBaseVersion] = useState<number | null>(null);
  const [phaseKey, setPhaseKey] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [editingPhase, setEditingPhase] = useState<string | "new" | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [showProjects, setShowProjects] = useState(false);

  // Start editing from the loaded version (once per load / save).
  const loaded = q.data;
  const def = draft ?? loaded?.definition ?? null;
  const dirty = !!draft && !!loaded && JSON.stringify(draft) !== JSON.stringify(loaded.definition);
  const problems = useMemo(() => (def ? validateTemplate(def) : []), [def]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const save = useMutation(
    trpc.templates.save.mutationOptions({
      onSuccess: async (r) => {
        toast("success", `Saved as version ${r.version}. Live projects are unchanged until you apply the update to them.`);
        setDraft(null);
        setBaseVersion(null);
        await qc.invalidateQueries({ queryKey: trpc.templates.get.queryKey({ templateId }) });
        await qc.invalidateQueries({ queryKey: trpc.templates.list.queryKey() });
      },
      onError: (e) => toast("error", errorMessage(e)),
    }),
  );

  if (q.isPending) return <Skeleton className="h-[600px] rounded-card" />;
  if (q.isError) return <ErrorState onRetry={() => q.refetch()} />;
  if (!def || !loaded) return null;

  const update = (fn: (d: TemplateDef) => TemplateDef) => {
    if (baseVersion === null) setBaseVersion(loaded.version);
    setDraft(fn(structuredClone(def)));
  };
  const selPhase = def.phases.find((p) => p.key === phaseKey) ?? def.phases[0]!;
  const tasks = def.tasks.filter((t) => t.phaseKey === selPhase.key);
  const editTask = editing && editing !== "new" ? def.tasks.find((t) => t.key === editing) ?? null : null;

  const moveTask = (key: string, dir: -1 | 1) =>
    update((d) => {
      const inPhase = d.tasks.filter((t) => t.phaseKey === selPhase.key);
      const i = inPhase.findIndex((t) => t.key === key);
      const j = i + dir;
      if (j < 0 || j >= inPhase.length) return d;
      const a = d.tasks.indexOf(inPhase[i]!);
      const b = d.tasks.indexOf(inPhase[j]!);
      [d.tasks[a], d.tasks[b]] = [d.tasks[b]!, d.tasks[a]!];
      return d;
    });

  return (
    <article>
      <Link href="/templates" className="mb-6 inline-flex items-center gap-2 text-sm text-muted hover:text-text">
        <IconArrowLeft size={16} /> Templates
      </Link>
      <header className="mb-8 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0 flex-1">
          <p className="eyebrow mb-2">
            {PROJECT_TYPE_LABEL[loaded.projectType]} · version {loaded.version}
            {loaded.isDefault ? " · default" : ""}
          </p>
          <label htmlFor="tpl-name" className="sr-only">
            Template name
          </label>
          <input
            id="tpl-name"
            value={def.name}
            maxLength={120}
            onChange={(e) => update((d) => ({ ...d, name: e.target.value }))}
            className="serif w-full rounded-control border border-transparent bg-transparent px-1 text-title hover:border-border focus:border-accent focus:outline-none sm:text-display"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {dirty && <StatusPill tone="attention">Unsaved changes</StatusPill>}
          <Button variant="ghost" onClick={() => setShowProjects(true)}>
            Projects
          </Button>
          <Button variant="secondary" onClick={() => setShowPreview(true)}>
            Preview
          </Button>
          {dirty && (
            <Button variant="ghost" onClick={() => setDraft(null)}>
              Discard
            </Button>
          )}
          <Button disabled={!dirty || problems.length > 0} loading={save.isPending} onClick={() => save.mutate({ templateId, version: baseVersion ?? loaded.version, definition: def })}>
            Save template
          </Button>
        </div>
      </header>

      {problems.length > 0 && (
        <div role="alert" className="mb-6 rounded-card border border-blocked/30 bg-blocked-tint/50 px-5 py-4 text-sm">
          <p className="font-medium">Fix these before saving:</p>
          <ul className="mt-2 list-disc pl-5">
            {problems.slice(0, 8).map((p, i) => (
              <li key={i}>
                {p.where}: {p.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <Field label="Description" htmlFor="tpl-desc" className="mb-8 max-w-3xl">
        <Textarea id="tpl-desc" rows={2} maxLength={2000} value={def.description ?? ""} onChange={(e) => update((d) => ({ ...d, description: e.target.value || null }))} />
      </Field>

      <FolderEditor folders={def.folders ?? [...DEFAULT_FOLDERS]} onChange={(folders) => update((d) => ({ ...d, folders }))} />

      <div className="grid gap-8 lg:grid-cols-[300px_1fr]">
        <section aria-labelledby="tpl-phases-h">
          <div className="mb-3 flex items-center justify-between">
            <h2 id="tpl-phases-h" className="serif text-subheading">
              Phases
            </h2>
            <Button variant="ghost" size="sm" onClick={() => setEditingPhase("new")}>
              <IconPlus size={16} /> Add
            </Button>
          </div>
          <PhaseList
            phases={def.phases}
            counts={Object.fromEntries(def.phases.map((p) => [p.key, def.tasks.filter((t) => t.phaseKey === p.key).length]))}
            selected={selPhase.key}
            onSelect={setPhaseKey}
            onReorder={(from, to) => update((d) => ({ ...d, phases: move(d.phases, from, to) }))}
            onEdit={setEditingPhase}
          />
        </section>

        <section aria-labelledby="tpl-tasks-h">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 id="tpl-tasks-h" className="serif text-subheading">
                {selPhase.name}
              </h2>
              {describeConditions(selPhase) && <p className="text-[12px] text-muted">Phase appears {describeConditions(selPhase)}</p>}
            </div>
            <Button variant="secondary" size="sm" onClick={() => setEditing("new")}>
              <IconPlus size={16} /> Task
            </Button>
          </div>
          {tasks.length === 0 ? (
            <EmptyState title="No tasks in this phase" body="Add the first one." />
          ) : (
            <TaskList
              tasks={tasks}
              all={def.tasks}
              onOpen={setEditing}
              onMove={moveTask}
              onReorder={(keys) =>
                update((d) => {
                  const others = d.tasks.filter((t) => t.phaseKey !== selPhase.key);
                  const firstIdx = d.tasks.findIndex((t) => t.phaseKey === selPhase.key);
                  const ordered = keys.map((k) => d.tasks.find((t) => t.key === k)!);
                  others.splice(Math.max(0, Math.min(firstIdx, others.length)), 0, ...ordered);
                  return { ...d, tasks: others };
                })
              }
            />
          )}
        </section>
      </div>

      {editing && (
        <TaskEditor
          def={def}
          task={editTask}
          phaseKey={selPhase.key}
          onClose={() => setEditing(null)}
          onSave={(t, originalKey) =>
            update((d) => {
              if (!originalKey) return { ...d, tasks: [...d.tasks, t] };
              return { ...d, tasks: d.tasks.map((x) => (x.key === originalKey ? t : x)) };
            })
          }
          onDelete={(key) =>
            update((d) => ({
              ...d,
              tasks: d.tasks
                .filter((x) => x.key !== key)
                .map((x) => ({
                  ...x,
                  dependsOn: (x.dependsOn ?? []).filter((k) => k !== key),
                  // A due date anchored on the deleted task falls back to the phase start.
                  due: typeof x.due.from === "object" && x.due.from.task === key ? { ...x.due, from: "phase_start" as const } : x.due,
                })),
            }))
          }
        />
      )}
      {editingPhase && (
        <PhaseEditor
          def={def}
          phase={editingPhase === "new" ? null : def.phases.find((p) => p.key === editingPhase)!}
          onClose={() => setEditingPhase(null)}
          onSave={(p, originalKey) => {
            update((d) => (originalKey ? { ...d, phases: d.phases.map((x) => (x.key === originalKey ? p : x)) } : { ...d, phases: [...d.phases, p] }));
            setPhaseKey(p.key);
          }}
          onDelete={(key) => {
            update((d) => ({ ...d, phases: d.phases.filter((x) => x.key !== key) }));
            setPhaseKey(null);
          }}
        />
      )}
      {showPreview && <PreviewDialog def={def} onClose={() => setShowPreview(false)} />}
      {showProjects && <ProjectsDialog templateId={templateId} version={loaded.version} dirty={dirty} onClose={() => setShowProjects(false)} />}
    </article>
  );
}

function PhaseList({
  phases,
  counts,
  selected,
  onSelect,
  onReorder,
  onEdit,
}: {
  phases: TemplatePhaseDef[];
  counts: Record<string, number>;
  selected: string;
  onSelect: (k: string) => void;
  onReorder: (from: number, to: number) => void;
  onEdit: (k: string) => void;
}) {
  const [drag, setDrag] = useState<number | null>(null);
  return (
    <ol className="flex flex-col gap-1">
      {phases.map((p, i) => (
        <li
          key={p.key}
          draggable
          onDragStart={() => setDrag(i)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            if (drag !== null && drag !== i) onReorder(drag, i);
            setDrag(null);
          }}
          className={cn("group flex items-center gap-1 rounded-panel border", p.key === selected ? "border-accent bg-accent-tint/40" : "border-transparent hover:bg-sunken")}
        >
          <span className="hidden cursor-grab pl-2 text-faint sm:block" aria-hidden="true">
            <IconGrip size={14} />
          </span>
          <button type="button" onClick={() => onSelect(p.key)} aria-current={p.key === selected || undefined} className="min-w-0 flex-1 px-2 py-2.5 text-left">
            <span className="block truncate text-[14px] font-medium">{p.name}</span>
            <span className="block text-[11px] text-muted">
              <span className="num">{counts[p.key] ?? 0}</span> tasks{describeConditions(p) ? ` · ${describeConditions(p)}` : ""}
            </span>
          </button>
          <div className="flex shrink-0 items-center pr-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
            <button type="button" className="rounded-control p-2 text-muted hover:bg-surface hover:text-text disabled:opacity-30" disabled={i === 0} onClick={() => onReorder(i, i - 1)} aria-label={`Move ${p.name} up`}>
              <IconArrowUp size={14} />
            </button>
            <button type="button" className="rounded-control p-2 text-muted hover:bg-surface hover:text-text disabled:opacity-30" disabled={i === phases.length - 1} onClick={() => onReorder(i, i + 1)} aria-label={`Move ${p.name} down`}>
              <IconArrowDown size={14} />
            </button>
            <button type="button" className="rounded-control px-2 py-1 text-[12px] text-muted hover:bg-surface hover:text-text" onClick={() => onEdit(p.key)}>
              Edit
            </button>
          </div>
        </li>
      ))}
    </ol>
  );
}

function TaskList({ tasks, all, onOpen, onMove, onReorder }: { tasks: TemplateTaskDef[]; all: TemplateTaskDef[]; onOpen: (k: string) => void; onMove: (k: string, d: -1 | 1) => void; onReorder: (keys: string[]) => void }) {
  const [drag, setDrag] = useState<string | null>(null);
  const drop = (e: DragEvent, target: string) => {
    e.preventDefault();
    if (!drag || drag === target) return setDrag(null);
    const keys = tasks.map((t) => t.key).filter((k) => k !== drag);
    keys.splice(keys.indexOf(target), 0, drag);
    onReorder(keys);
    setDrag(null);
  };
  const title = (k: string) => all.find((t) => t.key === k)?.title ?? k;
  return (
    <ul className="divide-y divide-border rounded-card border border-border bg-surface">
      {tasks.map((t, i) => (
        <li key={t.key} draggable onDragStart={() => setDrag(t.key)} onDragOver={(e) => e.preventDefault()} onDrop={(e) => drop(e, t.key)} className="group flex items-start gap-2 px-3 py-3 sm:px-4">
          <span className="hidden cursor-grab pt-1 text-faint sm:block" aria-hidden="true">
            <IconGrip size={14} />
          </span>
          <button type="button" onClick={() => onOpen(t.key)} className="min-w-0 flex-1 text-left">
            <span className="block text-[14px] font-medium">{t.title}</span>
            <span className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-muted">
              <span>{t.role}</span>
              <span className="num">
                {t.due.days} {t.due.unit === "business" ? "bus." : "cal."} days after {t.due.from === "phase_start" ? "phase start" : `“${title(t.due.from.task)}”`}
              </span>
              {t.requiresApproval && <span>Approval: {t.approverRole}</span>}
              {(t.dependsOn?.length ?? 0) > 0 && <span>After {t.dependsOn!.map(title).join(", ")}</span>}
              {t.killScreen && <span className="font-medium text-attention-text">Kill screen</span>}
              {t.milestone && (
                <span className="inline-flex items-center gap-1">
                  <IconFlag size={12} /> Milestone
                </span>
              )}
              {t.recurrence && (
                <span className="inline-flex items-center gap-1">
                  <IconRepeat size={12} /> {RECUR_LABEL[t.recurrence.freq]}
                </span>
              )}
              {describeConditions(t) && <span className="text-accent-text">{describeConditions(t)}</span>}
            </span>
          </button>
          <div className="flex shrink-0 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
            <button type="button" className="rounded-control p-2 text-muted hover:bg-sunken hover:text-text disabled:opacity-30" disabled={i === 0} onClick={() => onMove(t.key, -1)} aria-label={`Move ${t.title} up`}>
              <IconArrowUp size={14} />
            </button>
            <button type="button" className="rounded-control p-2 text-muted hover:bg-sunken hover:text-text disabled:opacity-30" disabled={i === tasks.length - 1} onClick={() => onMove(t.key, 1)} aria-label={`Move ${t.title} down`}>
              <IconArrowDown size={14} />
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}

function ToggleMulti({ id, label, value, onChange, hint }: { id: string; label: string; value: string[]; onChange: (v: string[]) => void; hint?: string }) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-[13px] font-medium">{label}</legend>
      {hint && <p className="text-[12px] text-muted">{hint}</p>}
      <div className="flex flex-wrap gap-2">
        {TOGGLES.map((t) => {
          const on = value.includes(t.key);
          return (
            <button
              key={t.key}
              id={`${id}-${t.key}`}
              type="button"
              aria-pressed={on}
              onClick={() => onChange(on ? value.filter((k) => k !== t.key) : [...value, t.key])}
              className={cn("min-h-9 rounded-full border px-3 text-[12px] transition-colors", on ? "border-primary bg-primary text-on-primary" : "border-border text-muted hover:border-text/40 hover:text-text")}
            >
              {t.label}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

function TaskEditor({
  def,
  task,
  phaseKey,
  onClose,
  onSave,
  onDelete,
}: {
  def: TemplateDef;
  task: TemplateTaskDef | null;
  phaseKey: string;
  onClose: () => void;
  onSave: (t: TemplateTaskDef, originalKey: string | null) => void;
  onDelete: (key: string) => void;
}) {
  const [t, setT] = useState<TemplateTaskDef>(
    task ?? { key: "", phaseKey, title: "", role: "PM", due: { days: 5, unit: "business", from: "phase_start" }, dependsOn: [], subItems: [] },
  );
  const [confirm, setConfirm] = useState(false);
  const [depFilter, setDepFilter] = useState("");
  const set = (patch: Partial<TemplateTaskDef>) => setT((cur) => ({ ...cur, ...patch }));
  const others = def.tasks.filter((x) => x.key !== task?.key);
  const edges = new Map(def.tasks.map((x) => [x.key, x.dependsOn ?? []]));
  const selfKey = task?.key ?? "__new__";
  const blockedDeps = new Set(others.filter((o) => wouldCreateCycle(edges, selfKey, o.key)).map((o) => o.key));
  const dependents = def.tasks.filter((x) => (x.dependsOn ?? []).includes(task?.key ?? "")).map((x) => x.title);

  const commit = () => {
    const title = t.title.trim();
    if (!title) return;
    const key = task?.key ?? slugKey(title, new Set(def.tasks.map((x) => x.key)));
    onSave({ ...t, key, title, subItems: (t.subItems ?? []).map((s) => s.trim()).filter(Boolean), approverRole: t.requiresApproval ? t.approverRole || "Owner" : null }, task?.key ?? null);
    onClose();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={task ? "Edit task" : "New task"}
      description="Changes stay in this editor until you save the template."
      footer={
        <>
          {task && (
            <Button variant="danger" className="mr-auto" onClick={() => setConfirm(true)}>
              Delete
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={commit} disabled={!t.title.trim()}>
            Done
          </Button>
        </>
      }
    >
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Title" htmlFor="te-title" className="sm:col-span-2">
          <Input id="te-title" value={t.title} maxLength={200} onChange={(e) => set({ title: e.target.value })} autoFocus />
        </Field>
        <Field label="Default role" htmlFor="te-role">
          <Input id="te-role" list="te-roles" value={t.role} maxLength={60} onChange={(e) => set({ role: e.target.value })} />
          <datalist id="te-roles">
            {ROLES.map((r) => (
              <option key={r} value={r} />
            ))}
          </datalist>
        </Field>
        <Field label="Phase" htmlFor="te-phase">
          <Select id="te-phase" value={t.phaseKey} onChange={(e) => set({ phaseKey: e.target.value })}>
            {def.phases.map((p) => (
              <option key={p.key} value={p.key}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>

        <fieldset className="sm:col-span-2">
          <legend className="mb-2 text-[13px] font-medium">Due</legend>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <label htmlFor="te-days" className="sr-only">
              Days
            </label>
            <Input id="te-days" type="number" min={0} max={3650} value={t.due.days} onChange={(e) => set({ due: { ...t.due, days: Math.max(0, Math.min(3650, Number(e.target.value) || 0)) } })} className="num h-10 w-24" />
            <label htmlFor="te-unit" className="sr-only">
              Unit
            </label>
            <Select id="te-unit" value={t.due.unit} onChange={(e) => set({ due: { ...t.due, unit: e.target.value as "business" | "calendar" } })} className="h-10">
              <option value="business">business days</option>
              <option value="calendar">calendar days</option>
            </Select>
            <span className="text-muted">after</span>
            <label htmlFor="te-from" className="sr-only">
              Counted from
            </label>
            <Select
              id="te-from"
              value={t.due.from === "phase_start" ? "phase_start" : t.due.from.task}
              onChange={(e) => set({ due: { ...t.due, from: e.target.value === "phase_start" ? "phase_start" : { task: e.target.value } } })}
              className="h-10 max-w-72"
            >
              <option value="phase_start">the phase starts</option>
              {others.map((o) => (
                <option key={o.key} value={o.key}>
                  “{o.title}” is done
                </option>
              ))}
            </Select>
          </div>
          <p className="mt-2 text-[12px] text-muted">Weekends and federal holidays are skipped; a calendar date that lands on one moves to the next business day.</p>
        </fieldset>

        <div className="flex flex-col gap-4">
          <Switch id="te-approval" checked={!!t.requiresApproval} onChange={(v) => set({ requiresApproval: v, approverRole: v ? t.approverRole || "Owner" : null })} label="Requires approval" />
          <Switch id="te-kill" checked={!!t.killScreen} onChange={(v) => set({ killScreen: v })} label="Kill screen" description="Can end the deal on its own." />
          <Switch id="te-milestone" checked={!!t.milestone} onChange={(v) => set({ milestone: v })} label="Milestone" />
        </div>
        <div className="flex flex-col gap-4">
          {t.requiresApproval && (
            <Field label="Approver role" htmlFor="te-approver">
              <Input id="te-approver" list="te-roles" value={t.approverRole ?? ""} maxLength={60} onChange={(e) => set({ approverRole: e.target.value })} />
            </Field>
          )}
          <Field label="Repeats" htmlFor="te-recur">
            <Select id="te-recur" value={t.recurrence?.freq ?? ""} onChange={(e) => set({ recurrence: e.target.value ? { freq: e.target.value as (typeof RECURRENCE_FREQS)[number] } : null })}>
              <option value="">Doesn&apos;t repeat</option>
              {RECURRENCE_FREQS.map((f) => (
                <option key={f} value={f}>
                  {RECUR_LABEL[f]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Required attachment" htmlFor="te-attach" hint="e.g. Survey PDF. Leave blank if none.">
            <Input id="te-attach" value={t.requiredAttachment ?? ""} maxLength={120} onChange={(e) => set({ requiredAttachment: e.target.value || null })} />
          </Field>
        </div>

        <Field label="Description" htmlFor="te-desc" className="sm:col-span-2">
          <Textarea id="te-desc" rows={2} maxLength={4000} value={t.description ?? ""} onChange={(e) => set({ description: e.target.value || null })} />
        </Field>
        <Field label="Sub-checklist" htmlFor="te-sub" className="sm:col-span-2" hint="One item per line.">
          <Textarea id="te-sub" rows={3} value={(t.subItems ?? []).join("\n")} onChange={(e) => set({ subItems: e.target.value.split("\n") })} />
        </Field>

        <div className="sm:col-span-2">
          <ToggleMulti id="te-show" label="Only include if" value={t.showIf ?? []} onChange={(v) => set({ showIf: v })} hint="Leave all off to include on every project." />
        </div>
        <div className="sm:col-span-2">
          <ToggleMulti id="te-hide" label="Leave out if" value={t.hideIf ?? []} onChange={(v) => set({ hideIf: v })} />
        </div>

        <fieldset className="sm:col-span-2">
          <legend className="mb-2 text-[13px] font-medium">Prerequisites</legend>
          {dependents.length > 0 && <p className="mb-2 text-[12px] text-muted">Needed before: {dependents.join(", ")}</p>}
          <Input value={depFilter} onChange={(e) => setDepFilter(e.target.value)} placeholder="Find a task" className="mb-2 h-10" aria-label="Find a prerequisite" />
          <ul className="max-h-56 overflow-y-auto rounded-panel border border-border p-2">
            {others
              .filter((o) => !depFilter || o.title.toLowerCase().includes(depFilter.toLowerCase()))
              .map((o) => {
                const checked = (t.dependsOn ?? []).includes(o.key);
                const loop = !checked && blockedDeps.has(o.key);
                return (
                  <li key={o.key}>
                    <label className={cn("flex min-h-10 items-center gap-3 rounded-control px-2 text-sm", loop ? "text-faint" : "cursor-pointer hover:bg-sunken")}>
                      <input
                        type="checkbox"
                        disabled={loop}
                        checked={checked}
                        onChange={(e) => set({ dependsOn: e.target.checked ? [...(t.dependsOn ?? []), o.key] : (t.dependsOn ?? []).filter((k) => k !== o.key) })}
                        className="size-4 accent-[var(--accent)]"
                      />
                      <span className="min-w-0 flex-1 truncate">{o.title}</span>
                      <span className="shrink-0 text-[11px] text-muted">{loop ? "would make a loop" : def.phases.find((p) => p.key === o.phaseKey)?.name}</span>
                    </label>
                  </li>
                );
              })}
          </ul>
        </fieldset>
      </div>
      <ConfirmDialog
        open={confirm}
        title="Delete this task from the template?"
        body={dependents.length ? `Tasks that depended on it (${dependents.join(", ")}) no longer will.` : "Live projects keep their copy until you apply the update to them."}
        confirmLabel="Delete"
        danger
        onCancel={() => setConfirm(false)}
        onConfirm={() => {
          onDelete(task!.key);
          onClose();
        }}
      />
    </Dialog>
  );
}

function PhaseEditor({ def, phase, onClose, onSave, onDelete }: { def: TemplateDef; phase: TemplatePhaseDef | null; onClose: () => void; onSave: (p: TemplatePhaseDef, originalKey: string | null) => void; onDelete: (key: string) => void }) {
  const [p, setP] = useState<TemplatePhaseDef>(phase ?? { key: "", name: "" });
  const tasksIn = phase ? def.tasks.filter((t) => t.phaseKey === phase.key).length : 0;
  const commit = () => {
    const name = p.name.trim();
    if (!name) return;
    const key = phase?.key ?? slugKey(name, new Set(def.phases.map((x) => x.key)));
    onSave({ ...p, key, name }, phase?.key ?? null);
    onClose();
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={phase ? "Edit phase" : "New phase"}
      footer={
        <>
          {phase && (
            <Button variant="danger" className="mr-auto" disabled={tasksIn > 0 || def.phases.length === 1} onClick={() => { onDelete(phase.key); onClose(); }} title={tasksIn > 0 ? "Move or delete its tasks first" : undefined}>
              Delete
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={commit} disabled={!p.name.trim()}>
            Done
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <Field label="Name" htmlFor="pe-name" hint={phase && tasksIn > 0 ? `${tasksIn} tasks; move or delete them to delete the phase.` : undefined}>
          <Input id="pe-name" value={p.name} maxLength={80} onChange={(e) => setP({ ...p, name: e.target.value })} autoFocus />
        </Field>
        <ToggleMulti id="pe-show" label="Only include if" value={p.showIf ?? []} onChange={(v) => setP({ ...p, showIf: v })} hint="e.g. Rental / Hold only when Rental hold is on." />
        <ToggleMulti id="pe-hide" label="Leave out if" value={p.hideIf ?? []} onChange={(v) => setP({ ...p, hideIf: v })} />
      </div>
    </Dialog>
  );
}

function PreviewDialog({ def, onClose }: { def: TemplateDef; onClose: () => void }) {
  const trpc = useTRPC();
  const [toggles, setToggles] = useState<string[]>([]);
  const [startOn, setStartOn] = useState(todayET());
  const q = useQuery({ ...trpc.templates.preview.queryOptions({ definition: def, toggles, startOn }), placeholderData: keepPreviousData });
  return (
    <Dialog open onClose={onClose} size="lg" title="Generate for a test project" description="What a new project would get with these answers. Nothing is saved.">
      <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
        <div className="flex flex-col gap-4">
          <Field label="Start date" htmlFor="pv-start">
            <Input id="pv-start" type="date" value={startOn} onChange={(e) => e.target.value && setStartOn(e.target.value)} className="num" />
          </Field>
          <ToggleMulti id="pv-tg" label="Site conditions" value={toggles} onChange={setToggles} />
        </div>
        <div>
          {!q.data ? (
            <Skeleton className="h-64" />
          ) : (
            <>
              <p className="mb-3 text-sm">
                <span className="num font-medium">{q.data.tasks.length}</span> tasks in <span className="num font-medium">{q.data.phases.length}</span> phases
              </p>
              <ol className="flex max-h-[55vh] flex-col gap-4 overflow-y-auto pr-2">
                {q.data.phases.map((p) => (
                  <li key={p.key}>
                    <p className="text-[13px] font-medium">{p.name}</p>
                    <ul className="mt-1 divide-y divide-border rounded-panel border border-border">
                      {q.data.tasks
                        .filter((t) => t.phaseKey === p.key)
                        .map((t) => (
                          <li key={t.key} className="flex justify-between gap-3 px-3 py-2 text-[13px]">
                            <span className="min-w-0">
                              {t.title}
                              {t.toggleSource.length > 0 && <Badge className="ml-2">{t.toggleSource.map(toggleLabel).join(", ")}</Badge>}
                            </span>
                            <span className="num shrink-0 text-muted">{t.dueOn ? formatIsoDate(t.dueOn) : "—"}</span>
                          </li>
                        ))}
                    </ul>
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}

function ProjectsDialog({ templateId, version, dirty, onClose }: { templateId: string; version: number; dirty: boolean; onClose: () => void }) {
  const trpc = useTRPC();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery(trpc.templates.projects.queryOptions({ templateId }));
  const [reviewing, setReviewing] = useState<string | null>(null);
  const preview = useQuery({ ...trpc.templates.updatePreview.queryOptions({ projectId: reviewing ?? "00000000-0000-0000-0000-000000000000" }), enabled: !!reviewing });
  const apply = useMutation(
    trpc.templates.applyUpdate.mutationOptions({
      onSuccess: async ([r]) => {
        toast("success", `Applied: ${r!.added} added, ${r!.removed} removed, ${r!.changed} changed`);
        setReviewing(null);
        await qc.invalidateQueries({ queryKey: trpc.templates.projects.queryKey({ templateId }) });
      },
      onError: async (e) => {
        toast("error", errorMessage(e));
        await preview.refetch();
      },
    }),
  );
  const d = preview.data;
  return (
    <Dialog open onClose={onClose} size="lg" title="Projects using this template" description={dirty ? "Save the template first; updates apply the saved version." : `Latest version: ${version}. Review each project's changes before applying.`}>
      {q.isPending ? (
        <Skeleton className="h-40" />
      ) : !q.data || q.data.length === 0 ? (
        <p className="text-sm text-muted">No live projects you can edit use this template.</p>
      ) : (
        <ul className="divide-y divide-border rounded-panel border border-border">
          {q.data.map((p) => (
            <li key={p.id} className="px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="min-w-0">
                  <Link href={`/projects/${p.id}?tab=checklist`} className="text-sm font-medium hover:underline hover:underline-offset-4">
                    {p.name}
                  </Link>
                  <span className="block text-[12px] text-muted">
                    On version {p.templateVersion ?? "?"}
                    {p.templateVersion === version ? " · up to date" : ""}
                  </span>
                </span>
                {p.templateVersion !== version && !dirty && (
                  <Button variant="secondary" size="sm" onClick={() => setReviewing(reviewing === p.id ? null : p.id)}>
                    {reviewing === p.id ? "Close" : "Review update"}
                  </Button>
                )}
              </div>
              {reviewing === p.id && (
                <div className="mt-3 rounded-panel bg-sunken/60 p-3 text-[13px]">
                  {!d ? (
                    <Skeleton className="h-16" />
                  ) : (
                    <>
                      <DiffSummary diff={d} />
                      <Button size="sm" className="mt-3" loading={apply.isPending} onClick={() => apply.mutate({ projectIds: [p.id], expectedVersion: d.toVersion })}>
                        Apply to {p.name}
                      </Button>
                    </>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

/** Folders new projects get from this template (brief §14). Financial stays: it's the gated one. */
function FolderEditor({ folders, onChange }: { folders: string[]; onChange: (f: string[]) => void }) {
  const [text, setText] = useState("");
  const add = () => {
    const name = text.trim().slice(0, 80);
    if (!name || folders.some((f) => f.toLowerCase() === name.toLowerCase())) return;
    onChange([...folders, name]);
    setText("");
  };
  return (
    <section aria-labelledby="tpl-folders-h" className="mb-10 max-w-3xl">
      <h2 id="tpl-folders-h" className="serif mb-1 text-subheading">
        Folders
      </h2>
      <p className="mb-3 text-[13px] text-muted">New projects start with these folders. Financial is always restricted to people with financial access.</p>
      <ul className="mb-3 flex flex-wrap gap-2">
        {folders.map((f, i) => (
          <li key={f} className="inline-flex h-9 items-center gap-1 rounded-full border border-border bg-surface pl-3 pr-1 text-[13px]">
            {f}
            <button type="button" disabled={i === 0} onClick={() => onChange(move(folders, i, i - 1))} className="rounded-full p-1.5 text-muted hover:bg-sunken disabled:opacity-30" aria-label={`Move ${f} earlier`}>
              <IconArrowLeft size={12} />
            </button>
            {f !== "Financial" && f !== "Photos" && (
              <button type="button" onClick={() => onChange(folders.filter((x) => x !== f))} className="rounded-full p-1.5 text-muted hover:bg-sunken hover:text-text" aria-label={`Remove ${f}`}>
                <IconClose size={12} />
              </button>
            )}
          </li>
        ))}
      </ul>
      <div className="flex max-w-sm gap-2">
        <label htmlFor="tpl-folder-new" className="sr-only">
          New folder
        </label>
        <Input id="tpl-folder-new" value={text} maxLength={80} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), add())} placeholder="Add a folder" className="h-10" />
        <Button variant="secondary" size="sm" onClick={add}>
          Add
        </Button>
      </div>
    </section>
  );
}
