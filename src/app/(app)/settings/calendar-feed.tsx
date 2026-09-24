"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ConfirmDialog, useToast } from "@/components/ui/overlay";
import { Button, Input, Panel } from "@/components/ui/primitives";
import { formatDateTimeET } from "@/core/time";
import { errorMessage, useTRPC } from "@/lib/trpc";

/** Module H: a private calendar link for iPhone, Google or Outlook. */
export function CalendarFeed() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery(trpc.calendar.status.queryOptions());
  const [fresh, setFresh] = useState<{ url: string; webcal: string } | null>(null);
  const [confirm, setConfirm] = useState<"new" | "off" | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: trpc.calendar.status.queryKey() });
  const create = useMutation(
    trpc.calendar.create.mutationOptions({
      onSuccess: async (r) => {
        setFresh(r);
        setConfirm(null);
        await refresh();
      },
      onError: (e) => toast("error", errorMessage(e)),
    }),
  );
  const revoke = useMutation(
    trpc.calendar.revoke.mutationOptions({
      onSuccess: async () => {
        setFresh(null);
        setConfirm(null);
        toast("success", "Calendar feed turned off");
        await refresh();
      },
      onError: (e) => toast("error", errorMessage(e)),
    }),
  );
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast("success", "Link copied");
    } catch {
      toast("error", "Couldn't copy. Select the link and copy it.");
    }
  };
  if (q.isPending || q.isError) return null;
  const active = q.data.active;

  return (
    <Panel
      title="Calendar feed"
      description="Your due dates, key dates, inspections, closings, meetings and expiries in your own calendar. No dollar figures, ever. The link is private: anyone with it sees your dates."
    >
      {fresh ? (
        <div className="flex flex-col gap-4">
          <p className="text-[14px]">Here&apos;s your link. It&apos;s shown once; if you lose it, make a new one.</p>
          <div className="flex flex-wrap gap-2">
            <Input readOnly value={fresh.url} aria-label="Calendar feed link" className="num min-w-0 flex-1 text-[13px]" onFocus={(e) => e.currentTarget.select()} />
            <Button variant="secondary" onClick={() => copy(fresh.url)}>
              Copy
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            <a href={fresh.webcal} className="inline-flex h-10 items-center rounded-control bg-primary px-4 text-[14px] font-medium text-on-primary">
              Add to iPhone / Mac Calendar
            </a>
          </div>
          <ul className="list-disc space-y-1 pl-5 text-[13px] text-muted">
            <li>iPhone: tap the button above, then Subscribe. Or Settings → Calendar → Accounts → Add Account → Other → Add Subscribed Calendar, and paste the link.</li>
            <li>Google Calendar (on a computer): Other calendars → + → From URL, paste the link.</li>
            <li>Outlook: Add calendar → Subscribe from web, paste the link.</li>
          </ul>
        </div>
      ) : active ? (
        <div className="flex flex-col gap-3 text-[14px]">
          <p>
            Your feed is on{q.data.lastFetchedAt ? `; your calendar last checked it ${formatDateTimeET(q.data.lastFetchedAt)}` : "; no calendar has read it yet"}.
          </p>
          <p className="text-[13px] text-muted">The link was shown once when it was made. Lost it? Make a new one; the old one stops working.</p>
        </div>
      ) : (
        <p className="text-[14px] text-muted">Off. Make a link to subscribe from your calendar app.</p>
      )}
      <div className="mt-5 flex flex-wrap gap-2">
        <Button variant={active ? "secondary" : "primary"} loading={create.isPending} onClick={() => (active ? setConfirm("new") : create.mutate())}>
          {active ? "Make a new link" : "Make my calendar link"}
        </Button>
        {active && (
          <Button variant="ghost" onClick={() => setConfirm("off")}>
            Turn off
          </Button>
        )}
      </div>
      <ConfirmDialog
        open={confirm !== null}
        title={confirm === "off" ? "Turn off your calendar feed?" : "Make a new link?"}
        body={confirm === "off" ? "Calendars subscribed to it stop updating." : "The old link stops working; calendars subscribed to it need the new one."}
        confirmLabel={confirm === "off" ? "Turn off" : "Make a new link"}
        danger={confirm === "off"}
        busy={create.isPending || revoke.isPending}
        onCancel={() => setConfirm(null)}
        onConfirm={() => (confirm === "off" ? revoke.mutate() : create.mutate())}
      />
    </Panel>
  );
}
