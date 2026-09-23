import { z } from "zod";
import { env } from "@/server/env";
import { errorSummaryJob, recordBackup, reportActionsRun, runJob, tickJob, usageCheckJob } from "@/server/services/jobs";

/**
 * Scheduled-job endpoints, called by GitHub Actions cron workflows with
 * `Authorization: Bearer $JOB_SECRET`. Each job is idempotent.
 */
const JOBS = {
  tick: () => tickJob(),
  "usage-check": usageCheckJob,
  "error-summary": errorSummaryJob,
} as const;

function authorized(req: Request): boolean {
  const secret = env().JOB_SECRET;
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (given.length !== secret.length) return false;
  let diff = 0;
  for (let i = 0; i < secret.length; i++) diff |= secret.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

const reportSchema = z.object({
  workflow: z.string().min(1).max(80),
  durationSeconds: z.number().int().min(0).max(6 * 3600),
  status: z.enum(["succeeded", "failed"]),
});

const backupSchema = z.object({
  objectKey: z.string().min(1).max(300),
  sizeBytes: z.number().int().min(0),
  kind: z.enum(["nightly", "restore-drill"]),
  note: z.string().max(500).optional(),
});

export async function POST(req: Request, ctx: RouteContext<"/api/jobs/[job]">) {
  if (!authorized(req)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { job } = await ctx.params;

  if (job === "report-run") {
    const parsed = reportSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: "Invalid body" }, { status: 400 });
    await reportActionsRun(parsed.data);
    return Response.json({ ok: true });
  }

  if (job === "record-backup") {
    const parsed = backupSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: "Invalid body" }, { status: 400 });
    await recordBackup(parsed.data);
    return Response.json({ ok: true });
  }

  const fn = JOBS[job as keyof typeof JOBS];
  if (!fn) return Response.json({ error: "Unknown job" }, { status: 404 });
  const trigger = req.headers.get("x-job-trigger") ?? "schedule";
  try {
    const result = await runJob(job, trigger, fn);
    return Response.json({ ok: true, result });
  } catch {
    return Response.json({ ok: false, error: "Job failed; see System page" }, { status: 500 });
  }
}
