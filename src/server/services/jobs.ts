import "server-only";
import { and, count, desc, eq, gte, max } from "drizzle-orm";
import { formatDateTimeET, hourET, startOfDayET, todayET } from "@/core/time";
import { billableMinutes } from "@/core/freeTier";
import { db, schema } from "../db";
import { env } from "../env";
import { renderEmail, sendEmail } from "./email";
import { logError } from "./errors";
import { runUsageCheck } from "./usage";

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
  const to = env().OWNER_ALERT_EMAIL ?? owner?.email;
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

/** Daily jobs and the New York hour they run at (or after, if a tick was missed). */
const DAILY: { job: string; hourET: number; fn: () => Promise<JobResult> }[] = [
  { job: "error-summary", hourET: 7, fn: errorSummaryJob },
];

/**
 * Vercel Cron calls this once an hour (vercel.json); it runs everything that
 * is due. Each job keeps its own batch small so the tick stays well inside
 * the function time limit (maxDuration 300s on the jobs route).
 */
export async function tickJob(now = new Date()): Promise<JobResult> {
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
  await attempt("usage-check", usageCheckJob);
  for (const d of DAILY) {
    if (hourET(now) >= d.hourET && !(await ranToday(d.job, now))) await attempt(d.job, d.fn);
  }
  if (failed.length) throw new Error(`Jobs failed: ${failed.join(", ")}`);
  return { ran };
}

export async function recordBackup(input: { objectKey: string; sizeBytes: number; kind: "nightly" | "restore-drill"; note?: string }) {
  await db()
    .insert(schema.backupRecord)
    .values(input)
    .onConflictDoNothing();
}
