"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type DragEvent, type FormEvent } from "react";
import { EmptyState, ErrorState } from "@/components/ui/architecture";
import { IconAlert, IconCheck, IconChevronDown, IconFlag, IconGrip, IconLock, IconPaperclip, IconPlus, IconRepeat } from "@/components/ui/icons";
import { useToast } from "@/components/ui/overlay";
import { Badge, Button, Input, Skeleton, StatusPill } from "@/components/ui/primitives";
import { toggleLabel } from "@/core/toggles";
import { formatIsoDate, todayET } from "@/core/time";
import { cn } from "@/lib/cn";
import { useInvalidateTaskViews } from "@/lib/task-cache";
import { errorMessage, useTRPC, type RouterOutputs } from "@/lib/trpc";
import { AddPhaseDialog, RenamePhaseDialog, SaveAsTemplateDialog, TemplateUpdateDialog } from "./checklist-extras";
import { BulkBar, ShiftPhaseDialog } from "./bulk";
import { TaskDialog } from "./task-dialog";
import { TogglesDialog } from "./toggles-dialog";

export type Checklist = RouterOutputs["checklist"]["get"];
export type ChecklistTask = Checklist["tasks"][number];

const RECUR: Record<string, string> = { weekly: "Weekly", biweekly: "Every 2 weeks", monthly: "Monthly" };

export function dueLabel(dueOn: string | null, today: string): string {
  if (!dueOn) return "";
  return formatIsoDate(dueOn, { year: dueOn.slice(0, 4) === today.slice(0, 4) ? undefined : "numeric" });
}

export function ChecklistTab({
  projectId,
  canSaveTemplate,
  focusPhase,
  focusTask,
  onFocusTask,
}: {
  projectId: string;
  canSaveTemplate: boolean;
  focusPhase?: string | null;
  /** The open task lives in the URL (?task=) so notifications and My Tasks can link straight to it. */
  focusTask?: string | null;
  onFocusTask: (taskId: string | null) => void;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery(trpc.checklist.get.queryOptions({ projectId }));
  const openTask = focusTask ?? null;
  const setOpenTask = onFocusTask;
  const [selecting, setSelecting] = useState(false);
  const [attachFor, setAttachFor] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [hideDone, setHideDone] = useState(false);
  const [dialog, setDialog] = useState<null | "toggles" | "update" | "save" | "addPhase" | { rename: string } | { shift: string }>(null);

  const refresh = useInvalidateTaskViews();

  const setDone = useMutation(
    trpc.checklist.setDone.mutationOptions({
      onMutate: async (v) => {
        // Optimistic tick so one tap feels instant.
        const key = trpc.checklist.get.queryKey({ projectId });
        await qc.cancelQueries({ queryKey: key });
        const prev = qc.getQueryData<Checklist>(key);
        if (prev) qc.setQueryData<Checklist>(key, { ...prev, tasks: prev.tasks.map((t) => (t.id === v.taskId ? { ...t, status: v.done ? (t.requiresApproval && !prev.access.canApprove ? "awaiting_approval" : "done") : "not_started" } : t)) });
        return { prev };
      },
      onSuccess: (r, v) => {
        // Take the server's new version at once, so a quick second tap isn't refused as stale.
        const key = trpc.checklist.get.queryKey({ projectId });
        const cur = qc.getQueryData<Checklist>(key);
        if (cur && r.status !== "needs_attachment") qc.setQueryData<Checklist>(key, { ...cur, tasks: cur.tasks.map((t) => (t.id === v.taskId ? { ...t, status: r.status, version: r.version } : t)) });
        if (r.status === "awaiting_approval") toast("success", "Sent for approval");
        if (r.status === "needs_attachment") {
          // Route to the attach step instead (brief §6).
          toast("error", `Attach ${"label" in r ? r.label : "the required file"} first.`);
          setAttachFor(v.taskId);
          setOpenTask(v.taskId);
        }
      },
      onError: (e, _v, ctx) => {
        if (ctx?.prev) qc.setQueryData(trpc.checklist.get.queryKey({ projectId }), ctx.prev);
        toast("error", errorMessage(e));
      },
      onSettled: () => refresh(),
    }),
  );
  const reorder = useMutation(trpc.checklist.reorder.mutationOptions({ onError: (e) => toast("error", errorMessage(e)), onSettled: () => refresh() }));

  if (q.isPending) return <Skeleton className="h-96 rounded-card" />;
  if (q.isError) return <ErrorState onRetry={() => q.refetch()} />;
  const cl = q.data;
  const today = todayET();
  const canEdit = cl.access.canEdit;
  const total = cl.tasks.length;
  const done = cl.tasks.filter((t) => t.status === "done").length;
  const active = cl.phases.find((p) => p.status === "active")?.key;
  const focusedPhase = focusPhase ?? cl.tasks.find((t) => t.id === openTask)?.phaseKey;
  const isOpen = (key: string) => expanded[key] ?? (focusedPhase ? key === focusedPhase : key === active);
  const behind = cl.template && cl.template.projectVersion !== null && cl.template.projectVersion < cl.template.latestVersion;
  const current = cl.tasks.find((t) => t.id === openTask) ?? null;

  const toggle = (t: ChecklistTask) => {
    // One change per task at a time: a second tap waits for the first to land.
    if (setDone.isPending && setDone.variables?.taskId === t.id) return;
    if (t.status !== "done" && t.waitingOn.length) {
      toast("error", `Waiting on: ${t.waitingOn.map((w) => w.title).join("; ")}`);
      return;
    }
    setDone.mutate({ projectId, taskId: t.id, done: t.status !== "done", version: t.version });
  };

  return (
    <section aria-labelledby="checklist-h">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 id="checklist-h" className="serif text-heading">
            Checklist
          </h2>
          <p className="mt-1 text-[13px] text-muted">
            <span className="num">{done}</span> of <span className="num">{total}</span> done
            {cl.template && <> · from “{cl.template.name}”</>}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canEdit && (
            <Button
              variant={selecting ? "secondary" : "ghost"}
              size="sm"
              aria-pressed={selecting}
              onClick={() => {
                setSelecting((x) => !x);
                setSelected(new Set());
              }}
            >
              {selecting ? "Done selecting" : "Select"}
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => setHideDone((h) => !h)} aria-pressed={hideDone}>
            {hideDone ? "Show done" : "Hide done"}
          </Button>
          {canEdit && (
            <Button variant="secondary" size="sm" onClick={() => setDialog("toggles")}>
              Site conditions{cl.toggles.length ? ` · ${cl.toggles.length}` : ""}
            </Button>
          )}
          {canEdit && (
            <Button variant="secondary" size="sm" onClick={() => setDialog("addPhase")}>
              <IconPlus size={16} /> Phase
            </Button>
          )}
          {canEdit && canSaveTemplate && (
            <Button variant="ghost" size="sm" onClick={() => setDialog("save")}>
              Save as template
            </Button>
          )}
        </div>
      </div>

      {behind && canEdit && (
        <div role="status" className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-card border border-accent/40 bg-accent-tint/50 px-5 py-4 text-sm">
          <span>
            “{cl.template!.name}” has changed since this checklist was made (version {cl.template!.projectVersion} → {cl.template!.latestVersion}).
          </span>
          <Button variant="secondary" size="sm" onClick={() => setDialog("update")}>
            Review update
          </Button>
        </div>
      )}

      {cl.toggles.length > 0 && (
        <p className="mb-6 flex flex-wrap items-center gap-2 text-[13px] text-muted">
          Site conditions:
          {cl.toggles.map((k) => (
            <Badge key={k}>{toggleLabel(k)}</Badge>
          ))}
        </p>
      )}

      {total === 0 && !canEdit ? (
        <EmptyState title="Nothing assigned to you here yet" body="Tasks assigned to you on this project will appear here." />
      ) : (
        <ol className="flex flex-col gap-3">
          {cl.phases.map((ph) => {
            const tasks = cl.tasks.filter((t) => t.phaseKey === ph.key);
            const shown = hideDone ? tasks.filter((t) => t.status !== "done") : tasks;
            const phaseDone = tasks.filter((t) => t.status === "done").length;
            const open = isOpen(ph.key);
            if (ph.status === "skipped" && tasks.length === 0) return null;
            return (
              <li key={ph.key} id={`phase-${ph.key}`} className={cn("group/phase scroll-mt-24 rounded-card border bg-surface", ph.status === "active" ? "border-accent/50" : "border-border")}>
                <div className="flex items-center gap-2 pr-3 sm:pr-4">
                  <button
                    type="button"
                    onClick={() => setExpanded((e) => ({ ...e, [ph.key]: !open }))}
                    aria-expanded={open}
                    aria-controls={`phase-body-${ph.key}`}
                    className="flex min-h-14 min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left sm:px-6"
                  >
                    <IconChevronDown size={18} className={cn("shrink-0 text-muted transition-transform duration-200", !open && "-rotate-90")} />
                    <span className="min-w-0 flex-1">
                      <span className={cn("block truncate text-[15px] font-medium", ph.status === "skipped" && "text-muted line-through")}>{ph.name}</span>
                      <span className="num block text-[12px] text-muted">
                        {phaseDone} of {tasks.length} done
                      </span>
                    </span>
                    {ph.status === "active" ? (
                      <StatusPill tone="accent">Current</StatusPill>
                    ) : ph.status === "done" ? (
                      <StatusPill tone="done">Done</StatusPill>
                    ) : ph.status === "skipped" ? (
                      <StatusPill tone="neutral">Skipped</StatusPill>
                    ) : null}
                  </button>
                  {canEdit && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setDialog({ shift: ph.key })}
                      aria-label={`Move ${ph.name} dates`}
                      className="lg:opacity-0 lg:focus-visible:opacity-100 lg:group-hover/phase:opacity-100"
                    >
                      Shift
                    </Button>
                  )}
                  {canEdit && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setDialog({ rename: ph.key })}
                      aria-label={`Rename ${ph.name}`}
                      className="lg:opacity-0 lg:focus-visible:opacity-100 lg:group-hover/phase:opacity-100"
                    >
                      Rename
                    </Button>
                  )}
                </div>
                <div id={`phase-body-${ph.key}`} hidden={!open} className="border-t border-border">
                  {shown.length === 0 ? (
                    <p className="px-6 py-5 text-[13px] text-muted">{tasks.length ? "Everything here is done." : "No tasks in this phase."}</p>
                  ) : (
                    <PhaseTasks
                      tasks={shown}
                      today={today}
                      canEdit={canEdit && !hideDone && !selecting}
                      selection={selecting ? selected : null}
                      onSelect={(id, on) =>
                        setSelected((cur) => {
                          const next = new Set(cur);
                          if (on) next.add(id);
                          else next.delete(id);
                          return next;
                        })
                      }
                      onToggle={toggle}
                      onOpen={setOpenTask}
                      onReorder={(ids) => reorder.mutate({ projectId, phaseKey: ph.key, taskIds: ids })}
                    />
                  )}
                  {canEdit && <AddTaskRow projectId={projectId} phaseKey={ph.key} onAdded={refresh} />}
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {current && (
        <TaskDialog
          projectId={projectId}
          task={current}
          checklist={cl}
          onClose={() => {
            setAttachFor(null);
            setOpenTask(null);
          }}
          onChanged={refresh}
          onToggle={() => toggle(current)}
          focusAttachments={attachFor === current.id}
        />
      )}
      {dialog === "toggles" && <TogglesDialog projectId={projectId} checklist={cl} onClose={() => setDialog(null)} onChanged={refresh} />}
      {dialog === "update" && <TemplateUpdateDialog projectId={projectId} onClose={() => setDialog(null)} onChanged={refresh} />}
      {dialog === "save" && <SaveAsTemplateDialog projectId={projectId} onClose={() => setDialog(null)} />}
      {dialog === "addPhase" && <AddPhaseDialog projectId={projectId} phases={cl.phases} onClose={() => setDialog(null)} onChanged={refresh} />}
      {selecting && (
        <BulkBar
          projectId={projectId}
          selected={[...selected].filter((id) => cl.tasks.some((t) => t.id === id))}
          people={cl.people}
          onClear={() => setSelected(new Set())}
          onDone={async () => {
            setSelected(new Set());
            await refresh();
          }}
        />
      )}
      {dialog && typeof dialog === "object" && "shift" in dialog && (
        <ShiftPhaseDialog projectId={projectId} phase={cl.phases.find((p) => p.key === dialog.shift)!} onClose={() => setDialog(null)} onChanged={refresh} />
      )}
      {dialog && typeof dialog === "object" && "rename" in dialog && (
        <RenamePhaseDialog projectId={projectId} phase={cl.phases.find((p) => p.key === dialog.rename)!} onClose={() => setDialog(null)} onChanged={refresh} />
      )}
    </section>
  );
}

function PhaseTasks({
  tasks,
  today,
  canEdit,
  selection,
  onSelect,
  onToggle,
  onOpen,
  onReorder,
}: {
  tasks: ChecklistTask[];
  today: string;
  canEdit: boolean;
  selection: Set<string> | null;
  onSelect: (id: string, on: boolean) => void;
  onToggle: (t: ChecklistTask) => void;
  onOpen: (id: string) => void;
  onReorder: (ids: string[]) => void;
}) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const drop = (e: DragEvent, targetId: string) => {
    e.preventDefault();
    const from = dragging;
    setDragging(null);
    setOver(null);
    if (!from || from === targetId) return;
    const ids = tasks.map((t) => t.id).filter((id) => id !== from);
    ids.splice(ids.indexOf(targetId), 0, from);
    onReorder(ids);
  };
  return (
    <ul className="divide-y divide-border">
      {tasks.map((t) => {
        const isDone = t.status === "done";
        const blocked = !isDone && t.waitingOn.length > 0;
        const overdue = !isDone && t.dueOn !== null && t.dueOn < today;
        return (
          <li
            key={t.id}
            draggable={canEdit}
            onDragStart={() => setDragging(t.id)}
            onDragEnd={() => {
              setDragging(null);
              setOver(null);
            }}
            onDragOver={(e) => {
              if (!dragging) return;
              e.preventDefault();
              setOver(t.id);
            }}
            onDrop={(e) => drop(e, t.id)}
            className={cn("group flex items-start gap-1 px-2 py-2 sm:px-4", over === t.id && dragging !== t.id && "shadow-[inset_0_2px_0_var(--accent)]", dragging === t.id && "opacity-50")}
          >
            {canEdit && (
              <span className="hidden cursor-grab self-center px-1 text-faint opacity-0 transition-opacity group-hover:opacity-100 sm:block" aria-hidden="true">
                <IconGrip size={16} />
              </span>
            )}
            {selection ? (
              <label className="flex size-11 shrink-0 cursor-pointer items-center justify-center">
                <input type="checkbox" checked={selection.has(t.id)} onChange={(e) => onSelect(t.id, e.target.checked)} aria-label={`Select ${t.title}`} className="size-5 accent-[var(--accent)]" />
              </label>
            ) : (
            <button
              type="button"
              role="checkbox"
              aria-checked={isDone}
              aria-disabled={blocked || undefined}
              aria-label={`${isDone ? "Reopen" : "Complete"}: ${t.title}${blocked ? " (waiting on other tasks)" : ""}`}
              onClick={() => onToggle(t)}
              className="flex size-11 shrink-0 items-center justify-center rounded-full"
            >
              <span
                className={cn(
                  "flex size-6 items-center justify-center rounded-full border transition-colors duration-150",
                  isDone ? "border-done bg-done text-on-primary" : blocked ? "border-dashed border-border-strong text-faint" : "border-control hover:border-text",
                )}
              >
                {isDone ? <IconCheck size={14} strokeWidth={2.25} /> : blocked ? <IconLock size={12} /> : null}
              </span>
            </button>
            )}
            <button type="button" onClick={() => onOpen(t.id)} className="min-w-0 flex-1 py-2 pr-2 text-left">
              <span className={cn("block text-[15px] leading-snug", isDone && "text-muted line-through decoration-border-strong")}>{t.title}</span>
              <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted">
                <span className={cn(t.assigneeName && "text-text")}>{t.assigneeName ?? t.role}</span>
                {t.priority === "high" && !isDone && <span className="font-medium text-attention-text">High priority</span>}
                {t.status === "in_progress" && <StatusPill tone="accent">In progress</StatusPill>}
                {t.status === "waiting" && <StatusPill tone="neutral">Waiting on {t.waitingOnParty}</StatusPill>}
                {t.status === "blocked" && <StatusPill tone="blocked">Blocked</StatusPill>}
                {t.approvalDecision === "rejected" && !isDone && t.status !== "awaiting_approval" && <StatusPill tone="attention">Sent back</StatusPill>}
                {t.dueOn ? (
                  <span className={cn("num inline-flex items-center gap-1", overdue && "font-medium text-blocked-text")}>
                    {overdue && <IconAlert size={12} />}
                    {overdue ? "Overdue · " : "Due "}
                    {dueLabel(t.dueOn, today)}
                  </span>
                ) : !isDone && t.dueRule ? (
                  <span className="text-faint">{t.dueRule.from === "phase_start" ? "Dated when its phase starts" : "Dated when the task before it is done"}</span>
                ) : null}
                {t.status === "awaiting_approval" ? (
                  <StatusPill tone="attention">Awaiting approval</StatusPill>
                ) : t.requiresApproval && !isDone ? (
                  <span>Needs {t.approverRole ?? "approval"} sign-off</span>
                ) : null}
                {t.killScreen && <span className="inline-flex items-center gap-1 font-medium text-attention-text">Kill screen</span>}
                {t.milestone && (
                  <span className="inline-flex items-center gap-1">
                    <IconFlag size={12} /> Milestone
                  </span>
                )}
                {t.recurrence && (
                  <span className="inline-flex items-center gap-1">
                    <IconRepeat size={12} /> {RECUR[t.recurrence.freq]}
                  </span>
                )}
                {t.requiredAttachment && !isDone && (
                  <span className="inline-flex items-center gap-1">
                    <IconPaperclip size={12} /> {t.requiredAttachment}
                  </span>
                )}
                {t.subItems.length > 0 && (
                  <span className="num">
                    {t.subItems.filter((s) => s.done).length}/{t.subItems.length} items
                  </span>
                )}
                {t.toggleSource.map((k) => (
                  <span key={k} className="text-faint">
                    {toggleLabel(k)}
                  </span>
                ))}
              </span>
              {t.status === "blocked" && t.blockedReason && <span className="mt-1 block text-[12px] text-blocked-text">{t.blockedReason}</span>}
              {blocked && (
                <span className="mt-1 flex items-start gap-1 text-[12px] text-muted">
                  <IconLock size={12} className="mt-0.5 shrink-0" /> Waiting on {t.waitingOn.map((w) => w.title).join(", ")}
                </span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function AddTaskRow({ projectId, phaseKey, onAdded }: { projectId: string; phaseKey: string; onAdded: () => Promise<unknown> }) {
  const trpc = useTRPC();
  const toast = useToast();
  const [key, setKey] = useState(0);
  const add = useMutation(
    trpc.checklist.addTask.mutationOptions({
      onSuccess: async () => {
        setKey((k) => k + 1);
        await onAdded();
      },
      onError: (e) => toast("error", errorMessage(e)),
    }),
  );
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const title = String(new FormData(e.currentTarget).get("title") ?? "").trim();
    if (title) add.mutate({ projectId, phaseKey, title });
  };
  return (
    <form key={key} onSubmit={submit} className="flex items-center gap-2 border-t border-border px-4 py-3 sm:px-6">
      <label htmlFor={`add-${phaseKey}`} className="sr-only">
        Add a task to this phase
      </label>
      <Input id={`add-${phaseKey}`} name="title" placeholder="Add a task…" maxLength={200} className="h-10 flex-1" autoComplete="off" />
      <Button type="submit" variant="secondary" size="sm" loading={add.isPending}>
        Add
      </Button>
    </form>
  );
}
