"use client";

import { onlineManager } from "@tanstack/react-query";

/**
 * Whether the app can reach the server (brief §12). Phones don't always
 * report losing their connection (navigator.onLine can stay true in Airplane
 * Mode), so a request failing for lack of a connection also counts: reads
 * then pause and the copy saved on the phone stays on screen, and a small
 * check every few seconds notices when the connection is back.
 */

const PROBE_MS = 10_000;
let timer: ReturnType<typeof setInterval> | null = null;
let started = false;

async function probe(): Promise<void> {
  try {
    const res = await fetch("/manifest.webmanifest", { cache: "no-store", method: "HEAD" });
    if (res.ok) {
      stopProbe();
      onlineManager.setOnline(true);
    }
  } catch {
    // Still offline.
  }
}

function startProbe() {
  if (timer || typeof window === "undefined") return;
  timer = setInterval(() => void probe(), PROBE_MS);
}

function stopProbe() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Start from what the phone says, and check again whenever it says the connection is back. */
export function initConnection(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  if (navigator.onLine === false) markOffline();
  // React Query's own listener trusts the "online" event; confirm it with a real request first.
  onlineManager.setEventListener((setOnline) => {
    const onOnline = () => void probe();
    const onOffline = () => {
      setOnline(false);
      startProbe();
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  });
}

/** A request just failed for lack of a connection. */
export function markOffline(): void {
  if (onlineManager.isOnline()) onlineManager.setOnline(false);
  startProbe();
}

export function isOnline(): boolean {
  return onlineManager.isOnline() && !(typeof navigator !== "undefined" && navigator.onLine === false);
}

export function subscribeOnline(fn: () => void): () => void {
  return onlineManager.subscribe(fn);
}
