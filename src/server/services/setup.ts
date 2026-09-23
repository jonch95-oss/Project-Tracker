import "server-only";
import { sql } from "drizzle-orm";
import { db, schema } from "../db";
import { env } from "../env";
import { recordAudit } from "./audit";
import { generateToken, hashToken } from "./tokens";

export function secretsMatch(given: string, expected: string | undefined): boolean {
  if (!expected || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

export async function hasAnyUser(): Promise<boolean> {
  const [r] = await db().select({ n: sql<number>`count(*)::int` }).from(schema.user);
  return (r?.n ?? 0) > 0;
}

export type SetupResult = { ok: true; inviteUrl: string } | { ok: false; error: string };

export function setupKeyConfigured(): boolean {
  return Boolean(env().SETUP_KEY);
}

/**
 * One-time bootstrap of the first owner on an empty production database.
 * Works only while no user exists, and only with the deployment's SETUP_KEY
 * (its own secret, not shared with cron or backups).
 */
export async function createFirstOwnerInvite(input: { email: string; name: string; secret: string }): Promise<SetupResult> {
  const key = env().SETUP_KEY;
  if (!key) return { ok: false, error: "Setup is not enabled: add SETUP_KEY to the project's environment variables and redeploy." };
  if (!secretsMatch(input.secret, key)) {
    // Slow down guessing and leave a trace.
    await new Promise((r) => setTimeout(r, 1_000));
    await recordAudit(db(), {
      actorId: null,
      actorName: "Setup",
      action: "login.failed",
      entityType: "setup",
      summary: "Failed first-owner setup attempt (wrong setup key)",
    });
    return { ok: false, error: "That setup key is not correct." };
  }
  const email = input.email.trim().toLowerCase();
  const name = input.name.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !name) return { ok: false, error: "Enter a name and a valid email." };

  return db().transaction(async (tx) => {
    // Serialize concurrent setup attempts, then re-check emptiness inside the lock.
    await tx.execute(sql`select pg_advisory_xact_lock(4242001)`);
    const [r] = await tx.select({ n: sql<number>`count(*)::int` }).from(schema.user);
    if ((r?.n ?? 0) > 0) return { ok: false as const, error: "Setup is already complete. Sign in instead." };
    await tx.update(schema.invitation).set({ revokedAt: new Date() }).where(sql`${schema.invitation.role} = 'owner' and ${schema.invitation.acceptedAt} is null and ${schema.invitation.revokedAt} is null`);
    const token = generateToken();
    const [inv] = await tx
      .insert(schema.invitation)
      .values({ email, name, role: "owner", tokenHash: await hashToken(token), expiresAt: new Date(Date.now() + 2 * 86_400_000) })
      .returning({ id: schema.invitation.id });
    await recordAudit(tx, {
      actorId: null,
      actorName: "Setup",
      action: "invite",
      entityType: "invitation",
      entityId: inv!.id,
      summary: `First-owner invitation created for ${name} (${email}) via setup`,
      data: { email, role: "owner" },
    });
    return { ok: true as const, inviteUrl: `${env().APP_URL}/invite/${token}` };
  });
}
