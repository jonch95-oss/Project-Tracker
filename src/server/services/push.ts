import "server-only";
import webpush from "web-push";
import { and, asc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { channelOn, inQuietHours, safeOutsideText, type Prefs } from "@/core/notify";
import { minuteOfDayET } from "@/core/time";
import { db, schema, type DbOrTx } from "../db";
import { env } from "../env";
import { renderEmail, sendEmail } from "./email";
import { logError } from "./errors";

/**
 * Web push (brief §9): free, through each browser's own push service
 * (Apple for iPhone home-screen apps, Google for Chrome, Mozilla for
 * Firefox). A notification row is written first (in-app), then this
 * dispatcher decides its push: sent, skipped (preference off or no
 * device) or held for quiet hours and released when they end.
 */

export interface PushMessage {
  title: string;
  body: string;
  url: string;
  tag?: string;
}

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushSender {
  readonly enabled: boolean;
  /** `gone` = the device unsubscribed (the subscription should be deleted). */
  send(target: PushTarget, msg: PushMessage): Promise<{ ok: boolean; gone: boolean }>;
}

function vapidSender(): PushSender {
  const { VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey, VAPID_SUBJECT: subject } = env();
  if (!publicKey || !privateKey) return { enabled: false, send: async () => ({ ok: false, gone: false }) };
  return {
    enabled: true,
    async send(target, msg) {
      try {
        await webpush.sendNotification({ endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } }, JSON.stringify(msg), {
          vapidDetails: { subject, publicKey, privateKey },
          TTL: 24 * 3600,
          timeout: 8000,
          urgency: "normal",
        });
        return { ok: true, gone: false };
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) return { ok: false, gone: true };
        await logError("request", err, { context: { push: new URL(target.endpoint).host, status } });
        return { ok: false, gone: false };
      }
    },
  };
}

let senderOverride: PushSender | null = null;
/** Tests swap in a capturing sender. */
export function setPushSenderForTests(s: PushSender | null) {
  senderOverride = s;
}
export function pushSender(): PushSender {
  return senderOverride ?? vapidSender();
}

export function pushPublicKey(): string | null {
  return pushSender().enabled ? (env().VAPID_PUBLIC_KEY ?? (senderOverride ? "test-key" : null)) : null;
}

/** A device that failed this many times in a row (not "gone", just failing) is dropped. */
const MAX_FAILURES = 5;

/** Send to all of a person's devices. Returns how many accepted it. */
export async function pushToUser(conn: DbOrTx, userId: string, msg: PushMessage): Promise<number> {
  const sender = pushSender();
  if (!sender.enabled) return 0;
  const subs = await conn.select().from(schema.pushSubscription).where(eq(schema.pushSubscription.userId, userId));
  const safe: PushMessage = { ...msg, title: safeOutsideText(msg.title).slice(0, 120), body: safeOutsideText(msg.body).slice(0, 240) };
  let ok = 0;
  await Promise.all(
    subs.map(async (s) => {
      const r = await sender.send(s, safe);
      if (r.ok) {
        ok++;
        await conn.update(schema.pushSubscription).set({ failures: 0, lastSuccessAt: new Date() }).where(eq(schema.pushSubscription.id, s.id));
      } else if (r.gone || s.failures + 1 >= MAX_FAILURES) {
        await conn.delete(schema.pushSubscription).where(eq(schema.pushSubscription.id, s.id));
      } else {
        await conn
          .update(schema.pushSubscription)
          .set({ failures: sql`${schema.pushSubscription.failures} + 1` })
          .where(eq(schema.pushSubscription.id, s.id));
      }
    }),
  );
  return ok;
}

type Settings = { prefs: Prefs; quietStart: string | null; quietEnd: string | null; digest: boolean };
const DEFAULT_SETTINGS: Settings = { prefs: {}, quietStart: null, quietEnd: null, digest: true };

export async function settingsFor(conn: DbOrTx, userIds: string[]): Promise<Map<string, Settings>> {
  const out = new Map<string, Settings>();
  if (userIds.length === 0) return out;
  const rows = await conn.select().from(schema.notificationSettings).where(inArray(schema.notificationSettings.userId, userIds));
  for (const r of rows) out.set(r.userId, { prefs: r.prefs, quietStart: r.quietStart, quietEnd: r.quietEnd, digest: r.digest });
  for (const id of userIds) if (!out.has(id)) out.set(id, DEFAULT_SETTINGS);
  return out;
}

/** Only these events ever email (brief §3: digest, invites, resets, approvals, the third overdue nudge). */
const EMAILED_KINDS = new Set(["approval_requested"]);

/** Notifications older than this are never pushed (a stuck queue must not replay old news). */
const STALE_MS = 12 * 3600_000;

function absolute(href: string | null): string {
  return `${env().APP_URL}${href ?? "/notifications"}`;
}

/**
 * Push every pending notification: straight away, or held when the person
 * is in quiet hours. Approval requests also email (recorded as skipped
 * while email is on hold). Safe to run concurrently: rows are claimed with
 * SKIP LOCKED. Runs after each request that notifies, and on the hourly tick.
 */
export async function dispatchPending(limit = 100, now = new Date()): Promise<{ sent: number; held: number; skipped: number }> {
  const conn = db();
  const tally = { sent: 0, held: 0, skipped: 0 };
  await conn.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: schema.notification.id,
        userId: schema.notification.userId,
        kind: schema.notification.kind,
        title: schema.notification.title,
        body: schema.notification.body,
        href: schema.notification.href,
        createdAt: schema.notification.createdAt,
      })
      .from(schema.notification)
      .where(eq(schema.notification.pushState, "pending"))
      .orderBy(asc(schema.notification.createdAt))
      .limit(limit)
      .for("update", { skipLocked: true });
    if (rows.length === 0) return;
    const settings = await settingsFor(tx, [...new Set(rows.map((r) => r.userId))]);
    const withDevice = new Set(
      (await tx.selectDistinct({ u: schema.pushSubscription.userId }).from(schema.pushSubscription).where(inArray(schema.pushSubscription.userId, [...settings.keys()]))).map((r) => r.u),
    );
    const enabled = pushSender().enabled;
    const minute = minuteOfDayET(now);

    for (const r of rows) {
      const s = settings.get(r.userId)!;
      if (EMAILED_KINDS.has(r.kind) && channelOn(s.prefs, r.kind, "email")) await emailNotification(tx, r);
      let state: "sent" | "held" | "skipped";
      if (!enabled || !withDevice.has(r.userId) || !channelOn(s.prefs, r.kind, "push") || now.getTime() - r.createdAt.getTime() > STALE_MS) state = "skipped";
      else if (inQuietHours(minute, s.quietStart, s.quietEnd)) state = "held";
      else state = (await pushToUser(tx, r.userId, { title: r.title, body: r.body ?? "", url: absolute(r.href), tag: r.id })) > 0 ? "sent" : "skipped";
      tally[state]++;
      await tx
        .update(schema.notification)
        .set({ pushState: state, pushedAt: state === "sent" ? now : null })
        .where(eq(schema.notification.id, r.id));
    }
  });
  return tally;
}

/**
 * Hourly: release pushes held for quiet hours once they end. Several held
 * notifications become one summary push rather than a burst; anything read
 * in the meantime, or older than a day, is dropped.
 */
export async function releaseHeld(now = new Date()): Promise<{ released: number; dropped: number }> {
  const conn = db();
  let released = 0;
  let dropped = 0;
  await conn.transaction(async (tx) => {
    const rows = await tx
      .select({ id: schema.notification.id, userId: schema.notification.userId, title: schema.notification.title, body: schema.notification.body, href: schema.notification.href, readAt: schema.notification.readAt, createdAt: schema.notification.createdAt })
      .from(schema.notification)
      .where(eq(schema.notification.pushState, "held"))
      .orderBy(asc(schema.notification.createdAt))
      .limit(500)
      .for("update", { skipLocked: true });
    if (rows.length === 0) return;
    const settings = await settingsFor(tx, [...new Set(rows.map((r) => r.userId))]);
    const minute = minuteOfDayET(now);
    const byUser = new Map<string, typeof rows>();
    for (const r of rows) byUser.set(r.userId, [...(byUser.get(r.userId) ?? []), r]);
    for (const [userId, list] of byUser) {
      const s = settings.get(userId)!;
      if (inQuietHours(minute, s.quietStart, s.quietEnd)) continue;
      const live = list.filter((r) => !r.readAt && now.getTime() - r.createdAt.getTime() < 24 * 3600_000);
      const dead = list.filter((r) => !live.includes(r));
      if (dead.length) {
        await tx.update(schema.notification).set({ pushState: "skipped" }).where(inArray(schema.notification.id, dead.map((r) => r.id)));
        dropped += dead.length;
      }
      if (live.length === 0) continue;
      const msg: PushMessage =
        live.length === 1
          ? { title: live[0]!.title, body: live[0]!.body ?? "", url: absolute(live[0]!.href), tag: live[0]!.id }
          : { title: `${live.length} notifications while you were off`, body: live.slice(0, 3).map((r) => r.title).join(" · "), url: absolute("/notifications"), tag: "held" };
      const ok = (await pushToUser(tx, userId, msg)) > 0;
      await tx
        .update(schema.notification)
        .set({ pushState: ok ? "sent" : "skipped", pushedAt: ok ? now : null })
        .where(inArray(schema.notification.id, live.map((r) => r.id)));
      released += live.length;
    }
  });
  return { released, dropped };
}

async function emailNotification(tx: DbOrTx, r: { userId: string; title: string; body: string | null; href: string | null }) {
  const [u] = await tx.select({ email: schema.user.email }).from(schema.user).where(eq(schema.user.id, r.userId));
  if (!u) return;
  const content = renderEmail({ preheader: safeOutsideText(r.title), heading: r.title, paragraphs: r.body ? [r.body] : [], cta: { label: "Open in Project Command", url: absolute(r.href) } });
  await sendEmail({ to: u.email, subject: `Project Command: ${safeOutsideText(r.title)}`.slice(0, 200), ...content, category: "approval", urgent: true });
}

/** Old pending rows the dispatcher never reached (it runs hourly as a safety net) are closed out. */
export async function closeStalePending(now = new Date()): Promise<number> {
  const res = await db()
    .update(schema.notification)
    .set({ pushState: "skipped" })
    .where(and(eq(schema.notification.pushState, "pending"), lt(schema.notification.createdAt, new Date(now.getTime() - STALE_MS)), isNull(schema.notification.pushedAt)))
    .returning({ id: schema.notification.id });
  return res.length;
}
