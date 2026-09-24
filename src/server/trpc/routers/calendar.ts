import { TRPCError } from "@trpc/server";
import { and, eq, isNull, sql } from "drizzle-orm";
import { schema } from "../../db";
import { env } from "../../env";
import { recordAudit } from "../../services/audit";
import { generateToken, hashToken } from "../../services/tokens";
import { protectedProcedure, router, type AuthedContext } from "../init";

function feedUser(ctx: AuthedContext) {
  // Investors and lenders follow their portal; they have no tasks or dates to subscribe to.
  if (ctx.actor.role === "investor")
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "The calendar feed is for the project team and collaborators.",
    });
}

/** Module H: each person's private, revocable calendar link (only its hash is stored). */
export const calendarRouter = router({
  status: protectedProcedure.query(async ({ ctx }) => {
    feedUser(ctx);
    const [f] = await ctx.db
      .select()
      .from(schema.calendarFeed)
      .where(
        and(
          eq(schema.calendarFeed.userId, ctx.viewer.id),
          isNull(schema.calendarFeed.revokedAt),
        ),
      );
    return f
      ? {
          active: true as const,
          createdAt: f.createdAt,
          lastFetchedAt: f.lastFetchedAt,
        }
      : { active: false as const };
  }),

  /** A new link (any older one stops working). The link is shown once; after that, make a new one. */
  create: protectedProcedure.mutation(async ({ ctx }) => {
    feedUser(ctx);
    const token = generateToken();
    await ctx.db.transaction(async (tx) => {
      // One live link per person: two quick taps take turns rather than both leaving a link live.
      await tx.execute(
        sql`select 1 from "user" where id = ${ctx.viewer.id} for update`,
      );
      await tx
        .update(schema.calendarFeed)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(schema.calendarFeed.userId, ctx.viewer.id),
            isNull(schema.calendarFeed.revokedAt),
          ),
        );
      await tx
        .insert(schema.calendarFeed)
        .values({ userId: ctx.viewer.id, tokenHash: await hashToken(token) });
      await recordAudit(tx, {
        actorId: ctx.viewer.id,
        actorName: ctx.viewer.name,
        action: "create",
        entityType: "calendar_feed",
        entityId: ctx.viewer.id,
        summary: `${ctx.viewer.name} made a new calendar feed link`,
        ip: ctx.ip,
      });
    });
    const url = `${env().APP_URL}/api/calendar/${token}.ics`;
    return { url, webcal: url.replace(/^https?:/, "webcal:") };
  }),

  revoke: protectedProcedure.mutation(async ({ ctx }) => {
    await ctx.db
      .update(schema.calendarFeed)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(schema.calendarFeed.userId, ctx.viewer.id),
          isNull(schema.calendarFeed.revokedAt),
        ),
      );
    await recordAudit(ctx.db, {
      actorId: ctx.viewer.id,
      actorName: ctx.viewer.name,
      action: "delete",
      entityType: "calendar_feed",
      entityId: ctx.viewer.id,
      summary: `${ctx.viewer.name} turned off their calendar feed`,
      ip: ctx.ip,
    });
    return { ok: true };
  }),
});
