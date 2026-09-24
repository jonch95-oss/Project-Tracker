"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { IconOffline } from "@/components/ui/icons";
import { Dialog, useToast } from "@/components/ui/overlay";
import { Button } from "@/components/ui/primitives";
import { formatDateTimeET } from "@/core/time";
import { restoreSnapshot, saveSnapshot, tellWorker } from "@/lib/offline-cache";
import { discardOthers, flushQueue, queueSnapshot, readQueue, removeOp, resolveConflict, retryOp, setQueueViewer, subscribeQueue, type QueueClient } from "@/lib/offline-queue";
import { registerServiceWorker } from "@/lib/push";
import { errorMessage, useTRPCClient } from "@/lib/trpc";

const subscribeOnline = (fn: () => void) => {
  window.addEventListener("online", fn);
  window.addEventListener("offline", fn);
  return () => {
    window.removeEventListener("online", fn);
    window.removeEventListener("offline", fn);
  };
};

/** How long after the last change the screens on show are saved to the phone. */
const SAVE_DELAY_MS = 3000;

/**
 * The iPhone app's offline state (brief §12). It keeps the screens this
 * person has opened on the phone (and puts them back when the app starts with
 * no connection); says when the app is showing saved copies and how many
 * ticks and comments are waiting to sync; lists any that need a decision; and
 * sends the queue whenever the connection comes back, the app returns to the
 * foreground, or every 30 seconds while anything is waiting.
 */
export function OfflineBar({ viewerId }: { viewerId: string }) {
  const client = useTRPCClient();
  const qc = useQueryClient();
  const toast = useToast();
  const online = useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );
  const [open, setOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  // The queue as stored (a string, so React can compare snapshots); read after hydration.
  const raw = useSyncExternalStore(subscribeQueue, queueSnapshot, () => "");
  const queue = useMemo(() => (raw ? readQueue().filter((o) => o.userId === viewerId) : []), [raw, viewerId]);
  const pending = queue.filter((o) => o.state === "pending").length;
  const attention = queue.filter((o) => o.state !== "pending");

  // Who is signed in: anything another person left on this phone goes, and their copy is never shown.
  useEffect(() => {
    setQueueViewer(viewerId);
    discardOthers(viewerId);
    void registerServiceWorker().then(() => tellWorker(viewerId));
    void restoreSnapshot(qc, viewerId);
  }, [viewerId, qc]);

  // Keep what's on screen on the phone, a few seconds after it last changed.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsub = qc.getQueryCache().subscribe((e) => {
      if (e.type !== "updated" || e.action.type !== "success") return;
      clearTimeout(timer);
      timer = setTimeout(() => void saveSnapshot(qc, viewerId), SAVE_DELAY_MS);
    });
    return () => {
      unsub();
      clearTimeout(timer);
    };
  }, [qc, viewerId]);

  const api: QueueClient = useMemo(
    () => ({
      setDone: (input) => client.checklist.setDone.mutate(input, { context: { offlineBypass: true } }) as Promise<{ status: string; version: number; label?: string }>,
      addComment: (input) => client.tasks.addComment.mutate(input, { context: { offlineBypass: true } }),
      latestVersion: async (projectId, taskId) => {
        try {
          return (await client.tasks.detail.query({ projectId, taskId })).version;
        } catch (e) {
          // Gone (or out of reach) for good; anything else (no connection) is thrown so nothing changes.
          if (["NOT_FOUND", "FORBIDDEN"].includes((e as { data?: { code?: string } }).data?.code ?? "")) return null;
          throw e;
        }
      },
    }),
    [client],
  );

  const sync = useCallback(async () => {
    if (!navigator.onLine || !readQueue().some((o) => o.state === "pending" && o.userId === viewerId)) return;
    setSyncing(true);
    try {
      const r = await flushQueue(api, errorMessage);
      if (r.sent) {
        toast("success", r.sent === 1 ? "1 offline change synced" : `${r.sent} offline changes synced`);
        await qc.invalidateQueries();
      }
    } finally {
      setSyncing(false);
    }
  }, [api, qc, toast, viewerId]);

  useEffect(() => {
    const first = setTimeout(() => void sync(), 0);
    const onVisible = () => document.visibilityState === "visible" && void sync();
    window.addEventListener("online", sync);
    document.addEventListener("visibilitychange", onVisible);
    const t = setInterval(() => void sync(), 30_000);
    return () => {
      window.removeEventListener("online", sync);
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(t);
      clearTimeout(first);
    };
  }, [sync]);

  if (online && pending === 0 && attention.length === 0) return null;
  return (
    <>
      <div role="status" className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-card border border-border bg-sunken px-4 py-3 text-[14px]">
        {!online && <IconOffline size={18} className="text-muted" />}
        <p className="min-w-0 flex-1">
          {!online ? <span className="font-medium">You&apos;re offline. </span> : null}
          {!online && <span className="text-muted">Showing what was saved on this phone. Ticks and comments are kept here and sync when you&apos;re back online.</span>}
          {online && pending > 0 && <span>{syncing ? "Syncing…" : `${pending} offline change${pending === 1 ? "" : "s"} waiting to sync.`}</span>}
          {!online && pending > 0 && <span className="num ml-1 font-medium">{pending} waiting.</span>}
          {attention.length > 0 && <span className="ml-1 font-medium text-attention-text">{attention.length === 1 ? "1 change needs you." : `${attention.length} changes need you.`}</span>}
        </p>
        {online && pending > 0 && (
          <Button size="sm" variant="secondary" loading={syncing} onClick={() => void sync()}>
            Sync now
          </Button>
        )}
        {attention.length > 0 && (
          <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
            Review
          </Button>
        )}
      </div>
      <Dialog open={open && attention.length > 0} onClose={() => setOpen(false)} title="Offline changes that didn't go through" description="Saved on this phone while you were offline.">
        <ul className="flex flex-col divide-y divide-border">
          {attention.map((o) => (
            <li key={o.id} className="flex flex-col gap-2 py-3">
              <p className="text-[14px] font-medium">{o.label}</p>
              {o.path === "tasks.addComment" && <blockquote className="whitespace-pre-wrap rounded-control bg-sunken px-3 py-2 text-[13px] select-text">{o.input.body}</blockquote>}
              <p className="text-[13px] text-muted">
                {o.message} · saved {formatDateTimeET(new Date(o.queuedAt))}
              </p>
              <div className="flex flex-wrap gap-2">
                {o.state === "conflict" && o.path === "checklist.setDone" && (
                  <Button size="sm" onClick={() => void resolveConflict(api, o.id, errorMessage).then(() => qc.invalidateQueries())}>
                    {o.input.done ? "Tick it anyway" : "Untick it anyway"}
                  </Button>
                )}
                {o.state === "failed" && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      retryOp(o.id);
                      void sync();
                    }}
                  >
                    Retry
                  </Button>
                )}
                {o.path === "tasks.addComment" && (
                  <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard?.writeText(o.input.body).then(() => toast("success", "Comment copied"))}>
                    Copy text
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => removeOp(o.id)}>
                  Discard
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </Dialog>
    </>
  );
}
