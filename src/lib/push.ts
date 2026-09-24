"use client";

import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useCallback } from "react";
import { authClient } from "./auth-client";
import { useTRPC } from "./trpc";

/**
 * Web push on this device (brief §9, §12). iPhone only allows push for the
 * app opened from the Home Screen (iOS 16.4+), so there the first step is
 * installing it.
 */
export type PushSupport = "ok" | "install-first" | "unsupported";

export function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
}

export function pushSupport(): PushSupport {
  if (typeof window === "undefined") return "unsupported";
  const capable = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  if (isIOS() && !isStandalone()) return "install-first";
  return capable ? "ok" : "unsupported";
}

export function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return Promise.resolve(null);
  return navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch(() => null);
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await registerServiceWorker();
  return reg ? reg.pushManager.getSubscription() : null;
}

/** A short name for the device list: "iPhone", "Mac · Chrome"… */
export function deviceLabel(): string {
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : "Computer";
  if (os === "iPhone" || os === "iPad") return os;
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  return `${os} · ${browser}`;
}

/** Ask permission (must follow a tap) and subscribe. Returns the subscription, or a reason it didn't happen. */
export async function subscribeThisDevice(publicKey: string): Promise<{ sub: PushSubscriptionJSON } | { error: string }> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    return { error: permission === "denied" ? "Notifications are blocked for this app. Turn them on in your device settings, then try again." : "Notifications weren't allowed." };
  }
  const reg = await registerServiceWorker();
  if (!reg) return { error: "This browser can't receive notifications." };
  await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  const sub = existing ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }));
  return { sub: sub.toJSON() };
}

/** Sign out, first detaching this device from push so the next person on it doesn't get your notifications. */
export function useSignOut() {
  const trpc = useTRPC();
  const router = useRouter();
  const unsubscribe = useMutation(trpc.push.unsubscribe.mutationOptions());
  return useCallback(async () => {
    try {
      const sub = await currentSubscription();
      if (sub) {
        await unsubscribe.mutateAsync({ endpoint: sub.endpoint }).catch(() => undefined);
        await sub.unsubscribe().catch(() => undefined);
      }
    } catch {
      // Push cleanup must never block signing out.
    }
    await authClient.signOut();
    router.replace("/login");
    router.refresh();
  }, [router, unsubscribe]);
}
