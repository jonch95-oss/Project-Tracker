/**
 * Create (or reset) a sign-in-by-username account with a temporary password.
 * The person must choose their own password the first time they sign in.
 *
 *   DATABASE_URL=… ACCOUNT_NAME="Ariel" ACCOUNT_USERNAME=ariel ACCOUNT_ROLE=admin \
 *   ACCOUNT_PASSWORD='…' [ACCOUNT_EMAIL=…] \
 *   npx tsx --conditions=react-server scripts/create-account.ts
 *
 * Run in production by the "Create account" GitHub workflow (the database URL
 * is a repository secret there). Never prints the password.
 */
import { randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { passwordProblem } from "../src/core/password";

const ROLES = ["owner", "admin", "member", "external"] as const;

async function main() {
  const url = process.env.DATABASE_URL;
  const name = (process.env.ACCOUNT_NAME ?? "").trim();
  const username = (process.env.ACCOUNT_USERNAME ?? "").trim().toLowerCase();
  const role = (process.env.ACCOUNT_ROLE ?? "").trim() as (typeof ROLES)[number];
  const password = process.env.ACCOUNT_PASSWORD ?? "";
  const email = (process.env.ACCOUNT_EMAIL ?? "").trim().toLowerCase() || `${username}@users.invalid`;
  if (!url) throw new Error("DATABASE_URL is required");
  if (!name || name.length > 120) throw new Error("ACCOUNT_NAME is required");
  if (!/^[a-z0-9_.]{3,30}$/.test(username)) throw new Error("ACCOUNT_USERNAME must be 3-30 letters, numbers, '_' or '.'");
  if (!ROLES.includes(role)) throw new Error(`ACCOUNT_ROLE must be one of ${ROLES.join(", ")}`);
  const problem = passwordProblem(password);
  if (problem) throw new Error(`ACCOUNT_PASSWORD: ${problem}`);

  const schema = await import("../src/server/db/schema");
  const { recordAudit } = await import("../src/server/services/audit");
  const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 20_000 });
  const db = drizzle(pool, { schema });
  const hash = await hashPassword(password);
  try {
    const result = await db.transaction(async (tx) => {
      const [existing] = await tx.select().from(schema.user).where(eq(schema.user.username, username));
      if (existing) {
        // Same person again: a fresh temporary password, and they choose their own on next sign-in.
        await tx.update(schema.user).set({ name, role, status: "active", mustChangePassword: true, updatedAt: new Date() }).where(eq(schema.user.id, existing.id));
        const updated = await tx.update(schema.account).set({ password: hash, updatedAt: new Date() }).where(and(eq(schema.account.userId, existing.id), eq(schema.account.providerId, "credential"))).returning({ id: schema.account.id });
        if (!updated.length) await tx.insert(schema.account).values({ id: randomUUID(), accountId: existing.id, providerId: "credential", userId: existing.id, password: hash, createdAt: new Date(), updatedAt: new Date() });
        await tx.delete(schema.session).where(eq(schema.session.userId, existing.id));
        return { id: existing.id, created: false };
      }
      const [clash] = await tx.select({ id: schema.user.id }).from(schema.user).where(sql`lower(${schema.user.email}) = ${email}`);
      if (clash) throw new Error("Another account already uses that email.");
      const id = randomUUID();
      await tx.insert(schema.user).values({ id, name, email, emailVerified: true, role, status: "active", username, displayUsername: username, mustChangePassword: true });
      await tx.insert(schema.account).values({ id: randomUUID(), accountId: id, providerId: "credential", userId: id, password: hash, createdAt: new Date(), updatedAt: new Date() });
      return { id, created: true };
    });
    await recordAudit(db as never, {
      actorId: null,
      actorName: "Setup script",
      action: "invite",
      entityType: "user",
      entityId: result.id,
      summary: `${result.created ? "Created" : "Reset"} ${name}'s account (sign-in name "${username}", ${role}) with a temporary password`,
      data: { username, role },
    });
    console.log(`${result.created ? "Created" : "Reset"} account for ${name} (username "${username}", ${role}). They must choose their own password at first sign-in.`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
