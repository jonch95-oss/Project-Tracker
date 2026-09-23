/**
 * Free-tier limits and Vercel Pro allowances for every external service, and
 * the math that decides when to warn. Checked 2026-09-23; re-verify at each
 * integration milestone and update here.
 *
 * Overage behaviour matters as much as the limit:
 * - Neon Free, Resend Free: hard caps (service stops, no charge).
 * - Vercel Pro: every metered item bills from the first unit against the
 *   team's $20/month usage credit, which is shared with the team's other
 *   projects. Blob has no separate free allowance, so this app budgets its own
 *   Blob share (10 GB stored ≈ $0.23/month) and refuses uploads at 95% of it.
 *   A team spend cap in Vercel stops anything beyond the credit billing silently.
 * - GitHub Actions (CI + nightly backup only): blocked at quota unless a
 *   payment method and a non-stopping budget exist.
 * - Resend's daily quota resets at 00:00 UTC.
 */

export type ServiceKey =
  | "neon.storage"
  | "blob.storage"
  | "blob.transfer"
  | "resend.daily"
  | "resend.monthly"
  | "actions.minutes"
  | "vercel.credit";

export interface FreeTierLimit {
  key: ServiceKey;
  service: string;
  metric: string;
  limit: number;
  unit: "bytes" | "emails" | "minutes" | "cents";
  period: "total" | "day" | "month";
  source: string;
  /** Plain-English note shown on the System page. */
  note?: string;
}

const GB = 1024 ** 3;

export const FREE_TIER_LIMITS: Record<ServiceKey, FreeTierLimit> = {
  "neon.storage": {
    key: "neon.storage",
    service: "Neon Postgres (Free)",
    metric: "Database storage",
    limit: 0.5 * GB,
    unit: "bytes",
    period: "total",
    source: "https://neon.com/docs/introduction/plans",
  },
  "blob.storage": {
    key: "blob.storage",
    service: "Vercel Blob (Pro)",
    metric: "Files and backups stored",
    limit: 10 * GB,
    unit: "bytes",
    period: "total",
    source: "https://vercel.com/docs/vercel-blob/usage-and-pricing",
    note: "App budget. Pro has no separate Blob allowance; 10 GB costs about $0.23/month from the $20 Pro credit. Uploads stop at 95%.",
  },
  "blob.transfer": {
    key: "blob.transfer",
    service: "Vercel Blob (Pro)",
    metric: "File downloads this month",
    limit: 20 * GB,
    unit: "bytes",
    period: "month",
    source: "https://vercel.com/docs/vercel-blob/usage-and-pricing",
    note: "App budget: about $1/month of the Pro credit. Metered by the app's download route.",
  },
  "resend.daily": {
    key: "resend.daily",
    service: "Resend (Free)",
    metric: "Emails today — UTC day, sent and received",
    limit: 100,
    unit: "emails",
    period: "day",
    source: "https://resend.com/docs/knowledge-base/account-quotas-and-limits",
    note: "Resend's day runs midnight to midnight UTC (8pm–8pm New York in summer, 7pm–7pm in winter).",
  },
  "resend.monthly": {
    key: "resend.monthly",
    service: "Resend (Free)",
    metric: "Emails this month",
    limit: 3_000,
    unit: "emails",
    period: "month",
    source: "https://resend.com/docs/knowledge-base/account-quotas-and-limits",
  },
  "actions.minutes": {
    key: "actions.minutes",
    service: "GitHub Actions (Free)",
    metric: "CI and backup minutes this month",
    limit: 2_000,
    unit: "minutes",
    period: "month",
    source: "https://docs.github.com/en/billing/concepts/product-billing/github-actions",
  },
  "vercel.credit": {
    key: "vercel.credit",
    service: "Vercel Pro",
    metric: "Team usage against the $20 monthly credit",
    limit: 2_000,
    unit: "cents",
    period: "month",
    source: "https://vercel.com/docs/plans/pro-plan",
    note: "Whole team, all projects. Needs a read-only VERCEL_USAGE_TOKEN to measure.",
  },
};

/** Warn at 70% (owner email), critical at 90%. */
export const WARN_THRESHOLD_BPS = 7_000;
export const CRITICAL_THRESHOLD_BPS = 9_000;

/** Blob storage bills from the Pro credit; uploads are refused at 95% of the app's budget. */
export const UPLOAD_STOP_BPS = 9_500;

/** Resend: hold non-urgent mail once the day's queue would pass this many. */
export const EMAIL_DAILY_SOFT_CAP = 80;

export type UsageLevel = "ok" | "warn" | "critical" | "exceeded";

export interface UsageReading {
  key: ServiceKey;
  used: number | null; // null = not measurable yet (adapter not connected)
}

export interface UsageStatus extends FreeTierLimit {
  used: number | null;
  /** Share of the limit used, in basis points (10000 = 100%). */
  bps: number | null;
  level: UsageLevel;
}

export function usageLevel(bps: number | null): UsageLevel {
  if (bps === null) return "ok";
  if (bps >= 10_000) return "exceeded";
  if (bps >= CRITICAL_THRESHOLD_BPS) return "critical";
  if (bps >= WARN_THRESHOLD_BPS) return "warn";
  return "ok";
}

export function evaluateUsage(reading: UsageReading): UsageStatus {
  const limit = FREE_TIER_LIMITS[reading.key];
  const bps =
    reading.used === null ? null : Math.floor((Math.max(0, reading.used) * 10_000) / limit.limit);
  return { ...limit, used: reading.used, bps, level: usageLevel(bps) };
}

/**
 * Keys that crossed into a warning level since they were last alerted.
 * `lastAlerted` maps key → the level we last emailed about in this period;
 * we alert again only when the level gets worse, so the owner gets one email
 * per threshold, not one per job run.
 */
export function alertsToSend(
  statuses: readonly UsageStatus[],
  lastAlerted: Partial<Record<ServiceKey, UsageLevel>>,
): UsageStatus[] {
  const rank: Record<UsageLevel, number> = { ok: 0, warn: 1, critical: 2, exceeded: 3 };
  return statuses.filter((s) => {
    if (s.level === "ok") return false;
    const prev = lastAlerted[s.key] ?? "ok";
    return rank[s.level] > rank[prev];
  });
}

/** The period bucket an alert belongs to, so alerts reset each day/month. */
export function periodKey(period: FreeTierLimit["period"], todayIso: string): string {
  if (period === "day") return todayIso;
  if (period === "month") return todayIso.slice(0, 7);
  return "total";
}

export function formatUsage(value: number | null, unit: FreeTierLimit["unit"]): string {
  if (value === null) return "Not connected";
  if (unit === "bytes") return formatBytes(value);
  if (unit === "cents") return `$${(value / 100).toFixed(2)}`;
  return new Intl.NumberFormat("en-US").format(value);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)} ${units[i]}`;
}

/** True when an upload of `size` bytes would take stored bytes past the stop threshold. */
export function uploadAllowed(storedBytes: number, size: number): boolean {
  const limit = FREE_TIER_LIMITS["blob.storage"].limit;
  return (storedBytes + size) * 10_000 < limit * UPLOAD_STOP_BPS;
}

/** GitHub bills each job rounded up to the whole minute. */
export function billableMinutes(durationSeconds: number): number {
  if (durationSeconds <= 0) return 0;
  return Math.ceil(durationSeconds / 60);
}
