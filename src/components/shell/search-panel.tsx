"use client";

import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { isOnline, subscribeOnline } from "@/lib/connection";
import { useTRPC, type RouterOutputs } from "@/lib/trpc";
import { IconCheckCircle, IconDirectory, IconPaperclip, IconPortfolio, IconSearch, IconUser } from "../ui/icons";
import { Kbd, Spinner } from "../ui/primitives";

type Hit = RouterOutputs["search"]["query"][number];

export interface Destination {
  href: string;
  label: string;
  icon: (p: { size?: number }) => ReactNode;
}

const GROUPS: { kind: Hit["kind"]; label: string; icon: (p: { size?: number }) => ReactNode }[] = [
  { kind: "project", label: "Projects", icon: IconPortfolio },
  { kind: "task", label: "Tasks", icon: IconCheckCircle },
  { kind: "file", label: "Files", icon: IconPaperclip },
  { kind: "person", label: "People", icon: IconUser },
  { kind: "vendor", label: "Directory", icon: IconDirectory },
];

interface Row {
  key: string;
  href: string;
  title: string;
  subtitle?: string;
  icon: (p: { size?: number }) => ReactNode;
  group: string;
}

/** Wait until typing pauses before asking the server. */
function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/**
 * ⌘K search (brief §7.7): projects, tasks, files, people and BBLs, only what
 * this person can open. With nothing typed it lists the places to go, so the
 * whole app can be driven from the keyboard: ↑ ↓ to move, Enter to open.
 */
export function SearchPanel({ destinations, onNavigate, autoFocus = true }: { destinations: Destination[]; onNavigate?: () => void; autoFocus?: boolean }) {
  const trpc = useTRPC();
  const router = useRouter();
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const typed = q.trim();
  const debounced = useDebounced(typed, 180);
  const online = useSyncExternalStore(subscribeOnline, isOnline, () => true);
  const res = useQuery({ ...trpc.search.query.queryOptions({ q: debounced }), enabled: debounced.length > 0 && online, staleTime: 15_000 });
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (!autoFocus) return;
    // After the dialog has opened (opening it moves focus to its first control).
    const f = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(f);
  }, [autoFocus]);

  const rows: Row[] = useMemo(() => {
    if (!typed) return destinations.map((d) => ({ key: `go:${d.href}`, href: d.href, title: d.label, icon: d.icon, group: "Go to" }));
    const hits = debounced === typed ? (res.data ?? []) : [];
    const out: Row[] = [];
    for (const g of GROUPS) for (const h of hits.filter((x) => x.kind === g.kind)) out.push({ key: `${h.kind}:${h.id}`, href: h.href, title: h.title, subtitle: h.subtitle, icon: g.icon, group: g.label });
    // Places whose name matches, after the results.
    const needle = typed.toLowerCase();
    for (const d of destinations) if (d.label.toLowerCase().includes(needle)) out.push({ key: `go:${d.href}`, href: d.href, title: d.label, icon: d.icon, group: "Go to" });
    return out;
  }, [typed, debounced, res.data, destinations]);

  const current = Math.min(active, Math.max(rows.length - 1, 0));

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${current}"]`)?.scrollIntoView({ block: "nearest" });
  }, [current]);

  const open = (r: Row | undefined) => {
    if (!r) return;
    onNavigate?.();
    router.push(r.href);
  };

  const loading = typed.length > 0 && (debounced !== typed || res.isFetching) && !res.data;
  return (
    <div className="flex flex-col">
      <div className="relative">
        <IconSearch size={18} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
        <input
          ref={inputRef}
          type="search"
          role="combobox"
          aria-expanded={rows.length > 0}
          aria-controls={listId}
          aria-activedescendant={rows[current] ? `${listId}-${current}` : undefined}
          aria-autocomplete="list"
          aria-label="Search projects, tasks, files, people and BBLs"
          placeholder="Projects, tasks, files, people, BBLs…"
          autoComplete="off"
          enterKeyHint="go"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((i) => Math.min(i + 1, rows.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              open(rows[current]);
            }
          }}
          className="h-12 w-full rounded-control border border-control bg-surface pl-10 pr-10 text-[16px] text-text placeholder:text-faint focus:border-accent focus:outline-none"
        />
        {loading && <Spinner className="absolute right-3 top-1/2 -translate-y-1/2 text-muted" />}
      </div>

      {typed && !online && <p className="mt-6 text-center text-sm text-muted">Search needs a connection. Your saved screens are still in the menu.</p>}
      {typed && online && !loading && res.isError && <p className="mt-6 text-center text-sm text-muted">Search didn&apos;t work just now. Try again in a moment.</p>}
      {typed && online && !loading && !res.isError && rows.length === 0 && (
        <p className="mt-6 text-center text-sm text-muted">
          Nothing matches &ldquo;{typed}&rdquo;. Try part of a name, an address or a BBL.
        </p>
      )}

      <ul ref={listRef} id={listId} role="listbox" aria-label="Results" className="mt-3 flex flex-col">
        {rows.map((r, i) => {
          const heading = i === 0 || rows[i - 1]!.group !== r.group ? r.group : null;
          const I = r.icon;
          return (
            <li key={r.key} role="presentation">
              {heading && <p className="eyebrow px-3 pb-1 pt-4 first:pt-1">{heading}</p>}
              <div
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === current}
                data-index={i}
                tabIndex={-1}
                onMouseMove={() => setActive(i)}
                onClick={() => open(r)}
                className={cn("flex cursor-pointer items-center gap-3 rounded-control px-3 py-2.5", i === current ? "bg-sunken" : "")}
              >
                <span className="text-muted">
                  <I size={18} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px]">{r.title}</span>
                  {r.subtitle && <span className="block truncate text-[13px] text-muted">{r.subtitle}</span>}
                </span>
                {i === current && (
                  <span className="hidden sm:block">
                    <Kbd>↵</Kbd>
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
