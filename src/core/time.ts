import { TZDate } from "@date-fns/tz";

/** Every "today", due date, digest and schedule is evaluated in New York time. */
export const APP_TIME_ZONE = "America/New_York";

/** A calendar date with no time, formatted YYYY-MM-DD. */
export type IsoDate = string;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: string): value is IsoDate {
  if (!ISO_DATE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

/** The calendar date in New York at the given instant. */
export function todayET(now: Date = new Date()): IsoDate {
  const z = new TZDate(now.getTime(), APP_TIME_ZONE);
  return formatParts(z.getFullYear(), z.getMonth() + 1, z.getDate());
}

/** The instant New York's day `date` begins (handles 23h/25h DST days). */
export function startOfDayET(date: IsoDate): Date {
  const [y, m, d] = parseIso(date);
  return new Date(new TZDate(y, m - 1, d, 0, 0, 0, 0, APP_TIME_ZONE).getTime());
}

/** Hour of day (0–23) in New York at the given instant. */
export function hourET(now: Date = new Date()): number {
  return new TZDate(now.getTime(), APP_TIME_ZONE).getHours();
}

/** Minutes after midnight in New York at the given instant. */
export function minuteOfDayET(now: Date = new Date()): number {
  const z = new TZDate(now.getTime(), APP_TIME_ZONE);
  return z.getHours() * 60 + z.getMinutes();
}

export function addDays(date: IsoDate, days: number): IsoDate {
  const [y, m, d] = parseIso(date);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return formatParts(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** Whole calendar days from `a` to `b` (b − a). */
export function daysBetween(a: IsoDate, b: IsoDate): number {
  const [ay, am, ad] = parseIso(a);
  const [by, bm, bd] = parseIso(b);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

/** 0 = Sunday … 6 = Saturday. */
export function dayOfWeek(date: IsoDate): number {
  const [y, m, d] = parseIso(date);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Format an instant for display in New York time. */
export function formatDateTimeET(instant: Date, opts: Intl.DateTimeFormatOptions = {}): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: APP_TIME_ZONE,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...opts,
  }).format(instant);
}

/** Format a calendar date, e.g. "Mar 4, 2026". */
export function formatIsoDate(date: IsoDate, opts: Intl.DateTimeFormatOptions = {}): string {
  const [y, m, d] = parseIso(date);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
    ...opts,
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

export function parseIso(date: IsoDate): [number, number, number] {
  if (!isIsoDate(date)) throw new Error(`Invalid ISO date: ${date}`);
  return date.split("-").map(Number) as [number, number, number];
}

function formatParts(y: number, m: number, d: number): IsoDate {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
