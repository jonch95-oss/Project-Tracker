/**
 * Create a sign-in-by-username account with a temporary password, or reset
 * the password of the account that already has that sign-in name. The person
 * must choose their own password the next time they sign in. A reset changes
 * only the password (and signs them out, removing old second factors); role,
 * name and status stay as they are.
 *
 *   DATABASE_URL=… ACCOUNT_NAME="Ariel" ACCOUNT_USERNAME=ariel ACCOUNT_ROLE=admin \
 *   ACCOUNT_PASSWORD='…' [ACCOUNT_EMAIL=…] \
 *   npx tsx --conditions=react-server scripts/create-account.ts
 *
 * Run in production by the "Create account" GitHub workflow (the database URL
 * is a repository secret there). Never prints the password.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const schema = await import("../src/server/db/schema");
  const { createOrResetAccount } = await import("../src/server/services/create-account");
  const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 20_000 });
  const db = drizzle(pool, { schema });
  try {
    const r = await createOrResetAccount(db as never, {
      name: process.env.ACCOUNT_NAME ?? "",
      username: process.env.ACCOUNT_USERNAME ?? "",
      role: (process.env.ACCOUNT_ROLE ?? "").trim() as never,
      password: process.env.ACCOUNT_PASSWORD ?? "",
      email: process.env.ACCOUNT_EMAIL,
    });
    const who = (process.env.ACCOUNT_USERNAME ?? "").trim().toLowerCase();
    console.log(r.created ? `Created account "${who}". They must choose their own password at first sign-in.` : `Reset the password for "${who}". They are signed out everywhere and must choose their own password at next sign-in.`);
    for (const n of r.notes) console.log(`Note: ${n}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
