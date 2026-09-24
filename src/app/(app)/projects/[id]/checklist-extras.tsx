"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Dialog, useToast } from "@/components/ui/overlay";
import { Button, Field, Input, Select, Skeleton } from "@/components/ui/primitives";
import { errorMessage, useTRPC } from "@/lib/trpc";
import type { Checklist } from "./checklist-tab";

export function TemplateUpdateDialog({ projectId, onClose, onChanged }: { projectId: string; onClose: () => void; onChanged: () => Promise<unknown> }) {
  const trpc = useTRPC();
  const toast = useToast();
  const q = useQuery(trpc.templates.updatePreview.queryOptions({ projectId }));
  const apply = useMutation(
    trpc.templates.applyUpdate.mutationOptions({
      onSuccess: async ([r]) => {
        toast("success", `Template update applied: ${r!.added} added, ${r!.removed} removed, ${r!.renamed} renamed`);
        onClose();
        await onChanged();
      },
      onError: (e) => toast("error", errorMessage(e)),
    }),
  );
  const d = q.data;
  const empty = d && d.add.length + d.remove.length + d.rename.length === 0;
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title="Apply template update"
      description={d ? `${d.templateName}: version ${d.fromVersion ?? "?"} → ${d.toVersion}. Only tasks that haven't started change.` : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!d} loading={apply.isPending} onClick={() => apply.mutate({ projectIds: [projectId] })}>
            {empty ? "Mark as up to date" : "Apply to this project"}
          </Button>
        </>
      }
    >
      {q.isPending ? (
        <Skeleton className="h-40" />
      ) : q.isError ? (
        <p className="text-sm text-blocked-text">{errorMessage(q.error)}</p>
      ) : (
        <div className="flex flex-col gap-5 text-sm">
          {empty && <p className="text-muted">Nothing on this checklist changes.</p>}
          <DiffList title="Added" items={d!.add.map((a) => a.title)} />
          <DiffList title="Removed (not started)" items={d!.remove.map((a) => a.title)} />
          <DiffList title="Renamed" items={d!.rename.map((r) => `${r.from} → ${r.to}`)} />
          <DiffList title="Kept as they are (already started)" items={d!.kept.map((a) => a.title)} muted />
        </div>
      )}
    </Dialog>
  );
}

function DiffList({ title, items, muted }: { title: string; items: string[]; muted?: boolean }) {
  if (!items.length) return null;
  return (
    <div>
      <p className="font-medium">
        {title} <span className="num text-muted">({items.length})</span>
      </p>
      <ul className={muted ? "mt-1 list-disc pl-5 text-faint" : "mt-1 list-disc pl-5 text-muted"}>
        {items.map((i, n) => (
          <li key={n}>{i}</li>
        ))}
      </ul>
    </div>
  );
}

export function SaveAsTemplateDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const trpc = useTRPC();
  const toast = useToast();
  const [saved, setSaved] = useState<string | null>(null);
  const save = useMutation(
    trpc.checklist.saveAsTemplate.mutationOptions({
      onSuccess: (r) => {
        setSaved(r.templateId);
        toast("success", "Template saved");
      },
      onError: (e) => toast("error", errorMessage(e)),
    }),
  );
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const name = String(new FormData(e.currentTarget).get("name") ?? "").trim();
    if (name) save.mutate({ projectId, name });
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="Save as template"
      description="This project's phases and tasks, with their roles, rules and prerequisites, become a new template. The project itself doesn't change."
      footer={
        saved ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
            <Link href={`/templates/${saved}`} className="inline-flex h-10 items-center rounded-control bg-primary px-4 text-sm font-medium text-on-primary">
              Open in Template studio
            </Link>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" form="save-template" loading={save.isPending}>
              Save template
            </Button>
          </>
        )
      }
    >
      {saved ? (
        <p className="text-sm">Saved. New projects of this type can start from it.</p>
      ) : (
        <form id="save-template" onSubmit={submit}>
          <Field label="Template name" htmlFor="st-name">
            <Input id="st-name" name="name" required maxLength={120} placeholder="e.g. Brownstone gut reno, occupied" />
          </Field>
        </form>
      )}
    </Dialog>
  );
}

export function AddPhaseDialog({ projectId, phases, onClose, onChanged }: { projectId: string; phases: Checklist["phases"]; onClose: () => void; onChanged: () => Promise<unknown> }) {
  const trpc = useTRPC();
  const toast = useToast();
  const add = useMutation(
    trpc.checklist.addPhase.mutationOptions({
      onSuccess: async () => {
        toast("success", "Phase added");
        onClose();
        await onChanged();
      },
      onError: (e) => toast("error", errorMessage(e)),
    }),
  );
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    add.mutate({ projectId, name: String(f.get("name") ?? "").trim(), afterKey: String(f.get("after")) });
  };
  const active = phases.find((p) => p.status === "active") ?? phases[0];
  return (
    <Dialog
      open
      onClose={onClose}
      title="Add a phase"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="add-phase" loading={add.isPending}>
            Add phase
          </Button>
        </>
      }
    >
      <form id="add-phase" onSubmit={submit} className="grid gap-5">
        <Field label="Name" htmlFor="ap-name">
          <Input id="ap-name" name="name" required maxLength={80} placeholder="e.g. Tenant Buyouts" />
        </Field>
        <Field label="After" htmlFor="ap-after">
          <Select id="ap-after" name="after" defaultValue={active?.key}>
            {phases.map((p) => (
              <option key={p.key} value={p.key}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
      </form>
    </Dialog>
  );
}

export function RenamePhaseDialog({ projectId, phase, onClose, onChanged }: { projectId: string; phase: Checklist["phases"][number]; onClose: () => void; onChanged: () => Promise<unknown> }) {
  const trpc = useTRPC();
  const toast = useToast();
  const rename = useMutation(
    trpc.checklist.renamePhase.mutationOptions({
      onSuccess: async () => {
        onClose();
        await onChanged();
      },
      onError: (e) => toast("error", errorMessage(e)),
    }),
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title="Rename phase"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="rename-phase" loading={rename.isPending}>
            Save
          </Button>
        </>
      }
    >
      <form
        id="rename-phase"
        onSubmit={(e) => {
          e.preventDefault();
          rename.mutate({ projectId, key: phase.key, name: String(new FormData(e.currentTarget).get("name") ?? "").trim() });
        }}
      >
        <Field label="Name" htmlFor="rp-name">
          <Input id="rp-name" name="name" required maxLength={80} defaultValue={phase.name} />
        </Field>
      </form>
    </Dialog>
  );
}
