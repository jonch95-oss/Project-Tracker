import { randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { and, eq, sql } from "drizzle-orm";
import type { GlobalRole } from "@/core/permissions";
import { passwordProblem } from "@/core/password";
import { schema, type DbOrTx } from "../db";
import { recordAudit } from "./audit";

export const CREATABLE_ROLES = ["owner", "admin", "member", "external"] as const satisfies readonly GlobalRole[];

export interface AccountInput {
  name: string;
  username: string;
  role: (typeof CREATABLE_ROLES)[number];
  password: string;
  /** A real address to attach; otherwise a placeholder (<username>@users.invalid) that is never mailed. */
  email?: string;
}

export interface AccountResult {
  id: string;
  created: boolean;
  /** Things the operator should know (a reset leaves role and status alone). */
  notes: string[];
}

const placeholder = (username: string) => `${username}@users.invalid`;

/**
 * Create a sign-in-by-username account with a temporary password, or reset
 * the password of the account that already has that sign-in name. A reset
 * changes only how the person signs in (password, sessions, second factors);
 * their role, name and status stay as they are. An existing account reached
 * by email gets the sign-in name only if it has none yet.
 */
export async function createOrResetAccount(conn: DbOrTx, raw: AccountInput): Promise<AccountResult> {
  const name = raw.name.trim();
  const username = raw.username.trim().toLowerCase();
  const email = raw.email?.trim().toLowerCase() || null;
  if (!name || name.length > 120) throw new Error("A name is required (up to 120 characters).");
  if (!/^[a-z0-9_.]{3,30}$/.test(username)) throw new Error("The username must be 3-30 letters, numbers, '_' or '.'.");
  if (!CREATABLE_ROLES.includes(raw.role)) throw new Error(`The role must be one of ${CREATABLE_ROLES.join(", ")}.`);
  const problem = passwordProblem(raw.password);
  if (problem) throw new Error(`Password: ${problem}`);
  const hash = await hashPassword(raw.password);

  const result = await conn.transaction(async (tx) => {
    const [byName] = await tx.select().from(schema.user).where(eq(schema.user.username, username));
    const [byEmail] = email ? await tx.select().from(schema.user).where(sql`lower(${schema.user.email}) = ${email}`) : [];

    let target = byName;
    if (byName) {
      // Only reset the account this sign-in name was given to: its placeholder address, or the address named here.
      const known = byName.email.toLowerCase();
      if (known !== placeholder(username) && known !== email) {
        throw new Error(`The sign-in name "${username}" belongs to an account with a different email. Pass that email to reset it.`);
      }
    } else if (byEmail) {
      if (byEmail.username) throw new Error(`That email already signs in as "${byEmail.username}".`);
      await tx.update(schema.user).set({ username, displayUsername: username, updatedAt: new Date() }).where(eq(schema.user.id, byEmail.id));
      target = byEmail;
    }

    if (target) {
      const notes: string[] = [];
      if (target.role !== raw.role) notes.push(`Role left as ${target.role} (change it on the Team page).`);
      if (target.status !== "active") notes.push("The account is deactivated; reactivate it on the Team page before they can sign in.");
      await tx.update(schema.user).set({ mustChangePassword: true, twoFactorEnabled: false, updatedAt: new Date() }).where(eq(schema.user.id, target.id));
      const updated = await tx.update(schema.account).set({ password: hash, updatedAt: new Date() }).where(and(eq(schema.account.userId, target.id), eq(schema.account.providerId, "credential"))).returning({ id: schema.account.id });
      if (!updated.length) await tx.insert(schema.account).values({ id: randomUUID(), accountId: target.id, providerId: "credential", userId: target.id, password: hash, createdAt: new Date(), updatedAt: new Date() });
      // A reset is also a recovery: sign out everywhere and drop the old second factors.
      await tx.delete(schema.session).where(eq(schema.session.userId, target.id));
      await tx.delete(schema.twoFactor).where(eq(schema.twoFactor.userId, target.id));
      await tx.delete(schema.passkey).where(eq(schema.passkey.userId, target.id));
      return { id: target.id, created: false, notes, name: target.name, role: target.role };
    }

    const id = randomUUID();
    await tx.insert(schema.user).values({ id, name, email: email ?? placeholder(username), emailVerified: true, role: raw.role, status: "active", username, displayUsername: username, mustChangePassword: true });
    await tx.insert(schema.account).values({ id: randomUUID(), accountId: id, providerId: "credential", userId: id, password: hash, createdAt: new Date(), updatedAt: new Date() });
    return { id, created: true, notes: [] as string[], name, role: raw.role as string };
  });

  await recordAudit(conn, {
    actorId: null,
    actorName: "Setup script",
    action: "invite",
    entityType: "user",
    entityId: result.id,
    summary: result.created
      ? `Created ${result.name}'s account (sign-in name "${username}", ${result.role}) with a temporary password`
      : `Reset ${result.name}'s password to a temporary one (sign-in name "${username}"); signed out everywhere and second factors removed`,
    data: { username, role: result.role, created: result.created },
  });
  return { id: result.id, created: result.created, notes: result.notes };
}
