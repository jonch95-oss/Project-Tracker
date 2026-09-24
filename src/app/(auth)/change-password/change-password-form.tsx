"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button, Field, Input } from "@/components/ui/primitives";
import { PASSWORD_HINT, passwordProblem } from "@/core/password";
import { authClient } from "@/lib/auth-client";

export function ChangePasswordForm({ name }: { name: string }) {
  const router = useRouter();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const problem = passwordProblem(next);
    if (problem) return setError(problem);
    if (next !== again) return setError("The two new passwords don't match.");
    if (next === current) return setError("Choose a password different from the one you were given.");
    setBusy(true);
    const res = await authClient.changePassword({ currentPassword: current, newPassword: next, revokeOtherSessions: true });
    setBusy(false);
    if (res.error) {
      setError(res.error.status === 429 ? "Too many attempts. Wait a minute and try again." : /password/i.test(res.error.message ?? "") && res.error.status === 400 ? (res.error.message ?? "That didn't work.") : "The current password isn't right.");
      return;
    }
    router.replace("/");
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-6" noValidate>
      <div>
        <h1 className="serif text-title">Choose your password</h1>
        <p className="mt-2 text-[15px] text-muted">Welcome, {name}. You signed in with a temporary password; pick your own to continue.</p>
      </div>
      <Field label="Temporary password" htmlFor="current">
        <Input id="current" type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
      </Field>
      <Field label="New password" htmlFor="new" hint={PASSWORD_HINT}>
        <Input id="new" type="password" autoComplete="new-password" required value={next} onChange={(e) => setNext(e.target.value)} />
      </Field>
      <Field label="New password again" htmlFor="again" error={error}>
        <Input id="again" type="password" autoComplete="new-password" required value={again} onChange={(e) => setAgain(e.target.value)} aria-invalid={!!error} />
      </Field>
      <Button type="submit" size="lg" loading={busy} disabled={!current || !next || !again}>
        Save and continue
      </Button>
    </form>
  );
}
