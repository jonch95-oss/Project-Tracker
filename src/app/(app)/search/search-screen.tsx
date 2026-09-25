"use client";

import { useMemo } from "react";
import type { GlobalRole } from "@/core/permissions";
import { navDestinations } from "@/components/shell/app-shell";
import { SearchPanel } from "@/components/shell/search-panel";
import { PageHeader } from "@/components/ui/primitives";

/** The phone's Search tab: the same search as ⌘K, full screen. */
export function SearchScreen({ role }: { role: GlobalRole }) {
  const destinations = useMemo(() => navDestinations(role), [role]);
  return (
    <>
      <PageHeader title="Search" />
      <SearchPanel destinations={destinations} />
    </>
  );
}
