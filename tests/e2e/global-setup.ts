import { execSync } from "node:child_process";
import { Client } from "pg";

/** Fresh database with migrations and the demo seed for every e2e run. */
export default async function globalSetup() {
  const url = new URL(process.env.E2E_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/pc_e2e_test");
  const name = url.pathname.slice(1);
  const admin = new URL(url);
  admin.pathname = "/postgres";
  const c = new Client({ connectionString: admin.toString() });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await c.query(`CREATE DATABASE "${name}"`);
  await c.end();
  const env = { ...process.env, DATABASE_URL: url.toString(), BETTER_AUTH_SECRET: "e2e-secret-e2e-secret-e2e-secret-0123456789", APP_URL: "http://localhost:3100" };
  execSync("npx tsx scripts/migrate.ts", { env, stdio: "inherit" });
  execSync("npm run seed:demo", { env, stdio: "inherit" });
}
