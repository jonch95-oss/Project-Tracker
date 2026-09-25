"use client";

import { dehydrate, hydrate, type QueryClient } from "@tanstack/react-query";
import { keyParts, overlayQueued } from "./offline-queue";

/**
 * What the app shows with no connection (brief §12): the answers of the
 * screens a person has opened, kept on the phone in IndexedDB under their own
 * user id and put back when the app starts. Money, audit and admin screens
 * are never kept, and amounts inside the screens that are kept are removed. Everything is deleted on sign-out, and another person's
 * copy is deleted as soon as someone else signs in on the phone.
 */

const DB = "pc-offline";
const STORE = "queries";
/** Screens never kept on the phone. */
const NEVER_KEEP = [
  "financials.",
  "capital.",
  "audit.",
  "analytics.",
  "users.",
  "system.",
  "import.",
  "usage.",
  "calendar.",
  "reports.",
  "search.",
  // Carry amounts, capital accounts or tax ids throughout: kept online only.
  "portal.",
  "units.",
  "directory.",
  "records.",
];

/**
 * Money inside screens that are kept (a card's headline figures, an RFI's
 * cost impact): removed before saving, so no amount is ever stored on the
 * phone. Amounts are always named "…Cents"; "headline" is the card's figures.
 */
export function withoutMoney(v: unknown, depth = 0): unknown {
  if (depth > 12 || v === null || typeof v !== "object") return v;
  if (v instanceof Date) return v;
  if (Array.isArray(v)) return v.map((x) => withoutMoney(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = k === "headline" || /Cents$/.test(k) ? null : withoutMoney(x, depth + 1);
  return out;
}
/** Answers older than this aren't shown offline. */
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

function open(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function run<T>(
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T | null> {
  const db = await open();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => {
        db.close();
        resolve(req ? (req.result as T) : null);
      };
      tx.onerror = tx.onabort = () => {
        db.close();
        resolve(null);
      };
    } catch {
      db.close();
      resolve(null);
    }
  });
}

/** The tRPC path of a query key ([["checklist","get"], {...}]). */
function pathOf(queryKey: readonly unknown[]): string {
  const p = queryKey[0];
  return Array.isArray(p) ? p.join(".") : "";
}

export function keepable(queryKey: readonly unknown[]): boolean {
  const path = pathOf(queryKey);
  return !!path && !NEVER_KEEP.some((n) => path.startsWith(n));
}

/** Save what's on screen now for this person (successful answers only). */
export async function saveSnapshot(
  qc: QueryClient,
  userId: string,
): Promise<void> {
  // Kept as plain objects (IndexedDB stores dates and the like as they are).
  const state = dehydrate(qc, {
    shouldDehydrateQuery: (q) =>
      q.state.status === "success" && keepable(q.queryKey),
    serializeData: (d) => withoutMoney(d),
  });
  await run("readwrite", (s) =>
    s.put({ at: Date.now(), state }, `user:${userId}`),
  );
}

/** Put this person's saved answers back (newer data already on screen wins). Anyone else's are deleted. */
export async function restoreSnapshot(
  qc: QueryClient,
  userId: string,
): Promise<boolean> {
  const keys =
    (await run<IDBValidKey[]>("readonly", (s) => s.getAllKeys())) ?? [];
  for (const k of keys)
    if (k !== `user:${userId}`) await run("readwrite", (s) => s.delete(k));
  const saved = await run<
    { at: number; state: ReturnType<typeof dehydrate> } | undefined
  >("readonly", (s) => s.get(`user:${userId}`));
  if (!saved || Date.now() - saved.at > MAX_AGE_MS) return false;
  // Changes still waiting to sync show on the saved copy too. Saved answers count as out of date:
  // anything already on screen wins, and each one is fetched again as soon as there's a connection.
  const state = {
    ...saved.state,
    queries: saved.state.queries.map((q) => {
      const { path, input } = keyParts(q.queryKey);
      return {
        ...q,
        state: {
          ...q.state,
          data: overlayQueued(path, input, q.state.data),
          dataUpdatedAt: 1,
          isInvalidated: true,
        },
      };
    }),
  };
  hydrate(qc, state, { defaultOptions: { deserializeData: (d) => d } });
  return true;
}

/** Delete every saved answer on this phone (sign-out). */
export async function clearSnapshots(): Promise<void> {
  await run("readwrite", (s) => s.clear());
}

/** Tell the service worker who is signed in (a different person clears its saved pages), or null to clear. */
export function tellWorker(viewerId: string | null, home?: string): void {
  try {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator))
      return;
    const msg =
      viewerId === null
        ? { type: "clear-offline" }
        : { type: "viewer", id: viewerId, home };
    navigator.serviceWorker.controller?.postMessage(msg);
    void navigator.serviceWorker.ready
      .then((r) => r.active?.postMessage(msg))
      .catch(() => undefined);
  } catch {
    // Never block the app on this.
  }
}
