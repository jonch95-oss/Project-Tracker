/**
 * Key dates on a project (brief §6): they drive reminders at 14, 7 and 1
 * days out (Milestone 7) and show on cards and the Needs-you rail. Pure.
 */
import { daysBetween } from "./time";

export const KEY_DATE_KINDS = [
  { key: "dd_expiry", label: "DD expiry" },
  { key: "closing", label: "Closing" },
  { key: "toe", label: "Time of the essence (TOE)" },
  { key: "tco_expiry", label: "TCO expiry" },
  { key: "loan_maturity", label: "Loan maturity" },
  { key: "exchange_1031_identify", label: "1031 identification deadline" },
  { key: "exchange_1031_close", label: "1031 closing deadline" },
  { key: "auction", label: "Auction date" },
  { key: "oath_hearing", label: "OATH hearing" },
  { key: "other", label: "Other" },
] as const;

export type KeyDateKind = (typeof KEY_DATE_KINDS)[number]["key"];

export function keyDateLabel(kind: string, custom?: string | null): string {
  if ((kind === "other" || kind === "oath_hearing") && custom) return custom;
  return KEY_DATE_KINDS.find((k) => k.key === kind)?.label ?? kind;
}

export interface KeyDateLike {
  date: string;
  done: boolean;
}

/** The next key date that hasn't passed or been marked done. */
export function nextKeyDate<T extends KeyDateLike>(dates: readonly T[], today: string): T | null {
  const future = dates.filter((d) => !d.done && d.date >= today).sort((a, b) => a.date.localeCompare(b.date));
  return future[0] ?? null;
}

/** Key dates in the next `days` days (today included), soonest first. */
export function upcomingKeyDates<T extends KeyDateLike>(dates: readonly T[], today: string, days = 14): T[] {
  return dates.filter((d) => !d.done && d.date >= today && daysBetween(today, d.date) <= days).sort((a, b) => a.date.localeCompare(b.date));
}

/** Reminder thresholds (days before) that a date is due for on `today`. */
export const KEY_DATE_REMINDERS = [14, 7, 1] as const;
export function reminderDue(date: string, today: string): (typeof KEY_DATE_REMINDERS)[number] | null {
  const d = daysBetween(today, date);
  return (KEY_DATE_REMINDERS as readonly number[]).includes(d) ? (d as 14 | 7 | 1) : null;
}

/** Key dates that are about money (a loan, a 1031 exchange): shown only to people who see the project's financials. */
export const FINANCIAL_KEY_DATE_KINDS: ReadonlySet<string> = new Set(["loan_maturity", "exchange_1031_identify", "exchange_1031_close"]);
export function isFinancialKeyDate(kind: string): boolean {
  return FINANCIAL_KEY_DATE_KINDS.has(kind);
}
