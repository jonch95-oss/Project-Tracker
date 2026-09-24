"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { EmptyState, ErrorState } from "@/components/ui/architecture";
import { IconPlus } from "@/components/ui/icons";
import { Dialog, useToast } from "@/components/ui/overlay";
import { Button, Field, Input, Select, Skeleton, StatusPill, Textarea, type Tone } from "@/components/ui/primitives";
import { SUBMITTAL_DECISIONS } from "@/core/field";
import { formatIsoDate } from "@/core/time";
import { useFileUpload } from "@/lib/file-upload";
import { errorMessage, useTRPC, type RouterOutputs } from "@/lib/trpc";
import { PersonSelect } from "./people";

type Data = RouterOutputs["submittals"]["list"];
type Submittal = Data["submittals"][number];

const STATUS: Record<string, { label: string; tone: Tone }> = {
  pending: { label: "In review", tone: "attention" },
  approved: { label: "Approved", tone: "done" },
  approved_as_noted: { label: "Approved as noted", tone: "done" },
  revise_resubmit: { label: "Revise and resubmit", tone: "blocked" },
  rejected: { label: "Rejected", tone: "blocked" },
};

/** Module F: submittals by spec section, the reviewer's decision, and every revision kept. */
export function SubmittalsView({ projectId }: { projectId: string }) {
  const trpc = useTRPC();
  const q = useQuery(trpc.submittals.list.queryOptions({ projectId }));
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  if (q.isPending) return <Skeleton className="h-80 rounded-card" />;
  if (q.isError) return <ErrorState onRetry={() => q.refetch()} />;
  const { submittals, canEdit } = q.data;
  const current = submittals.find((s) => s.id === open) ?? null;
  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13px] text-muted">{submittals.filter((s) => s.status === "pending").length} in review</p>
        {canEdit && (
          <Button size="sm" onClick={() => setAdding(true)}>
            <IconPlus size={16} /> Log submittal
          </Button>
        )}
      </div>
      {submittals.length === 0 ? (
        <EmptyState title="No submittals" body={canEdit ? "Log shop drawings, product data and samples as they come in." : "Submittals you review show here."} />
      ) : (
        <ul className="divide-y divide-border rounded-card border border-border bg-surface">
          {submittals.map((s) => (
            <li key={s.id}>
              <button type="button" onClick={() => setOpen(s.id)} className="flex w-full flex-col gap-1 px-5 py-4 text-left hover:bg-sunken/60 sm:flex-row sm:items-center sm:gap-4">
                <span className="num w-20 shrink-0 text-[13px] text-muted">#{s.number}{s.specSection ? ` · ${s.specSection}` : ""}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-medium">{s.item}</span>
                  <span className="block truncate text-[13px] text-muted">
                    {s.submittedBy ?? "—"} → {s.reviewerLabel ?? "—"} · rev {s.revisions[0]?.revision ?? 0}
                  </span>
                </span>
                <StatusPill tone={STATUS[s.status]!.tone}>{STATUS[s.status]!.label}</StatusPill>
              </button>
            </li>
          ))}
        </ul>
      )}
      {current && <SubmittalSheet projectId={projectId} s={current} canEdit={canEdit} onClose={() => setOpen(null)} />}
      {adding && <NewSubmittal projectId={projectId} onClose={() => setAdding(false)} />}
    </div>
  );
}

function useUploadOne(projectId: string) {
  const trpc = useTRPC();
  const folders = useQuery(trpc.files.folders.queryOptions({ projectId }));
  const up = useFileUpload(projectId);
  const folderId = folders.data?.folders.find((f) => f.name === "Construction")?.id ?? folders.data?.folders.find((f) => !f.gated && !f.isPhotos)?.id;
  return { busy: up.busy, upload: async (file: File | null) => (file && folderId ? (await up.upload([file], { folderId })).lastFileId : null) };
}

function SubmittalSheet({ projectId, s, canEdit, onClose }: { projectId: string; s: Submittal; canEdit: boolean; onClose: () => void }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const toast = useToast();
  const refresh = () => qc.invalidateQueries({ queryKey: trpc.submittals.list.queryKey({ projectId }) });
  const onError = (e: unknown) => toast("error", errorMessage(e));
  const [decision, setDecision] = useState<string>("approved");
  const [notes, setNotes] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const up = useUploadOne(projectId);
  const decide = useMutation(trpc.submittals.decide.mutationOptions({ onSuccess: () => toast("success", "Decision recorded"), onError, onSettled: refresh }));
  const resubmit = useMutation(trpc.submittals.resubmit.mutationOptions({ onSuccess: (r) => toast("success", `Revision ${r.revision} logged`), onError, onSettled: refresh }));
  return (
    <Dialog open onClose={onClose} size="lg" title={`Submittal #${s.number}: ${s.item}`} description={[s.specSection && `Spec ${s.specSection}`, s.submittedBy && `from ${s.submittedBy}`, s.reviewerLabel && `reviewer ${s.reviewerLabel}`].filter(Boolean).join(" · ")} footer={<Button onClick={onClose}>Done</Button>}>
      <div className="flex flex-col gap-6">
        <ol className="divide-y divide-border rounded-panel border border-border">
          {s.revisions.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
              <span>
                <span className="font-medium">Rev {r.revision}</span> <span className="num text-muted">· {r.submittedOn ? formatIsoDate(r.submittedOn, { month: "short", day: "numeric" }) : ""}</span>
                {r.fileName && (
                  <a className="ml-2 underline underline-offset-4" href={`/projects/${projectId}?tab=files&file=${r.fileId}`}>
                    {r.fileName}
                  </a>
                )}
                {r.notes && <span className="mt-1 block text-[13px] text-muted">{r.notes}</span>}
              </span>
              {r.decision ? <StatusPill tone={STATUS[r.decision]!.tone}>{STATUS[r.decision]!.label}</StatusPill> : <StatusPill tone="attention">In review</StatusPill>}
            </li>
          ))}
        </ol>
        {s.canDecide && (
          <section className="flex flex-col gap-3">
            <h3 className="eyebrow">Decision on rev {s.revisions[0]?.revision ?? 0}</h3>
            <Select aria-label="Decision" value={decision} onChange={(e) => setDecision(e.target.value)}>
              {SUBMITTAL_DECISIONS.map((x) => (
                <option key={x.key} value={x.key}>
                  {x.label}
                </option>
              ))}
            </Select>
            <Textarea aria-label="Notes" rows={2} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes for the submitter" />
            <Button className="self-end" loading={decide.isPending} onClick={() => decide.mutate({ projectId, id: s.id, version: s.version, decision: decision as never, notes: notes || null })}>
              Record decision
            </Button>
          </section>
        )}
        {canEdit && s.status !== "pending" && (
          <section className="flex flex-col gap-3">
            <h3 className="eyebrow">Resubmit</h3>
            <input type="file" aria-label="Revised file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-sm" />
            <Button className="self-end" variant="secondary" loading={resubmit.isPending || up.busy} onClick={async () => resubmit.mutate({ projectId, id: s.id, version: s.version, fileId: await up.upload(file) })}>
              Log revision {(s.revisions[0]?.revision ?? 0) + 1}
            </Button>
          </section>
        )}
      </div>
    </Dialog>
  );
}

function NewSubmittal({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const toast = useToast();
  const [reviewer, setReviewer] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const up = useUploadOne(projectId);
  const create = useMutation(
    trpc.submittals.create.mutationOptions({
      onSuccess: async (r) => {
        toast("success", `Submittal #${r.number} logged`);
        await qc.invalidateQueries({ queryKey: trpc.submittals.list.queryKey({ projectId }) });
        onClose();
      },
      onError: (e) => toast("error", errorMessage(e)),
    }),
  );
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const s = (k: string) => String(f.get(k) ?? "").trim() || null;
    create.mutate({ projectId, specSection: s("spec"), item: s("item") ?? "", submittedBy: s("by"), reviewerId: reviewer, reviewerName: reviewer ? null : s("reviewerName"), dueOn: s("due"), fileId: await up.upload(file) });
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="Log a submittal"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="sub-form" loading={create.isPending || up.busy}>
            Log
          </Button>
        </>
      }
    >
      <form id="sub-form" onSubmit={submit} className="grid gap-5 sm:grid-cols-2">
        <Field label="Item" htmlFor="sub-item" className="sm:col-span-2">
          <Input id="sub-item" name="item" required maxLength={200} placeholder="e.g. Storefront shop drawings" />
        </Field>
        <Field label="Spec section" htmlFor="sub-spec">
          <Input id="sub-spec" name="spec" maxLength={40} placeholder="08 41 13" />
        </Field>
        <Field label="Submitted by" htmlFor="sub-by">
          <Input id="sub-by" name="by" maxLength={120} placeholder="Company" />
        </Field>
        <Field label="Reviewer" htmlFor="sub-reviewer">
          <PersonSelect id="sub-reviewer" projectId={projectId} value={reviewer} onChange={setReviewer} empty="Someone else…" />
        </Field>
        {!reviewer && (
          <Field label="Reviewer (name)" htmlFor="sub-reviewer-name">
            <Input id="sub-reviewer-name" name="reviewerName" maxLength={120} />
          </Field>
        )}
        <Field label="Response needed by" htmlFor="sub-due">
          <Input id="sub-due" name="due" type="date" className="num" />
        </Field>
        <Field label="File (optional)" htmlFor="sub-file">
          <input id="sub-file" type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-sm" />
        </Field>
      </form>
    </Dialog>
  );
}
