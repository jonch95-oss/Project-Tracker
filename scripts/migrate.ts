/** Apply pending migrations from ./drizzle. Usage: DATABASE_URL=... npm run db:migrate */
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 20_000 });
  const client = await pool.connect();
  try {
    // Two production builds can overlap; only one migrates at a time.
    await client.query("select pg_advisory_lock(7310204554)");
    await migrate(drizzle(client), { migrationsFolder: "./drizzle" });
    console.log("Migrations applied.");
  } finally {
    await client.query("select pg_advisory_unlock(7310204554)").catch(() => {});
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
