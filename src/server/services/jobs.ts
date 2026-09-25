import "server-only";
import { and, count, desc, eq, gte, lt, max, sql } from "drizzle-orm";
import { formatDateTimeET, hourET, startOfDayET, todayET } from "@/core/time";
import { billableMinutes } from "@/core/freeTier";
import { db, schema } from "../db";
import { env } from "../env";
import { drainOutbox, pruneOutbox, renderEmail, sendEmail } from "./email";
import { logError } from "./errors";
import { runUsageCheck } from "./usage";
import { cleanupAbandonedUploads } from "./uploads";
import { purgeTrashJob } from "./files";
import { followUpJob, keyDateReminderJob } from "./tasks";
import { closeStalePending, dispatchPending, releaseHeld } from "./push";
import { digestJob, dueTomorrowJob, overdueNudgeJob } from "./notifications";
import { directoryReminderJob } from "./directory";
import { expiryReminderJob } from "./expiries";
import { siteLogNudgeJob } from "./field";
import { recordsSyncJob } from "./records";
import { weeklyReportJob } from "./weekly-report";

export type JobResult = Record<string, unknown>;

/** Run a job and record it in job_run. Failures are logged and re-thrown. */
export async function runJob(job: string, trigger: string, fn: () => Promise<JobResult>, now = new Date()): Promise<JobResult> {
  const conn = db();
  const started = Date.now();
  const [run] = await conn.insert(schema.jobRun).values({ job, trigger, status: "running", startedAt: now }).returning({ id: schema.jobRun.id });
  try {
    const detail = await fn();
    await conn
      .update(schema.jobRun)
      .set({ status: "succeeded", finishedAt: new Date(), durationSeconds: Math.round((Date.now() - started) / 1000), detail })
      .where(eq(schema.jobRun.id, run!.id));
    return detail;
  } catch (err) {
    await conn
      .update(schema.jobRun)
      .set({ status: "failed", finishedAt: new Date(), durationSeconds: Math.round((Date.now() - started) / 1000), error: String(err).slice(0, 2000) })
      .where(eq(schema.jobRun.id, run!.id));
    await logError("job", err, { path: job });
    throw err;
  }
}

export async function usageCheckJob(): Promise<JobResult> {
  const { alerted } = await runUsageCheck();
  return { alerted };
}

/** Daily summary of the last 24h of errors to the owner (skipped when there are none). */
export async function errorSummaryJob(): Promise<JobResult> {
  const conn = db();
  const since = new Date(Date.now() - 86_400_000);
  const groups = await conn
    .select({ fingerprint: schema.errorLog.fingerprint, message: max(schema.errorLog.message), n: count(), lastAt: max(schema.errorLog.occurredAt) })
    .from(schema.errorLog)
    .where(gte(schema.errorLog.occurredAt, since))
    .groupBy(schema.errorLog.fingerprint)
    .orderBy(desc(count()))
    .limit(15);
  if (groups.length === 0) return { errors: 0, emailed: false };

  const [owner] = await conn
    .select({ email: schema.user.email })
    .from(schema.user)
    .where(and(eq(schema.user.role, "owner"), eq(schema.user.status, "active")))
    .limit(1);
  const to = env().OWNER_ALERT_EMAIL || owner?.email;
  if (!to) return { errors: groups.length, emailed: false };

  const total = groups.reduce((a, g) => a + g.n, 0);
  const content = renderEmail({
    preheader: `${total} errors in the last 24 hours`,
    heading: "Daily error summary",
    paragraphs: [
      `${total} errors were recorded in the last 24 hours, in ${groups.length} groups:`,
      ...groups.map((g) => `${g.n}× ${g.message ?? "Unknown"} (last ${g.lastAt ? formatDateTimeET(g.lastAt) : "—"})`),
    ],
    cta: { label: "Open System page", url: `${env().APP_URL}/system` },
  });
  await sendEmail({ to, subject: `Project Command: ${total} errors in the last 24 hours`, ...content, category: "system", urgent: false });
  return { errors: groups.length, emailed: true };
}

/**
 * GitHub Actions workflows report their own runtime so the System page can
 * track the 2,000-minute monthly allowance.
 */
export async function reportActionsRun(input: { workflow: string; durationSeconds: number; status: "succeeded" | "failed" }) {
  const finished = new Date();
  await db().insert(schema.jobRun).values({
    job: `actions:${input.workflow}`,
    trigger: "actions-report",
    status: input.status,
    startedAt: new Date(finished.getTime() - input.durationSeconds * 1000),
    finishedAt: finished,
    durationSeconds: input.durationSeconds,
    billableMinutes: billableMinutes(input.durationSeconds),
  });
}

/** True if `job` already succeeded today (New York day). Keeps daily jobs idempotent. */
async function ranToday(job: string, now: Date): Promise<boolean> {
  const [row] = await db()
    .select({ n: count() })
    .from(schema.jobRun)
    .where(and(eq(schema.jobRun.job, job), eq(schema.jobRun.status, "succeeded"), gte(schema.jobRun.startedAt, startOfDayET(todayET(now)))));
  return (row?.n ?? 0) > 0;
}

/** Jobs are killed at the route's maxDuration (300s); anything "running" longer died. */
const STALE_RUN_MS = 10 * 60_000;

async function markStaleRuns(now: Date): Promise<number> {
  const res = await db()
    .update(schema.jobRun)
    .set({ status: "failed", finishedAt: now, error: "Timed out or crashed (no completion recorded)" })
    .where(and(eq(schema.jobRun.status, "running"), lt(schema.jobRun.startedAt, new Date(now.getTime() - STALE_RUN_MS))))
    .returning({ id: schema.jobRun.id });
  return res.length;
}

/**
 * Fails (and so shows red on System, and emails the owner once email is on)
 * when production has no nightly backup in the last 36 hours.
 */
export async function backupWatchJob(now = new Date()): Promise<JobResult> {
  if (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== "production") return { skipped: "not production" };
  const [latest] = await db()
    .select({ at: max(schema.backupRecord.createdAt) })
    .from(schema.backupRecord)
    .where(eq(schema.backupRecord.kind, "nightly"));
  const last = latest?.at ?? null;
  if (last && now.getTime() - last.getTime() < 36 * 3_600_000) return { lastBackup: last.toISOString() };
  const [owner] = await db()
    .select({ email: schema.user.email })
    .from(schema.user)
    .where(and(eq(schema.user.role, "owner"), eq(schema.user.status, "active")))
    .limit(1);
  const to = env().OWNER_ALERT_EMAIL || owner?.email;
  if (to) {
    const content = renderEmail({
      preheader: "The nightly database backup has not run",
      heading: "Backups have stopped",
      paragraphs: [
        last ? `The last nightly backup was recorded ${formatDateTimeET(last)}.` : "No nightly backup has ever been recorded.",
        "Check the \"Nightly backup\" workflow in GitHub Actions and its secrets.",
      ],
      cta: { label: "Open System page", url: `${env().APP_URL}/system` },
    });
    await sendEmail({ to, subject: "Project Command: backups have stopped", ...content, category: "system", urgent: true });
  }
  throw new Error(last ? `No nightly backup since ${last.toISOString()}` : "No nightly backup has been recorded yet");
}

export async function outboxJob(): Promise<JobResult> {
  const drained = await drainOutbox();
  const pruned = await pruneOutbox();
  return { ...drained, pruned };
}

/** Daily jobs and the New York hour they run at (or after, if a tick was missed). */
const DAILY: { job: string; hourET: number; fn: () => Promise<JobResult> }[] = [
  { job: "error-summary", hourET: 7, fn: errorSummaryJob },
  { job: "backup-watch", hourET: 9, fn: () => backupWatchJob() },
  { job: "task-follow-ups", hourET: 8, fn: () => followUpJob() },
  { job: "key-date-reminders", hourET: 8, fn: () => keyDateReminderJob() },
  { job: "daily-digest", hourET: 7, fn: () => digestJob() },
  { job: "due-tomorrow", hourET: 9, fn: () => dueTomorrowJob() },
  { job: "overdue-nudges", hourET: 9, fn: () => overdueNudgeJob() },
  { job: "expiry-reminders", hourET: 8, fn: () => expiryReminderJob() },
  { job: "directory-reminders", hourET: 8, fn: () => directoryReminderJob() },
  { job: "site-log-nudge", hourET: 17, fn: () => siteLogNudgeJob() },
  // Checked daily from 7am; builds only on Mondays (once per week).
  { job: "weekly-report", hourET: 7, fn: () => weeklyReportJob() },
];

/** Push: send anything the per-request dispatch missed, release quiet-hours holds, close out stale rows. */
export async function pushJob(now = new Date()): Promise<JobResult> {
  const pending = await dispatchPending(500, now);
  const held = await releaseHeld(now);
  const stale = await closeStalePending(now);
  return { ...pending, ...held, stale };
}

/** Arbitrary constant: only one tick runs at a time. */
const TICK_LOCK_ID = 7_310_204_553;

/**
 * Vercel Cron calls this once an hour (vercel.json); it runs everything that
 * is due. Each job keeps its own batch small so the tick stays well inside
 * the function time limit (maxDuration 300s on the jobs route). An
 * overlapping tick (a retry, or a slow previous run) exits immediately, so
 * daily jobs never run twice.
 */
export async function tickJob(now = new Date()): Promise<JobResult> {
  return db().transaction(async (tx) => {
    const [lock] = await tx.execute<{ ok: boolean }>(sql`select pg_try_advisory_xact_lock(${TICK_LOCK_ID}) as ok`).then((r) => r.rows);
    if (!lock?.ok) return { skipped: "another tick is running" };

    const ran: string[] = [];
    const failed: string[] = [];
    const attempt = async (job: string, fn: () => Promise<JobResult>) => {
      try {
        await runJob(job, "tick", fn, now);
        ran.push(job);
      } catch {
        failed.push(job);
      }
    };
    const stale = await markStaleRuns(now);
    await attempt("usage-check", usageCheckJob);
    await attempt("email-outbox", outboxJob);
    await attempt("upload-cleanup", () => cleanupAbandonedUploads());
    await attempt("trash-purge", () => purgeTrashJob());
    for (const d of DAILY) {
      if (hourET(now) >= d.hourET && !(await ranToday(d.job, now))) await attempt(d.job, d.fn);
    }
    // Push before the records sync, so a slow NYC Open Data can never hold up held notifications.
    await attempt("push", () => pushJob(now));
    // Public records: nightly per project (1–6am New York), failed sources retried with backoff, inside a time budget.
    await attempt("records-sync", async () => {
      try {
        return await recordsSyncJob(now, 150_000);
      } finally {
        // Record alerts (critical orders above all) go out on this tick even if a source failed.
        await dispatchPending(200, now);
      }
    });
    if (failed.length) throw new Error(`Jobs failed: ${failed.join(", ")}`);
    return { ran, staleRunsClosed: stale };
  });
}

export async function recordBackup(input: { objectKey: string; sizeBytes: number; kind: "nightly" | "restore-drill"; note?: string }) {
  await db()
    .insert(schema.backupRecord)
    .values(input)
    .onConflictDoNothing();
}
