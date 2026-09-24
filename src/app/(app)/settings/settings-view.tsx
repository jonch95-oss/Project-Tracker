"use client";

import { useMutation } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import QRCode from "qrcode";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { IconFaceId, IconKey, IconPhone, IconShield, IconSignOut } from "@/components/ui/icons";
import { ConfirmDialog, Dialog, useToast } from "@/components/ui/overlay";
import { Button, Field, Input, PageHeader, Panel, StatusPill } from "@/components/ui/primitives";
import { ROLE_LABEL } from "@/core/labels";
import type { GlobalRole } from "@/core/permissions";
import { PASSWORD_HINT, passwordProblem } from "@/core/password";
import { authClient } from "@/lib/auth-client";
import { errorMessage, useTRPC } from "@/lib/trpc";
import { hasPasskeySupport, useClientFlag } from "@/lib/use-client-flag";
import { useSignOut } from "@/lib/push";
import { NotificationSettings } from "./notification-settings";

interface ViewerProps {
  name: string;
  email: string;
  title: string | null;
  twoFactorEnabled: boolean;
  role: GlobalRole;
}

export function SettingsView({ viewer, welcome }: { viewer: ViewerProps; welcome: boolean }) {
  const signOut = useSignOut();
  return (
    <>
      <PageHeader eyebrow={ROLE_LABEL[viewer.role]} title="Settings" description="Your profile, sign-in, security and notifications." />
      {welcome && (
        <div className="mb-8 flex flex-col gap-4 rounded-card border border-accent/30 bg-accent-tint px-6 py-6 sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <div>
            <h2 className="serif text-heading">You&apos;re in.</h2>
            <p className="mt-1 text-sm text-muted">On iPhone, install the app to your Home Screen and turn on Face ID sign-in below.</p>
          </div>
          <Link href="/install" className="inline-flex h-10 items-center gap-2 rounded-control bg-primary px-4 text-sm font-medium text-on-primary">
            <IconPhone size={18} /> iPhone install guide
          </Link>
        </div>
      )}
      <div className="grid gap-8 xl:grid-cols-2">
        <ProfilePanel viewer={viewer} />
        <PasswordPanel />
        <TwoFactorPanel enabled={viewer.twoFactorEnabled} />
        <PasskeyPanel />
      </div>
      <NotificationSettings />
      <div className="mt-12 flex justify-center lg:hidden">
        <Button
          variant="secondary"
          size="lg"
          onClick={signOut}
        >
          <IconSignOut size={18} /> Sign out
        </Button>
      </div>
    </>
  );
}

function ProfilePanel({ viewer }: { viewer: ViewerProps }) {
  const trpc = useTRPC();
  const toast = useToast();
  const router = useRouter();
  const [name, setName] = useState(viewer.name);
  const [title, setTitle] = useState(viewer.title ?? "");
  const save = useMutation(
    trpc.me.updateProfile.mutationOptions({
      onSuccess: () => {
        toast("success", "Profile saved");
        router.refresh();
      },
      onError: (e) => toast("error", errorMessage(e)),
    }),
  );
  return (
    <Panel title="Profile">
      <form
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate({ name, title: title.trim() || null });
        }}
      >
        <Field label="Name" htmlFor="pf-name">
          <Input id="pf-name" value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" />
        </Field>
        <Field label="Title" htmlFor="pf-title">
          <Input id="pf-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Project Manager" />
        </Field>
        <Field label="Email" htmlFor="pf-email" hint="Your sign-in email.">
          <Input id="pf-email" value={viewer.email} disabled readOnly />
        </Field>
        <div>
          <Button type="submit" variant="secondary" loading={save.isPending}>
            Save profile
          </Button>
        </div>
      </form>
    </Panel>
  );
}

function PasswordPanel() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const next = String(f.get("next"));
    const problem = passwordProblem(next);
    if (problem) return setError(problem);
    if (next !== String(f.get("confirm"))) return setError("The new passwords don't match.");
    setBusy(true);
    setError(null);
    const res = await authClient.changePassword({ currentPassword: String(f.get("current")), newPassword: next, revokeOtherSessions: true });
    setBusy(false);
    if (res.error) {
      if (res.error.status === 429) return setError("Too many attempts. Wait a minute.");
      if (res.error.status === 400 && res.error.message) return setError(res.error.message);
      return setError("Your current password is incorrect.");
    }
    form.reset();
    toast("success", "Password changed. Other devices were signed out.");
  }
  return (
    <Panel title="Password" description="Changing it signs you out on your other devices.">
      <form className="flex flex-col gap-5" onSubmit={onSubmit}>
        <Field label="Current password" htmlFor="pw-current">
          <Input id="pw-current" name="current" type="password" autoComplete="current-password" required />
        </Field>
        <Field label="New password" htmlFor="pw-next" hint={PASSWORD_HINT}>
          <Input id="pw-next" name="next" type="password" autoComplete="new-password" required />
        </Field>
        <Field label="Confirm new password" htmlFor="pw-confirm" error={error}>
          <Input id="pw-confirm" name="confirm" type="password" autoComplete="new-password" required />
        </Field>
        <div>
          <Button type="submit" variant="secondary" loading={busy}>
            Change password
          </Button>
        </div>
      </form>
    </Panel>
  );
}

function TwoFactorPanel({ enabled: initial }: { enabled: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [enabled, setEnabled] = useState(initial);
  const [mode, setMode] = useState<null | "enable" | "disable">(null);
  const [stage, setStage] = useState<"password" | "scan" | "codes">("password");
  const [password, setPassword] = useState("");
  const [qr, setQr] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function close() {
    setMode(null);
    setStage("password");
    setPassword("");
    setCode("");
    setError(null);
    setQr(null);
    router.refresh();
  }

  async function start(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    if (mode === "disable") {
      const res = await authClient.twoFactor.disable({ password });
      setBusy(false);
      if (res.error) return setError("Incorrect password.");
      setEnabled(false);
      toast("success", "Two-factor authentication turned off");
      return close();
    }
    const res = await authClient.twoFactor.enable({ password, issuer: "Project Command" });
    setBusy(false);
    if (res.error || !res.data) return setError("Incorrect password.");
    if (!("totpURI" in res.data)) return setError("Authenticator setup is unavailable.");
    setQr(await QRCode.toString(res.data.totpURI, { type: "svg", margin: 0, color: { dark: "#1D1B18", light: "#FBFAF7" } }));
    setSecret(new URL(res.data.totpURI).searchParams.get("secret"));
    setBackupCodes(res.data.backupCodes);
    setStage("scan");
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await authClient.twoFactor.verifyTotp({ code: code.replace(/\s/g, "") });
    setBusy(false);
    if (res.error) return setError("That code didn't match. Codes change every 30 seconds.");
    setEnabled(true);
    setStage("codes");
  }

  return (
    <Panel
      title="Two-factor authentication"
      description="A 6-digit code from an authenticator app, in addition to your password."
      actions={enabled ? <StatusPill tone="done">On</StatusPill> : <StatusPill tone="neutral">Off</StatusPill>}
    >
      <div className="flex items-start gap-4">
        <IconShield size={28} className="mt-0.5 shrink-0 text-accent" />
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted">
            {enabled ? "Your account asks for a code from your authenticator app at sign-in, unless you've trusted the device." : "Recommended for everyone, and strongly for the owner."}
          </p>
          <div>
            <Button variant={enabled ? "ghost" : "secondary"} onClick={() => setMode(enabled ? "disable" : "enable")}>
              {enabled ? "Turn off" : "Set up two-factor"}
            </Button>
          </div>
        </div>
      </div>

      <Dialog open={mode !== null} onClose={close} dismissible={stage !== "codes"} title={mode === "disable" ? "Turn off two-factor" : stage === "codes" ? "Save your backup codes" : "Set up two-factor"}>
        {stage === "password" && (
          <form onSubmit={start} className="flex flex-col gap-5">
            <Field label="Confirm your password" htmlFor="tf-pw" error={error}>
              <Input id="tf-pw" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
            </Field>
            <Button type="submit" loading={busy} variant={mode === "disable" ? "danger" : "primary"}>
              Continue
            </Button>
          </form>
        )}
        {stage === "scan" && (
          <form onSubmit={verify} className="flex flex-col gap-5">
            <p className="text-sm text-muted">Scan with 1Password, Google Authenticator or the iPhone Passwords app, then enter the code it shows.</p>
            {qr && <div className="mx-auto size-48 rounded-panel border border-border bg-surface p-3 [&>svg]:size-full" dangerouslySetInnerHTML={{ __html: qr }} />}
            {secret && (
              <p className="text-center text-[13px] text-muted">
                Or enter this key: <code className="font-mono text-text">{secret}</code>
              </p>
            )}
            <Field label="Code from the app" htmlFor="tf-code" error={error}>
              <Input id="tf-code" inputMode="numeric" autoComplete="one-time-code" required value={code} onChange={(e) => setCode(e.target.value)} className="num text-lg tracking-[0.2em]" />
            </Field>
            <Button type="submit" loading={busy}>
              Turn on
            </Button>
          </form>
        )}
        {stage === "codes" && (
          <div className="flex flex-col gap-5">
            <p className="text-sm text-muted">Each code works once if you lose your phone. Store them somewhere safe, like your password manager. They won&apos;t be shown again.</p>
            <ul className="grid grid-cols-2 gap-2 rounded-panel border border-border bg-sunken p-4 font-mono text-sm">
              {backupCodes.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                onClick={async () => {
                  await navigator.clipboard.writeText(backupCodes.join("\n"));
                  toast("success", "Backup codes copied");
                }}
              >
                Copy codes
              </Button>
              <Button onClick={close}>I&apos;ve saved them</Button>
            </div>
          </div>
        )}
      </Dialog>
    </Panel>
  );
}

interface PasskeyRow {
  id: string;
  name?: string | null;
  createdAt: Date | string;
  deviceType: string;
}

function PasskeyPanel() {
  const toast = useToast();
  const [passkeys, setPasskeys] = useState<PasskeyRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<PasskeyRow | null>(null);
  const supported = useClientFlag(hasPasskeySupport);

  const load = useCallback(async () => {
    const res = await authClient.passkey.listUserPasskeys();
    setPasskeys((res.data as PasskeyRow[] | null) ?? []);
  }, []);

  useEffect(() => {
    // Loading from an external system (the auth server) on mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function add() {
    setBusy(true);
    const res = await authClient.passkey.addPasskey({ name: deviceName(navigator.userAgent) });
    setBusy(false);
    if (res?.error) return toast("error", "Passkey setup was cancelled.");
    toast("success", "Passkey added. You can sign in with Face ID or Touch ID now.");
    await load();
  }

  async function remove(id: string) {
    setRemoving(null);
    const res = await authClient.passkey.deletePasskey({ id });
    if (res.error) return toast("error", "Couldn't remove that passkey.");
    toast("success", "Passkey removed");
    await load();
  }

  return (
    <Panel title="Face ID & passkeys" description="Sign in with Face ID or Touch ID instead of typing your password.">
      <div className="flex flex-col gap-5">
        {passkeys && passkeys.length > 0 ? (
          <ul className="divide-y divide-border rounded-panel border border-border">
            {passkeys.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-4 px-4 py-3">
                <div className="flex min-w-0 items-center gap-3">
                  <IconKey size={18} className="shrink-0 text-muted" />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{p.name || "Passkey"}</p>
                    <p className="text-[12px] text-muted">
                      Added <time>{new Date(p.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" })}</time>
                    </p>
                  </div>
                </div>
                <Button size="sm" variant="ghost" onClick={() => setRemoving(p)}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        ) : passkeys ? (
          <p className="text-sm text-muted">No passkeys yet.</p>
        ) : null}
        <div>
          <Button variant="secondary" onClick={add} loading={busy} disabled={!supported}>
            <IconFaceId size={18} /> Add a passkey on this device
          </Button>
          {!supported && <p className="mt-2 text-[13px] text-muted">This browser doesn&apos;t support passkeys.</p>}
        </div>
      </div>
      <ConfirmDialog
        open={removing !== null}
        title={`Remove "${removing?.name || "Passkey"}"?`}
        body="You won't be able to sign in with it any more. Your password and other passkeys still work."
        confirmLabel="Remove passkey"
        danger
        onConfirm={() => removing && remove(removing.id)}
        onCancel={() => setRemoving(null)}
      />
    </Panel>
  );
}

/** A human name for the device a passkey was created on. */
function deviceName(ua: string): string {
  if (/iPhone/.test(ua)) return "iPhone (Face ID)";
  if (/iPad/.test(ua)) return "iPad";
  if (/Macintosh/.test(ua)) return "Mac (Touch ID)";
  if (/Windows/.test(ua)) return "Windows (Hello)";
  if (/Android/.test(ua)) return "Android phone";
  return "This device";
}
