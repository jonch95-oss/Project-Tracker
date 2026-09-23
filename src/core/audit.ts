/**
 * Tamper-evident audit log. Each entry's hash covers its own content and the
 * previous entry's hash, so editing or removing any row breaks the chain from
 * that point on. (The database also forbids UPDATE/DELETE on the table.)
 */

export const AUDIT_ACTIONS = [
  "create",
  "update",
  "delete",
  "approve",
  "reject",
  "permission.change",
  "login",
  "login.failed",
  "logout",
  "export",
  "invite",
  "invite.accept",
  "invite.revoke",
  "user.deactivate",
  "user.reactivate",
  "password.reset",
  "password.resetLink",
  "2fa.enable",
  "2fa.disable",
  "passkey.add",
  "passkey.remove",
  "audit.verify",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const GENESIS_HASH = "0".repeat(64);

export interface AuditEntryContent {
  seq: number;
  occurredAt: string; // ISO instant
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  projectId: string | null;
  summary: string;
  data: unknown;
  ip: string | null;
}

/** Deterministic JSON: object keys sorted recursively, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function computeAuditHash(prevHash: string, entry: AuditEntryContent): Promise<string> {
  return sha256Hex(`${prevHash}\n${canonicalJson(entry)}`);
}

export interface StoredAuditEntry extends AuditEntryContent {
  prevHash: string;
  hash: string;
}

export type ChainVerification =
  | { ok: true; checked: number; lastHash: string }
  | { ok: false; checked: number; brokenAtSeq: number; reason: string };

/** Verify entries in ascending `seq` order, starting from `startPrevHash`. */
export async function verifyAuditChain(
  entries: readonly StoredAuditEntry[],
  startPrevHash: string = GENESIS_HASH,
  startSeq = 1,
): Promise<ChainVerification> {
  let prev = startPrevHash;
  let expectedSeq = startSeq;
  let checked = 0;
  for (const e of entries) {
    if (e.seq !== expectedSeq) {
      return { ok: false, checked, brokenAtSeq: expectedSeq, reason: "Missing entry (gap in sequence)" };
    }
    if (e.prevHash !== prev) {
      return { ok: false, checked, brokenAtSeq: e.seq, reason: "Previous-hash link does not match" };
    }
    const { prevHash: _p, hash, ...content } = e;
    void _p;
    const recomputed = await computeAuditHash(prev, content);
    if (recomputed !== hash) {
      return { ok: false, checked, brokenAtSeq: e.seq, reason: "Entry content was altered" };
    }
    prev = hash;
    expectedSeq++;
    checked++;
  }
  return { ok: true, checked, lastHash: prev };
}

/** Keys whose values must never be written to the audit log. */
const SECRET_KEYS = /password|secret|token|backupcodes|otp|hash|key$/i;

export function scrubAuditData(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(scrubAuditData);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEYS.test(k) ? "[redacted]" : scrubAuditData(v);
  }
  return out;
}
