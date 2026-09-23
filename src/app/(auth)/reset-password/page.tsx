"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState, type FormEvent } from "react";
import { Button, Field, Input } from "@/components/ui/primitives";
import { PASSWORD_HINT, passwordProblem } from "@/core/password";
import { authClient } from "@/lib/auth-client";

function ResetForm() {
  const params = useSearchParams();
  const router = useRouter();
  const token = params.get("token");
  const tokenError = params.get("error");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!token || tokenError) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="serif text-[40px] leading-[44px]">Link expired</h1>
        <p className="text-[15px] text-muted">This reset link is invalid or has expired. Ask the owner for a new one.</p>
        <Link href="/forgot-password" className="text-sm underline underline-offset-4">
          How to get a new link
        </Link>
      </div>
    );
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const problem = passwordProblem(password);
    if (problem) return setError(problem);
    if (password !== confirm) return setError("The passwords don't match.");
    setBusy(true);
    setError(null);
    const res = await authClient.resetPassword({ newPassword: password, token: token! });
    setBusy(false);
    if (res.error) return setError(res.error.status === 400 && res.error.message ? res.error.message : "This link has expired. Ask for a new one.");
    router.replace("/login?reset=1");
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-6" noValidate>
      <div>
        <h1 className="serif text-[40px] leading-[44px]">Choose a new password</h1>
        <p className="mt-2 text-[15px] text-muted">{PASSWORD_HINT}</p>
      </div>
      <Field label="New password" htmlFor="password">
        <Input id="password" type="password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      <Field label="Confirm password" htmlFor="confirm" error={error}>
        <Input id="confirm" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} aria-invalid={!!error} />
      </Field>
      <Button type="submit" size="lg" loading={busy}>
        Save password
      </Button>
    </form>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense>
      <ResetForm />
    </Suspense>
  );
}
