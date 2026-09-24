"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createTRPCClient,
  httpBatchLink,
  httpLink,
  loggerLink,
  splitLink,
  type TRPCLink,
} from "@trpc/client";
import { observable } from "@trpc/server/observable";
import { createTRPCContext } from "@trpc/tanstack-react-query";
import type { inferRouterOutputs } from "@trpc/server";
import { useState, type ReactNode } from "react";
import superjson from "superjson";
import type { AppRouter } from "@/server/trpc/root";
import {
  enqueue,
  isNetworkError,
  isQueueable,
  overlayQueued,
  queuedResult,
  setTaskTitleLookup,
} from "./offline-queue";

export const { TRPCProvider, useTRPC, useTRPCClient } =
  createTRPCContext<AppRouter>();
export type RouterOutputs = inferRouterOutputs<AppRouter>;

/**
 * Offline (brief §12): a tick or comment made with no connection is queued on
 * the device and answered at once; fresh data always shows what's still
 * queued. Calls made by the sync itself pass `offlineBypass`.
 */
function offlineLink(): TRPCLink<AppRouter> {
  return () =>
    ({ op, next }) =>
      observable((observer) => {
        const bypass = (op.context as { offlineBypass?: boolean } | undefined)
          ?.offlineBypass;
        if (op.type === "mutation" && isQueueable(op.path) && !bypass) {
          const path = op.path;
          const queue = () => {
            enqueue(path, op.input);
            observer.next({
              result: { type: "data", data: queuedResult(path, op.input) },
            } as never);
            observer.complete();
          };
          if (typeof navigator !== "undefined" && navigator.onLine === false) {
            queue();
            return;
          }
          const sub = next(op).subscribe({
            next: (v) => observer.next(v),
            error: (err) =>
              isNetworkError(err) ? queue() : observer.error(err),
            complete: () => observer.complete(),
          });
          return () => sub.unsubscribe();
        }
        const sub = next(op).subscribe({
          next: (v) => {
            if (op.type === "query" && v.result.type === "data")
              observer.next({
                ...v,
                result: {
                  ...v.result,
                  data: overlayQueued(op.path, op.input, v.result.data),
                },
              } as never);
            else observer.next(v);
          },
          error: (err) => observer.error(err),
          complete: () => observer.complete(),
        });
        return () => sub.unsubscribe();
      });
}

/** A task's title from whatever is already loaded (for naming queued changes). */
function findTaskTitle(qc: QueryClient, taskId: string): string | null {
  const look = (v: unknown, depth: number): string | null => {
    if (!v || typeof v !== "object" || depth > 5) return null;
    if (Array.isArray(v)) {
      for (const x of v) {
        const r = look(x, depth + 1);
        if (r) return r;
      }
      return null;
    }
    const o = v as Record<string, unknown>;
    if (o.id === taskId && typeof o.title === "string") return o.title;
    for (const k of ["tasks", "sections", "groups"])
      if (k in o) {
        const r = look(o[k], depth + 1);
        if (r) return r;
      }
    return null;
  };
  for (const q of qc.getQueryCache().getAll()) {
    const r = look(q.state.data, 0);
    if (r) return r;
  }
  return null;
}

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      mutations: {
        // Always reach the client: queued kinds are saved for later, others say they need a connection.
        networkMode: "always",
      },
      queries: {
        // Try once even offline: the service worker may have a saved copy.
        networkMode: "offlineFirst",
        staleTime: 30_000,
        // Neon's free plan can take a few seconds to wake; retry once.
        retry: (count, err) =>
          count < 1 &&
          !/UNAUTHORIZED|FORBIDDEN|NOT_FOUND/.test(
            String((err as { data?: { code?: string } })?.data?.code),
          ),
        refetchOnWindowFocus: true,
      },
    },
  });
}

export function TRPCReactProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => {
    const qc = makeQueryClient();
    setTaskTitleLookup((id) => findTaskTitle(qc, id));
    return qc;
  });
  const [trpcClient] = useState(() =>
    createTRPCClient<AppRouter>({
      links: [
        loggerLink({
          enabled: (op) =>
            process.env.NODE_ENV === "development" &&
            op.direction === "down" &&
            op.result instanceof Error,
        }),
        offlineLink(),
        // Reads go one per request (GET), so the service worker can keep a saved copy of each for offline use.
        splitLink({
          condition: (op) => op.type === "query",
          true: httpLink({ url: "/api/trpc", transformer: superjson }),
          false: httpBatchLink({ url: "/api/trpc", transformer: superjson }),
        }),
      ],
    }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        {children}
      </TRPCProvider>
    </QueryClientProvider>
  );
}

/** Human message for a failed tRPC call. */
export function errorMessage(err: unknown): string {
  if (!err) return "Something went wrong.";
  if (isNetworkError(err))
    return "You're offline. Try again when you have a connection.";
  const e = err as {
    message?: string;
    data?: {
      code?: string;
      zodError?: { fieldErrors?: Record<string, string[]> };
    };
  };
  const fieldErrors = e.data?.zodError?.fieldErrors;
  if (fieldErrors) {
    const first = Object.values(fieldErrors).flat()[0];
    if (first) return first;
  }
  if (e.data?.code === "FORBIDDEN")
    return e.message && e.message !== "FORBIDDEN"
      ? e.message
      : "You don't have permission to do that.";
  if (e.data?.code === "UNAUTHORIZED")
    return "Your session has ended. Please sign in again.";
  if (e.data?.code === "INTERNAL_SERVER_ERROR")
    return "Something went wrong on our side. It has been logged.";
  return e.message ?? "Something went wrong.";
}
