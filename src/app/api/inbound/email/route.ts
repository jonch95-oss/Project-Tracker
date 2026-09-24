import {
  MAX_INBOUND_BODY_BYTES,
  parseInboundPayload,
  verifyWebhookSignature,
} from "@/core/inbound";
import { db } from "@/server/db";
import { env } from "@/server/env";
import { logError } from "@/server/services/errors";
import { receiveInbound } from "@/server/services/inbound";

export const maxDuration = 60;

/** Read at most `limit` bytes of the body; null when it's bigger. */
async function readLimited(
  req: Request,
  limit: number,
): Promise<string | null> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > limit) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Module I: the mail provider's inbound webhook. Off (404) unless both the
 * inbound domain and the signing secret are set. Every request must carry a
 * valid, fresh signature. Rejected mail still gets a 200 so the provider
 * doesn't retry it; only a bad signature or payload is refused.
 */
export async function POST(req: Request) {
  const { INBOUND_EMAIL_SECRET: secret, INBOUND_EMAIL_DOMAIN: domain } = env();
  if (!secret || !domain) return new Response("Not found", { status: 404 });
  const body = await readLimited(req, MAX_INBOUND_BODY_BYTES);
  if (body === null)
    return Response.json({ error: "Too large" }, { status: 413 });
  const headers = {
    id: req.headers.get("svix-id") ?? req.headers.get("webhook-id"),
    timestamp:
      req.headers.get("svix-timestamp") ?? req.headers.get("webhook-timestamp"),
    signature:
      req.headers.get("svix-signature") ?? req.headers.get("webhook-signature"),
  };
  if (!verifyWebhookSignature(secret, headers, body))
    return Response.json({ error: "Bad signature" }, { status: 401 });
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return Response.json({ error: "Bad payload" }, { status: 400 });
  }
  const msg = parseInboundPayload(payload, headers.id!);
  // Other event types on the same endpoint are acknowledged and ignored.
  if (!msg) return Response.json({ ok: true, ignored: true });
  try {
    const result = await receiveInbound(db(), msg);
    return Response.json({ ok: true, ...result });
  } catch (e) {
    await logError("request", e, { path: "/api/inbound/email" });
    return Response.json(
      { error: "Couldn't save the message" },
      { status: 500 },
    );
  }
}
