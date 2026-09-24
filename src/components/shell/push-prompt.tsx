"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { deviceLabel, currentSubscription, pushSupport, registerServiceWorker, subscribeThisDevice, type PushSupport } from "@/lib/push";
import { errorMessage, useTRPC } from "@/lib/trpc";
import { useToast } from "../ui/overlay";
import { Button } from "../ui/primitives";
import { IconBell, IconPhone } from "../ui/icons";

const DISMISS_KEY = "pc.push-prompt.dismissed";

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * First-run push onboarding (brief §9): on iPhone in Safari, point to the
 * install guide; in the installed app or a desktop browser, ask for
 * permission after a tap. Also re-registers this device on every open so a
 * rotated push address, or a device that changed hands, stays correct.
 */
/** Only on the landing pages: never between someone and the project they opened. */
const PROMPT_PAGES = ["/portfolio", "/tasks", "/notifications"];

export function PushPrompt() {
  const pathname = usePathname();
  const trpc = useTRPC();
  const toast = useToast();
  const config = useQuery({ ...trpc.push.config.queryOptions(), staleTime: Infinity });
  const subscribe = useMutation(trpc.push.subscribe.mutationOptions());
  const [state, setState] = useState<{ support: PushSupport; permission: NotificationPermission | "n/a"; dismissed: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const support = pushSupport();
    const permission = typeof Notification === "undefined" ? "n/a" : Notification.permission;
    // Browser-only facts, read once after mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState({ support, permission, dismissed: readDismissed() });
    void registerServiceWorker();
  }, []);

  const publicKey = config.data?.publicKey ?? null;
  const { mutate: resync } = subscribe;
  useEffect(() => {
    if (!publicKey || state?.permission !== "granted") return;
    void currentSubscription().then((sub) => {
      const json = sub?.toJSON();
      if (json?.endpoint && json.keys?.p256dh && json.keys.auth) resync({ endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth }, label: deviceLabel() });
    });
  }, [publicKey, state?.permission, resync]);

  if (!state || state.dismissed || !publicKey || !PROMPT_PAGES.includes(pathname)) return null;
  if (state.support === "unsupported" || state.permission === "granted" || state.permission === "denied") return null;

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {}
    setState({ ...state, dismissed: true });
  };

  async function enable() {
    setBusy(true);
    try {
      const r = await subscribeThisDevice(publicKey!);
      if ("error" in r) {
        toast("error", r.error);
        setState({ ...state!, permission: typeof Notification === "undefined" ? "n/a" : Notification.permission });
        return;
      }
      await subscribe.mutateAsync({ endpoint: r.sub.endpoint!, keys: { p256dh: r.sub.keys!.p256dh!, auth: r.sub.keys!.auth! }, label: deviceLabel() });
      toast("success", "Notifications are on for this device");
      setState({ ...state!, permission: "granted" });
    } catch (e) {
      toast("error", errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const install = state.support === "install-first";
  return (
    <div role="region" aria-label="Notifications" className="mb-8 flex flex-col gap-4 rounded-card border border-accent/30 bg-accent-tint px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 text-accent">{install ? <IconPhone size={20} /> : <IconBell size={20} />}</span>
        <div>
          <h2 className="text-[15px] font-medium">{install ? "Get notifications on your iPhone" : "Turn on notifications"}</h2>
          <p className="mt-1 text-[13px] text-muted">
            {install ? "Add Project Command to your Home Screen first: iPhone only sends notifications to installed apps." : "Hear about assignments, approvals and reminders on this device, even when the app is closed."}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 gap-2">
        <Button variant="ghost" size="sm" onClick={dismiss}>
          Not now
        </Button>
        {install ? (
          <Link href="/install" className="inline-flex h-9 items-center rounded-control bg-primary px-4 text-sm font-medium text-on-primary">
            Show me how
          </Link>
        ) : (
          <Button size="sm" onClick={enable} loading={busy}>
            Turn on
          </Button>
        )}
      </div>
    </div>
  );
}
