"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient, httpBatchLink, loggerLink } from "@trpc/client";
import { createTRPCContext } from "@trpc/tanstack-react-query";
import type { inferRouterOutputs } from "@trpc/server";
import { useState, type ReactNode } from "react";
import superjson from "superjson";
import type { AppRouter } from "@/server/trpc/root";

export const { TRPCProvider, useTRPC, useTRPCClient } = createTRPCContext<AppRouter>();
export type RouterOutputs = inferRouterOutputs<AppRouter>;

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        // Neon's free plan can take a few seconds to wake; retry once.
        retry: (count, err) => count < 1 && !/UNAUTHORIZED|FORBIDDEN|NOT_FOUND/.test(String((err as { data?: { code?: string } })?.data?.code)),
        refetchOnWindowFocus: true,
      },
    },
  });
}

export function TRPCReactProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(makeQueryClient);
  const [trpcClient] = useState(() =>
    createTRPCClient<AppRouter>({
      links: [
        loggerLink({ enabled: (op) => process.env.NODE_ENV === "development" && op.direction === "down" && op.result instanceof Error }),
        httpBatchLink({ url: "/api/trpc", transformer: superjson }),
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
  const e = err as { message?: string; data?: { code?: string; zodError?: { fieldErrors?: Record<string, string[]> } } };
  const fieldErrors = e.data?.zodError?.fieldErrors;
  if (fieldErrors) {
    const first = Object.values(fieldErrors).flat()[0];
    if (first) return first;
  }
  if (e.data?.code === "FORBIDDEN") return e.message && e.message !== "FORBIDDEN" ? e.message : "You don't have permission to do that.";
  if (e.data?.code === "UNAUTHORIZED") return "Your session has ended. Please sign in again.";
  if (e.data?.code === "INTERNAL_SERVER_ERROR") return "Something went wrong on our side. It has been logged.";
  return e.message ?? "Something went wrong.";
}
