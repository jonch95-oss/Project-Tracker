"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { IconFaceId } from "@/components/ui/icons";
import { Button, Field, Input } from "@/components/ui/primitives";
import { authClient } from "@/lib/auth-client";
import { hasPasskeySupport, useClientFlag } from "@/lib/use-client-flag";

type Step = "password" | "totp" | "backup";

export function LoginForm({ next, justReset }: { next: string; justReset: boolean }) {
  const router = useRouter();
  const [step, setStep] = useState<Step>("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [trustDevice, setTrustDevice] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const passkeySupported = useClientFlag(hasPasskeySupport);

  function done() {
    router.replace(next);
    router.refresh();
  }

  function startOver(message: string | null = null) {
    setStep("password");
    setCode("");
    setPassword("");
    setError(message);
  }

  async function onPassword(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { data, error } = await authClient.signIn.email({ email: email.trim(), password });
    setBusy(false);
    if (error) {
      setError(error.status === 429 ? "Too many attempts. Wait a minute and try again." : "That email and password don't match.");
      return;
    }
    if (data && "twoFactorRedirect" in data && data.twoFactorRedirect) {
      setStep("totp");
      return;
    }
    done();
  }

  async function onCode(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res =
      step === "totp"
        ? await authClient.twoFactor.verifyTotp({ code: code.replace(/\s/g, ""), trustDevice })
        : await authClient.twoFactor.verifyBackupCode({ code: code.trim(), trustDevice });
    setBusy(false);
    if (res.error) {
      if (res.error.status === 429) return setError("Too many attempts. Wait a minute and try again.");
      // The two-step challenge lasts 10 minutes; after that, sign in again.
      if (res.error.status === 401 && /cookie|expired|session/i.test(res.error.message ?? "")) {
        return startOver("That sign-in expired. Enter your password again.");
      }
      return setError("That code didn't work. Check it and try again.");
    }
    done();
  }

  async function onPasskey() {
    setBusy(true);
    setError(null);
    const res = await authClient.signIn.passkey();
    setBusy(false);
    if (res?.error) {
      setError("Face ID sign-in was cancelled or isn't set up on this device yet.");
      return;
    }
    done();
  }

  if (step !== "password") {
    return (
      <form onSubmit={onCode} className="flex flex-col gap-6" noValidate>
        <div>
          <h1 className="serif text-[40px] leading-[44px]">Two-step check</h1>
          <p className="mt-2 text-[15px] text-muted">
            {step === "totp" ? "Enter the 6-digit code from your authenticator app." : "Enter one of your saved backup codes."}
          </p>
        </div>
        <Field label={step === "totp" ? "Authentication code" : "Backup code"} htmlFor="code" error={error}>
          <Input
            id="code"
            name="code"
            inputMode={step === "totp" ? "numeric" : "text"}
            autoComplete="one-time-code"
            autoFocus
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
            aria-invalid={!!error}
            aria-describedby={error ? "code-error" : undefined}
            className="num text-lg tracking-[0.2em]"
          />
        </Field>
        <label className="flex items-center gap-2 text-sm text-muted">
          <input type="checkbox" checked={trustDevice} onChange={(e) => setTrustDevice(e.target.checked)} className="size-4 accent-[var(--primary)]" />
          Trust this device for 30 days
        </label>
        <Button type="submit" size="lg" loading={busy}>
          Verify
        </Button>
        <button
          type="button"
          className="text-sm text-muted underline-offset-4 hover:text-text hover:underline"
          onClick={() => {
            setStep(step === "totp" ? "backup" : "totp");
            setCode("");
            setError(null);
          }}
        >
          {step === "totp" ? "Use a backup code instead" : "Use my authenticator app"}
        </button>
        <button type="button" className="text-sm text-muted underline-offset-4 hover:text-text hover:underline" onClick={() => startOver()}>
          Start over with a different account
        </button>
      </form>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="serif text-[40px] leading-[44px]">Sign in</h1>
        <p className="mt-2 text-[15px] text-muted">Access is by invitation only.</p>
      </div>
      {justReset && (
        <p role="status" className="rounded-panel border border-done/30 bg-done-tint px-4 py-3 text-sm text-done-text">
          Your password was changed. Sign in with the new one.
        </p>
      )}

      {passkeySupported && (
        <>
          <Button variant="secondary" size="lg" onClick={onPasskey} disabled={busy}>
            <IconFaceId size={20} /> Sign in with Face ID or passkey
          </Button>
          <div className="flex items-center gap-4 text-[12px] uppercase tracking-[0.14em] text-faint">
            <span className="h-px flex-1 bg-border" /> or <span className="h-px flex-1 bg-border" />
          </div>
        </>
      )}

      <form onSubmit={onPassword} className="flex flex-col gap-5" noValidate>
        <Field label="Email" htmlFor="email">
          <Input id="email" name="email" type="email" autoComplete="username webauthn" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Password" htmlFor="password" error={error}>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={!!error}
            aria-describedby={error ? "password-error" : undefined}
          />
        </Field>
        <Button type="submit" size="lg" loading={busy} disabled={!email || !password}>
          Sign in
        </Button>
      </form>
      <Link href="/forgot-password" className="text-center text-sm text-muted underline-offset-4 hover:text-text hover:underline">
        Forgot your password?
      </Link>
    </div>
  );
}
