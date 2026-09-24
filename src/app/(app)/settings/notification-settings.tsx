"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { ConfirmDialog, useToast } from "@/components/ui/overlay";
import { Button, Input, Panel, Skeleton, StatusPill, Switch } from "@/components/ui/primitives";
import { channelOn, type Prefs } from "@/core/notify";
import { formatDateTimeET } from "@/core/time";
import { currentSubscription, deviceLabel, pushSupport, subscribeThisDevice, type PushSupport } from "@/lib/push";
import { errorMessage, useTRPC, type RouterOutputs } from "@/lib/trpc";

type Settings = RouterOutputs["notifySettings"]["get"];

/** Notification preferences (brief §9): this device, push and email per event, quiet hours, the daily digest. */
export function NotificationSettings() {
  const trpc = useTRPC();
  const q = useQuery(trpc.notifySettings.get.queryOptions());
  return (
    <div id="notifications" className="mt-8 scroll-mt-8">
    <Panel title="Notifications" description="Everything always lands in your Inbox. Choose what also reaches your phone or email.">
      <div className="flex flex-col gap-10 px-6 py-6 sm:px-8">
        <ThisDevice />
        {q.data ? <Preferences key={JSON.stringify(q.data)} initial={q.data} /> : <Skeleton className="h-96 rounded-panel" />}
      </div>
    </Panel>
    </div>
  );
}

function ThisDevice() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const toast = useToast();
  const config = useQuery(trpc.push.config.queryOptions());
  const devices = useQuery(trpc.push.devices.queryOptions());
  const refresh = () => qc.invalidateQueries({ queryKey: trpc.push.devices.queryKey() });
  const subscribe = useMutation(trpc.push.subscribe.mutationOptions({ onSettled: refresh }));
  const unsubscribe = useMutation(trpc.push.unsubscribe.mutationOptions({ onSettled: refresh }));
  const remove = useMutation(trpc.push.removeDevice.mutationOptions({ onSettled: refresh, onError: (e) => toast("error", errorMessage(e)) }));
  const test = useMutation(trpc.push.test.mutationOptions({ onSuccess: () => toast("success", "Test sent. It should arrive in a few seconds."), onError: (e) => toast("error", errorMessage(e)) }));
  const [local, setLocal] = useState<{ support: PushSupport; permission: string; endpoint: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<{ id: string; label: string } | null>(null);

  useEffect(() => {
    let live = true;
    void currentSubscription().then((sub) => {
      if (live) setLocal({ support: pushSupport(), permission: typeof Notification === "undefined" ? "n/a" : Notification.permission, endpoint: sub?.endpoint ?? null });
    });
    return () => {
      live = false;
    };
  }, []);

  const publicKey = config.data?.publicKey ?? null;
  const here = local?.endpoint ? devices.data?.find((d) => d.endpoint === local.endpoint) : undefined;

  async function turnOn() {
    if (!publicKey) return;
    setBusy(true);
    try {
      const r = await subscribeThisDevice(publicKey);
      if ("error" in r) return toast("error", r.error);
      await subscribe.mutateAsync({ endpoint: r.sub.endpoint!, keys: { p256dh: r.sub.keys!.p256dh!, auth: r.sub.keys!.auth! }, label: deviceLabel() });
      setLocal({ support: "ok", permission: "granted", endpoint: r.sub.endpoint! });
      toast("success", "Notifications are on for this device");
    } catch (e) {
      toast("error", errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    setBusy(true);
    try {
      const sub = await currentSubscription();
      if (sub) {
        await unsubscribe.mutateAsync({ endpoint: sub.endpoint });
        await sub.unsubscribe();
      }
      setLocal((l) => (l ? { ...l, endpoint: null } : l));
    } catch (e) {
      toast("error", errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  let status: ReactNode;
  if (!local || config.isPending) status = <Skeleton className="h-10 w-64" />;
  else if (!publicKey) status = <p className="text-sm text-muted">Push notifications aren&apos;t set up on this server yet.</p>;
  else if (local.support === "install-first")
    status = (
      <p className="text-sm text-muted">
        On iPhone, notifications work only in the installed app.{" "}
        <Link href="/install" className="underline underline-offset-4">
          Add it to your Home Screen
        </Link>
        , open it from there, then come back here.
      </p>
    );
  else if (local.support === "unsupported") status = <p className="text-sm text-muted">This browser can&apos;t receive notifications.</p>;
  else if (local.permission === "denied")
    status = <p className="text-sm text-muted">Notifications are blocked for this app. Allow them in your browser or device settings, then reload.</p>;
  else if (here || local.endpoint)
    status = (
      <div className="flex flex-wrap items-center gap-3">
        <StatusPill tone="done">On for this device</StatusPill>
        <Button size="sm" variant="secondary" onClick={() => test.mutate()} loading={test.isPending}>
          Send a test
        </Button>
        <Button size="sm" variant="ghost" onClick={turnOff} loading={busy}>
          Turn off here
        </Button>
      </div>
    );
  else
    status = (
      <Button size="sm" onClick={turnOn} loading={busy}>
        Turn on for this device
      </Button>
    );

  return (
    <section aria-labelledby="ns-device">
      <h3 id="ns-device" className="eyebrow mb-3">
        This device
      </h3>
      {status}
      {devices.data && devices.data.length > 0 && (
        <ul className="mt-5 divide-y divide-border rounded-panel border border-border">
          {devices.data.map((d) => (
            <li key={d.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {d.label ?? "Device"}
                  {d.endpoint === local?.endpoint && <span className="ml-2 text-[12px] font-normal text-muted">this one</span>}
                </p>
                <p className="text-[12px] text-muted">{d.lastSuccessAt ? `Last notified ${formatDateTimeET(d.lastSuccessAt)}` : `Added ${formatDateTimeET(d.createdAt)}`}</p>
              </div>
              <Button size="sm" variant="ghost" onClick={() => setRemoving({ id: d.id, label: d.label ?? "this device" })}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={removing !== null}
        title={`Stop notifications on ${removing?.label ?? "this device"}?`}
        body="It stops receiving push notifications. You can turn them on again from that device."
        confirmLabel="Remove"
        danger
        busy={remove.isPending}
        onCancel={() => setRemoving(null)}
        onConfirm={() => removing && remove.mutate({ id: removing.id }, { onSettled: () => setRemoving(null) })}
      />
    </section>
  );
}

function Preferences({ initial }: { initial: Settings }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const toast = useToast();
  const [prefs, setPrefs] = useState<Prefs>(initial.prefs);
  const [quiet, setQuiet] = useState(initial.quietStart !== null);
  const [quietStart, setQuietStart] = useState(initial.quietStart ?? "21:00");
  const [quietEnd, setQuietEnd] = useState(initial.quietEnd ?? "07:00");
  const [digest, setDigest] = useState(initial.digest);
  const save = useMutation(
    trpc.notifySettings.save.mutationOptions({
      onSuccess: () => {
        toast("success", "Notification settings saved");
        return qc.invalidateQueries({ queryKey: trpc.notifySettings.get.queryKey() });
      },
      onError: (e) => toast("error", errorMessage(e)),
    }),
  );
  const set = (kind: string, channel: "push" | "email", on: boolean) => setPrefs((p) => ({ ...p, [kind]: { ...p[kind], [channel]: on } }));

  return (
    <>
      <section aria-labelledby="ns-events">
        <h3 id="ns-events" className="eyebrow mb-3">
          What reaches you
        </h3>
        {!initial.emailOn && <p className="mb-3 text-[13px] text-muted">Email is paused until a sender is chosen. Your email choices apply once it starts.</p>}
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-[12px] text-muted">
              <th scope="col" className="py-2 font-normal">
                Event
              </th>
              <th scope="col" className="w-16 py-2 text-center font-normal">
                Push
              </th>
              <th scope="col" className="w-16 py-2 text-center font-normal">
                Email
              </th>
            </tr>
          </thead>
          <tbody>
            {initial.events.map((e) => (
              <tr key={e.kind} className="border-b border-border last:border-0">
                <th scope="row" className="py-3 pr-2 text-left font-normal">
                  {e.label}
                </th>
                <td className="py-3 text-center">
                  <input type="checkbox" className="size-5 accent-[var(--primary)]" aria-label={`${e.label}: push`} checked={channelOn(prefs, e.kind, "push")} onChange={(ev) => set(e.kind, "push", ev.target.checked)} />
                </td>
                <td className="py-3 text-center">
                  {e.email ? (
                    <input type="checkbox" className="size-5 accent-[var(--primary)]" aria-label={`${e.label}: email`} checked={channelOn(prefs, e.kind, "email")} onChange={(ev) => set(e.kind, "email", ev.target.checked)} />
                  ) : (
                    <span className="text-muted" aria-label="No email for this event">
                      —
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-[12px] text-muted">To keep inboxes quiet, email carries only the digest, approvals and the third overdue reminder.</p>
      </section>

      <section aria-labelledby="ns-quiet" className="flex flex-col gap-4">
        <h3 id="ns-quiet" className="eyebrow">
          Quiet hours and digest
        </h3>
        <Switch id="ns-quiet-on" checked={quiet} onChange={setQuiet} label="Quiet hours" description="Push waits until they end (New York time). Everything still lands in your Inbox." />
        {quiet && (
          <div className="flex flex-wrap items-end gap-4">
            <label className="flex flex-col gap-1 text-[13px] text-muted">
              From
              <Input type="time" value={quietStart} onChange={(e) => setQuietStart(e.target.value)} className="w-32" required />
            </label>
            <label className="flex flex-col gap-1 text-[13px] text-muted">
              Until
              <Input type="time" value={quietEnd} onChange={(e) => setQuietEnd(e.target.value)} className="w-32" required />
            </label>
          </div>
        )}
        <Switch id="ns-digest" checked={digest} onChange={setDigest} label="Daily digest at 7:00am" description="Your overdue, due today, approvals waiting and blocked tasks, in one message." />
      </section>

      <div className="flex justify-end">
        <Button
          onClick={() => save.mutate({ prefs: prefs as Record<string, { push?: boolean; email?: boolean }>, quietStart: quiet ? quietStart : null, quietEnd: quiet ? quietEnd : null, digest })}
          loading={save.isPending}
        >
          Save notification settings
        </Button>
      </div>
    </>
  );
}
