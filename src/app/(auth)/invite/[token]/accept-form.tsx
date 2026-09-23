"use client";

import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button, Field, Input } from "@/components/ui/primitives";
import { authClient } from "@/lib/auth-client";
import { errorMessage, useTRPC } from "@/lib/trpc";

export function AcceptInviteForm({ token, email, defaultName, roleLabel }: { token: string; email: string; defaultName: string; roleLabel: string }) {
  const trpc = useTRPC();
  const router = useRouter();
  const [name, setName] = useState(defaultName);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const accept = useMutation(trpc.invites.accept.mutationOptions());

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 12) return setError("Use at least 12 characters.");
    if (!/[a-zA-Z]/.test(password) || !/[^a-zA-Z]/.test(password)) return setError("Mix letters with numbers or symbols.");
    if (password !== confirm) return setError("The passwords don't match.");
    try {
      await accept.mutateAsync({ token, name, password });
    } catch (err) {
      return setError(errorMessage(err));
    }
    const res = await authClient.signIn.email({ email, password });
    if (res.error) return router.replace("/login");
    router.replace("/settings?welcome=1");
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-6" noValidate>
      <div>
        <p className="eyebrow mb-3">Invitation · {roleLabel}</p>
        <h1 className="serif text-[40px] leading-[44px]">Welcome to Project Command</h1>
        <p className="mt-2 text-[15px] text-muted">
          Set up your account for <span className="text-text">{email}</span>.
        </p>
      </div>
      <Field label="Your name" htmlFor="name">
        <Input id="name" autoComplete="name" required value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Password" htmlFor="password" hint="At least 12 characters, mixing letters with numbers or symbols.">
        <Input id="password" type="password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      <Field label="Confirm password" htmlFor="confirm" error={error}>
        <Input id="confirm" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} aria-invalid={!!error} />
      </Field>
      <Button type="submit" size="lg" loading={accept.isPending}>
        Create account
      </Button>
    </form>
  );
}
