import "server-only";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import {
  alertsToSend,
  evaluateUsage,
  FREE_TIER_LIMITS,
  formatUsage,
  periodKey,
  type ServiceKey,
  type UsageLevel,
  type UsageReading,
  type UsageStatus,
} from "@/core/freeTier";
import { db, schema, type Database } from "../db";
import { env } from "../env";
import { quotaDay, renderEmail, sendEmail } from "./email";

function monthStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

async function counter(conn: Database, key: string, period: string): Promise<number> {
  const [row] = await conn
    .select({ value: schema.usageCounter.value })
    .from(schema.usageCounter)
    .where(and(eq(schema.usageCounter.key, key), eq(schema.usageCounter.periodKey, period)));
  return row?.value ?? 0;
}

/** Increment a self-metered counter (e.g. R2 operations). */
export async function bumpCounter(key: ServiceKey, by = 1, now = new Date()): Promise<void> {
  const period = periodKey(FREE_TIER_LIMITS[key].period, quotaDay(now));
  await db()
    .insert(schema.usageCounter)
    .values({ key, periodKey: period, value: by })
    .onConflictDoUpdate({
      target: [schema.usageCounter.key, schema.usageCounter.periodKey],
      set: { value: sql`${schema.usageCounter.value} + ${by}`, updatedAt: new Date() },
    });
}

/** Read every free-tier metric we can measure. Unmeasurable ones return null. */
export async function readUsage(conn: Database = db(), now = new Date()): Promise<UsageStatus[]> {
  const day = quotaDay(now);
  const month = day.slice(0, 7);

  const [dbSize] = await conn.execute<{ bytes: string }>(sql`select pg_database_size(current_database())::text as bytes`).then((r) => r.rows);

  const [emails] = await conn
    .select({
      today: sql<number>`count(*) filter (where ${schema.emailOutbox.sendDate} = ${day})::int`,
      month: sql<number>`count(*) filter (where ${schema.emailOutbox.sentAt} >= ${monthStartUtc(now)})::int`,
    })
    .from(schema.emailOutbox)
    .where(inArray(schema.emailOutbox.status, ["sent"]));

  const [minutes] = await conn
    .select({ total: sql<number>`coalesce(sum(${schema.jobRun.billableMinutes}), 0)::int` })
    .from(schema.jobRun)
    .where(gte(schema.jobRun.startedAt, monthStartUtc(now)));

  // R2 holds uploaded files (metered on upload/delete) and nightly backups.
  const [backupBytes] = await conn
    .select({ total: sql<string>`coalesce(sum(${schema.backupRecord.sizeBytes}), 0)::text` })
    .from(schema.backupRecord)
    .where(eq(schema.backupRecord.kind, "nightly"));
  const fileBytes = await counter(conn, "r2.storage", "total");

  const readings: UsageReading[] = [
    { key: "neon.storage", used: dbSize ? Number(dbSize.bytes) : null },
    { key: "r2.storage", used: fileBytes + Number(backupBytes?.total ?? 0) },
    { key: "r2.classA", used: await counter(conn, "r2.classA", month) },
    { key: "r2.classB", used: await counter(conn, "r2.classB", month) },
    { key: "resend.daily", used: emails?.today ?? 0 },
    { key: "resend.monthly", used: emails?.month ?? 0 },
    { key: "actions.minutes", used: minutes?.total ?? 0 },
    // Needs a Cloudflare analytics token; shown as "Not connected" until provided.
    { key: "workers.requests", used: null },
  ];
  return readings.map(evaluateUsage);
}

/**
 * Email the owner when any metric crosses 70% (and again at 90% / 100%),
 * once per level per period. Returns what was alerted.
 */
export async function runUsageCheck(conn: Database = db(), now = new Date()) {
  const statuses = await readUsage(conn, now);
  const day = quotaDay(now);

  const alerted = await conn.select().from(schema.usageAlert);
  const last: Partial<Record<ServiceKey, UsageLevel>> = {};
  const rank = { ok: 0, warn: 1, critical: 2, exceeded: 3 } as const;
  for (const s of statuses) {
    const pk = periodKey(s.period, day);
    for (const a of alerted) {
      if (a.key === s.key && a.periodKey === pk) {
        const cur = last[s.key] ?? "ok";
        if (rank[a.level] > rank[cur]) last[s.key] = a.level;
      }
    }
  }

  const toSend = alertsToSend(statuses, last);
  if (toSend.length === 0) return { alerted: [] as ServiceKey[], statuses };

  const recipient = env().OWNER_ALERT_EMAIL ?? (await ownerEmail(conn));
  if (recipient) {
    const lines = toSend.map(
      (s) =>
        `${s.service} — ${s.metric}: ${formatUsage(s.used, s.unit)} of ${formatUsage(s.limit, s.unit)} (${((s.bps ?? 0) / 100).toFixed(0)}%).`,
    );
    const content = renderEmail({
      preheader: "A free-tier limit is getting close",
      heading: "Free-tier usage warning",
      paragraphs: [
        "One or more services Project Command runs on have passed a free-tier warning level. Nothing has been upgraded and nothing will be charged automatically by the app.",
        ...lines,
        "Open the System page for details and the recommended action.",
      ],
      cta: { label: "Open System page", url: `${env().APP_URL}/system` },
    });
    await sendEmail({ to: recipient, subject: "Project Command: free-tier usage warning", ...content, category: "system", urgent: true });
  }
  await conn
    .insert(schema.usageAlert)
    .values(
      toSend.map((s) => ({
        key: s.key,
        periodKey: periodKey(s.period, day),
        level: s.level as "warn" | "critical" | "exceeded",
        usedValue: s.used ?? 0,
      })),
    )
    .onConflictDoNothing();
  return { alerted: toSend.map((s) => s.key), statuses };
}

async function ownerEmail(conn: Database): Promise<string | null> {
  const [o] = await conn
    .select({ email: schema.user.email })
    .from(schema.user)
    .where(and(eq(schema.user.role, "owner"), eq(schema.user.status, "active")))
    .limit(1);
  return o?.email ?? null;
}
