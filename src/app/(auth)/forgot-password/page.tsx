"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Button, Field, Input } from "@/components/ui/primitives";
import { authClient } from "@/lib/auth-client";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await authClient.requestPasswordReset({ email: email.trim(), redirectTo: "/reset-password" });
    setBusy(false);
    if (res.error?.status === 429) {
      setError("Too many requests. Try again in a few minutes.");
      return;
    }
    // Same message whether or not the account exists.
    setSent(true);
  }

  if (sent) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="serif text-[40px] leading-[44px]">Check your email</h1>
        <p className="text-[15px] text-muted">If {email} has an account, a reset link is on its way. It works for one hour.</p>
        <Link href="/login" className="text-sm text-muted underline underline-offset-4 hover:text-text">
          Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-6" noValidate>
      <div>
        <h1 className="serif text-[40px] leading-[44px]">Reset password</h1>
        <p className="mt-2 text-[15px] text-muted">We&apos;ll email you a link to choose a new one.</p>
      </div>
      <Field label="Email" htmlFor="email" error={error}>
        <Input id="email" type="email" autoComplete="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
      </Field>
      <Button type="submit" size="lg" loading={busy} disabled={!email}>
        Send reset link
      </Button>
      <Link href="/login" className="text-center text-sm text-muted underline-offset-4 hover:text-text hover:underline">
        Back to sign in
      </Link>
    </form>
  );
}
