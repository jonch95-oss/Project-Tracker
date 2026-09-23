import { eq, sql } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { db, schema } from "@/server/db";
import { recordAudit } from "@/server/services/audit";
import { budgetDecision, drainOutbox, sendEmail, setMailerForTests, type Mailer } from "@/server/services/email";
import { backupWatchJob, tickJob } from "@/server/services/jobs";
import { runUsageCheck } from "@/server/services/usage";
import { POST as jobRoute } from "@/app/api/jobs/[job]/route";
import { callerFor, createUser } from "../support/fixtures";

describe("audit log", () => {
  let ownerId: string;
  beforeAll(async () => {
    ownerId = (await createUser("owner")).id;
  });

  it("rejects UPDATE, DELETE and TRUNCATE at the database level", async () => {
    await recordAudit(db(), { actorId: ownerId, action: "update", entityType: "test", summary: "row to tamper with" });
    const blocked = (e: unknown) => /append-only/.test(String((e as { cause?: Error }).cause?.message ?? e));
    await expect(db().execute(sql`update audit_log set summary = 'tampered'`)).rejects.toSatisfy(blocked);
    await expect(db().execute(sql`delete from audit_log`)).rejects.toSatisfy(blocked);
    await expect(db().execute(sql`truncate audit_log`)).rejects.toSatisfy(blocked);
  });

  it("keeps a valid chain under concurrent writes", async () => {
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        recordAudit(db(), { actorId: ownerId, action: "update", entityType: "test", summary: `concurrent ${i}` }),
      ),
    );
    const owner = await callerFor(ownerId);
    const result = await owner.audit.verify();
    expect(result.ok).toBe(true);
    const [dupes] = await db().execute<{ n: number }>(sql`select count(*)::int as n from (select seq from audit_log group by seq having count(*) > 1) d`).then((r) => r.rows);
    expect(dupes?.n).toBe(0);
  });

  it("detects tampering even if the trigger is bypassed", async () => {
    // Simulate a superuser disabling the trigger and editing a row.
    const client = db();
    const [original] = await client.select({ summary: schema.auditLog.summary }).from(schema.auditLog).where(eq(schema.auditLog.seq, 1));
    await client.execute(sql`alter table audit_log disable trigger audit_log_no_update`);
    try {
      await client.execute(sql`update audit_log set summary = 'rewritten history' where seq = 1`);
      const owner = await callerFor(ownerId);
      expect(await owner.audit.verify()).toMatchObject({ ok: false, brokenAtSeq: 1 });
    } finally {
      // Put the row back so later tests see an intact chain.
      await client.update(schema.auditLog).set({ summary: original!.summary }).where(eq(schema.auditLog.seq, 1));
      await client.execute(sql`alter table audit_log enable trigger audit_log_no_update`);
    }
    expect((await (await callerFor(ownerId)).audit.verify()).ok).toBe(true);
  });

  it("the audit list pages and filters", async () => {
    const owner = await callerFor(ownerId);
    const page1 = await owner.audit.list({ limit: 10 });
    expect(page1.items).toHaveLength(10);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await owner.audit.list({ limit: 10, cursor: page1.nextCursor });
    expect(page2.items[0]!.seq).toBeLessThan(page1.items[9]!.seq);
    const filtered = await owner.audit.list({ q: "concurrent 1" });
    expect(filtered.items.every((i) => i.summary.includes("concurrent 1"))).toBe(true);
  });
});

describe("email budget", () => {
  afterEach(() => setMailerForTests(null));

  it("holds non-urgent mail at 80/day and everything at 100/day", () => {
    expect(budgetDecision(79, false)).toBe("send");
    expect(budgetDecision(80, false)).toBe("hold");
    expect(budgetDecision(80, true)).toBe("send");
    expect(budgetDecision(99, true)).toBe("send");
    expect(budgetDecision(100, true)).toBe("hold");
  });

  it("critical alerts (stop-work / vacate) always send", () => {
    expect(budgetDecision(100, true, true)).toBe("send");
    expect(budgetDecision(250, false, true)).toBe("send");
  });

  it("with email on hold, records a skipped row without the body", async () => {
    const status = await sendEmail({ to: "skip@example.com", subject: "Invite", html: "<p>secret link</p>", text: "secret link", category: "invite", urgent: true });
    expect(status).toBe("skipped");
    const [row] = await db().select().from(schema.emailOutbox).where(eq(schema.emailOutbox.toAddress, "skip@example.com"));
    expect(row).toMatchObject({ status: "skipped", html: "", text: "" });
  });

  it("never drops mail: failed messages stay in the outbox and are retried", async () => {
    const failing: Mailer = { name: "test", enabled: true, send: async () => { throw new Error("provider down"); } };
    setMailerForTests(failing);
    const status = await sendEmail({ to: "x@example.com", subject: "s", html: "<p>h</p>", text: "t", category: "system", urgent: true });
    expect(status).toBe("failed");
    const rows = await db().select().from(schema.emailOutbox).where(eq(schema.emailOutbox.toAddress, "x@example.com"));
    expect(rows[0]?.status).toBe("failed");
    expect(rows[0]?.error).toContain("provider down");

    // The provider recovers: the hourly drain delivers it and removes the body.
    setMailerForTests({ name: "test", enabled: true, send: async () => ({ id: "ok" }) });
    const drained = await drainOutbox();
    expect(drained.sent).toBeGreaterThanOrEqual(1);
    const [after] = await db().select().from(schema.emailOutbox).where(eq(schema.emailOutbox.toAddress, "x@example.com"));
    expect(after).toMatchObject({ status: "sent", attempts: 2 });
    expect(after?.text).not.toContain("t\n");
    expect(after?.html).toBe("[body removed after sending]");
  });

  it("parallel sends never exceed the daily cap", async () => {
    setMailerForTests({ name: "test", enabled: true, send: async () => ({ id: "ok" }) });
    const today = new Date().toISOString().slice(0, 10);
    // Pretend 78 were already sent today.
    await db().insert(schema.emailOutbox).values(
      Array.from({ length: 78 }, (_, i) => ({ toAddress: `p${i}@example.com`, subject: "s", html: "", text: "", category: "digest" as const, status: "sent" as const, sendDate: today })),
    );
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => sendEmail({ to: `race${i}@example.com`, subject: "s", html: "h", text: "t", category: "digest", urgent: false })),
    );
    const [row] = await db().execute<{ n: number }>(sql`select count(*)::int as n from email_outbox where status = 'sent' and send_date = ${today}`).then((r) => r.rows);
    expect(row!.n).toBeLessThanOrEqual(80);
    expect(results.filter((r) => r === "held").length).toBeGreaterThan(0);
  });
});

describe("free-tier usage alerts", () => {
  it("emails the owner once when a metric passes 70%, again only on escalation", async () => {
    const sent: string[] = [];
    setMailerForTests({ name: "test", enabled: true, send: async (m) => { sent.push(m.subject); return { id: "x" }; } });
    try {
      // Simulate 1,500 GitHub Actions minutes this month (75%).
      await db().insert(schema.jobRun).values({ job: "actions:ci", trigger: "actions-report", status: "succeeded", billableMinutes: 1_500 });
      const first = await runUsageCheck();
      expect(first.alerted).toContain("actions.minutes");
      const second = await runUsageCheck();
      expect(second.alerted).not.toContain("actions.minutes");

      await db().insert(schema.jobRun).values({ job: "actions:ci", trigger: "actions-report", status: "succeeded", billableMinutes: 350 });
      const third = await runUsageCheck();
      expect(third.alerted).toContain("actions.minutes"); // now 92.5% → critical
      expect(sent.filter((s) => s.includes("free-tier"))).toHaveLength(2);
    } finally {
      setMailerForTests(null);
    }
  });

  it("the System overview reports every service", async () => {
    const owner = await callerFor((await createUser("owner")).id);
    const o = await owner.system.overview();
    const keys = o.usage.map((u) => u.key).sort();
    expect(keys).toEqual(["actions.minutes", "blob.storage", "blob.transfer", "neon.storage", "resend.daily", "resend.monthly", "vercel.credit"]);
    expect(o.usage.find((u) => u.key === "neon.storage")!.used).toBeGreaterThan(0);
  });
});

describe("job endpoints", () => {
  const req = (job: string, token?: string, body?: unknown) =>
    jobRoute(
      new Request(`http://localhost:3000/api/jobs/${job}`, {
        method: "POST",
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      }),
      { params: Promise.resolve({ job }) },
    );

  it("rejects missing or wrong secrets", async () => {
    expect((await req("usage-check")).status).toBe(401);
    expect((await req("usage-check", "wrong-secret-wrong-secret-xx")).status).toBe(401);
  });

  it("runs known jobs and records them", async () => {
    const res = await req("error-summary", process.env.CRON_SECRET);
    expect(res.status).toBe(200);
    const runs = await db().select().from(schema.jobRun).where(eq(schema.jobRun.job, "error-summary"));
    expect(runs.at(-1)?.status).toBe("succeeded");
    expect((await req("nope", process.env.CRON_SECRET)).status).toBe(404);
  });

  it("records Actions minutes reported by workflows", async () => {
    const res = await req("report-run", process.env.CRON_SECRET, { workflow: "nightly-backup", durationSeconds: 95, status: "succeeded" });
    expect(res.status).toBe(200);
    const [run] = await db().select().from(schema.jobRun).where(eq(schema.jobRun.job, "actions:nightly-backup"));
    expect(run?.billableMinutes).toBe(2);
    expect((await req("report-run", process.env.CRON_SECRET, { workflow: "x", durationSeconds: -1, status: "ok" })).status).toBe(400);
  });
});

describe("hourly tick", () => {
  it("runs daily jobs once per New York day, only after their hour", async () => {
    const before7 = new Date("2030-01-15T11:30:00Z"); // 6:30 ET
    const after7 = new Date("2030-01-15T12:30:00Z"); // 7:30 ET
    const early = await tickJob(before7);
    expect(early.ran).toEqual(["usage-check", "email-outbox"]);
    const first = await tickJob(after7);
    expect(first.ran).toContain("error-summary");
    const second = await tickJob(after7);
    expect(second.ran).not.toContain("error-summary");
  });

  it("closes runs that died mid-flight and skips an overlapping tick", async () => {
    const now = new Date("2030-01-16T12:30:00Z");
    const [stuck] = await db()
      .insert(schema.jobRun)
      .values({ job: "stuck", status: "running", startedAt: new Date(now.getTime() - 3_600_000) })
      .returning();
    const res = await tickJob(now);
    expect(res.staleRunsClosed).toBeGreaterThanOrEqual(1);
    const [after] = await db().select().from(schema.jobRun).where(eq(schema.jobRun.id, stuck!.id));
    expect(after?.status).toBe("failed");

    // Hold the tick lock from another connection: a second tick exits at once.
    const results = await Promise.all([tickJob(now), tickJob(now)]);
    expect(results.some((r) => r.skipped === "another tick is running")).toBe(true);
  });

  it("backup watch fails loudly when no nightly backup is recent", async () => {
    await expect(backupWatchJob(new Date("2031-01-01T14:00:00Z"))).rejects.toThrow(/nightly backup/);
  });

  it("records backups reported by the workflow", async () => {
    const res = await jobRoute(
      new Request("http://localhost:3000/api/jobs/record-backup", {
        method: "POST",
        headers: { authorization: `Bearer ${process.env.CRON_SECRET}`, "content-type": "application/json" },
        body: JSON.stringify({ objectKey: "backups/2030-01-15.sql.gz", sizeBytes: 123456, kind: "nightly" }),
      }),
      { params: Promise.resolve({ job: "record-backup" }) },
    );
    expect(res.status).toBe(200);
    const rows = await db().select().from(schema.backupRecord).where(eq(schema.backupRecord.objectKey, "backups/2030-01-15.sql.gz"));
    expect(rows[0]?.sizeBytes).toBe(123456);
  });
});
