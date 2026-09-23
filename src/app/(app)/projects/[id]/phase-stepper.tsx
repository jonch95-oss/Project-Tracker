"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { IconCheck } from "@/components/ui/icons";
import { ConfirmDialog, Dialog, useToast } from "@/components/ui/overlay";
import { Button, StatusPill } from "@/components/ui/primitives";
import { daysInPhase, type PhaseState } from "@/core/phases";
import { formatIsoDate, todayET } from "@/core/time";
import { cn } from "@/lib/cn";
import { errorMessage, useTRPC } from "@/lib/trpc";

/**
 * Phase stepper (brief §7.3). Everyone sees where the project stands; people
 * who can edit the project pick a phase to make it current, or skip / restore
 * it. The checklist for a phase opens here once templates arrive (M3).
 */
export function PhaseStepper({ projectId, phases, version, canEdit }: { projectId: string; phases: PhaseState[]; version: number; canEdit: boolean }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const toast = useToast();
  const [selected, setSelected] = useState<PhaseState | null>(null);
  const [confirmBack, setConfirmBack] = useState<PhaseState | null>(null);
  const track = useRef<HTMLOListElement>(null);
  // Keep the current phase in view when the track scrolls sideways (phones, long tracks).
  useEffect(() => {
    const el = track.current?.querySelector<HTMLElement>("[data-active]");
    if (el && track.current && track.current.scrollWidth > track.current.clientWidth) {
      track.current.scrollLeft = Math.max(0, el.offsetLeft - track.current.offsetLeft - 16);
    }
  }, [phases]);
  const list = [...phases].sort((a, b) => a.sortOrder - b.sortOrder);
  const activeIdx = list.findIndex((p) => p.status === "active");
  const days = daysInPhase(list, todayET());

  const done = async () => {
    await qc.invalidateQueries({ queryKey: trpc.projects.get.queryKey({ projectId }) });
    await qc.invalidateQueries({ queryKey: trpc.projects.list.queryKey() });
  };
  const onError = async (e: unknown) => {
    toast("error", errorMessage(e));
    await done();
  };
  const setPhase = useMutation(
    trpc.projects.setPhase.mutationOptions({
      onSuccess: async () => {
        setSelected(null);
        setConfirmBack(null);
        toast("success", "Phase updated");
        await done();
      },
      onError,
    }),
  );
  const skip = useMutation(
    trpc.projects.skipPhase.mutationOptions({
      onSuccess: async () => {
        setSelected(null);
        await done();
      },
      onError,
    }),
  );

  const selIdx = selected ? list.findIndex((p) => p.key === selected.key) : -1;

  return (
    <section aria-labelledby="phases-h" className="mt-10">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="phases-h" className="serif text-heading">
          Phases
        </h2>
        {activeIdx >= 0 && (
          <p className="text-[13px] text-muted">
            In <span className="font-medium text-text">{list[activeIdx]!.name}</span>
            {days != null && (
              <>
                {" "}
                for <span className="num">{days}</span> {days === 1 ? "day" : "days"}
              </>
            )}
          </p>
        )}
      </div>
      <ol ref={track} className="-mx-4 flex snap-x gap-2 overflow-x-auto px-4 pb-2 [scrollbar-width:thin] sm:mx-0 sm:px-0">
        {list.map((p, i) => (
          <li key={p.key} className="min-w-[128px] flex-1 snap-start" data-active={p.status === "active" || undefined}>
            <button
              type="button"
              onClick={() => setSelected(p)}
              aria-current={p.status === "active" ? "step" : undefined}
              className={cn(
                "flex h-full min-h-24 w-full flex-col justify-between gap-2 rounded-panel border p-3 text-left transition-colors duration-150",
                p.status === "active" && "border-accent bg-accent-tint/60",
                p.status === "done" && "border-border bg-surface",
                p.status === "pending" && "border-border bg-surface/50",
                p.status === "skipped" && "border-dashed border-border-strong bg-transparent text-muted",
                "hover:border-text/40",
              )}
            >
              <span className="num text-[11px] text-muted">{String(i + 1).padStart(2, "0")}</span>
              <span className={cn("text-[13px] leading-tight", p.status === "active" && "font-medium", p.status === "skipped" && "line-through")}>{p.name}</span>
              <span className="text-[11px] text-muted">
                {p.status === "done" ? (
                  <span className="inline-flex items-center gap-1">
                    <IconCheck size={12} /> Done
                  </span>
                ) : p.status === "active" ? (
                  "Current"
                ) : p.status === "skipped" ? (
                  "Skipped"
                ) : (
                  "Upcoming"
                )}
              </span>
            </button>
          </li>
        ))}
      </ol>

      <Dialog
        open={!!selected}
        onClose={() => setSelected(null)}
        title={selected?.name ?? ""}
        description={selected ? describe(selected) : undefined}
        footer={
          selected && canEdit ? (
            <>
              {selected.status !== "active" &&
                (selected.status === "skipped" ? (
                  <Button variant="secondary" loading={skip.isPending} onClick={() => skip.mutate({ projectId, key: selected.key, skipped: false, version })}>
                    Restore phase
                  </Button>
                ) : (
                  <Button variant="ghost" loading={skip.isPending} onClick={() => skip.mutate({ projectId, key: selected.key, skipped: true, version })}>
                    Skip this phase
                  </Button>
                ))}
              {selected.status !== "active" && selected.status !== "skipped" && (
                <Button
                  loading={setPhase.isPending}
                  onClick={() => (activeIdx >= 0 && selIdx < activeIdx ? setConfirmBack(selected) : setPhase.mutate({ projectId, key: selected.key, version }))}
                >
                  Make this the current phase
                </Button>
              )}
              {selected.status === "active" && (
                <Button variant="secondary" onClick={() => setSelected(null)}>
                  Close
                </Button>
              )}
            </>
          ) : (
            <Button variant="secondary" onClick={() => setSelected(null)}>
              Close
            </Button>
          )
        }
      >
        {selected && (
          <div className="space-y-4 text-sm">
            <StatusPill tone={selected.status === "active" ? "accent" : selected.status === "done" ? "done" : "neutral"}>
              {selected.status === "active" ? "Current phase" : selected.status === "done" ? "Done" : selected.status === "skipped" ? "Skipped" : "Upcoming"}
            </StatusPill>
            <p className="text-muted">This phase&apos;s checklist appears here once project templates are set up.</p>
            {canEdit && selected.status === "pending" && selIdx > activeIdx + 1 && activeIdx >= 0 && (
              <p className="text-muted">Jumping ahead marks the phases in between as done today.</p>
            )}
          </div>
        )}
      </Dialog>

      <ConfirmDialog
        open={!!confirmBack}
        onCancel={() => setConfirmBack(null)}
        title={`Move back to ${confirmBack?.name ?? ""}?`}
        body="Use this when a deal falls out of contract or a phase has to be redone. Later phases go back to upcoming and lose their dates."
        confirmLabel="Move back"
        danger
        busy={setPhase.isPending}
        onConfirm={() => confirmBack && setPhase.mutate({ projectId, key: confirmBack.key, version })}
      />
    </section>
  );
}

function describe(p: PhaseState): string {
  if (p.status === "done" && p.startedOn && p.completedOn) return `${formatIsoDate(p.startedOn)} – ${formatIsoDate(p.completedOn)}`;
  if (p.status === "active" && p.startedOn) return `Since ${formatIsoDate(p.startedOn)}`;
  if (p.status === "skipped") return "Not part of this project.";
  return "Not started.";
}
