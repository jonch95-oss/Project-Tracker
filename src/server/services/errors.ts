import "server-only";
import { sha256Hex } from "@/core/audit";
import { db, schema } from "../db";

export type ErrorSource = "trpc" | "request" | "job" | "client" | "auth";

export interface ErrorContext {
  path?: string | null;
  userId?: string | null;
  context?: Record<string, unknown>;
}

/**
 * Record an error in `error_log`. Never throws: logging must not turn one
 * failure into two. The owner receives a daily summary (jobs/error-summary).
 */
export async function logError(source: ErrorSource, error: unknown, ctx: ErrorContext = {}): Promise<void> {
  try {
    const err = error instanceof Error ? error : new Error(String(error));
    const firstFrame = err.stack?.split("\n")[1]?.trim() ?? "";
    const fingerprint = (await sha256Hex(`${source}|${err.name}|${err.message}|${firstFrame}`)).slice(0, 16);
    console.error(`[${source}] ${err.name}: ${err.message}`);
    await db()
      .insert(schema.errorLog)
      .values({
        source,
        fingerprint,
        message: `${err.name}: ${err.message}`.slice(0, 2_000),
        stack: err.stack?.slice(0, 8_000) ?? null,
        path: ctx.path ?? null,
        userId: ctx.userId ?? null,
        context: ctx.context ?? null,
      });
  } catch (loggingFailure) {
    console.error("Failed to write error_log", loggingFailure);
  }
}
