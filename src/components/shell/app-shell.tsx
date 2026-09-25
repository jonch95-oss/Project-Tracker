"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { useTRPC } from "@/lib/trpc";
import { useSignOut } from "@/lib/push";
import { cn } from "@/lib/cn";
import type { GlobalRole } from "@/core/permissions";
import { Avatar } from "../ui/primitives";
import { OfflineBar } from "./offline-bar";
import { PushPrompt } from "./push-prompt";
import { CommandBar, useCommandBar } from "./command-bar";
import { warmProjectTabs } from "@/app/(app)/projects/[id]/tab-loaders";
import {
  IconBell,
  IconLedger,
  IconMore,
  IconPortfolio,
  IconSettings,
  IconSignOut,
  IconSystem,
  IconChart,
  IconCalendar,
  IconSearch,
  IconDirectory,
  IconTemplate,
  IconUpload,
  IconTasks,
  IconTeam,
} from "../ui/icons";

export interface ShellViewer {
  id: string;
  name: string;
  email: string;
  role: GlobalRole;
  title: string | null;
}

interface NavItem {
  href: string;
  label: string;
  icon: (p: { size?: number }) => ReactNode;
  roles: GlobalRole[];
  mobile: boolean;
}

const ALL: GlobalRole[] = ["owner", "admin", "member", "external"];
/** Investors and lenders get their portal, notifications and settings, nothing else. */
const WITH_INVESTOR: GlobalRole[] = [...ALL, "investor"];

const NAV: NavItem[] = [
  {
    href: "/portal",
    label: "Investments",
    icon: IconPortfolio,
    roles: ["investor"],
    mobile: true,
  },
  {
    href: "/portfolio",
    label: "Portfolio",
    icon: IconPortfolio,
    roles: ALL,
    mobile: true,
  },
  {
    href: "/tasks",
    label: "My Tasks",
    icon: IconTasks,
    roles: ALL,
    mobile: true,
  },
  {
    href: "/search",
    label: "Search",
    icon: IconSearch,
    roles: ALL,
    mobile: true,
  },
  {
    href: "/notifications",
    label: "Notifications",
    icon: IconBell,
    roles: WITH_INVESTOR,
    mobile: true,
  },
  {
    href: "/directory",
    label: "Directory",
    icon: IconDirectory,
    roles: ["owner", "admin", "member"],
    mobile: false,
  },
  {
    href: "/templates",
    label: "Templates",
    icon: IconTemplate,
    roles: ["owner", "admin"],
    mobile: false,
  },
  {
    href: "/import",
    label: "Import",
    icon: IconUpload,
    roles: ["owner", "admin"],
    mobile: false,
  },
  {
    href: "/team",
    label: "Team",
    icon: IconTeam,
    roles: ["owner"],
    mobile: false,
  },
  {
    href: "/analytics",
    label: "Analytics",
    icon: IconChart,
    roles: ["owner"],
    mobile: false,
  },
  {
    href: "/reports",
    label: "Weekly report",
    icon: IconCalendar,
    roles: ["owner"],
    mobile: false,
  },
  {
    href: "/audit",
    label: "Audit log",
    icon: IconLedger,
    roles: ["owner"],
    mobile: false,
  },
  {
    href: "/system",
    label: "System",
    icon: IconSystem,
    roles: ["owner"],
    mobile: false,
  },
  {
    href: "/settings",
    label: "Settings",
    icon: IconSettings,
    roles: WITH_INVESTOR,
    // On the phone, Settings sits under More so Search gets a tab.
    mobile: false,
  },
];

/** The places a person can go, for search with nothing typed. */
export function navDestinations(role: GlobalRole) {
  return NAV.filter((n) => n.roles.includes(role) && n.href !== "/search").map((n) => ({ href: n.href, label: n.label, icon: n.icon }));
}

const ROLE_LABEL: Record<GlobalRole, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Team member",
  external: "Outside collaborator",
  investor: "Investor",
};

function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AppShell({
  viewer,
  children,
}: {
  viewer: ShellViewer;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);
  const trpc = useTRPC();
  const unread =
    useQuery({
      ...trpc.notifications.unreadCount.queryOptions(),
      refetchInterval: 60_000,
      refetchOnWindowFocus: true,
    }).data?.count ?? 0;
  const qc = useQueryClient();
  useEffect(() => {
    // A new notification arrived (or some were read elsewhere): refresh the list too.
    void qc.invalidateQueries({ queryKey: trpc.notifications.list.queryKey() });
  }, [unread, qc, trpc]);
  const badge = (href: string) =>
    href === "/notifications" && unread > 0 ? unread : 0;
  const items = NAV.filter((n) => n.roles.includes(viewer.role));
  // Owners and admins land on Portfolio; everyone else on My Tasks.
  const tasksFirst = viewer.role === "member" || viewer.role === "external";
  const ordered = tasksFirst
    ? [
        ...items.filter((i) => i.href === "/tasks"),
        ...items.filter((i) => i.href !== "/tasks"),
      ]
    : items;
  const mobileItems = ordered.filter((n) => n.mobile);
  const overflow = ordered.filter((n) => !n.mobile);

  const signOut = useSignOut();
  const canSearch = viewer.role !== "investor";
  const [searchOpen, setSearchOpen] = useCommandBar(canSearch);
  // The desktop rail has its own search button (⌘K); the Search screen is for the phone.
  const railItems = ordered.filter((i) => i.href !== "/search");
  const destinations = railItems.map((i) => ({ href: i.href, label: i.label, icon: i.icon }));
  // Once any page is idle, fetch the project tabs' code too, so they open later with no signal.
  useEffect(() => {
    if (viewer.role === "investor") return;
    const t = setTimeout(warmProjectTabs, 4000);
    return () => clearTimeout(t);
  }, [viewer.role]);

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[256px_1fr]">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-control focus:bg-surface focus:px-4 focus:py-2"
      >
        Skip to content
      </a>

      {/* Desktop rail */}
      <aside className="sticky top-0 hidden h-dvh flex-col border-r border-border px-5 py-8 lg:flex">
        <Link href="/" className="mb-12 block px-3">
          <span className="serif block text-[26px] leading-7">
            Project Command
          </span>
          <span className="mt-2 block h-px w-10 bg-accent" aria-hidden="true" />
        </Link>
        {canSearch && (
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            className="mb-6 flex h-10 items-center gap-3 rounded-control border border-border px-3 text-sm text-muted transition-colors duration-150 hover:border-border-strong hover:text-text"
            aria-keyshortcuts="Meta+K Control+K"
          >
            <IconSearch size={18} />
            Search
            <kbd className="ml-auto font-mono text-[11px] text-faint">⌘K</kbd>
          </button>
        )}
        <nav aria-label="Main" className="flex flex-1 flex-col gap-1">
          {railItems.map((item) => {
            const active = isActive(pathname, item.href);
            const I = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-10 items-center gap-3 rounded-control px-3 text-sm transition-colors duration-150",
                  active
                    ? "bg-surface font-medium text-text shadow-[inset_0_0_0_1px_var(--border)]"
                    : "text-muted hover:bg-surface/60 hover:text-text",
                )}
              >
                <I size={18} />
                {item.label}
                {badge(item.href) > 0 && (
                  <span className="num ml-auto rounded-full bg-accent px-1.5 text-[11px] font-medium leading-5 text-on-accent">
                    {badge(item.href) > 99 ? "99+" : badge(item.href)}
                    <span className="sr-only"> unread</span>
                  </span>
                )}
              </Link>
            );
          })}
        </nav>
        <div className="mt-6 border-t border-border pt-6">
          <div className="flex items-center gap-3 px-3">
            <Avatar name={viewer.name} size={36} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{viewer.name}</p>
              <p className="truncate text-[12px] text-muted">
                {ROLE_LABEL[viewer.role]}
              </p>
            </div>
            <button
              type="button"
              onClick={signOut}
              className="rounded-control p-2 text-muted hover:bg-surface hover:text-text"
              aria-label="Sign out"
              title="Sign out"
            >
              <IconSignOut size={18} />
            </button>
          </div>
        </div>
      </aside>

      <main
        id="main"
        className="min-w-0 px-4 pb-[calc(96px+env(safe-area-inset-bottom))] pt-[calc(24px+env(safe-area-inset-top))] sm:px-8 lg:px-12 lg:pb-16 lg:pt-12"
      >
        <div className="mx-auto max-w-[1200px]">
          <OfflineBar viewerId={viewer.id} home={viewer.role === "owner" || viewer.role === "admin" ? "/portfolio" : viewer.role === "investor" ? "/portal" : "/tasks"} />
          <PushPrompt />
          {children}
        </div>
      </main>

      {canSearch && <CommandBar open={searchOpen} onClose={() => setSearchOpen(false)} destinations={destinations} />}

      {/* iPhone bottom tab bar */}
      <nav
        aria-label="Main"
        className="safe-bottom fixed inset-x-0 bottom-0 z-40 border-t border-border bg-bg/90 backdrop-blur-md lg:hidden"
      >
        <ul className="mx-auto flex max-w-lg items-stretch justify-around px-2">
          {mobileItems.map((item) => {
            const active = isActive(pathname, item.href);
            const I = item.icon;
            return (
              <li key={item.href} className="flex-1">
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex h-16 flex-col items-center justify-center gap-1 text-[11px]",
                    active ? "font-medium text-text" : "text-muted",
                  )}
                >
                  <span className="relative">
                    <I size={22} />
                    {badge(item.href) > 0 && (
                      <span className="num absolute -right-2 -top-1 min-w-4 rounded-full bg-accent px-1 text-center text-[10px] font-medium leading-4 text-on-accent">
                        {badge(item.href) > 99 ? "99+" : badge(item.href)}
                        <span className="sr-only"> unread</span>
                      </span>
                    )}
                  </span>
                  {item.label === "Notifications" ? "Inbox" : item.label}
                </Link>
              </li>
            );
          })}
          {overflow.length > 0 && (
            <li className="flex-1">
              <button
                type="button"
                onClick={() => setMoreOpen((o) => !o)}
                aria-expanded={moreOpen}
                aria-controls="more-menu"
                className={cn(
                  "flex h-16 w-full flex-col items-center justify-center gap-1 text-[11px]",
                  overflow.some((o) => isActive(pathname, o.href))
                    ? "font-medium text-text"
                    : "text-muted",
                )}
              >
                <IconMore size={22} />
                More
              </button>
            </li>
          )}
        </ul>
        {moreOpen && (
          <div
            id="more-menu"
            className="border-t border-border bg-surface px-4 py-2"
          >
            {overflow.map((item) => {
              const I = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setMoreOpen(false)}
                  className="flex h-12 items-center gap-3 text-[15px]"
                >
                  <I size={20} /> {item.label}
                </Link>
              );
            })}
            <button
              type="button"
              onClick={signOut}
              className="flex h-12 w-full items-center gap-3 text-[15px] text-muted"
            >
              <IconSignOut size={20} /> Sign out
            </button>
          </div>
        )}
      </nav>
    </div>
  );
}
