import { and, eq, isNull } from "drizzle-orm";
import { buildCalendar } from "@/core/ics";
import { db, schema } from "@/server/db";
import { env } from "@/server/env";
import { calendarEventsFor } from "@/server/services/calendar";
import { hashToken } from "@/server/services/tokens";

/**
 * Module H: a person's calendar feed (`/api/calendar/<token>.ics`) for
 * iPhone, Google or Outlook. The token is the only credential, so the answer
 * to a bad, revoked or deactivated link is the same plain 404.
 */
export async function GET(_req: Request, ctx: RouteContext<"/api/calendar/[file]">) {
  const { file } = await ctx.params;
  const token = file.replace(/\.ics$/, "");
  if (!/^[A-Za-z0-9_-]{30,80}$/.test(token)) return new Response("Not found", { status: 404 });
  const conn = db();
  const [row] = await conn
    .select({ feed: schema.calendarFeed, user: schema.user })
    .from(schema.calendarFeed)
    .innerJoin(schema.user, eq(schema.user.id, schema.calendarFeed.userId))
    .where(and(eq(schema.calendarFeed.tokenHash, await hashToken(token)), isNull(schema.calendarFeed.revokedAt)));
  if (!row || row.user.status !== "active" || row.user.role === "investor") return new Response("Not found", { status: 404 });
  const appUrl = env().APP_URL;
  const events = await calendarEventsFor({ userId: row.user.id, role: row.user.role, status: row.user.status }, appUrl);
  // Note the fetch (at most every ten minutes), so Settings can say the feed is being read.
  if (!row.feed.lastFetchedAt || Date.now() - row.feed.lastFetchedAt.getTime() > 600_000) {
    await conn.update(schema.calendarFeed).set({ lastFetchedAt: new Date() }).where(eq(schema.calendarFeed.id, row.feed.id));
  }
  const body = buildCalendar({ name: `Project Command · ${row.user.name}`, events, stamp: new Date(), domain: new URL(appUrl).host });
  return new Response(body, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="project-command.ics"',
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex",
    },
  });
}
