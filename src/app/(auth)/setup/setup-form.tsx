"use client";

import Link from "next/link";
import { useActionState } from "react";
import { Button, Field, Input } from "@/components/ui/primitives";
import { setupOwner } from "./actions";

export function SetupForm() {
  const [state, action, pending] = useActionState(setupOwner, null);

  if (state?.ok) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="serif text-title">One step left</h1>
        <p className="text-[15px] text-muted">Open this link to choose the owner password. It works once and expires in 48 hours.</p>
        <Link href={state.inviteUrl} className="inline-flex h-12 items-center justify-center rounded-control bg-primary px-6 text-[15px] font-medium text-on-primary">
          Set the owner password
        </Link>
      </div>
    );
  }

  return (
    <form action={action} className="flex flex-col gap-6">
      <div>
        <p className="eyebrow mb-3">First run</p>
        <h1 className="serif text-title">Create the owner</h1>
        <p className="mt-2 text-[15px] text-muted">This page works once, while the database is empty. Everyone else is invited from Team.</p>
      </div>
      <Field label="Your name" htmlFor="setup-name">
        <Input id="setup-name" name="name" required autoComplete="name" />
      </Field>
      <Field label="Email" htmlFor="setup-email">
        <Input id="setup-email" name="email" type="email" required autoComplete="email" />
      </Field>
      <Field label="Setup key" htmlFor="setup-secret" hint="The SETUP_KEY value from the Vercel project's environment variables." error={state && !state.ok ? state.error : null}>
        <Input id="setup-secret" name="secret" type="password" required autoComplete="off" />
      </Field>
      <Button type="submit" size="lg" loading={pending}>
        Continue
      </Button>
    </form>
  );
}
