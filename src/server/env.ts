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
  /** One-time key for the /setup page that creates the first owner (separate from CRON_SECRET). */
  SETUP_KEY: z.string().min(24).optional(),

  // Email is on hold (brief §3). With no sender configured the no-op adapter records "skipped" rows.
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default("Project Command <projects@liandev.com>"),
  OWNER_ALERT_EMAIL: z.string().optional(),

  // Provider usage APIs (optional; System page shows "Not connected" without them)
  NEON_API_KEY: z.string().optional(),
  NEON_PROJECT_ID: z.string().optional(),
  /** Read-only Vercel token (billing read) for the Pro credit meter on the System page. */
  VERCEL_USAGE_TOKEN: z.string().optional(),
  VERCEL_TEAM_ID: z.string().optional(),
  /**
   * Virus-scan hook (brief §13). Optional: when set, every uploaded file's
   * short-lived download link is POSTed here and the reply decides whether the
   * file is kept. No free hosted scanner is wired in, so by default files are
   * recorded as "not scanned".
   */
  VIRUS_SCAN_URL: z.url().optional(),
  VIRUS_SCAN_TOKEN: z.string().optional(),
  /** Web push (brief §9). The public key is shown to browsers; the private key signs each push. Without them push is off. */
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().default("mailto:projects@liandev.com"),
  /** NYC Open Data (Socrata) app token for the public-records watch. */
  SOCRATA_APP_TOKEN: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function env(): Env {
  if (cached) return cached;
  // Blank values (e.g. `OWNER_ALERT_EMAIL=` copied from .env.example) count as unset.
  const raw = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined && v.trim() !== ""));
  const parsed = schema.safeParse({ ...raw, APP_URL: raw.APP_URL || vercelUrl() });
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

/** Tests change process.env between files; clear the parsed cache. */
export function resetEnvForTests() {
  cached = undefined;
}
