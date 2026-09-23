import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { EMAIL_DAILY_SOFT_CAP, FREE_TIER_LIMITS } from "@/core/freeTier";
import { db, schema, type DbOrTx } from "../db";
import { env } from "../env";
import { logError } from "./errors";

export type EmailCategory = (typeof schema.EMAIL_CATEGORIES)[number];

export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
  category: EmailCategory;
  /** Urgent mail may use the budget above the soft cap (invites, resets, approvals). */
  urgent: boolean;
}

export interface Mailer {
  readonly name: string;
  send(msg: { from: string; to: string; subject: string; html: string; text: string }): Promise<{ id: string }>;
}

/** Development / test adapter: prints the message; the outbox row is the record. */
export const consoleMailer: Mailer = {
  name: "console",
  async send(msg) {
    if (env().NODE_ENV !== "test") {
      console.info(`\n[email:console] to=${msg.to} subject="${msg.subject}"\n${msg.text}\n`);
    }
    return { id: `console-${crypto.randomUUID()}` };
  },
};

export function resendMailer(apiKey: string): Mailer {
  return {
    name: "resend",
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
  return key ? resendMailer(key) : consoleMailer;
}

/** Resend's daily quota resets at midnight UTC, so the budget day is the UTC date. */
export function quotaDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Emails that already count against today's Resend quota (one recipient each). */
export async function emailsCountedToday(conn: DbOrTx = db(), today = quotaDay()): Promise<number> {
  const [row] = await conn
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.emailOutbox)
    .where(and(eq(schema.emailOutbox.sendDate, today), inArray(schema.emailOutbox.status, ["sent"])));
  return row?.n ?? 0;
}

export type BudgetDecision = "send" | "hold";

/**
 * Resend's free plan allows 100 emails/day. Non-urgent mail stops at the soft
 * cap (80) and is held for the next digest; urgent mail may use the rest.
 * Nothing is ever dropped: held mail stays in the outbox, visible on System.
 */
export function budgetDecision(sentToday: number, urgent: boolean): BudgetDecision {
  const hardCap = FREE_TIER_LIMITS["resend.daily"].limit;
  if (sentToday >= hardCap) return "hold";
  if (!urgent && sentToday >= EMAIL_DAILY_SOFT_CAP) return "hold";
  return "send";
}

/** Queue and (budget permitting) send one email. Returns the outbox status. */
export async function sendEmail(msg: OutgoingEmail): Promise<"sent" | "held" | "failed"> {
  const today = quotaDay();
  const conn = db();
  const [row] = await conn
    .insert(schema.emailOutbox)
    .values({
      toAddress: msg.to,
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
      category: msg.category,
      urgent: msg.urgent,
      status: "queued",
    })
    .returning({ id: schema.emailOutbox.id });
  const id = row!.id;

  const decision = budgetDecision(await emailsCountedToday(conn, today), msg.urgent);
  if (decision === "hold") {
    await conn
      .update(schema.emailOutbox)
      .set({ status: "held", error: "Daily email budget reached; held for next send window" })
      .where(eq(schema.emailOutbox.id, id));
    return "held";
  }

  try {
    const result = await mailer().send({
      from: env().EMAIL_FROM,
      to: msg.to,
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
    });
    await conn
      .update(schema.emailOutbox)
      .set({ status: "sent", sendDate: today, sentAt: new Date(), providerId: result.id, attempts: 1 })
      .where(eq(schema.emailOutbox.id, id));
    return "sent";
  } catch (err) {
    await conn
      .update(schema.emailOutbox)
      .set({ status: "failed", error: String(err).slice(0, 1000), attempts: 1 })
      .where(eq(schema.emailOutbox.id, id));
    await logError("request", err, { context: { emailId: id, category: msg.category } });
    return "failed";
  }
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
