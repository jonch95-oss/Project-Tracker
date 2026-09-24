"use client";

import { useQuery } from "@tanstack/react-query";
import { Select } from "@/components/ui/primitives";
import { useTRPC } from "@/lib/trpc";

/** The project's people, for "to", "reviewer" and "assigned to" pickers. */
export function usePeople(projectId: string) {
  const trpc = useTRPC();
  const q = useQuery(trpc.members.list.queryOptions({ projectId }));
  return (q.data ?? []).filter((m) => m.status === "active").map((m) => ({ id: m.userId, name: m.name, company: m.company, role: m.projectRole }));
}

export function PersonSelect({ id, projectId, value, onChange, empty = "Nobody yet", label }: { id: string; projectId: string; value: string | null; onChange: (v: string | null) => void; empty?: string; label?: string }) {
  const people = usePeople(projectId);
  return (
    <Select id={id} aria-label={label} value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">{empty}</option>
      {people.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
          {p.company ? ` (${p.company})` : ""}
          {p.role ? ` · ${p.role}` : ""}
        </option>
      ))}
    </Select>
  );
}
