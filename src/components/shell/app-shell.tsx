"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/cn";
import type { GlobalRole } from "@/core/permissions";
import { Avatar } from "../ui/primitives";
import {
  IconLedger,
  IconMore,
  IconPortfolio,
  IconSettings,
  IconSignOut,
  IconSystem,
  IconTasks,
  IconTeam,
} from "../ui/icons";

export interface ShellViewer {
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

const NAV: NavItem[] = [
  { href: "/portfolio", label: "Portfolio", icon: IconPortfolio, roles: ALL, mobile: true },
  { href: "/tasks", label: "My Tasks", icon: IconTasks, roles: ALL, mobile: true },
  { href: "/team", label: "Team", icon: IconTeam, roles: ["owner"], mobile: false },
  { href: "/audit", label: "Audit log", icon: IconLedger, roles: ["owner"], mobile: false },
  { href: "/system", label: "System", icon: IconSystem, roles: ["owner"], mobile: false },
  { href: "/settings", label: "Settings", icon: IconSettings, roles: ALL, mobile: true },
];

const ROLE_LABEL: Record<GlobalRole, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Team member",
  external: "Outside collaborator",
};

function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AppShell({ viewer, children }: { viewer: ShellViewer; children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [moreOpen, setMoreOpen] = useState(false);
  const items = NAV.filter((n) => n.roles.includes(viewer.role));
  // Owners and admins land on Portfolio; everyone else on My Tasks.
  const tasksFirst = viewer.role === "member" || viewer.role === "external";
  const ordered = tasksFirst ? [...items.filter((i) => i.href === "/tasks"), ...items.filter((i) => i.href !== "/tasks")] : items;
  const mobileItems = ordered.filter((n) => n.mobile);
  const overflow = ordered.filter((n) => !n.mobile);

  async function signOut() {
    await authClient.signOut();
    router.replace("/login");
    router.refresh();
  }

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[256px_1fr]">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-control focus:bg-surface focus:px-4 focus:py-2">
        Skip to content
      </a>

      {/* Desktop rail */}
      <aside className="sticky top-0 hidden h-dvh flex-col border-r border-border px-5 py-8 lg:flex">
        <Link href="/" className="mb-12 block px-3">
          <span className="serif block text-[26px] leading-7">Project Command</span>
          <span className="mt-2 block h-px w-10 bg-accent" aria-hidden="true" />
        </Link>
        <nav aria-label="Main" className="flex flex-1 flex-col gap-1">
          {ordered.map((item) => {
            const active = isActive(pathname, item.href);
            const I = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-10 items-center gap-3 rounded-control px-3 text-sm transition-colors duration-150",
                  active ? "bg-surface font-medium text-text shadow-[inset_0_0_0_1px_var(--border)]" : "text-muted hover:bg-surface/60 hover:text-text",
                )}
              >
                <I size={18} />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="mt-6 border-t border-border pt-6">
          <div className="flex items-center gap-3 px-3">
            <Avatar name={viewer.name} size={36} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{viewer.name}</p>
              <p className="truncate text-[12px] text-muted">{ROLE_LABEL[viewer.role]}</p>
            </div>
            <button type="button" onClick={signOut} className="rounded-control p-2 text-muted hover:bg-surface hover:text-text" aria-label="Sign out" title="Sign out">
              <IconSignOut size={18} />
            </button>
          </div>
        </div>
      </aside>

      <main id="main" className="min-w-0 px-4 pb-[calc(96px+env(safe-area-inset-bottom))] pt-[calc(24px+env(safe-area-inset-top))] sm:px-8 lg:px-12 lg:pb-16 lg:pt-12">
        <div className="mx-auto max-w-[1200px]">{children}</div>
      </main>

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
                  className={cn("flex h-16 flex-col items-center justify-center gap-1 text-[11px]", active ? "font-medium text-text" : "text-muted")}
                >
                  <I size={22} />
                  {item.label}
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
                className={cn("flex h-16 w-full flex-col items-center justify-center gap-1 text-[11px]", overflow.some((o) => isActive(pathname, o.href)) ? "font-medium text-text" : "text-muted")}
              >
                <IconMore size={22} />
                More
              </button>
            </li>
          )}
        </ul>
        {moreOpen && (
          <div id="more-menu" className="border-t border-border bg-surface px-4 py-2">
            {overflow.map((item) => {
              const I = item.icon;
              return (
                <Link key={item.href} href={item.href} onClick={() => setMoreOpen(false)} className="flex h-12 items-center gap-3 text-[15px]">
                  <I size={20} /> {item.label}
                </Link>
              );
            })}
            <button type="button" onClick={signOut} className="flex h-12 w-full items-center gap-3 text-[15px] text-muted">
              <IconSignOut size={20} /> Sign out
            </button>
          </div>
        )}
      </nav>
    </div>
  );
}
