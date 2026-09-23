"use client";

import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface TabItem<K extends string> {
  key: K;
  label: string;
  badge?: ReactNode;
}

/** Underlined text tabs with arrow-key navigation (WAI-ARIA tabs pattern). */
export function Tabs<K extends string>({
  items,
  value,
  onChange,
  className,
  idBase,
  label,
}: {
  items: TabItem<K>[];
  value: K;
  onChange: (key: K) => void;
  className?: string;
  /** Stable id prefix, so a <TabPanel idBase=…> can point back at its tab. */
  idBase?: string;
  label?: string;
}) {
  const generated = useId();
  const id = idBase ?? generated;
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent, i: number) => {
    const delta = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const next = (i + delta + items.length) % items.length;
    refs.current[next]?.focus();
    onChange(items[next]!.key);
  };
  return (
    <div role="tablist" aria-label={label} className={cn("flex gap-6 overflow-x-auto border-b border-border [scrollbar-width:none]", className)}>
      {items.map((t, i) => {
        const selected = t.key === value;
        return (
          <button
            key={t.key}
            ref={(el) => {
              refs.current[i] = el;
            }}
            id={`${id}-${t.key}`}
            role="tab"
            type="button"
            aria-selected={selected}
            aria-controls={`${id}-panel-${t.key}`}
            tabIndex={selected ? 0 : -1}
            onKeyDown={(e) => onKey(e, i)}
            onClick={() => onChange(t.key)}
            className={cn(
              "relative -mb-px flex h-11 shrink-0 items-center gap-2 border-b-2 text-sm transition-colors duration-150",
              selected ? "border-text font-medium text-text" : "border-transparent text-muted hover:text-text",
            )}
          >
            {t.label}
            {t.badge}
          </button>
        );
      })}
    </div>
  );
}

/** The content region for the selected tab. */
export function TabPanel({ idBase, tab, children, className }: { idBase: string; tab: string; children: React.ReactNode; className?: string }) {
  return (
    <div role="tabpanel" id={`${idBase}-panel-${tab}`} aria-labelledby={`${idBase}-${tab}`} tabIndex={0} className={className}>
      {children}
    </div>
  );
}
