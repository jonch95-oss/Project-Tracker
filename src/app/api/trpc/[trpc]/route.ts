import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { allowedOrigins } from "@/server/env";
import { createContext } from "@/server/trpc/init";
import { appRouter } from "@/server/trpc/root";

/**
 * CSRF: every mutation must come from our own origin. Browsers always send
 * Origin on cross-site POSTs, so a missing or foreign Origin is rejected.
 */
function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return req.headers.get("sec-fetch-site") === "same-origin";
  return allowedOrigins().includes(origin);
}

function handler(req: Request) {
  if (req.method !== "GET" && !sameOrigin(req)) {
    return new Response(JSON.stringify({ error: "Cross-origin request blocked" }), {
      status: 403,
      headers: { "content-type": "application/json" },
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
