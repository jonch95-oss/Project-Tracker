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
  APP_URL: z.url().default("http://localhost:3000"),
  JOB_SECRET: z.string().min(24).optional(),

  // Email (Resend). Without a key, email is written to the outbox and logged.
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default("Project Command <projects@liandev.com>"),
  OWNER_ALERT_EMAIL: z.string().optional(),

  // Provider usage APIs (optional; System page shows "Not connected" without them)
  NEON_API_KEY: z.string().optional(),
  NEON_PROJECT_ID: z.string().optional(),
  GITHUB_USAGE_TOKEN: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid server environment: ${issues}`);
  }
  cached = parsed.data;
  return cached;
}
