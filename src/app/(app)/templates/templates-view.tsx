"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { ErrorState } from "@/components/ui/architecture";
import { IconPlus } from "@/components/ui/icons";
import { ConfirmDialog, Dialog, useToast } from "@/components/ui/overlay";
import { Badge, Button, Field, Input, PageHeader, Select, Skeleton, StatusPill } from "@/components/ui/primitives";
import { PROJECT_TYPE_LABEL, type ProjectTypeKey } from "@/core/labels";
import { formatDateTimeET } from "@/core/time";
import { errorMessage, useTRPC, type RouterOutputs } from "@/lib/trpc";

type Row = RouterOutputs["templates"]["list"][number];

export function TemplatesView() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery(trpc.templates.list.queryOptions());
  const [creating, setCreating] = useState(false);
  const [archiving, setArchiving] = useState<Row | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: trpc.templates.list.queryKey() });
  const setDefault = useMutation(trpc.templates.setDefault.mutationOptions({ onSuccess: async () => { toast("success", "Default template changed"); await refresh(); }, onError: (e) => toast("error", errorMessage(e)) }));
  const archive = useMutation(
    trpc.templates.setArchived.mutationOptions({
      onSuccess: async () => {
        setArchiving(null);
        toast("success", "Template archived");
        await refresh();
      },
      onError: (e) => toast("error", errorMessage(e)),
    }),
  );

  const types = Object.keys(PROJECT_TYPE_LABEL) as ProjectTypeKey[];
  return (
    <>
      <PageHeader
        eyebrow="Owner & admins"
        title="Templates"
        description="Each project type's phases and checklist. Changes never rewrite live projects; you apply updates project by project, with a preview."
        actions={
          <Button onClick={() => setCreating(true)}>
            <IconPlus size={18} /> New template
          </Button>
        }
      />
      {q.isPending ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-40 rounded-card" />
          ))}
        </div>
      ) : q.isError ? (
        <ErrorState onRetry={() => q.refetch()} />
      ) : (
        <div className="flex flex-col gap-10">
          {types.map((type) => {
            const rows = q.data.filter((t) => t.projectType === type);
            if (!rows.length) return null;
            return (
              <section key={type} aria-labelledby={`tt-${type}`}>
                <h2 id={`tt-${type}`} className="serif mb-4 text-heading">
                  {PROJECT_TYPE_LABEL[type]}
                </h2>
                <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  {rows.map((t) => (
                    <li key={t.id} className="flex flex-col rounded-card border border-border bg-surface p-6">
                      <div className="flex items-start justify-between gap-3">
                        <Link href={`/templates/${t.id}`} className="min-w-0 text-[15px] font-medium hover:underline hover:underline-offset-4">
                          {t.name}
                        </Link>
                        {t.isDefault && <StatusPill tone="accent">Default</StatusPill>}
                      </div>
                      {t.description && <p className="mt-2 line-clamp-2 text-[13px] text-muted">{t.description}</p>}
                      <p className="num mt-4 flex flex-wrap gap-2 text-[12px] text-muted">
                        <Badge>{t.phases} phases</Badge>
                        <Badge>{t.tasks} tasks</Badge>
                        <Badge>
                          {t.projects} {t.projects === 1 ? "project" : "projects"}
                        </Badge>
                      </p>
                      <p className="mt-3 text-[12px] text-faint">
                        Version {t.version} · saved {formatDateTimeET(t.updatedAt)}
                      </p>
                      <div className="mt-5 flex flex-wrap gap-2 border-t border-border pt-4">
                        <Link href={`/templates/${t.id}`} className="inline-flex h-10 items-center rounded-control bg-primary px-4 text-[13px] font-medium text-on-primary lg:h-8">
                          Open
                        </Link>
                        {!t.isDefault && (
                          <Button variant="ghost" size="sm" onClick={() => setDefault.mutate({ templateId: t.id })}>
                            Make default
                          </Button>
                        )}
                        {!t.isDefault && (
                          <Button variant="ghost" size="sm" onClick={() => setArchiving(t)}>
                            Archive
                          </Button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
      {creating && <NewTemplateDialog rows={q.data ?? []} onClose={() => setCreating(false)} />}
      <ConfirmDialog
        open={!!archiving}
        title={`Archive “${archiving?.name ?? ""}”?`}
        body="New projects can't use it. Projects already made from it keep their checklists."
        confirmLabel="Archive"
        busy={archive.isPending}
        onCancel={() => setArchiving(null)}
        onConfirm={() => archiving && archive.mutate({ templateId: archiving.id, archived: true })}
      />
    </>
  );
}

function NewTemplateDialog({ rows, onClose }: { rows: Row[]; onClose: () => void }) {
  const trpc = useTRPC();
  const router = useRouter();
  const toast = useToast();
  const create = useMutation(
    trpc.templates.create.mutationOptions({
      onSuccess: ({ id }) => router.push(`/templates/${id}`),
      onError: (e) => toast("error", errorMessage(e)),
    }),
  );
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const name = String(f.get("name") ?? "").trim();
    const from = String(f.get("from"));
    create.mutate({ name, from: from.startsWith("type:") ? { projectType: from.slice(5) as ProjectTypeKey } : { templateId: from } });
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="New template"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="new-template" loading={create.isPending}>
            Create and edit
          </Button>
        </>
      }
    >
      <form id="new-template" onSubmit={submit} className="grid gap-5">
        <Field label="Name" htmlFor="nt-name">
          <Input id="nt-name" name="name" required maxLength={120} placeholder="e.g. Brownstone gut reno, occupied" />
        </Field>
        <Field label="Start from" htmlFor="nt-from" hint="A copy you can change freely.">
          <Select id="nt-from" name="from" defaultValue="type:gut_renovation">
            <optgroup label="Library defaults">
              {(Object.keys(PROJECT_TYPE_LABEL) as ProjectTypeKey[]).map((t) => (
                <option key={t} value={`type:${t}`}>
                  {PROJECT_TYPE_LABEL[t]} (library)
                </option>
              ))}
            </optgroup>
            <optgroup label="Your templates">
              {rows.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </optgroup>
          </Select>
        </Field>
      </form>
    </Dialog>
  );
}
