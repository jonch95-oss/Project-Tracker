"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { SegmentedControl } from "@/components/project/visuals";
import { IconClose, IconComment, IconEye } from "@/components/ui/icons";
import { useToast } from "@/components/ui/overlay";
import { Avatar, Button, Field, Input, Select, Skeleton, StatusPill, Textarea } from "@/components/ui/primitives";
import { mentionMatches, mentionToken, parseComment, type Person } from "@/core/mentions";
import { formatDateTimeET, formatIsoDate } from "@/core/time";
import { cn } from "@/lib/cn";
import { errorMessage, useTRPC, type RouterOutputs } from "@/lib/trpc";

type Detail = RouterOutputs["tasks"]["detail"];
type WorkStatus = "not_started" | "in_progress" | "waiting" | "blocked";

const STATUS_ITEMS: { key: WorkStatus; label: string }[] = [
  { key: "not_started", label: "To do" },
  { key: "in_progress", label: "Doing" },
  { key: "waiting", label: "Waiting" },
  { key: "blocked", label: "Blocked" },
];

export function useTaskDetail(projectId: string, taskId: string) {
  const trpc = useTRPC();
  return useQuery(trpc.tasks.detail.queryOptions({ projectId, taskId }));
}

/**
 * Who has it and where it stands: assignee, status (with who we're waiting
 * on or what's blocking), priority, and the approval step.
 */
export function TaskWork({ projectId, taskId, version, done, onChanged }: { projectId: string; taskId: string; version: number; done: boolean; onChanged: () => Promise<unknown> }) {
  const trpc = useTRPC();
  const toast = useToast();
  const q = useTaskDetail(projectId, taskId);
  const [pending, setPending] = useState<"waiting" | "blocked" | null>(null);
  const onError = (e: unknown) => toast("error", errorMessage(e));
  const opts = { onError, onSettled: () => onChanged() };
  const assign = useMutation(trpc.tasks.assign.mutationOptions(opts));
  const setStatus = useMutation(trpc.tasks.setStatus.mutationOptions({ ...opts, onSuccess: () => setPending(null) }));
  const setPriority = useMutation(trpc.tasks.setPriority.mutationOptions(opts));
  const decide = useMutation(trpc.tasks.decide.mutationOptions({ ...opts, onSuccess: (_r, v) => toast("success", v.decision === "approved" ? "Approved" : "Sent back") }));
  const [rejecting, setRejecting] = useState(false);

  if (q.isPending) return <Skeleton className="h-28 rounded-panel" />;
  if (!q.data) return null;
  const d = q.data;
  const status = d.status;
  const work = d.access.canWork && !done;

  const submitReason = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const text = String(new FormData(e.currentTarget).get("reason") ?? "").trim();
    if (!text || !pending) return;
    setStatus.mutate({ projectId, taskId, version, status: pending, ...(pending === "waiting" ? { waitingOn: text } : { blockedReason: text }) });
  };

  return (
    <div className="flex flex-col gap-5 rounded-panel border border-border p-4 sm:p-5">
      <div className="grid gap-4 sm:grid-cols-2">
        {d.access.canAssign ? (
          <Field label="Assigned to" htmlFor="tw-assignee">
            <Select id="tw-assignee" value={d.assigneeId ?? ""} disabled={assign.isPending} onChange={(e) => assign.mutate({ projectId, taskId, version, assigneeId: e.target.value || null })}>
              <option value="">Nobody yet</option>
              {d.people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.projectRole ? ` · ${p.projectRole}` : ""}
                  {p.external ? " (outside)" : ""}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <div>
            <p className="text-[13px] font-medium">Assigned to</p>
            <p className="mt-2 flex items-center gap-2 text-sm">{d.assigneeName ? <>{d.assigneeName}</> : <span className="text-muted">Nobody yet</span>}</p>
          </div>
        )}
        <Field label="Priority" htmlFor="tw-priority">
          <Select id="tw-priority" value={d.priority} disabled={!d.access.canPrioritize || done} onChange={(e) => setPriority.mutate({ projectId, taskId, version, priority: e.target.value as "low" | "normal" | "high" })}>
            <option value="low">Low</option>
            <option value="normal">Normal</option>
            <option value="high">High</option>
          </Select>
        </Field>
      </div>

      {status === "awaiting_approval" ? (
        <div className="rounded-panel bg-attention-tint/60 px-4 py-3 text-sm">
          <p className="font-medium">Waiting for {d.approval.approverName ?? "approval"}</p>
          {d.approval.requestedAt && <p className="text-[13px] text-muted">Sent {formatDateTimeET(d.approval.requestedAt, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</p>}
          <div className="mt-3 flex flex-wrap gap-2">
            {d.approval.canDecide && !rejecting && (
              <>
                <Button size="sm" loading={decide.isPending && decide.variables?.decision === "approved"} onClick={() => decide.mutate({ projectId, taskId, version, decision: "approved" })}>
                  Approve
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setRejecting(true)}>
                  Send back
                </Button>
              </>
            )}
            {d.access.canWork && !d.approval.canDecide && (
              <Button size="sm" variant="ghost" loading={setStatus.isPending} onClick={() => setStatus.mutate({ projectId, taskId, version, status: "in_progress" })}>
                Withdraw request
              </Button>
            )}
          </div>
          {rejecting && (
            <form
              className="mt-3 flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const note = String(new FormData(e.currentTarget).get("note") ?? "").trim();
                if (note) decide.mutate({ projectId, taskId, version, decision: "rejected", note }, { onSuccess: () => setRejecting(false) });
              }}
            >
              <label htmlFor="tw-note" className="text-[13px] font-medium">
                What needs to change?
              </label>
              <Textarea id="tw-note" name="note" rows={2} maxLength={1000} required autoFocus />
              <div className="flex gap-2">
                <Button size="sm" type="submit" loading={decide.isPending}>
                  Send back
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setRejecting(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          )}
        </div>
      ) : done ? (
        d.approval.decision === "approved" && d.approval.decidedByName ? <p className="text-[13px] text-muted">Approved by {d.approval.decidedByName}.</p> : null
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-[13px] font-medium">Status</p>
          {work ? (
            <SegmentedControl<WorkStatus>
              label="Status"
              value={pending ?? (status as WorkStatus)}
              onChange={(k) => {
                if (k === "waiting" || k === "blocked") setPending(k);
                else {
                  setPending(null);
                  if (k !== status) setStatus.mutate({ projectId, taskId, version, status: k });
                }
              }}
              items={STATUS_ITEMS}
              className="self-start"
            />
          ) : (
            <p className="text-sm">{STATUS_ITEMS.find((s) => s.key === status)?.label ?? status}</p>
          )}
          {pending && (
            <form onSubmit={submitReason} className="flex flex-col gap-2 sm:flex-row">
              <label htmlFor="tw-reason" className="sr-only">
                {pending === "waiting" ? "Who are you waiting on?" : "What's blocking it?"}
              </label>
              <Input
                id="tw-reason"
                name="reason"
                autoFocus
                required
                maxLength={pending === "waiting" ? 200 : 500}
                defaultValue={pending === "waiting" ? (d.waitingOn ?? "") : (d.blockedReason ?? "")}
                placeholder={pending === "waiting" ? "Who? e.g. Expediter — DOB plan exam" : "What's blocking it?"}
                className="h-10 flex-1"
              />
              <div className="flex gap-2">
                <Button type="submit" size="sm" loading={setStatus.isPending}>
                  Save
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setPending(null)}>
                  Cancel
                </Button>
              </div>
            </form>
          )}
          {!pending && status === "waiting" && d.waitingOn && (
            <p className="text-[13px] text-muted">
              Waiting on <span className="font-medium text-text">{d.waitingOn}</span>
              {d.waitingSince && <> since {formatIsoDate(d.waitingSince, { month: "short", day: "numeric", year: undefined })}</>}
              {d.followUpOn && <> · next follow-up {formatIsoDate(d.followUpOn, { month: "short", day: "numeric", year: undefined })}</>}
            </p>
          )}
          {!pending && status === "blocked" && d.blockedReason && <p className="text-[13px] text-blocked-text">Blocked: {d.blockedReason}</p>}
          {d.approval.decision === "rejected" && <p className="rounded-panel bg-sunken px-3 py-2 text-[13px]">Sent back by {d.approval.decidedByName ?? "the approver"}: {d.approval.note}</p>}
        </div>
      )}
    </div>
  );
}

/** Watchers get updates; adding an outside collaborator shares the task with them. */
export function Watchers({ projectId, taskId, detail: d, onChanged }: { projectId: string; taskId: string; detail: Detail; onChanged: () => Promise<unknown> }) {
  const trpc = useTRPC();
  const toast = useToast();
  const opts = { onError: (e: unknown) => toast("error", errorMessage(e)), onSettled: () => onChanged() };
  const watch = useMutation(trpc.tasks.watch.mutationOptions(opts));
  const setWatcher = useMutation(trpc.tasks.setWatcher.mutationOptions(opts));
  const watchers = d.people.filter((p) => d.watcherIds.includes(p.id));
  const addable = d.people.filter((p) => !d.watcherIds.includes(p.id));
  const canLeave = d.access.canWork;
  return (
    <section aria-labelledby="td-watch-h">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 id="td-watch-h" className="text-[13px] font-medium">
          Watchers
        </h3>
        {(!d.watching || canLeave) && (
          <Button variant="ghost" size="sm" loading={watch.isPending} onClick={() => watch.mutate({ projectId, taskId, on: !d.watching })}>
            <IconEye size={16} /> {d.watching ? "Stop watching" : "Watch"}
          </Button>
        )}
      </div>
      {watchers.length === 0 ? (
        <p className="text-sm text-muted">Nobody yet.</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {watchers.map((p) => (
            <li key={p.id} className="inline-flex h-8 items-center gap-2 rounded-full border border-border pl-1 pr-2 text-[13px]">
              <Avatar name={p.name} size={24} />
              {p.name}
              {p.external && <span className="text-muted">(outside)</span>}
              {d.access.canManageWatchers && (
                <button type="button" onClick={() => setWatcher.mutate({ projectId, taskId, userId: p.id, on: false })} className="rounded-full p-1 text-muted hover:bg-sunken hover:text-text" aria-label={`Remove ${p.name}`}>
                  <IconClose size={12} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {d.access.canManageWatchers && addable.length > 0 && (
        <div className="mt-3 max-w-sm">
          <label htmlFor="td-add-watcher" className="sr-only">
            Add a watcher
          </label>
          <Select id="td-add-watcher" value="" onChange={(e) => e.target.value && setWatcher.mutate({ projectId, taskId, userId: e.target.value, on: true })}>
            <option value="">Add a watcher or share with…</option>
            {addable.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.external ? " (outside — shares this task)" : ""}
              </option>
            ))}
          </Select>
        </div>
      )}
    </section>
  );
}

/** Comments with @mentions. Type @ and a name; the pick becomes a mention that notifies them. */
export function Comments({ projectId, taskId, detail: d, onChanged }: { projectId: string; taskId: string; detail: Detail; onChanged: () => Promise<unknown> }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const toast = useToast();
  const [text, setText] = useState("");
  const [chosen, setChosen] = useState<Person[]>([]);
  const [query, setQuery] = useState<{ q: string; start: number } | null>(null);
  const [hi, setHi] = useState(0);
  const box = useRef<HTMLTextAreaElement>(null);
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: trpc.tasks.detail.queryKey({ projectId, taskId }) });
    await onChanged();
  };
  const onError = (e: unknown) => toast("error", errorMessage(e));
  const add = useMutation(
    trpc.tasks.addComment.mutationOptions({
      onSuccess: async () => {
        setText("");
        setChosen([]);
        await refresh();
      },
      onError,
    }),
  );
  const remove = useMutation(trpc.tasks.deleteComment.mutationOptions({ onSuccess: refresh, onError }));
  const matches = query ? mentionMatches(query.q, d.mentionable) : [];

  const onInput = (value: string, caret: number) => {
    setText(value);
    const before = value.slice(0, caret);
    const m = /(^|\s)@([\p{L}' -]{0,30})$/u.exec(before);
    if (m) {
      setQuery({ q: m[2]!, start: caret - m[2]!.length - 1 });
      setHi(0);
    } else setQuery(null);
  };
  const pick = (p: Person) => {
    if (!query) return;
    const caret = box.current?.selectionStart ?? text.length;
    const next = `${text.slice(0, query.start)}@${p.name} ${text.slice(caret)}`;
    setText(next);
    setChosen((c) => (c.some((x) => x.id === p.id) ? c : [...c, p]));
    setQuery(null);
    requestAnimationFrame(() => {
      const pos = query.start + p.name.length + 2;
      box.current?.focus();
      box.current?.setSelectionRange(pos, pos);
    });
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!query || matches.length === 0) {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setHi((h) => (h + (e.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length);
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      pick(matches[hi]!);
    } else if (e.key === "Escape") {
      e.stopPropagation();
      setQuery(null);
    }
  };
  function submit(e?: FormEvent) {
    e?.preventDefault();
    let body = text.trim();
    if (!body) return;
    // Longest names first so "@Ann Lee" isn't eaten by "@Ann".
    for (const p of [...chosen].sort((a, b) => b.name.length - a.name.length)) body = body.split(`@${p.name}`).join(mentionToken(p));
    add.mutate({ projectId, taskId, body });
  }

  return (
    <section aria-labelledby="td-comments-h">
      <h3 id="td-comments-h" className="mb-3 flex items-center gap-2 text-[13px] font-medium">
        <IconComment size={16} /> Comments
      </h3>
      {d.comments.length > 0 && (
        <ol className="mb-4 flex flex-col gap-4">
          {d.comments.map((c) => (
            <li key={c.id} className="flex gap-3">
              <Avatar name={c.authorName ?? "?"} size={28} className="mt-0.5" />
              <div className="min-w-0 flex-1">
                <p className="text-[13px]">
                  <span className="font-medium">{c.authorName ?? "Former teammate"}</span>{" "}
                  <span className="text-muted">
                    {formatDateTimeET(c.createdAt, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                    {c.editedAt && !c.deletedAt ? " · edited" : ""}
                  </span>
                </p>
                {c.deletedAt ? (
                  <p className="text-sm italic text-muted">Comment removed.</p>
                ) : (
                  <p className="whitespace-pre-line break-words text-[15px] leading-relaxed">
                    {parseComment(c.body, d.people).map((part, i) =>
                      part.kind === "text" ? (
                        <span key={i}>{part.text}</span>
                      ) : (
                        <span key={i} className="rounded bg-accent-tint px-1 font-medium text-accent-text">
                          @{part.name}
                        </span>
                      ),
                    )}
                  </p>
                )}
                {c.mine && !c.deletedAt && (
                  <button type="button" onClick={() => remove.mutate({ projectId, taskId, commentId: c.id })} className="mt-1 text-[12px] text-muted underline-offset-4 hover:underline">
                    Remove
                  </button>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
      <form onSubmit={submit} className="relative">
        <label htmlFor="td-comment" className="sr-only">
          Write a comment
        </label>
        <Textarea
          ref={box}
          id="td-comment"
          rows={2}
          maxLength={3500}
          value={text}
          onChange={(e) => onInput(e.target.value, e.target.selectionStart)}
          onKeyDown={onKey}
          placeholder="Write a comment. Type @ to mention someone."
          role="combobox"
          aria-expanded={matches.length > 0}
          aria-controls="td-mentions"
          aria-autocomplete="list"
          aria-activedescendant={matches.length ? `td-mention-${matches[hi]?.id}` : undefined}
        />
        {query && matches.length > 0 && (
          <ul id="td-mentions" role="listbox" className="absolute bottom-full left-0 z-10 mb-1 w-64 overflow-hidden rounded-panel border border-border bg-surface py-1 shadow-lift">
            {matches.map((p, i) => (
              <li key={p.id} id={`td-mention-${p.id}`} role="option" aria-selected={i === hi}>
                <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(p)} className={cn("flex h-10 w-full items-center gap-2 px-3 text-left text-sm", i === hi && "bg-sunken")}>
                  <Avatar name={p.name} size={24} /> {p.name}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-2 flex justify-end">
          <Button type="submit" size="sm" loading={add.isPending} disabled={!text.trim()}>
            Comment
          </Button>
        </div>
      </form>
    </section>
  );
}

export function StatusChip({ status }: { status: string }) {
  if (status === "in_progress") return <StatusPill tone="accent">In progress</StatusPill>;
  if (status === "waiting") return <StatusPill tone="neutral">Waiting</StatusPill>;
  if (status === "blocked") return <StatusPill tone="blocked">Blocked</StatusPill>;
  if (status === "awaiting_approval") return <StatusPill tone="attention">Awaiting approval</StatusPill>;
  if (status === "done") return <StatusPill tone="done">Done</StatusPill>;
  return <StatusPill tone="neutral">Not started</StatusPill>;
}
