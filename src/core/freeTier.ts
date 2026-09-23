/**
 * Free-tier limits for every external service and the math that decides when
 * to warn. Limits were checked against each provider's pricing docs on
 * 2026-09-23; re-verify at each integration milestone and update here.
 *
 * Overage behaviour matters as much as the limit:
 * - Neon, Resend, Sentry, Workers: hard caps (service stops, no charge).
 * - R2: overage is billed automatically to the card on file, so the app meters
 *   its own R2 usage and refuses uploads before the limit (see R2_UPLOAD_STOP_BPS).
 * - GitHub Actions: blocked at quota unless a payment method and a non-stopping
 *   budget exist; keep the account budget at $0 with "stop usage" enabled.
 * - Resend's daily quota resets at 00:00 UTC.
 */

export type ServiceKey =
  | "neon.storage"
  | "r2.storage"
  | "r2.classA"
  | "r2.classB"
  | "resend.daily"
  | "resend.monthly"
  | "actions.minutes"
  | "workers.requests";

export interface FreeTierLimit {
  key: ServiceKey;
  service: string;
  metric: string;
  limit: number;
  unit: "bytes" | "emails" | "minutes" | "operations" | "requests";
  period: "total" | "day" | "month";
  source: string;
}

const GB = 1024 ** 3;

export const FREE_TIER_LIMITS: Record<ServiceKey, FreeTierLimit> = {
  "neon.storage": {
    key: "neon.storage",
    service: "Neon Postgres",
    metric: "Database storage",
    limit: 0.5 * GB,
    unit: "bytes",
    period: "total",
    source: "https://neon.com/pricing",
  },
  "r2.storage": {
    key: "r2.storage",
    service: "Cloudflare R2",
    metric: "File storage",
    limit: 10 * GB,
    unit: "bytes",
    period: "total",
    source: "https://developers.cloudflare.com/r2/pricing/",
  },
  "r2.classA": {
    key: "r2.classA",
    service: "Cloudflare R2",
    metric: "Class A operations (writes)",
    limit: 1_000_000,
    unit: "operations",
    period: "month",
    source: "https://developers.cloudflare.com/r2/pricing/",
  },
  "r2.classB": {
    key: "r2.classB",
    service: "Cloudflare R2",
    metric: "Class B operations (reads)",
    limit: 10_000_000,
    unit: "operations",
    period: "month",
    source: "https://developers.cloudflare.com/r2/pricing/",
  },
  "resend.daily": {
    key: "resend.daily",
    service: "Resend",
    metric: "Emails today (UTC day)",
    limit: 100,
    unit: "emails",
    period: "day",
    source: "https://resend.com/pricing",
  },
  "resend.monthly": {
    key: "resend.monthly",
    service: "Resend",
    metric: "Emails this month",
    limit: 3_000,
    unit: "emails",
    period: "month",
    source: "https://resend.com/pricing",
  },
  "actions.minutes": {
    key: "actions.minutes",
    service: "GitHub Actions",
    metric: "Private-repo minutes this month",
    limit: 2_000,
    unit: "minutes",
    period: "month",
    source: "https://docs.github.com/en/billing/concepts/product-billing/github-actions",
  },
  "workers.requests": {
    key: "workers.requests",
    service: "Cloudflare Workers",
    metric: "Requests today (UTC day)",
    limit: 100_000,
    unit: "requests",
    period: "day",
    source: "https://developers.cloudflare.com/workers/platform/pricing/",
  },
};

/** Warn at 70% (owner email), critical at 90%. */
export const WARN_THRESHOLD_BPS = 7_000;
export const CRITICAL_THRESHOLD_BPS = 9_000;

/** R2 bills overage automatically; uploads are refused at 95% of the storage limit. */
export const R2_UPLOAD_STOP_BPS = 9_500;

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

/** GitHub bills each job rounded up to the whole minute. */
export function billableMinutes(durationSeconds: number): number {
  if (durationSeconds <= 0) return 0;
  return Math.ceil(durationSeconds / 60);
}
