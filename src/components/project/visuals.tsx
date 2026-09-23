"use client";

import { useState, type ReactNode } from "react";
import { AddressPlaceholder } from "@/components/ui/architecture";
import { formatMoneyCompact } from "@/core/money";
import { currentPhase, type PhaseState } from "@/core/phases";
import { cn } from "@/lib/cn";
import { photoUrl } from "@/lib/photo-upload";

/**
 * Horizontal phase track: one hairline segment per phase. Done phases are
 * filled, the current one is bronze and labelled, skipped ones are dashed.
 * The current phase name is always written out, so status never rests on
 * color alone.
 */
export function PhaseTrack({ phases, className, showLabel = true }: { phases: readonly PhaseState[]; className?: string; showLabel?: boolean }) {
  const cur = currentPhase(phases);
  const list = [...phases].sort((a, b) => a.sortOrder - b.sortOrder);
  const counted = list.filter((p) => p.status !== "skipped");
  const idx = cur ? counted.findIndex((p) => p.key === cur.key) : -1;
  const allDone = list.length > 0 && list.every((p) => p.status === "done" || p.status === "skipped");
  const label = cur ? cur.name : allDone ? "Complete" : "Not started";
  return (
    <div className={className}>
      {showLabel && (
        <p className="mb-2 flex items-baseline justify-between gap-3 text-[13px]">
          <span className="truncate font-medium text-text">{label}</span>
          {idx >= 0 && (
            <span className="num shrink-0 text-muted">
              Phase {idx + 1} of {counted.length}
            </span>
          )}
        </p>
      )}
      <ol className="flex gap-[3px]" aria-label={`Phase: ${label}`}>
        {list.map((p) => (
          <li
            key={p.key}
            title={`${p.name}${p.status === "skipped" ? " (skipped)" : p.status === "done" ? " (done)" : p.status === "active" ? " (current)" : ""}`}
            className={cn(
              "h-1.5 flex-1 rounded-full",
              p.status === "done" && "bg-text/70",
              p.status === "active" && "bg-accent",
              p.status === "pending" && "bg-border-strong/70",
              p.status === "skipped" && "border border-dashed border-border-strong bg-transparent",
            )}
          >
            <span className="sr-only">
              {p.name}: {p.status}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** The project photo if there is one, else the address-in-serif placeholder. Falls back on load errors. */
export function ProjectImage({
  photoId,
  address,
  borough,
  size = "card",
  className,
  alt,
  priority,
}: {
  photoId: string | null | undefined;
  address: string;
  borough?: string | null;
  size?: "card" | "hero" | "thumb";
  className?: string;
  alt?: string;
  priority?: boolean;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  if (!photoId || failed === photoId) return <AddressPlaceholder address={address} borough={borough} size={size} className={className} />;
  return (
    <div className={cn("relative overflow-hidden bg-stone", className)}>
      {/* eslint-disable-next-line @next/next/no-img-element -- private, access-checked route; next/image can't forward the session */}
      <img
        src={photoUrl(photoId, size === "hero" ? "full" : "thumb")}
        alt={alt ?? `Photo of ${address}`}
        loading={priority ? "eager" : "lazy"}
        decoding="async"
        onError={() => setFailed(photoId)}
        className="absolute inset-0 size-full object-cover"
      />
    </div>
  );
}

export function SegmentedControl<K extends string>({
  value,
  onChange,
  items,
  label,
  className,
}: {
  value: K;
  onChange: (k: K) => void;
  items: { key: K; label: string; icon?: ReactNode }[];
  label: string;
  className?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={cn("inline-flex rounded-control border border-control bg-surface p-0.5", className)}>
      {items.map((it) => {
        const on = it.key === value;
        return (
          <button
            key={it.key}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(it.key)}
            onKeyDown={(e) => {
              const i = items.findIndex((x) => x.key === value);
              const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
              if (!d) return;
              e.preventDefault();
              const next = items[(i + d + items.length) % items.length]!;
              onChange(next.key);
              (e.currentTarget.parentElement?.querySelectorAll("button")[(i + d + items.length) % items.length] as HTMLButtonElement | undefined)?.focus();
            }}
            tabIndex={on ? 0 : -1}
            className={cn(
              "inline-flex h-9 items-center gap-1.5 rounded-[calc(var(--radius-control)-2px)] px-3 text-[13px] transition-colors duration-150",
              on ? "bg-primary font-medium text-on-primary" : "text-muted hover:text-text",
            )}
          >
            {it.icon}
            {it.label}
          </button>
        );
      })}
    </div>
  );
}

export interface Headline {
  purchasePriceCents: number | null;
  totalBudgetCents: number | null;
  projectedSelloutCents: number | null;
}

/** Compact headline financials for cards; only rendered when the server sent them (the viewer has the flag). */
export function HeadlineFigures({ headline, className }: { headline: Headline; className?: string }) {
  const items = [
    ["Price", headline.purchasePriceCents],
    ["Budget", headline.totalBudgetCents],
    ["Sellout", headline.projectedSelloutCents],
  ] as const;
  if (items.every(([, v]) => v == null)) return null;
  return (
    <dl className={cn("grid grid-cols-3 gap-3", className)}>
      {items.map(([k, v]) => (
        <div key={k} className="min-w-0">
          <dt className="text-[11px] uppercase tracking-[0.08em] text-muted">{k}</dt>
          <dd className="num truncate text-[14px] font-medium">{v == null ? "—" : formatMoneyCompact(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

export function pct(bps: number): string {
  return `${Math.round(bps / 100)}%`;
}
