import "server-only";
import { z } from "zod";

/**
 * Server environment. Secrets live only in env vars; nothing here is ever
 * sent to the browser. Optional values switch adapters from mock to real.
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().min(32),
  /** Canonical URL. On Vercel it defaults to the production URL (production) or the branch URL (preview). */
  APP_URL: z.url().default("http://localhost:3000"),
  /** Sent by Vercel Cron as `Authorization: Bearer …`; also used by the GitHub backup workflow. */
  CRON_SECRET: z.string().min(24).optional(),

  // Email (Resend). Without a key, email is written to the outbox and logged.
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default("Project Command <projects@liandev.com>"),
  OWNER_ALERT_EMAIL: z.string().optional(),

  // Provider usage APIs (optional; System page shows "Not connected" without them)
  NEON_API_KEY: z.string().optional(),
  NEON_PROJECT_ID: z.string().optional(),
  /** Read-only Vercel token (billing read) for the Pro credit meter on the System page. */
  VERCEL_USAGE_TOKEN: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse({ ...process.env, APP_URL: process.env.APP_URL || vercelUrl() });
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid server environment: ${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Derive the app URL from Vercel's system environment variables when APP_URL is not set. */
function vercelUrl(): string | undefined {
  if (process.env.VERCEL_ENV === "production" && process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  if (process.env.VERCEL_BRANCH_URL) return `https://${process.env.VERCEL_BRANCH_URL}`;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return undefined;
}

/**
 * Every origin this deployment answers on. Vercel serves one deployment at
 * its unique URL, its branch URL and (for production) the project domains,
 * so auth and CSRF checks must accept each of them.
 */
export function allowedOrigins(): string[] {
  const origins = new Set<string>([new URL(env().APP_URL).origin]);
  for (const host of [process.env.VERCEL_URL, process.env.VERCEL_BRANCH_URL, process.env.VERCEL_PROJECT_PRODUCTION_URL]) {
    if (host) origins.add(`https://${host}`);
  }
  return [...origins];
}
