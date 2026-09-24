import "server-only";
import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import { EMAIL_DAILY_SOFT_CAP, FREE_TIER_LIMITS } from "@/core/freeTier";
import { db, schema, type DbOrTx } from "../db";
import { env } from "../env";
import { logError } from "./errors";

export type EmailCategory = (typeof schema.EMAIL_CATEGORIES)[number];
export type EmailStatus = "sent" | "held" | "failed" | "skipped";

export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
  category: EmailCategory;
  /** Urgent mail may use the budget above the soft cap (invites, resets, approvals, critical alerts). */
  urgent: boolean;
  /** Critical alerts (stop-work / vacate orders) always send, whatever the soft cap. */
  critical?: boolean;
}

/**
 * Email port. Email is on hold until the owner chooses a sender (brief §3);
 * the default adapter is a no-op, and invites and resets are shared as
 * on-screen links instead. A Resend adapter is ready for when a sender exists.
 */
export interface Mailer {
  readonly name: "noop" | "console" | "resend" | "test";
  readonly enabled: boolean;
  send(msg: { from: string; to: string; subject: string; html: string; text: string }): Promise<{ id: string }>;
}

/** Production default while email is on hold: sends nothing, logs nothing. */
export const noopMailer: Mailer = {
  name: "noop",
  enabled: false,
  async send() {
    throw new Error("Email is not configured");
  },
};

/** Local development only: prints the message so links can be followed. Never used in production. */
export const consoleMailer: Mailer = {
  name: "console",
  enabled: true,
  async send(msg) {
    console.info(`\n[email:console] to=${msg.to} subject="${msg.subject}"\n${msg.text}\n`);
    return { id: `console-${crypto.randomUUID()}` };
  },
};

export function resendMailer(apiKey: string): Mailer {
  return {
    name: "resend",
    enabled: true,
    async send(msg) {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: msg.from, to: [msg.to], subject: msg.subject, html: msg.html, text: msg.text }),
      });
      if (!res.ok) {
        throw new Error(`Resend responded ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      const body = (await res.json()) as { id?: string };
      return { id: body.id ?? "unknown" };
    },
  };
}

let mailerOverride: Mailer | null = null;
/** Tests swap in a capturing mailer. */
export function setMailerForTests(m: Mailer | null) {
  mailerOverride = m;
}

export function mailer(): Mailer {
  if (mailerOverride) return mailerOverride;
  const key = env().RESEND_API_KEY;
  if (key) return resendMailer(key);
  return env().NODE_ENV === "development" ? consoleMailer : noopMailer;
}

/** True when a real sender is configured (the app then offers email delivery). */
export function emailEnabled(): boolean {
  const m = mailer();
  return m.enabled && m.name !== "console";
}

/** Resend's daily quota resets at midnight UTC, so the budget day is the UTC date. */
export function quotaDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Emails that already count against today's quota (one recipient each). */
export async function emailsCountedToday(conn: DbOrTx = db(), today = quotaDay()): Promise<number> {
  const [row] = await conn
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.emailOutbox)
    .where(and(eq(schema.emailOutbox.sendDate, today), inArray(schema.emailOutbox.status, ["sent"])));
  return row?.n ?? 0;
}

export type BudgetDecision = "send" | "hold";

/**
 * 100 emails per UTC day. Non-urgent mail stops at the soft cap (80) and is
 * held for the next digest; urgent mail may use the rest; critical alerts
 * (stop-work / vacate) always go. Nothing is dropped: held mail stays in the
 * outbox and is retried by the hourly tick.
 */
export function budgetDecision(sentToday: number, urgent: boolean, critical = false): BudgetDecision {
  if (critical) return "send";
  const hardCap = FREE_TIER_LIMITS["resend.daily"].limit;
  if (sentToday >= hardCap) return "hold";
  if (!urgent && sentToday >= EMAIL_DAILY_SOFT_CAP) return "hold";
  return "send";
}

/** Arbitrary constant for the send-serialization advisory lock. */
const EMAIL_LOCK_ID = 7_310_204_552;
const REDACTED = "[body removed after sending]";

async function deliver(id: string, msg: OutgoingEmail): Promise<EmailStatus> {
  const conn = db();
  const today = quotaDay();
  // Serialize the budget check and the send so parallel sends cannot overshoot the cap.
  return conn.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${EMAIL_LOCK_ID})`);
    if (budgetDecision(await emailsCountedToday(tx, today), msg.urgent, msg.critical) === "hold") {
      await tx
        .update(schema.emailOutbox)
        .set({ status: "held", error: "Daily email budget reached (UTC day); retried after midnight UTC" })
        .where(eq(schema.emailOutbox.id, id));
      return "held";
    }
    try {
      const result = await mailer().send({ from: env().EMAIL_FROM, to: msg.to, subject: msg.subject, html: msg.html, text: msg.text });
      // Bodies can contain live invite / reset links: never keep them after sending.
      await tx
        .update(schema.emailOutbox)
        .set({ status: "sent", sendDate: today, sentAt: new Date(), providerId: result.id, error: null, html: REDACTED, text: REDACTED, attempts: sql`${schema.emailOutbox.attempts} + 1` })
        .where(eq(schema.emailOutbox.id, id));
      return "sent";
    } catch (err) {
      await tx
        .update(schema.emailOutbox)
        .set({ status: "failed", error: String(err).slice(0, 1000), attempts: sql`${schema.emailOutbox.attempts} + 1` })
        .where(eq(schema.emailOutbox.id, id));
      await logError("request", err, { context: { emailId: id, category: msg.category } });
      return "failed";
    }
  });
}

/**
 * Queue and (budget permitting) send one email. With no sender configured
 * the message is recorded as "skipped" — recipient, subject and category
 * only, never the body — so nothing disappears silently and no live links
 * are stored.
 */
export async function sendEmail(msg: OutgoingEmail): Promise<EmailStatus> {
  const m = mailer();
  if (!m.enabled) {
    await db().insert(schema.emailOutbox).values({
      toAddress: msg.to,
      subject: msg.subject,
      html: "",
      text: "",
      category: msg.category,
      urgent: msg.urgent,
      critical: msg.critical ?? false,
      status: "skipped",
      error: "Email is on hold (no sender configured)",
    });
    return "skipped";
  }
  const [row] = await db()
    .insert(schema.emailOutbox)
    .values({ toAddress: msg.to, subject: msg.subject, html: msg.html, text: msg.text, category: msg.category, urgent: msg.urgent, critical: msg.critical ?? false, status: "queued" })
    .returning({ id: schema.emailOutbox.id });
  return deliver(row!.id, msg);
}

/**
 * Hourly: retry held mail (after the UTC day rolls over) and failed mail
 * (up to 5 attempts), urgent first, oldest first. Batched to stay well inside
 * the function time limit.
 */
export async function drainOutbox(limit = 25): Promise<{ attempted: number; sent: number }> {
  if (!mailer().enabled) return { attempted: 0, sent: 0 };
  const conn = db();
  const rows = await conn
    .select()
    .from(schema.emailOutbox)
    .where(
      sql`(${schema.emailOutbox.status} = 'held' and ${schema.emailOutbox.createdAt} < ${new Date(`${quotaDay()}T00:00:00.000Z`)})
        or (${schema.emailOutbox.status} = 'failed' and ${schema.emailOutbox.attempts} < 5)
        or (${schema.emailOutbox.status} = 'held' and ${schema.emailOutbox.urgent} = true)`,
    )
    .orderBy(sql`${schema.emailOutbox.critical} desc`, sql`${schema.emailOutbox.urgent} desc`, asc(schema.emailOutbox.createdAt))
    .limit(limit);
  let sent = 0;
  for (const r of rows) {
    const status = await deliver(r.id, { to: r.toAddress, subject: r.subject, html: r.html, text: r.text, category: r.category, urgent: r.urgent, critical: r.critical });
    if (status === "sent") sent++;
    if (status === "held") break; // budget reached; try again next hour
  }
  return { attempted: rows.length, sent };
}

/** Rows older than 30 days are pruned; bodies of unsent rows go with them. */
export async function pruneOutbox(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - 30 * 86_400_000);
  const res = await db()
    .delete(schema.emailOutbox)
    .where(and(lt(schema.emailOutbox.createdAt, cutoff), inArray(schema.emailOutbox.status, ["sent", "skipped"])))
    .returning({ id: schema.emailOutbox.id });
  return res.length;
}

/* ------------------------------------------------------------------ */
/* Templates                                                           */
/* ------------------------------------------------------------------ */

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export interface EmailContent {
  preheader: string;
  heading: string;
  paragraphs: string[];
  cta?: { label: string; url: string };
  footnote?: string;
}

/** Quiet, typographic HTML email in the house palette. All inputs are escaped. */
export function renderEmail(c: EmailContent): { html: string; text: string } {
  const paragraphs = c.paragraphs
    .map((p) => `<p style="margin:0 0 16px;font:15px/1.6 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1D1B18">${esc(p)}</p>`)
    .join("");
  const cta = c.cta
    ? `<p style="margin:24px 0 8px"><a href="${esc(c.cta.url)}" style="display:inline-block;background:#1D1B18;color:#FBFAF7;text-decoration:none;padding:12px 20px;border-radius:8px;font:500 14px -apple-system,Segoe UI,Helvetica,Arial,sans-serif">${esc(c.cta.label)}</a></p>
       <p style="margin:0 0 16px;font:12px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#6B645A">Or paste this link into your browser:<br>${esc(c.cta.url)}</p>`
    : "";
  const foot = c.footnote
    ? `<p style="margin:24px 0 0;font:12px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#6B645A">${esc(c.footnote)}</p>`
    : "";
  const html = `<!doctype html><html><body style="margin:0;background:#F5F2EC">
<span style="display:none;max-height:0;overflow:hidden">${esc(c.preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F2EC;padding:40px 16px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FBFAF7;border:1px solid #E4DDD1;border-radius:16px">
<tr><td style="padding:40px 40px 8px;font:13px -apple-system,Segoe UI,Helvetica,Arial,sans-serif;letter-spacing:.12em;text-transform:uppercase;color:#8A6A45">Project Command</td></tr>
<tr><td style="padding:8px 40px 0"><h1 style="margin:0 0 24px;font:400 30px/1.2 Georgia,'Times New Roman',serif;color:#1D1B18">${esc(c.heading)}</h1>${paragraphs}${cta}${foot}</td></tr>
<tr><td style="padding:24px 40px 40px"></td></tr>
</table></td></tr></table></body></html>`;
  const text = [
    c.heading,
    "",
    ...c.paragraphs.flatMap((p) => [p, ""]),
    ...(c.cta ? [`${c.cta.label}: ${c.cta.url}`, ""] : []),
    ...(c.footnote ? [c.footnote] : []),
  ].join("\n");
  return { html, text };
}
