"use client";

import { useSyncExternalStore } from "react";

const noop = () => () => {};

/** Evaluate a browser-only capability without a hydration mismatch (false on the server). */
export function useClientFlag(check: () => boolean): boolean {
  return useSyncExternalStore(noop, check, () => false);
}

export const hasPasskeySupport = () => typeof window !== "undefined" && "PublicKeyCredential" in window;
