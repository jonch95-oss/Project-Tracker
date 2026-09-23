"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { ErrorState } from "@/components/ui/architecture";
import { IconCopy, IconPlus } from "@/components/ui/icons";
import { Dialog, useToast } from "@/components/ui/overlay";
import { Avatar, Badge, Button, Field, Input, PageHeader, Panel, Select, Skeleton, StatusPill } from "@/components/ui/primitives";
import { ROLE_DESCRIPTION, ROLE_LABEL } from "@/core/labels";
import { GLOBAL_ROLES, type GlobalRole } from "@/core/permissions";
import { formatDateTimeET } from "@/core/time";
import { errorMessage, useTRPC } from "@/lib/trpc";

export function TeamView({ viewerId }: { viewerId: string }) {
  const trpc = useTRPC();
  const users = useQuery(trpc.users.list.queryOptions());
  const invites = useQuery(trpc.users.invitations.queryOptions());
  const [inviting, setInviting] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <>
      <PageHeader
        eyebrow="Owner"
        title="Team & permissions"
        description="Invite people, set their role, and control what they can see on each project."
        actions={
          <Button onClick={() => setInviting(true)}>
            <IconPlus size={18} /> Invite someone
          </Button>
        }
      />

      <div className="flex flex-col gap-8">
        <Panel title="People" description="Roles apply everywhere. Project access and financial visibility are set per project.">
          {users.isPending ? (
            <div className="space-y-3">
              <Skeleton className="h-14" />
              <Skeleton className="h-14" />
            </div>
          ) : users.isError ? (
            <ErrorState onRetry={() => users.refetch()} />
          ) : (
            <ul className="-mx-6 divide-y divide-border sm:-mx-8">
              {users.data.map((u) => (
                <li key={u.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(u.id)}
                    className="flex w-full items-center gap-4 px-6 py-4 text-left transition-colors hover:bg-sunken/60 sm:px-8"
                  >
                    <Avatar name={u.name} size={40} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">
                        {u.name} {u.id === viewerId && <span className="text-[13px] font-normal text-muted">(you)</span>}
                      </p>
                      <p className="truncate text-[13px] text-muted">
                        {u.email}
                        {u.title ? ` · ${u.title}` : ""}
                      </p>
                    </div>
                    <div className="hidden shrink-0 items-center gap-2 sm:flex">
                      <span className="num text-[13px] text-muted">{u.projectCount} projects</span>
                      {!u.twoFactorEnabled && u.role === "owner" && <StatusPill tone="attention">No 2FA</StatusPill>}
                    </div>
                    {u.status === "deactivated" ? <StatusPill tone="blocked">Deactivated</StatusPill> : <Badge>{ROLE_LABEL[u.role]}</Badge>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Pending invitations" description="Invitations expire after 7 days.">
          {invites.isPending ? (
            <Skeleton className="h-14" />
          ) : invites.isError ? (
            <ErrorState onRetry={() => invites.refetch()} />
          ) : invites.data.length === 0 ? (
            <p className="text-sm text-muted">No invitations waiting.</p>
          ) : (
            <ul className="-mx-6 divide-y divide-border sm:-mx-8">
              {invites.data.map((i) => (
                <PendingInvite key={i.id} invite={i} />
              ))}
            </ul>
          )}
        </Panel>
      </div>

      {inviting && <InviteDialog onClose={() => setInviting(false)} />}
      {selected && users.data && (
        <UserDialog user={users.data.find((u) => u.id === selected)!} isSelf={selected === viewerId} onClose={() => setSelected(null)} />
      )}
    </>
  );
}

function PendingInvite({ invite }: { invite: { id: string; email: string; name: string; role: GlobalRole; expiresAt: Date } }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const toast = useToast();
  const refresh = () => qc.invalidateQueries({ queryKey: trpc.users.invitations.queryKey() });
  const resend = useMutation(
    trpc.users.resendInvite.mutationOptions({
      onSuccess: async (r) => {
        await refresh();
        toast(r.delivery === "sent" ? "success" : "error", r.delivery === "sent" ? "Invitation sent again" : "Email held or failed. Copy the link from a new invitation instead.");
      },
      onError: (e) => toast("error", errorMessage(e)),
    }),
  );
  const revoke = useMutation(
    trpc.users.revokeInvite.mutationOptions({
      onSuccess: async () => {
        await refresh();
        toast("success", "Invitation revoked");
      },
      onError: (e) => toast("error", errorMessage(e)),
    }),
  );
  const expired = invite.expiresAt < new Date();
  return (
    <li className="flex flex-col gap-3 px-6 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-8">
      <div className="min-w-0">
        <p className="truncate font-medium">
          {invite.name} <span className="font-normal text-muted">· {ROLE_LABEL[invite.role]}</span>
        </p>
        <p className="truncate text-[13px] text-muted">
          {invite.email} · {expired ? "Expired" : `Expires ${formatDateTimeET(invite.expiresAt, { hour: undefined, minute: undefined })}`}
        </p>
      </div>
      <div className="flex gap-2">
        <Button size="sm" variant="secondary" loading={resend.isPending} onClick={() => resend.mutate({ invitationId: invite.id })}>
          Resend
        </Button>
        <Button size="sm" variant="ghost" loading={revoke.isPending} onClick={() => revoke.mutate({ invitationId: invite.id })}>
          Revoke
        </Button>
      </div>
    </li>
  );
}

function InviteDialog({ onClose }: { onClose: () => void }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [role, setRole] = useState<GlobalRole>("member");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ url: string; delivery: string; email: string } | null>(null);
  const toast = useToast();
  const invite = useMutation(
    trpc.users.invite.mutationOptions({
      onSuccess: async (r, vars) => {
        await qc.invalidateQueries({ queryKey: trpc.users.invitations.queryKey() });
        setResult({ url: r.inviteUrl, delivery: r.delivery, email: vars.email });
      },
      onError: (e) => setError(errorMessage(e)),
    }),
  );

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const f = new FormData(e.currentTarget);
    invite.mutate({
      email: String(f.get("email")).trim(),
      name: String(f.get("name")).trim(),
      role,
      title: String(f.get("title") ?? "").trim() || undefined,
      company: String(f.get("company") ?? "").trim() || undefined,
    });
  }

  if (result) {
    const whatsapp = `https://wa.me/?text=${encodeURIComponent(`You're invited to Project Command. Set up your account here: ${result.url}`)}`;
    return (
      <Dialog open onClose={onClose} title="Invitation ready" footer={<Button onClick={onClose}>Done</Button>}>
        <div className="flex flex-col gap-5">
          {result.delivery === "sent" ? (
            <StatusPill tone="done">Emailed to {result.email}</StatusPill>
          ) : (
            <StatusPill tone="attention">Email {result.delivery}; share the link below instead</StatusPill>
          )}
          <p className="text-sm text-muted">You can also share the link yourself. It works once and expires in 7 days.</p>
          <div className="flex items-center gap-2 rounded-control border border-border bg-sunken p-3">
            <code className="min-w-0 flex-1 truncate font-mono text-[12px]">{result.url}</code>
            <Button
              size="sm"
              variant="secondary"
              onClick={async () => {
                await navigator.clipboard.writeText(result.url);
                toast("success", "Link copied");
              }}
            >
              <IconCopy size={16} /> Copy
            </Button>
          </div>
          <a href={whatsapp} target="_blank" rel="noopener noreferrer" className="text-sm underline underline-offset-4">
            Share on WhatsApp
          </a>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Invite someone"
      description="They'll get an email with a link to set their password, plus the iPhone install guide."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="invite-form" loading={invite.isPending}>
            Send invitation
          </Button>
        </>
      }
    >
      <form id="invite-form" onSubmit={onSubmit} className="grid gap-5 sm:grid-cols-2">
        <Field label="Name" htmlFor="inv-name">
          <Input id="inv-name" name="name" required autoComplete="off" />
        </Field>
        <Field label="Email" htmlFor="inv-email">
          <Input id="inv-email" name="email" type="email" required autoComplete="off" />
        </Field>
        <Field label="Role" htmlFor="inv-role" className="sm:col-span-2" hint={ROLE_DESCRIPTION[role]}>
          <Select id="inv-role" value={role} onChange={(e) => setRole(e.target.value as GlobalRole)}>
            {GLOBAL_ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Title" htmlFor="inv-title" hint="Optional, e.g. Architect">
          <Input id="inv-title" name="title" />
        </Field>
        <Field label="Company" htmlFor="inv-company" hint="Optional, for outside firms" error={error}>
          <Input id="inv-company" name="company" />
        </Field>
      </form>
    </Dialog>
  );
}

function UserDialog({
  user,
  isSelf,
  onClose,
}: {
  user: { id: string; name: string; email: string; role: GlobalRole; status: "active" | "deactivated"; twoFactorEnabled: boolean; lastSeenAt: Date | null };
  isSelf: boolean;
  onClose: () => void;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const toast = useToast();
  const access = useQuery(trpc.users.access.queryOptions({ userId: user.id }));
  const refresh = () => qc.invalidateQueries({ queryKey: trpc.users.list.queryKey() });
  const setRole = useMutation(
    trpc.users.setRole.mutationOptions({
      onSuccess: async () => {
        await refresh();
        toast("success", "Role updated");
      },
      onError: (e) => toast("error", errorMessage(e)),
    }),
  );
  const setStatus = useMutation(
    trpc.users.setStatus.mutationOptions({
      onSuccess: async (_r, v) => {
        await refresh();
        toast("success", v.status === "deactivated" ? `${user.name} deactivated and signed out everywhere` : `${user.name} reactivated`);
        onClose();
      },
      onError: (e) => toast("error", errorMessage(e)),
    }),
  );

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={user.name}
      description={
        <>
          {user.email}
          {user.lastSeenAt ? ` · Last active ${formatDateTimeET(new Date(user.lastSeenAt))}` : " · Never signed in"}
        </>
      }
      footer={
        !isSelf && (
          <Button
            variant={user.status === "active" ? "danger" : "secondary"}
            loading={setStatus.isPending}
            onClick={() => setStatus.mutate({ userId: user.id, status: user.status === "active" ? "deactivated" : "active" })}
          >
            {user.status === "active" ? "Deactivate" : "Reactivate"}
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-8">
        <Field label="Role" htmlFor="user-role" hint={isSelf ? "You can't change your own owner role." : ROLE_DESCRIPTION[user.role]}>
          <Select id="user-role" value={user.role} disabled={isSelf || setRole.isPending} onChange={(e) => setRole.mutate({ userId: user.id, role: e.target.value as GlobalRole })}>
            {GLOBAL_ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </Select>
        </Field>

        <div>
          <h3 className="mb-3 text-sm font-medium">Project access</h3>
          {access.isPending ? (
            <Skeleton className="h-12" />
          ) : access.data && access.data.length > 0 ? (
            <ul className="divide-y divide-border rounded-panel border border-border">
              {access.data.map((a) => (
                <li key={a.projectId} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <Link href={`/projects/${a.projectId}`} className="min-w-0 hover:underline">
                    <span className="block truncate text-sm font-medium">{a.projectName}</span>
                    <span className="block truncate text-[13px] text-muted">
                      {a.projectRole} · {a.address}
                    </span>
                  </Link>
                  <div className="flex flex-wrap gap-1.5">
                    {a.canViewFinancials && <StatusPill tone="accent">Financials</StatusPill>}
                    {a.canEditChecklist && <StatusPill tone="neutral">Checklist</StatusPill>}
                    {a.canApprove && <StatusPill tone="done">Approver</StatusPill>}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">Not on any projects yet. Add people from a project&apos;s Team tab.</p>
          )}
          <p className="mt-3 text-[13px] text-muted">Workload across tasks appears here once tasks are live.</p>
        </div>
      </div>
    </Dialog>
  );
}
