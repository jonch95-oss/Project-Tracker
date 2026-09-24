import { TRPCError } from "@trpc/server";
import { and, desc, eq, notInArray } from "drizzle-orm";
import { z } from "zod";
import { isHHMM, NOTIFY_EVENTS } from "@/core/notify";
import { schema } from "../../db";
import { emailEnabled } from "../../services/email";
import { pushPublicKey, pushToUser } from "../../services/push";
import { protectedProcedure, router } from "../init";

const KINDS = NOTIFY_EVENTS.map((e) => e.kind) as [string, ...string[]];
const hhmm = z.string().refine(isHHMM, "Use a time like 21:00");

/** Preferences (brief §9): push and email per event, quiet hours, the daily digest. In-app is always on. */
export const notifySettingsRouter = router({
  get: protectedProcedure.query(async ({ ctx }) => {
    const [row] = await ctx.db.select().from(schema.notificationSettings).where(eq(schema.notificationSettings.userId, ctx.actor.userId));
    return {
      prefs: row?.prefs ?? {},
      quietStart: row?.quietStart ?? null,
      quietEnd: row?.quietEnd ?? null,
      digest: row?.digest ?? true,
      events: NOTIFY_EVENTS,
      emailOn: emailEnabled(),
    };
  }),

  save: protectedProcedure
    .input(
      z.object({
        prefs: z.partialRecord(z.enum(KINDS), z.object({ push: z.boolean().optional(), email: z.boolean().optional() })),
        quietStart: hhmm.nullable(),
        quietEnd: hhmm.nullable(),
        digest: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if ((input.quietStart === null) !== (input.quietEnd === null)) throw new TRPCError({ code: "BAD_REQUEST", message: "Set both ends of quiet hours, or neither." });
      if (input.quietStart && input.quietStart === input.quietEnd) throw new TRPCError({ code: "BAD_REQUEST", message: "Quiet hours need different start and end times." });
      // Email only exists for the events the brief emails (digest, approvals, the third overdue nudge).
      const prefs = Object.fromEntries(
        Object.entries(input.prefs).map(([k, v]) => {
          const emails = NOTIFY_EVENTS.find((e) => e.kind === k)?.email;
          return [k, { ...(v.push !== undefined ? { push: v.push } : {}), ...(emails && v.email !== undefined ? { email: v.email } : {}) }];
        }),
      );
      const values = { prefs, quietStart: input.quietStart, quietEnd: input.quietEnd, digest: input.digest };
      await ctx.db
        .insert(schema.notificationSettings)
        .values({ userId: ctx.actor.userId, ...values })
        .onConflictDoUpdate({ target: schema.notificationSettings.userId, set: { ...values, updatedAt: new Date() } });
      return { ok: true };
    }),
});

/** Browsers that accept push only from the big push services: the server never posts anywhere else. */
const PUSH_HOSTS = [/\.push\.apple\.com$/, /^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /\.push\.services\.mozilla\.com$/, /^updates\.push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/];
const pushEndpoint = z
  .url()
  .max(1000)
  .refine((u) => {
    const url = new URL(u);
    return url.protocol === "https:" && PUSH_HOSTS.some((h) => h.test(url.hostname));
  }, "Not a browser push service");
const b64url = z.string().min(8).max(200).regex(/^[A-Za-z0-9_-]+=*$/);

/** Enough devices for a phone, a laptop and a few spares; the oldest drop off beyond this. */
const MAX_DEVICES = 10;

export const pushRouter = router({
  /** The public key browsers need to subscribe; null when push isn't configured. */
  config: protectedProcedure.query(() => ({ publicKey: pushPublicKey() })),

  devices: protectedProcedure.query(async ({ ctx }) =>
    ctx.db
      .select({ id: schema.pushSubscription.id, label: schema.pushSubscription.label, createdAt: schema.pushSubscription.createdAt, lastSuccessAt: schema.pushSubscription.lastSuccessAt, endpoint: schema.pushSubscription.endpoint })
      .from(schema.pushSubscription)
      .where(eq(schema.pushSubscription.userId, ctx.actor.userId))
      .orderBy(desc(schema.pushSubscription.createdAt)),
  ),

  /**
   * Register this browser. A device that was someone else's (a shared
   * laptop, a sign-out without unsubscribing) moves to whoever signs in.
   */
  subscribe: protectedProcedure
    .input(z.object({ endpoint: pushEndpoint, keys: z.object({ p256dh: b64url, auth: b64url }), label: z.string().trim().max(60).optional() }))
    .mutation(async ({ ctx, input }) => {
      const values = { userId: ctx.actor.userId, endpoint: input.endpoint, p256dh: input.keys.p256dh, auth: input.keys.auth, label: input.label || null, failures: 0 };
      await ctx.db.insert(schema.pushSubscription).values(values).onConflictDoUpdate({ target: schema.pushSubscription.endpoint, set: values });
      const keep = await ctx.db
        .select({ id: schema.pushSubscription.id })
        .from(schema.pushSubscription)
        .where(eq(schema.pushSubscription.userId, ctx.actor.userId))
        .orderBy(desc(schema.pushSubscription.createdAt))
        .limit(MAX_DEVICES);
      await ctx.db.delete(schema.pushSubscription).where(and(eq(schema.pushSubscription.userId, ctx.actor.userId), notInArray(schema.pushSubscription.id, keep.map((k) => k.id))));
      return { ok: true };
    }),

  /** This browser stops (turning push off, or signing out). */
  unsubscribe: protectedProcedure.input(z.object({ endpoint: z.string().max(1000) })).mutation(async ({ ctx, input }) => {
    await ctx.db.delete(schema.pushSubscription).where(and(eq(schema.pushSubscription.userId, ctx.actor.userId), eq(schema.pushSubscription.endpoint, input.endpoint)));
    return { ok: true };
  }),

  removeDevice: protectedProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    await ctx.db.delete(schema.pushSubscription).where(and(eq(schema.pushSubscription.userId, ctx.actor.userId), eq(schema.pushSubscription.id, input.id)));
    return { ok: true };
  }),

  /** Send a test push to this person's devices. */
  test: protectedProcedure.mutation(async ({ ctx }) => {
    const n = await pushToUser(ctx.db, ctx.actor.userId, { title: "Project Command", body: "Push notifications are working on this device.", url: "/settings", tag: "test" });
    if (n === 0) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "No device accepted the test. Turn notifications on for this device first." });
    return { devices: n };
  }),
});
