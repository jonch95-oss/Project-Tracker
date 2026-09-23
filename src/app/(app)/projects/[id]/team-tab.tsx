"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { EmptyState, ErrorState } from "@/components/ui/architecture";
import { IconPlus } from "@/components/ui/icons";
import { Dialog, useToast } from "@/components/ui/overlay";
import { Avatar, Button, Field, Select, Skeleton, StatusPill, Switch } from "@/components/ui/primitives";
import { PROJECT_ROLES } from "@/core/permissions";
import { errorMessage, useTRPC } from "@/lib/trpc";

interface EditState {
  userId: string;
  name: string;
  isExternal: boolean;
  projectRole: string;
  canViewFinancials: boolean;
  canEditChecklist: boolean;
  canApprove: boolean;
  isNew: boolean;
}

export function TeamTab({ projectId, canManage }: { projectId: string; canManage: boolean }) {
  const trpc = useTRPC();
  const members = useQuery(trpc.members.list.queryOptions({ projectId }));
  const [edit, setEdit] = useState<EditState | null>(null);
  const [adding, setAdding] = useState(false);

  if (members.isPending) return <Skeleton className="h-48 rounded-card" />;
  if (members.isError) return <ErrorState onRetry={() => members.refetch()} />;

  return (
    <section>
      <div className="mb-6 flex items-center justify-between gap-4">
        <h2 className="serif text-[28px] leading-8">Team</h2>
        {canManage && (
          <Button variant="secondary" onClick={() => setAdding(true)}>
            <IconPlus size={18} /> Add person
          </Button>
        )}
      </div>
      {members.data.length === 0 ? (
        <EmptyState title="No one on this project yet" body="Add the people who will work on it." />
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-card border border-border bg-surface">
          {members.data.map((m) => (
            <li key={m.userId} className="flex flex-col gap-3 px-6 py-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-center gap-4">
                <Avatar name={m.name} size={40} />
                <div className="min-w-0">
                  <p className="truncate font-medium">
                    {m.name}
                    {m.status === "deactivated" && <span className="ml-2 text-[13px] font-normal text-muted">(deactivated)</span>}
                  </p>
                  <p className="truncate text-[13px] text-muted">
                    {m.projectRole}
                    {m.company ? ` · ${m.company}` : ""}
                    {m.email ? ` · ${m.email}` : ""}
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                {m.flags?.canViewFinancials && <StatusPill tone="accent">Financials</StatusPill>}
                {m.flags?.canEditChecklist && <StatusPill tone="neutral">Edits checklist</StatusPill>}
                {m.flags?.canApprove && <StatusPill tone="done">Approver</StatusPill>}
                {canManage && m.flags && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setEdit({
                        userId: m.userId,
                        name: m.name,
                        isExternal: m.globalRole === "external",
                        projectRole: m.projectRole,
                        ...m.flags!,
                        isNew: false,
                      })
                    }
                  >
                    Edit access
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {canManage && adding && (
        <AddPicker
          projectId={projectId}
          onClose={() => setAdding(false)}
          onPick={(u) => {
            setAdding(false);
            setEdit({
              userId: u.id,
              name: u.name,
              isExternal: u.role === "external",
              projectRole: u.role === "external" ? "Consultant" : "PM",
              canViewFinancials: false,
              canEditChecklist: u.role === "admin",
              canApprove: false,
              isNew: true,
            });
          }}
        />
      )}
      {canManage && edit && <AccessDialog projectId={projectId} state={edit} onClose={() => setEdit(null)} />}
    </section>
  );
}

function AddPicker({ projectId, onClose, onPick }: { projectId: string; onClose: () => void; onPick: (u: { id: string; name: string; role: string }) => void }) {
  const trpc = useTRPC();
  const candidates = useQuery(trpc.members.candidates.queryOptions({ projectId }));
  const [userId, setUserId] = useState("");
  return (
    <Dialog
      open
      onClose={onClose}
      title="Add person"
      description="Choose someone who already has an account. The owner invites new people from Team."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!userId}
            onClick={() => {
              const u = candidates.data?.find((c) => c.id === userId);
              if (u) onPick(u);
            }}
          >
            Continue
          </Button>
        </>
      }
    >
      {candidates.isPending ? (
        <Skeleton className="h-11" />
      ) : candidates.data && candidates.data.length > 0 ? (
        <Field label="Person" htmlFor="pick-user">
          <Select id="pick-user" value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">Choose…</option>
            {candidates.data.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.email})
              </option>
            ))}
          </Select>
        </Field>
      ) : (
        <p className="text-sm text-muted">Everyone with an account is already on this project.</p>
      )}
    </Dialog>
  );
}

function AccessDialog({ projectId, state, onClose }: { projectId: string; state: EditState; onClose: () => void }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const toast = useToast();
  const [s, setS] = useState(state);
  const [error, setError] = useState<string | null>(null);
  const invalidate = () => qc.invalidateQueries({ queryKey: trpc.members.list.queryKey({ projectId }) });

  const upsert = useMutation(
    trpc.members.upsert.mutationOptions({
      onSuccess: async () => {
        await invalidate();
        toast("success", state.isNew ? `${s.name} added` : "Access updated");
        onClose();
      },
      onError: (e) => setError(errorMessage(e)),
    }),
  );
  const remove = useMutation(
    trpc.members.remove.mutationOptions({
      onSuccess: async () => {
        await invalidate();
        toast("success", `${s.name} removed from the project`);
        onClose();
      },
      onError: (e) => setError(errorMessage(e)),
    }),
  );

  return (
    <Dialog
      open
      onClose={onClose}
      title={state.isNew ? `Add ${s.name}` : `${s.name}'s access`}
      footer={
        <>
          {!state.isNew && (
            <Button variant="danger" className="mr-auto" loading={remove.isPending} onClick={() => remove.mutate({ projectId, userId: s.userId })}>
              Remove from project
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={upsert.isPending}
            onClick={() =>
              upsert.mutate({
                projectId,
                userId: s.userId,
                projectRole: s.projectRole,
                canViewFinancials: s.canViewFinancials,
                canEditChecklist: s.canEditChecklist,
                canApprove: s.canApprove,
              })
            }
          >
            {state.isNew ? "Add to project" : "Save"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-6">
        <Field label="Role on this project" htmlFor="acc-role">
          <Select id="acc-role" value={s.projectRole} onChange={(e) => setS({ ...s, projectRole: e.target.value })}>
            {[...new Set([s.projectRole, ...PROJECT_ROLES])].map((r) => (
              <option key={r}>{r}</option>
            ))}
          </Select>
        </Field>
        <Switch
          id="acc-fin"
          label="Can view financials"
          description="Budget, costs, invoices, draws and sales. Hidden everywhere else when off."
          checked={s.canViewFinancials}
          onChange={(v) => setS({ ...s, canViewFinancials: v })}
        />
        <Switch
          id="acc-check"
          label="Can edit the checklist"
          description={s.isExternal ? "Outside collaborators cannot edit checklists." : "Add, remove, reorder and re-date tasks."}
          checked={s.canEditChecklist}
          disabled={s.isExternal}
          onChange={(v) => setS({ ...s, canEditChecklist: v })}
        />
        <Switch id="acc-approve" label="Can approve" description="Sign off on tasks that require approval." checked={s.canApprove} onChange={(v) => setS({ ...s, canApprove: v })} />
        {error && (
          <p role="alert" className="text-sm text-blocked-text">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
