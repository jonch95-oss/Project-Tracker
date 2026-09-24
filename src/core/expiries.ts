/**
 * Expiry tracker (Module B): permits, policies, COIs, loan maturities, rate
 * caps and deadlines, with reminders at 30, 14 and 7 days out and every day
 * once expired. Pure.
 */
import { daysBetween } from "./time";

export const EXPIRY_CATEGORIES = [
  { key: "dob_permit", label: "DOB work permit" },
  { key: "shed_permit", label: "Sidewalk shed permit" },
  { key: "dot_permit", label: "DOT permit" },
  { key: "crane_permit", label: "Crane permit" },
  { key: "tco", label: "TCO (90-day renewal)" },
  { key: "builders_risk", label: "Builder's risk policy" },
  { key: "gl_policy", label: "General liability policy" },
  { key: "umbrella", label: "Umbrella policy" },
  { key: "vendor_coi_gl", label: "Vendor COI: general liability" },
  { key: "vendor_coi_wc", label: "Vendor COI: workers' comp" },
  { key: "vendor_coi_db", label: "Vendor COI: disability" },
  { key: "loan_maturity", label: "Loan maturity" },
  { key: "loan_extension", label: "Loan extension option" },
  { key: "rate_cap", label: "Rate cap" },
  { key: "lpc_permit", label: "LPC permit" },
  { key: "exchange_1031", label: "1031 deadline" },
  { key: "other", label: "Other" },
] as const;
export type ExpiryCategory = (typeof EXPIRY_CATEGORIES)[number]["key"];

export const isVendorCoi = (c: string) => c.startsWith("vendor_coi_");
/** Money-side items only people with financial access see. */
export const FINANCIAL_EXPIRY = new Set<string>(["loan_maturity", "loan_extension", "rate_cap", "exchange_1031"]);

export function expiryLabel(category: string, custom?: string | null): string {
  const base = EXPIRY_CATEGORIES.find((c) => c.key === category)?.label ?? category;
  return custom ? `${base}: ${custom}` : base;
}

export const EXPIRY_REMINDERS = [30, 14, 7] as const;

export type ExpiryState = "ok" | "soon" | "expired";

/** Soon = inside the first reminder window. */
export function expiryState(expiresOn: string, today: string): ExpiryState {
  const n = daysBetween(today, expiresOn);
  if (n < 0) return "expired";
  return n <= EXPIRY_REMINDERS[0] ? "soon" : "ok";
}

/**
 * Which reminder is due today, as a stable mark ("30", "14", "7", or
 * "expired:YYYY-MM-DD" for each day after). A missed day is caught up by
 * the latest threshold passed, never a burst.
 */
export function expiryReminderMark(expiresOn: string, today: string, sent: ReadonlySet<string>): string | null {
  const n = daysBetween(today, expiresOn);
  if (n < 0) {
    const mark = `expired:${today}`;
    return sent.has(mark) ? null : mark;
  }
  const passed = EXPIRY_REMINDERS.filter((t) => n <= t);
  if (passed.length === 0) return null;
  const latest = String(passed[passed.length - 1]);
  return sent.has(latest) ? null : latest;
}

/** One name per vendor however it's typed ("ACME Builders, LLC" = "Acme Builders LLC"). */
export function vendorKey(name: string | null | undefined): string {
  return (name ?? "")
    .toLowerCase()
    .replace(/[.,'’]/g, "")
    .replace(/\b(llc|inc|corp|co|ltd|lp|llp|pc)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
