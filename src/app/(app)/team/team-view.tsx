"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { ErrorState } from "@/components/ui/architecture";
import { ShareLinkDialog } from "@/components/share-link";
import { IconPlus } from "@/components/ui/icons";
import { ConfirmDialog, Dialog, useToast } from "@/components/ui/overlay";
import { Avatar, Badge, Button, Field, Input, PageHeader, Panel, Select, Skeleton, StatusPill } from "@/components/ui/primitives";
import { ROLE_DESCRIPTION, ROLE_LABEL } from "@/core/labels";
import { GLOBAL_ROLES, type GlobalRole } from "@/core/permissions";
import { formatDateTimeET } from "@/core/time";
import { errorMessage, useTRPC } from "@/lib/trpc";

/** How someone signs in: their email, or "signs in as ariel" for a username-only account (no real email). */
function signInLabel(u: { email: string; username?: string | null }): string {
  if (u.username && u.email.endsWith("@users.invalid")) return `Signs in as ${u.username}`;
  return u.username ? `${u.email} · ${u.username}` : u.email;
}

/** The invitation message, with the iPhone install guide, for WhatsApp or text. */
function inviteText(): string {
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  return `You're invited to Project Command. On iPhone, the install guide is at ${origin}/install. Set up your account here:`;
}

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
                        {signInLabel(u)}
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
  const [link, setLink] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const resend = useMutation(
    trpc.users.resendInvite.mutationOptions({
      onSuccess: async (r) => {
        await refresh();
        setLink(r.inviteUrl);
      },
      onError: (e) => toast("error", errorMessage(e)),
    }),
  );
  const revoke = useMutation(
    trpc.users.revokeInvite.mutationOptions({
      onSuccess: async () => {
        setConfirmRevoke(false);
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
          New link
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setConfirmRevoke(true)}>
          Revoke
        </Button>
      </div>
      {link && (
        <ShareLinkDialog
          title="New invitation link"
          intro={<>The previous link no longer works. This one works once and expires in 7 days.</>}
          url={link}
          whatsappText={inviteText()}
          onClose={() => setLink(null)}
        />
      )}
      <ConfirmDialog
        open={confirmRevoke}
        title={`Revoke ${invite.name}'s invitation?`}
        body="The link stops working immediately. You can invite them again later."
        confirmLabel="Revoke invitation"
        danger
        busy={revoke.isPending}
        onConfirm={() => revoke.mutate({ invitationId: invite.id })}
        onCancel={() => setConfirmRevoke(false)}
      />
    </li>
  );
}

function InviteDialog({ onClose }: { onClose: () => void }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [role, setRole] = useState<GlobalRole>("member");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ url: string; delivery: string; email: string } | null>(null);
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
    return (
      <ShareLinkDialog
        title="Invitation ready"
        intro={
          result.delivery === "sent" ? (
            <>Emailed to {result.email}. You can also share the link yourself. It works once and expires in 7 days.</>
          ) : (
            <>Send this link to {result.email} by WhatsApp or text. It works once and expires in 7 days. The iPhone install guide is linked on the page it opens.</>
          )
        }
        url={result.url}
        whatsappText={inviteText()}
        onClose={onClose}
      />
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Invite someone"
      description="You'll get a one-time link to send them by WhatsApp or text."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="invite-form" loading={invite.isPending}>
            Create invitation
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
  user: { id: string; name: string; email: string; role: GlobalRole; status: "active" | "deactivated"; twoFactorEnabled: boolean; lastSeenAt: Date | null; username?: string | null; mustChangePassword?: boolean };
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
  const [pendingRole, setPendingRole] = useState<GlobalRole | null>(null);
  const [confirmStatus, setConfirmStatus] = useState(false);
  const [resetUrl, setResetUrl] = useState<string | null>(null);
  const resetLink = useMutation(
    trpc.users.createResetLink.mutationOptions({
      onSuccess: (r) => setResetUrl(r.resetUrl),
      onError: (e) => toast("error", errorMessage(e)),
    }),
  );
  const firstName = user.name.split(" ")[0];

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={user.name}
      description={
        <>
          {signInLabel(user)}
          {user.mustChangePassword ? " · Hasn't chosen their own password yet" : ""}
          {user.lastSeenAt ? ` · Last active ${formatDateTimeET(new Date(user.lastSeenAt))}` : " · Never signed in"}
        </>
      }
      footer={
        <>
          {user.status === "active" && (
            <Button variant="secondary" className="mr-auto" loading={resetLink.isPending} onClick={() => resetLink.mutate({ userId: user.id })}>
              Create password reset link
            </Button>
          )}
          {!isSelf && (
            <Button variant={user.status === "active" ? "danger" : "secondary"} onClick={() => setConfirmStatus(true)}>
              {user.status === "active" ? "Deactivate" : "Reactivate"}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-8">
        <Field label="Role" htmlFor="user-role" hint={isSelf ? "You can't change your own owner role." : ROLE_DESCRIPTION[user.role]}>
          <Select id="user-role" value={user.role} disabled={isSelf || setRole.isPending} onChange={(e) => setPendingRole(e.target.value as GlobalRole)}>
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
      <ConfirmDialog
        open={pendingRole !== null}
        title={`Make ${firstName} ${pendingRole ? ROLE_LABEL[pendingRole].toLowerCase() : ""}?`}
        body={
          pendingRole === "owner"
            ? "Owners can do everything, including managing users, the audit log and the System page."
            : pendingRole === "external"
              ? "Outside collaborators only see projects they're added to, only their own or shared tasks, and never other people's emails."
              : pendingRole
                ? ROLE_DESCRIPTION[pendingRole]
                : null
        }
        confirmLabel="Change role"
        busy={setRole.isPending}
        onConfirm={() => {
          if (pendingRole) setRole.mutate({ userId: user.id, role: pendingRole }, { onSettled: () => setPendingRole(null) });
        }}
        onCancel={() => setPendingRole(null)}
      />
      <ConfirmDialog
        open={confirmStatus}
        title={user.status === "active" ? `Deactivate ${firstName}?` : `Reactivate ${firstName}?`}
        body={
          user.status === "active"
            ? `${firstName} is signed out on every device immediately and can't sign in again until reactivated. Their project history stays.`
            : `${firstName} can sign in again with their existing password and passkeys.`
        }
        confirmLabel={user.status === "active" ? "Deactivate" : "Reactivate"}
        danger={user.status === "active"}
        busy={setStatus.isPending}
        onConfirm={() => setStatus.mutate({ userId: user.id, status: user.status === "active" ? "deactivated" : "active" })}
        onCancel={() => setConfirmStatus(false)}
      />
      {resetUrl && (
        <ShareLinkDialog
          title={`Reset link for ${firstName}`}
          intro={<>Send this to {firstName} by WhatsApp or text. It works once, for one hour, and signs them out of other devices when used.</>}
          url={resetUrl}
          whatsappText="Here is your Project Command password reset link (valid for one hour):"
          onClose={() => setResetUrl(null)}
        />
      )}
    </Dialog>
  );
}
