"use client";

import { useMutation } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Dialog, useToast } from "@/components/ui/overlay";
import { Button, Field, Input, Select } from "@/components/ui/primitives";
import { errorMessage, useTRPC } from "@/lib/trpc";

interface Person {
  id: string;
  name: string;
  projectRole: string | null;
  external: boolean;
}

type Mode = null | "reassign" | "redate" | "shift";

/** Bulk actions on the selected tasks (brief §6): reassign, re-date, or shift by N days. */
export function BulkBar({ projectId, selected, people, onClear, onDone }: { projectId: string; selected: string[]; people: Person[]; onClear: () => void; onDone: () => Promise<unknown> }) {
  const trpc = useTRPC();
  const toast = useToast();
  const [mode, setMode] = useState<Mode>(null);
  const bulk = useMutation(
    trpc.tasks.bulk.mutationOptions({
      onSuccess: async (r) => {
        toast("success", `${r.changed} task${r.changed === 1 ? "" : "s"} updated${r.skippedDone ? ` · ${r.skippedDone} done left alone` : ""}`);
        setMode(null);
        await onDone();
      },
      onError: (e) => toast("error", errorMessage(e)),
    }),
  );
  const n = selected.length;
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const s = (k: string) => String(f.get(k) ?? "");
    if (mode === "reassign") bulk.mutate({ projectId, taskIds: selected, action: { kind: "reassign", assigneeId: s("assignee") || null } });
    if (mode === "redate") bulk.mutate({ projectId, taskIds: selected, action: { kind: "redate", dueOn: s("due") } });
    if (mode === "shift") {
      const days = Number(s("days")) * (s("dir") === "earlier" ? -1 : 1);
      bulk.mutate({ projectId, taskIds: selected, action: { kind: "shift", days, unit: s("unit") as "business" | "calendar" } });
    }
  };
  return (
    <>
      <div role="region" aria-label="Bulk actions" className="safe-bottom fixed inset-x-0 bottom-16 z-30 border-t border-border bg-surface/95 px-4 py-3 shadow-lift backdrop-blur-md lg:bottom-0 lg:left-[256px]">
        <div className="mx-auto flex max-w-[1200px] flex-wrap items-center gap-2">
          <span className="num mr-auto text-sm font-medium">
            {n} selected
            {n > 0 && (
              <button type="button" onClick={onClear} className="ml-3 text-[13px] font-normal text-muted underline underline-offset-4">
                Clear
              </button>
            )}
          </span>
          <Button size="sm" variant="secondary" disabled={!n} onClick={() => setMode("reassign")}>
            Reassign
          </Button>
          <Button size="sm" variant="secondary" disabled={!n} onClick={() => setMode("redate")}>
            Re-date
          </Button>
          <Button size="sm" variant="secondary" disabled={!n} onClick={() => setMode("shift")}>
            Shift
          </Button>
        </div>
      </div>
      {mode && (
        <Dialog
          open
          onClose={() => setMode(null)}
          title={mode === "reassign" ? `Reassign ${n} task${n === 1 ? "" : "s"}` : mode === "redate" ? `Set a due date on ${n} task${n === 1 ? "" : "s"}` : `Move ${n} task${n === 1 ? "" : "s"}`}
          description="Tasks already done are left alone."
          footer={
            <>
              <Button variant="ghost" onClick={() => setMode(null)}>
                Cancel
              </Button>
              <Button type="submit" form="bulk-form" loading={bulk.isPending}>
                Apply
              </Button>
            </>
          }
        >
          <form id="bulk-form" onSubmit={submit} className="grid gap-5 sm:grid-cols-2">
            {mode === "reassign" && (
              <Field label="Assign to" htmlFor="bulk-assignee" className="sm:col-span-2">
                <Select id="bulk-assignee" name="assignee" defaultValue="">
                  <option value="">Nobody (unassigned)</option>
                  {people.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                      {p.projectRole ? ` · ${p.projectRole}` : ""}
                      {p.external ? " (outside)" : ""}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            {mode === "redate" && (
              <Field label="Due date" htmlFor="bulk-due">
                <Input id="bulk-due" name="due" type="date" required className="num" />
              </Field>
            )}
            {mode === "shift" && <ShiftFields />}
          </form>
        </Dialog>
      )}
    </>
  );
}

function ShiftFields() {
  return (
    <>
      <Field label="By" htmlFor="shift-days">
        <Input id="shift-days" name="days" type="number" inputMode="numeric" min={1} max={365} required defaultValue={5} className="num" />
      </Field>
      <Field label="Days" htmlFor="shift-unit">
        <Select id="shift-unit" name="unit" defaultValue="business">
          <option value="business">Business days</option>
          <option value="calendar">Calendar days</option>
        </Select>
      </Field>
      <Field label="Direction" htmlFor="shift-dir" className="sm:col-span-2">
        <Select id="shift-dir" name="dir" defaultValue="later">
          <option value="later">Later</option>
          <option value="earlier">Earlier</option>
        </Select>
      </Field>
    </>
  );
}

/** Shift every open, dated task in a phase by N days. */
export function ShiftPhaseDialog({ projectId, phase, onClose, onChanged }: { projectId: string; phase: { key: string; name: string }; onClose: () => void; onChanged: () => Promise<unknown> }) {
  const trpc = useTRPC();
  const toast = useToast();
  const shift = useMutation(
    trpc.tasks.shiftPhase.mutationOptions({
      onSuccess: async (r) => {
        toast("success", `${r.changed} task${r.changed === 1 ? "" : "s"} moved`);
        await onChanged();
        onClose();
      },
      onError: (e) => toast("error", errorMessage(e)),
    }),
  );
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const days = Number(f.get("days")) * (f.get("dir") === "earlier" ? -1 : 1);
    shift.mutate({ projectId, phaseKey: phase.key, days, unit: String(f.get("unit")) as "business" | "calendar" });
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Shift ${phase.name}`}
      description="Moves the due date of every open, dated task in this phase. Tasks dated from them follow."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="shift-form" loading={shift.isPending}>
            Shift dates
          </Button>
        </>
      }
    >
      <form id="shift-form" onSubmit={submit} className="grid gap-5 sm:grid-cols-2">
        <ShiftFields />
      </form>
    </Dialog>
  );
}
