import "server-only";
import { dehydrate, HydrationBoundary, QueryClient } from "@tanstack/react-query";
import { createTRPCOptionsProxy, type TRPCOptionsProxy } from "@trpc/tanstack-react-query";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import superjson from "superjson";
import { createContext } from "./init";
import { appRouter, type AppRouter } from "./root";

/**
 * Run a screen's first queries on the server and send their answers with the
 * page, so it arrives drawn (no placeholder that jumps when the data lands).
 * The client picks them up in its own query cache; a query that fails here is
 * left for the client to fetch as usual. Pages saved on the phone never carry
 * these answers (the service worker asks for the shell only).
 */
export async function Prefetch({ load, children }: { load: (trpc: TRPCOptionsProxy<AppRouter>, qc: QueryClient) => Promise<unknown>[]; children: ReactNode }) {
  const incoming = await headers();
  // The service worker saving a page for offline use asks for the shell only: no data inside it.
  if (incoming.get("x-pc-shell") === "1") return <>{children}</>;
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: false }, dehydrate: { serializeData: superjson.serialize } } });
  const h = new Headers(incoming);
  const trpc = createTRPCOptionsProxy<AppRouter>({ ctx: () => createContext({ headers: h }), router: appRouter, queryClient: qc });
  await Promise.allSettled(load(trpc, qc));
  return <HydrationBoundary state={dehydrate(qc)}>{children}</HydrationBoundary>;
}
