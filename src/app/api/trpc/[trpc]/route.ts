import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { after } from "next/server";
import { allowedOrigins } from "@/server/env";
import { createContext } from "@/server/trpc/init";
import { appRouter } from "@/server/trpc/root";
import { dispatchPending } from "@/server/services/push";
import { takePushDirty } from "@/server/services/tasks";
import { syncProjectRecords, takeSnapshotQueue } from "@/server/services/records";
import { logError } from "@/server/services/errors";

/**
 * CSRF: every mutation must come from our own origin. Browsers always send
 * Origin on cross-site POSTs, so a missing or foreign Origin is rejected.
 */
function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return req.headers.get("sec-fetch-site") === "same-origin";
  return allowedOrigins().includes(origin);
}

/** Room after the response for a first public-records snapshot (each capped at 50 seconds). */
export const maxDuration = 120;

function handler(req: Request) {
  if (req.method !== "GET" && !sameOrigin(req)) {
    return new Response(JSON.stringify({ error: "Cross-origin request blocked" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }
  // Push whatever this request notified, once the response is on its way (the hourly tick is the safety net).
  if (req.method === "POST") {
    after(async () => {
      if (takePushDirty()) await dispatchPending().catch((err) => logError("request", err, { path: "push-dispatch" }));
      // A project that just got a lot pulls its first public-records snapshot now (Module A); the nightly run is the safety net.
      for (const id of takeSnapshotQueue()) await syncProjectRecords(id, { deadline: Date.now() + 50_000 }).catch((err) => logError("request", err, { path: "records-first-snapshot" }));
    });
  }
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    createContext: () => createContext({ headers: req.headers }),
  });
}

export { handler as GET, handler as POST };
