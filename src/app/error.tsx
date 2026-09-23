"use client";

import { Elevation } from "@/components/ui/architecture";

export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-4 text-center">
      <Elevation className="mb-8 h-28 text-accent/40" />
      <h1 className="serif text-[44px] leading-[48px]">Something went wrong</h1>
      <p className="mt-3 max-w-md text-[15px] text-muted">The error has been logged for the owner. Try again, and if it keeps happening, let them know.</p>
      <button type="button" onClick={reset} className="mt-8 inline-flex h-11 items-center rounded-control bg-primary px-5 text-sm font-medium text-on-primary">
        Try again
      </button>
    </main>
  );
}
