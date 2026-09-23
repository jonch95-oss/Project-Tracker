/**
 * Vercel build entry: apply migrations on production builds (idempotent),
 * then build. Preview builds never migrate the production database.
 */
import { execSync } from "node:child_process";

const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (process.env.VERCEL_ENV === "production" && url) {
  console.log("Applying database migrations…");
  execSync("npx tsx scripts/migrate.ts", { stdio: "inherit", env: { ...process.env, DATABASE_URL: url } });
} else {
  console.log(`Skipping migrations (VERCEL_ENV=${process.env.VERCEL_ENV ?? "unset"}, database ${url ? "set" : "not set"}).`);
}
execSync("npx next build", { stdio: "inherit" });
