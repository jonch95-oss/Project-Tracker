/**
 * Module I: email into a project. Pure helpers for the inbound webhook:
 * per-project addresses, sender parsing, webhook signatures (the Svix scheme
 * Resend uses) and the provider payload.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** Attachments bigger than this are skipped (and listed as skipped in the saved email). */
export const MAX_INBOUND_ATTACHMENT_BYTES = 25 * 1024 * 1024;
/** At most this many attachments are saved from one message. */
export const MAX_INBOUND_ATTACHMENTS = 20;
/** The largest webhook body the route reads (attachments arrive base64-encoded). */
export const MAX_INBOUND_BODY_BYTES = 40 * 1024 * 1024;
/** Signed webhooks older or newer than this are refused (replay window). */
export const SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;
/** The folder inbound attachments land in, to be filed. */
export const INBOX_FOLDER = "Inbox";

const KEY_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/**
 * A project's inbound local part: the street number and name from its
 * address (or its name), plus four random characters so addresses can't be
 * guessed from the address alone, e.g. "347-myrtle-k3f9".
 */
export function inboundKeyFor(
  address: string,
  name: string,
  random: Uint8Array,
): string {
  const words = (s: string) =>
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9 ]+/g, " ")
      .split(/\s+/)
      .filter(
        (w) =>
          w &&
          ![
            "ave",
            "avenue",
            "st",
            "street",
            "rd",
            "road",
            "pl",
            "place",
            "blvd",
            "the",
            "unit",
            "apt",
            "brooklyn",
            "ny",
          ].includes(w),
      );
  const from = words(address.split(",")[0] ?? "").slice(0, 2);
  const base =
    (from.length ? from : words(name).slice(0, 2)).join("-").slice(0, 30) ||
    "project";
  const suffix = [...random.slice(0, 4)]
    .map((b) => KEY_ALPHABET[b % KEY_ALPHABET.length])
    .join("");
  return `${base}-${suffix}`;
}

/** The bare, lower-case email address from `Name <a@b.c>` or `a@b.c`; null when there isn't one. */
export function emailAddressOf(value: string): string | null {
  const angle = /<([^<>\s]+@[^<>\s]+)>/.exec(value);
  const raw = (angle?.[1] ?? value).trim().toLowerCase();
  return /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/.test(raw) ? raw : null;
}

/** The project key a recipient address points at, when it's on our inbound domain. */
export function inboundKeyFromRecipient(
  recipient: string,
  domain: string,
): string | null {
  const email = emailAddressOf(recipient);
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (email.slice(at + 1) !== domain.toLowerCase()) return null;
  const local = email.slice(0, at).split("+")[0]!;
  return /^[a-z0-9-]{3,40}$/.test(local) ? local : null;
}

/**
 * Verify a Svix-signed webhook (Resend's scheme): HMAC-SHA256 of
 * `${id}.${timestamp}.${body}` keyed with the base64 secret after "whsec_",
 * matched against any "v1,<base64>" signature in the header, with the
 * timestamp inside the replay window.
 */
export function verifyWebhookSignature(
  secret: string,
  headers: {
    id: string | null;
    timestamp: string | null;
    signature: string | null;
  },
  body: string,
  now = Date.now(),
): boolean {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature || !/^\d{1,12}$/.test(timestamp))
    return false;
  if (Math.abs(now - Number(timestamp) * 1000) > SIGNATURE_TOLERANCE_MS)
    return false;
  let key: Buffer;
  try {
    key = Buffer.from(
      secret.startsWith("whsec_") ? secret.slice(6) : secret,
      "base64",
    );
  } catch {
    return false;
  }
  if (!key.length) return false;
  const expected = createHmac("sha256", key)
    .update(`${id}.${timestamp}.${body}`)
    .digest();
  for (const part of signature.split(" ")) {
    const [version, sig] = part.split(",");
    if (version !== "v1" || !sig) continue;
    const given = Buffer.from(sig, "base64");
    if (given.length === expected.length && timingSafeEqual(given, expected))
      return true;
  }
  return false;
}

/** Sign a body the way the provider does (tests and local tooling). */
export function signWebhook(
  secret: string,
  id: string,
  timestamp: number,
  body: string,
): string {
  const key = Buffer.from(
    secret.startsWith("whsec_") ? secret.slice(6) : secret,
    "base64",
  );
  return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

export interface InboundAttachment {
  filename: string;
  contentType: string;
  /** Decoded bytes; null when the provider didn't include the content. */
  content: Uint8Array | null;
}

export interface InboundMessage {
  providerId: string;
  from: string;
  to: string[];
  subject: string;
  text: string;
  attachments: InboundAttachment[];
}

type Json = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const list = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string")
    : typeof v === "string"
      ? v.split(",")
      : [];

/** Rough plain text from an HTML-only message. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The message from the provider's `email.received` webhook. Accepts the
 * event envelope ({ type, data }) or the bare message. Returns null when the
 * payload isn't an inbound email.
 */
export function parseInboundPayload(
  payload: unknown,
  deliveryId: string,
): InboundMessage | null {
  if (!payload || typeof payload !== "object") return null;
  const outer = payload as Json;
  if (
    outer.type !== undefined &&
    outer.type !== "email.received" &&
    outer.type !== "inbound.email"
  )
    return null;
  const d = (
    outer.data && typeof outer.data === "object" ? outer.data : outer
  ) as Json;
  const from = str(d.from) || str((d.from as Json | undefined)?.email);
  const to = list(d.to);
  if (!from || !to.length) return null;
  const attachments = (
    Array.isArray(d.attachments) ? d.attachments : []
  ).flatMap((a): InboundAttachment[] => {
    if (!a || typeof a !== "object") return [];
    const x = a as Json;
    const b64 = str(x.content) || str(x.content_base64);
    let content: Uint8Array | null = null;
    if (b64) {
      const buf = Buffer.from(b64, "base64");
      content = buf.length ? new Uint8Array(buf) : null;
    }
    return [
      {
        filename: str(x.filename) || str(x.name) || "attachment",
        contentType:
          str(x.content_type) ||
          str(x.contentType) ||
          "application/octet-stream",
        content,
      },
    ];
  });
  return {
    providerId: str(d.email_id) || str(d.id) || str(d.message_id) || deliveryId,
    from,
    to,
    subject: str(d.subject).slice(0, 300),
    text: (str(d.text) || htmlToText(str(d.html))).slice(0, 200_000),
    attachments,
  };
}
