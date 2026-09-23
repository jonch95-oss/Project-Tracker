import type { Instrumentation } from "next";

export async function register() {}

/** Server errors from rendering, route handlers and proxy go to error_log. */
export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { logError } = await import("@/server/services/errors");
  await logError("request", err, {
    path: request.path,
    context: { method: request.method, routerKind: context.routerKind, routePath: context.routePath, routeType: context.routeType },
  });
};
