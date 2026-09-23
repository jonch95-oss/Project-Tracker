import { Elevation } from "@/components/ui/architecture";

/** Split layout: a quiet architectural plate on the left, the form on the right. */
export default function AuthLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[1.1fr_1fr]">
      <aside className="relative hidden overflow-hidden border-r border-border bg-stone lg:flex lg:flex-col lg:justify-between lg:p-16">
        <div>
          <p className="eyebrow">Ariel Development · Lian Development</p>
        </div>
        <Elevation className="absolute right-12 top-28 h-[58%] text-accent/30" />
        <div className="relative max-w-md">
          <h1 className="serif text-[64px] leading-[1]">Project Command</h1>
          <p className="mt-6 text-[15px] text-muted">
            Every project, every phase, and exactly what needs doing today.
          </p>
        </div>
      </aside>
      <main className="flex items-center justify-center px-4 py-12 sm:px-8">
        <div className="w-full max-w-[400px]">
          <div className="mb-10 lg:hidden">
            <p className="serif text-[32px] leading-9">Project Command</p>
            <span className="mt-2 block h-px w-10 bg-accent" aria-hidden="true" />
          </div>
          {children}
        </div>
      </main>
    </div>
  );
}
