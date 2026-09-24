"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { EmptyState, ErrorState } from "@/components/ui/architecture";
import { IconPlus } from "@/components/ui/icons";
import { Dialog, useToast } from "@/components/ui/overlay";
import { Button, Field, Input, Skeleton, StatusPill, Textarea } from "@/components/ui/primitives";
import { centsToInput, FieldError, optionalSignedMoney } from "@/core/forms";
import { formatMoney } from "@/core/money";
import { daysBetween, formatIsoDate, todayET } from "@/core/time";
import { cn } from "@/lib/cn";
import { useFileUpload } from "@/lib/file-upload";
import { errorMessage, useTRPC, type RouterOutputs } from "@/lib/trpc";
import { PersonSelect } from "./people";

type Data = RouterOutputs["rfis"]["list"];
type Rfi = Data["rfis"][number];
const d = (iso: string | null) => (iso ? formatIsoDate(iso, { month: "short", day: "numeric", year: "numeric" }) : "—");

/** Module F: RFIs with who asked, who answers, when it's due, cost and time impact, files, and one click to a change order. */
export function RfisView({ projectId }: { projectId: string }) {
  const trpc = useTRPC();
  const q = useQuery(trpc.rfis.list.queryOptions({ projectId }));
  const [editing, setEditing] = useState<Rfi | "new" | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  if (q.isPending) return <Skeleton className="h-80 rounded-card" />;
  if (q.isError) return <ErrorState onRetry={() => q.refetch()} />;
  const { rfis, access } = q.data;
  const shown = rfis.filter((r) => showClosed || r.status !== "closed");
  const today = todayET();
  const current = rfis.find((r) => r.id === open) ?? null;
  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13px] text-muted">
          {rfis.filter((r) => r.status === "open").length} open · {rfis.filter((r) => r.status === "answered").length} answered
        </p>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => setShowClosed((v) => !v)} aria-pressed={showClosed}>
            {showClosed ? "Hide closed" : "Show closed"}
          </Button>
          {access.canEdit && (
            <Button size="sm" onClick={() => setEditing("new")}>
              <IconPlus size={16} /> New RFI
            </Button>
          )}
        </div>
      </div>
      {shown.length === 0 ? (
        <EmptyState title="No RFIs" body={access.canEdit ? "Raise one when the field needs an answer from the design team." : "RFIs addressed to you show here."} />
      ) : (
        <ul className="divide-y divide-border rounded-card border border-border bg-surface">
          {shown.map((r) => {
            const late = r.status === "open" && r.dueOn && r.dueOn < today;
            return (
              <li key={r.id}>
                <button type="button" onClick={() => setOpen(r.id)} className="flex w-full flex-col gap-1 px-5 py-4 text-left hover:bg-sunken/60 sm:flex-row sm:items-center sm:gap-4">
                  <span className="num w-14 shrink-0 text-[13px] text-muted">RFI {r.number}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-medium">{r.subject}</span>
                    <span className="block truncate text-[13px] text-muted">
                      {r.fromLabel ?? "—"} → {r.toLabel ?? "—"}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-3">
                    {r.dueOn && r.status === "open" && <span className={cn("num text-[13px]", late ? "font-medium text-blocked-text" : "text-muted")}>{late ? `${daysBetween(r.dueOn, today)}d late` : `due ${formatIsoDate(r.dueOn, { month: "short", day: "numeric" })}`}</span>}
                    <StatusPill tone={r.status === "open" ? "attention" : r.status === "answered" ? "accent" : "neutral"}>{r.status === "open" ? "Open" : r.status === "answered" ? "Answered" : "Closed"}</StatusPill>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {current && <RfiSheet projectId={projectId} rfi={current} access={access} onClose={() => setOpen(null)} onEdit={() => setEditing(current)} />}
      {editing && <RfiForm projectId={projectId} rfi={editing === "new" ? null : editing} canSeeCost={access.canSeeCost} onClose={() => setEditing(null)} />}
    </div>
  );
}

function useRefresh(projectId: string) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  return () => Promise.all([qc.invalidateQueries({ queryKey: trpc.rfis.list.queryKey({ projectId }) }), qc.invalidateQueries({ queryKey: trpc.financials.overview.queryKey() })]);
}

function RfiSheet({ projectId, rfi: r, access, onClose, onEdit }: { projectId: string; rfi: Rfi; access: Data["access"]; onClose: () => void; onEdit: () => void }) {
  const trpc = useTRPC();
  const toast = useToast();
  const refresh = useRefresh(projectId);
  const [answer, setAnswer] = useState("");
  const onError = (e: unknown) => toast("error", errorMessage(e));
  const answerM = useMutation(trpc.rfis.answer.mutationOptions({ onSuccess: () => toast("success", "Answer sent"), onError, onSettled: refresh }));
  const status = useMutation(trpc.rfis.setStatus.mutationOptions({ onError, onSettled: refresh }));
  const co = useMutation(trpc.rfis.toChangeOrder.mutationOptions({ onSuccess: (x) => toast("success", x.created ? `Change order #${x.number} raised for approval` : "Already a change order"), onError, onSettled: refresh }));
  const attach = useMutation(trpc.rfis.attach.mutationOptions({ onError, onSettled: refresh }));
  const folders = useQuery({ ...trpc.files.folders.queryOptions({ projectId }), enabled: access.canEdit });
  const up = useFileUpload(projectId);
  const folderId = folders.data?.folders.find((f) => f.name === "Design")?.id ?? folders.data?.folders.find((f) => !f.gated && !f.isPhotos)?.id;
  async function addFiles(files: File[]) {
    if (!folderId) return toast("error", "No folder to file it in.");
    for (const file of files) {
      const res = await up.upload([file], { folderId });
      if (res.lastFileId) await attach.mutateAsync({ projectId, id: r.id, fileId: res.lastFileId, on: true });
    }
  }
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={`RFI ${r.number}: ${r.subject}`}
      description={`${r.fromLabel ?? "—"} → ${r.toLabel ?? "—"}${r.dueOn ? ` · due ${d(r.dueOn)}` : ""}`}
      footer={
        <>
          {access.canEdit && (
            <Button variant="ghost" className="mr-auto" onClick={onEdit}>
              Edit
            </Button>
          )}
          {access.canEdit && r.status !== "closed" && (
            <Button variant="ghost" loading={status.isPending} onClick={() => status.mutate({ projectId, id: r.id, version: r.version, status: "closed" })}>
              Close RFI
            </Button>
          )}
          {access.canEdit && r.status === "closed" && (
            <Button variant="ghost" loading={status.isPending} onClick={() => status.mutate({ projectId, id: r.id, version: r.version, status: "open" })}>
              Reopen
            </Button>
          )}
          <Button onClick={onClose}>Done</Button>
        </>
      }
    >
      <div className="flex flex-col gap-6">
        <section>
          <h3 className="eyebrow mb-2">Question</h3>
          <p className="whitespace-pre-wrap text-[15px]">{r.question}</p>
        </section>
        <dl className="grid grid-cols-2 gap-4 text-sm">
          {access.canSeeCost && (
            <div>
              <dt className="text-[12px] text-muted">Cost impact</dt>
              <dd className="num font-medium">{r.costImpactCents === null ? "—" : formatMoney(r.costImpactCents)}</dd>
            </div>
          )}
          <div>
            <dt className="text-[12px] text-muted">Schedule impact</dt>
            <dd className="num font-medium">{r.scheduleImpactDays === null ? "—" : `${r.scheduleImpactDays} days`}</dd>
          </div>
        </dl>
        <section>
          <h3 className="eyebrow mb-2">Answer</h3>
          {r.answer ? (
            <p className="whitespace-pre-wrap text-[15px]">{r.answer}</p>
          ) : r.canAnswer ? (
            <div className="flex flex-col gap-2">
              <Textarea aria-label="Answer" rows={4} maxLength={8000} value={answer} onChange={(e) => setAnswer(e.target.value)} />
              <Button className="self-end" disabled={!answer.trim()} loading={answerM.isPending} onClick={() => answerM.mutate({ projectId, id: r.id, version: r.version, answer })}>
                Send answer
              </Button>
            </div>
          ) : (
            <p className="text-[13px] text-muted">Waiting for {r.toLabel ?? "an answer"}.</p>
          )}
        </section>
        <section>
          <h3 className="eyebrow mb-2">Files</h3>
          {r.files.length === 0 && <p className="text-[13px] text-muted">None attached.</p>}
          <ul className="flex flex-col gap-1 text-sm">
            {r.files.map((f) => (
              <li key={f.id}>
                <a className="underline underline-offset-4" href={`/projects/${projectId}?tab=files&file=${f.id}`}>
                  {f.name}
                </a>
              </li>
            ))}
          </ul>
          {access.canEdit && (
            <label className="mt-2 inline-flex cursor-pointer text-[13px] underline underline-offset-4">
              {up.busy ? "Uploading…" : "Attach a file"}
              <input type="file" multiple className="sr-only" onChange={(e) => void addFiles([...(e.target.files ?? [])])} />
            </label>
          )}
        </section>
        {access.canRaiseCo && (r.status === "answered" || r.status === "closed") && (
          <div className="rounded-panel bg-sunken px-4 py-3 text-sm">
            {r.changeOrderId ? (
              <span>A change order was raised from this RFI (see Financials).</span>
            ) : (
              <span className="flex flex-wrap items-center justify-between gap-3">
                <span>Does the answer change cost or time?</span>
                <Button size="sm" variant="secondary" loading={co.isPending} onClick={() => co.mutate({ projectId, id: r.id })}>
                  Raise a change order
                </Button>
              </span>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}

function RfiForm({ projectId, rfi, canSeeCost, onClose }: { projectId: string; rfi: Rfi | null; canSeeCost: boolean; onClose: () => void }) {
  const trpc = useTRPC();
  const toast = useToast();
  const refresh = useRefresh(projectId);
  const [to, setTo] = useState<string | null>(rfi?.toUserId ?? null);
  const [from, setFrom] = useState<string | null>(rfi?.fromUserId ?? null);
  const [err, setErr] = useState<FieldError | null>(null);
  const save = useMutation(
    trpc.rfis.save.mutationOptions({
      onSuccess: async (r) => {
        toast("success", rfi ? "RFI saved" : `RFI ${r.number} raised`);
        await refresh();
        onClose();
      },
      onError: (e) => toast("error", errorMessage(e)),
    }),
  );
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const s = (k: string) => String(f.get(k) ?? "").trim();
    setErr(null);
    let cost: number | null = null;
    try {
      cost = canSeeCost ? optionalSignedMoney(s("cost"), "cost", "Cost impact") : null;
    } catch (x) {
      if (x instanceof FieldError) return setErr(x);
      throw x;
    }
    const days = s("days");
    save.mutate({
      projectId,
      id: rfi?.id,
      version: rfi?.version,
      subject: s("subject"),
      question: s("question"),
      fromUserId: from,
      fromName: from ? null : s("fromName") || null,
      toUserId: to,
      toName: to ? null : s("toName") || null,
      dueOn: s("due") || null,
      costImpactCents: canSeeCost ? cost : (rfi?.costImpactCents ?? null),
      scheduleImpactDays: days === "" ? null : Math.round(Number(days)),
    });
  };
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={rfi ? `Edit RFI ${rfi.number}` : "New RFI"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="rfi-form" loading={save.isPending}>
            {rfi ? "Save" : "Raise RFI"}
          </Button>
        </>
      }
    >
      <form id="rfi-form" onSubmit={submit} className="grid gap-5 sm:grid-cols-2">
        <Field label="Subject" htmlFor="rfi-subject" className="sm:col-span-2">
          <Input id="rfi-subject" name="subject" required maxLength={200} defaultValue={rfi?.subject ?? ""} />
        </Field>
        <Field label="Question" htmlFor="rfi-question" className="sm:col-span-2">
          <Textarea id="rfi-question" name="question" required rows={4} maxLength={8000} defaultValue={rfi?.question ?? ""} />
        </Field>
        <Field label="From" htmlFor="rfi-from">
          <PersonSelect id="rfi-from" projectId={projectId} value={from} onChange={setFrom} empty="Someone else…" />
        </Field>
        {!from && (
          <Field label="From (name)" htmlFor="rfi-from-name">
            <Input id="rfi-from-name" name="fromName" maxLength={120} defaultValue={rfi?.fromName ?? ""} />
          </Field>
        )}
        <Field label="To (who answers)" htmlFor="rfi-to">
          <PersonSelect id="rfi-to" projectId={projectId} value={to} onChange={setTo} empty="Someone else…" />
        </Field>
        {!to && (
          <Field label="To (name)" htmlFor="rfi-to-name">
            <Input id="rfi-to-name" name="toName" maxLength={120} defaultValue={rfi?.toName ?? ""} />
          </Field>
        )}
        <Field label="Answer needed by" htmlFor="rfi-due">
          <Input id="rfi-due" name="due" type="date" defaultValue={rfi?.dueOn ?? ""} className="num" />
        </Field>
        <Field label="Schedule impact (days)" htmlFor="rfi-days">
          <Input id="rfi-days" name="days" type="number" inputMode="numeric" defaultValue={rfi?.scheduleImpactDays ?? ""} className="num" />
        </Field>
        {canSeeCost && (
          <Field label="Cost impact" htmlFor="rfi-cost" error={err?.field === "cost" ? err.message : undefined}>
            <Input id="rfi-cost" name="cost" inputMode="decimal" defaultValue={centsToInput(rfi?.costImpactCents ?? null)} placeholder="$0" className="num" />
          </Field>
        )}
      </form>
    </Dialog>
  );
}
