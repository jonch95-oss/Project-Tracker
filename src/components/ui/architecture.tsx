import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Photo placeholder: the address set large in serif on a stone ground with a
 * faint elevation drawing. Used until a project has a hero photo. Never a grey icon.
 */
export function AddressPlaceholder({
  address,
  borough,
  className,
  size = "card",
}: {
  address: string;
  borough?: string | null;
  className?: string;
  size?: "card" | "hero" | "thumb";
}) {
  const text = { card: "text-[34px] leading-[38px]", hero: "text-title sm:text-[72px] sm:leading-[76px]", thumb: "text-[15px] leading-[18px]" }[size];
  return (
    <div className={cn("relative isolate flex overflow-hidden bg-stone", className)}>
      <Elevation className="absolute -right-6 bottom-0 -z-10 h-[88%] text-accent/15" />
      <div className={cn("mt-auto p-6", size === "thumb" && "p-2", size === "hero" && "p-8 sm:p-12")}>
        {borough && size !== "thumb" && <p className="eyebrow mb-2">{borough}</p>}
        <p className={cn("serif text-text/90", text)}>{address}</p>
      </div>
    </div>
  );
}

/** Hairline brownstone elevation, used as quiet ornament. */
export function Elevation({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 240 300" className={className} fill="none" stroke="currentColor" strokeWidth="1.25" aria-hidden="true">
      <path d="M8 22h224M14 32h212M22 32v262h196V32" />
      <path d="M22 46h196M22 118h196M22 196h196" strokeDasharray="2 4" />
      {[46, 106, 166].map((x) => (
        <g key={x}>
          <rect x={x} y="58" width="28" height="48" />
          <path d={`M${x} 64h28M${x + 14} 58v48`} />
          <rect x={x} y="134" width="28" height="48" />
          <path d={`M${x} 140h28M${x + 14} 134v48`} />
        </g>
      ))}
      <rect x="46" y="212" width="28" height="48" />
      <rect x="166" y="212" width="28" height="48" />
      <path d="M106 294v-70a14 14 0 0 1 28 0v70M96 294h48M90 300h60" />
    </svg>
  );
}

/** Designed empty state: serif headline, one line of guidance, optional action. */
export function EmptyState({
  title,
  body,
  action,
  className,
}: {
  title: string;
  body: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("relative overflow-hidden rounded-card border border-dashed border-border-strong bg-surface/60 px-8 py-14 text-center sm:py-20", className)}>
      <Elevation className="mx-auto mb-6 h-24 text-accent/40" />
      <h2 className="serif mx-auto max-w-md text-heading">{title}</h2>
      <div className="mx-auto mt-3 max-w-md text-[15px] text-muted">{body}</div>
      {action && <div className="mt-8 flex justify-center">{action}</div>}
    </div>
  );
}

/** Designed error state for failed loads. */
export function ErrorState({ title = "This didn't load", body, onRetry }: { title?: string; body?: ReactNode; onRetry?: () => void }) {
  return (
    <div role="alert" className="rounded-card border border-blocked/30 bg-blocked-tint/50 px-8 py-10 text-center">
      <h2 className="serif text-heading text-text">{title}</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted">{body ?? "Check your connection and try again. If it keeps happening, let the owner know."}</p>
      {onRetry && (
        <button type="button" onClick={onRetry} className="mt-6 h-10 rounded-control border border-border-strong bg-surface px-4 text-sm font-medium hover:bg-sunken">
          Try again
        </button>
      )}
    </div>
  );
}
