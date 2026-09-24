"use client";

import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Dialog, useToast } from "@/components/ui/overlay";
import { Button, Skeleton, Switch } from "@/components/ui/primitives";
import { TOGGLES } from "@/core/toggles";
import { errorMessage, useTRPC } from "@/lib/trpc";
import type { Checklist } from "./checklist-tab";

/**
 * Site conditions (brief §5.1): flip toggles and see exactly which tasks and
 * phases change before applying. Started tasks are only removed if ticked.
 */
export function TogglesDialog({ projectId, checklist, onClose, onChanged }: { projectId: string; checklist: Checklist; onClose: () => void; onChanged: () => Promise<unknown> }) {
  const trpc = useTRPC();
  const toast = useToast();
  const [on, setOn] = useState<string[]>(checklist.toggles);
  const [removeStarted, setRemoveStarted] = useState<string[]>([]);
  const implied = new Set(checklist.impliedToggles);
  const hidden = new Set(checklist.hiddenToggles);
  const changed = on.length !== checklist.toggles.length || on.some((k) => !checklist.toggles.includes(k));
  const preview = useQuery({ ...trpc.checklist.previewToggles.queryOptions({ projectId, toggles: on }), enabled: changed, placeholderData: keepPreviousData });
  const apply = useMutation(
    trpc.checklist.setToggles.mutationOptions({
      onSuccess: async (r) => {
        toast("success", `Site conditions updated: ${r.added} added, ${r.removed} removed`);
        onClose();
        await onChanged();
      },
      onError: (e) => toast("error", errorMessage(e)),
    }),
  );
  const flip = (k: string, v: boolean) => {
    setOn((cur) => (v ? [...cur, k] : cur.filter((x) => x !== k)));
    setRemoveStarted([]);
  };
  const p = changed ? preview.data : undefined;

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title="Site conditions"
      description="Each condition adds or removes the tasks that go with it. Nothing changes until you apply."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!changed || preview.isFetching} loading={apply.isPending} onClick={() => apply.mutate({ projectId, toggles: on, removeStarted })}>
            Apply changes
          </Button>
        </>
      }
    >
      <div className="grid gap-8 lg:grid-cols-[1fr_1fr]">
        <ul className="flex flex-col gap-4">
          {TOGGLES.filter((t) => !hidden.has(t.key) || implied.has(t.key)).map((t) => (
            <li key={t.key}>
              <Switch
                id={`tg-${t.key}`}
                checked={implied.has(t.key) || on.includes(t.key)}
                disabled={implied.has(t.key)}
                onChange={(v) => flip(t.key, v)}
                label={t.label}
                description={implied.has(t.key) ? "Set by the project type." : "hint" in t ? t.hint : undefined}
              />
            </li>
          ))}
        </ul>
        <div aria-live="polite" className="rounded-panel border border-border bg-sunken/50 p-4 text-sm">
          {!changed ? (
            <p className="text-muted">Turn a condition on or off to see what it changes.</p>
          ) : !p ? (
            <Skeleton className="h-32" />
          ) : p.add.length + p.remove.length + p.ask.length + p.phasesAdded.length + p.phasesRemoved.length === 0 ? (
            <p className="text-muted">No tasks change.</p>
          ) : (
            <div className="flex flex-col gap-4">
              {p.phasesAdded.length > 0 && <p>Adds the phase{p.phasesAdded.length > 1 ? "s" : ""} {p.phasesAdded.join(", ")}.</p>}
              {p.phasesRemoved.length > 0 && <p>Sets aside {p.phasesRemoved.join(", ")} (if it hasn&apos;t started).</p>}
              {p.add.length > 0 && (
                <div>
                  <p className="font-medium">Adds {p.add.length} task{p.add.length > 1 ? "s" : ""}</p>
                  <ul className="mt-1 list-disc pl-5 text-muted">
                    {p.add.map((a) => (
                      <li key={a.key}>
                        {a.title} <span className="text-faint">· {a.phase}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {p.remove.length > 0 && (
                <div>
                  <p className="font-medium">Removes {p.remove.length} task{p.remove.length > 1 ? "s" : ""} not started yet</p>
                  <ul className="mt-1 list-disc pl-5 text-muted">
                    {p.remove.map((a) => (
                      <li key={a.id}>{a.title}</li>
                    ))}
                  </ul>
                </div>
              )}
              {p.ask.length > 0 && (
                <fieldset>
                  <legend className="font-medium">Already started — remove these too?</legend>
                  <p className="text-[12px] text-muted">Unticked ones stay on the checklist.</p>
                  <ul className="mt-2 flex flex-col gap-1">
                    {p.ask.map((a) => (
                      <li key={a.id}>
                        <label className="flex min-h-10 items-center gap-3">
                          <input
                            type="checkbox"
                            className="size-4 accent-[var(--accent)]"
                            checked={removeStarted.includes(a.id)}
                            onChange={(e) => setRemoveStarted((cur) => (e.target.checked ? [...cur, a.id] : cur.filter((x) => x !== a.id)))}
                          />
                          {a.title}
                        </label>
                      </li>
                    ))}
                  </ul>
                </fieldset>
              )}
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}
