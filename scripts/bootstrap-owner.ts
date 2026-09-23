/**
 * Create the first owner invitation on an empty database and print the link.
 * Usage: DATABASE_URL=... APP_URL=https://projects.liandev.com \
 *        npm run bootstrap:owner -- --email jon@liandev.com --name "Jon"
 *
 * Refuses to run if an owner already exists; every later invitation is sent
 * from inside the app.
 */
import { createHash, randomBytes } from "node:crypto";
import { Client } from "pg";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const email = arg("email")?.toLowerCase();
  const name = arg("name");
  const url = process.env.DATABASE_URL;
  const appUrl = process.env.APP_URL ?? "http://localhost:3000";
  if (!email || !name || !url) throw new Error("Usage: --email <email> --name <name> with DATABASE_URL set");

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const owners = await client.query(`select count(*)::int as n from "user" where role = 'owner'`);
    if (owners.rows[0].n > 0) throw new Error("An owner already exists. Invite people from the Team page.");

    const token = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(`invite:${token}`).digest("hex");
    await client.query(
      `update invitation set revoked_at = now() where email = $1 and accepted_at is null and revoked_at is null`,
      [email],
    );
    await client.query(
      `insert into invitation (email, name, role, token_hash, expires_at) values ($1, $2, 'owner', $3, now() + interval '2 days')`,
      [email, name, tokenHash],
    );
    console.log(`\nOwner invitation for ${name} <${email}> (valid 48 hours):\n\n  ${appUrl}/invite/${token}\n`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
