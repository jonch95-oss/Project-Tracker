/**
 * Business-day math for due dates (brief §13: relative dates across weekends
 * and holidays). Holidays are the US federal holidays as observed (a Saturday
 * holiday moves to Friday, a Sunday one to Monday), which is when banks,
 * title companies and most city agencies close. Pure: dates are "YYYY-MM-DD".
 */
import { addDays, dayOfWeek, isIsoDate, parseIso } from "./time";

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

/** The n-th (1-based) weekday `dow` (0 = Sunday) of a month; n = -1 means the last one. */
function nthWeekday(year: number, month: number, dow: number, n: number): string {
  if (n > 0) {
    const first = dayOfWeek(iso(year, month, 1));
    const day = 1 + ((dow - first + 7) % 7) + (n - 1) * 7;
    return iso(year, month, day);
  }
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const lastDow = dayOfWeek(iso(year, month, lastDay));
  return iso(year, month, lastDay - ((lastDow - dow + 7) % 7));
}

function observed(date: string): string {
  const d = dayOfWeek(date);
  if (d === 6) return addDays(date, -1);
  if (d === 0) return addDays(date, 1);
  return date;
}

const cache = new Map<number, Set<string>>();

/** Observed US federal holidays for a year. */
export function holidays(year: number): Set<string> {
  const hit = cache.get(year);
  if (hit) return hit;
  const set = new Set<string>([
    observed(iso(year, 1, 1)), // New Year's Day
    nthWeekday(year, 1, 1, 3), // Martin Luther King Jr. Day
    nthWeekday(year, 2, 1, 3), // Washington's Birthday
    nthWeekday(year, 5, 1, -1), // Memorial Day
    observed(iso(year, 6, 19)), // Juneteenth
    observed(iso(year, 7, 4)), // Independence Day
    nthWeekday(year, 9, 1, 1), // Labor Day
    nthWeekday(year, 10, 1, 2), // Columbus Day
    observed(iso(year, 11, 11)), // Veterans Day
    nthWeekday(year, 11, 4, 4), // Thanksgiving
    observed(iso(year, 12, 25)), // Christmas
  ]);
  // New Year's Day on a Saturday is observed on Dec 31 of the year before.
  const next = observed(iso(year + 1, 1, 1));
  if (next.startsWith(`${year}-`)) set.add(next);
  cache.set(year, set);
  return set;
}

export function isHoliday(date: string): boolean {
  return holidays(parseIso(date)[0]).has(date);
}

export function isBusinessDay(date: string): boolean {
  const d = dayOfWeek(date);
  return d !== 0 && d !== 6 && !isHoliday(date);
}

/** The date itself if it's a business day, otherwise the next one. */
export function nextBusinessDay(date: string): string {
  let d = date;
  while (!isBusinessDay(d)) d = addDays(d, 1);
  return d;
}

/** Answers already worked out (the schedule forecast asks the same questions many times over). */
const memo = new Map<string, string>();
const MEMO_MAX = 50_000;

/**
 * Move `n` business days from `date` (negative goes back). Zero returns the
 * date rolled forward to a business day.
 */
export function addBusinessDays(date: string, n: number): string {
  if (!isIsoDate(date)) throw new Error(`Not a date: ${date}`);
  const k = `${date}|${n}`;
  const hit = memo.get(k);
  if (hit) return hit;
  const out = walkBusinessDays(date, n);
  if (memo.size >= MEMO_MAX) memo.clear();
  memo.set(k, out);
  return out;
}

function walkBusinessDays(date: string, n: number): string {
  if (n === 0) return nextBusinessDay(date);
  const step = n > 0 ? 1 : -1;
  let d = date;
  let left = Math.abs(n);
  while (left > 0) {
    d = addDays(d, step);
    if (isBusinessDay(d)) left--;
  }
  return d;
}

export type OffsetUnit = "business" | "calendar";

/**
 * A due date `days` after an anchor. Calendar offsets that land on a weekend
 * or holiday roll forward to the next business day, so nothing is ever due on
 * a day the office is closed.
 */
export function offsetDate(anchor: string, days: number, unit: OffsetUnit): string {
  if (unit === "business") return addBusinessDays(anchor, days);
  return nextBusinessDay(addDays(anchor, days));
}
