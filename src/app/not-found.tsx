import Link from "next/link";
import { Elevation } from "@/components/ui/architecture";

export default function NotFound() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-4 text-center">
      <Elevation className="mb-8 h-28 text-accent/40" />
      <p className="eyebrow">404</p>
      <h1 className="serif mt-3 text-title">This page doesn&apos;t exist</h1>
      <p className="mt-3 max-w-md text-[15px] text-muted">The link may be old, or you may not have access to it.</p>
      <Link href="/" className="mt-8 inline-flex h-11 items-center rounded-control bg-primary px-5 text-sm font-medium text-on-primary">
        Go home
      </Link>
    </main>
  );
}
