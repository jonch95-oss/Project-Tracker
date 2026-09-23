/**
 * Parsing for optional numeric form fields. Blank means "not set" (null);
 * anything else must be a clean number, never silently coerced.
 */
import { MoneyError, parseMoney, type Cents } from "./money";

export class FieldError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
  }
}

/** Whole numbers such as square feet or unit counts; commas allowed. */
export function optionalInt(raw: string | null | undefined, field: string, label: string, max = 100_000_000): number | null {
  const s = (raw ?? "").trim().replace(/,/g, "");
  if (s === "") return null;
  if (!/^\d+$/.test(s)) throw new FieldError(field, `${label} must be a whole number.`);
  const n = Number(s);
  if (n > max) throw new FieldError(field, `${label} looks too large.`);
  return n;
}

/** Ratios such as FAR, up to two decimals. */
export function optionalDecimal2(raw: string | null | undefined, field: string, label: string, max = 99): number | null {
  const s = (raw ?? "").trim();
  if (s === "") return null;
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new FieldError(field, `${label} must be a number with up to two decimals, e.g. 2.43.`);
  const n = Number(s);
  if (n > max) throw new FieldError(field, `${label} looks too large.`);
  return n;
}

/** Dollar amounts ("$1,250,000"); stored as integer cents. Negative amounts are refused here. */
export function optionalMoney(raw: string | null | undefined, field: string, label: string): Cents | null {
  const s = (raw ?? "").trim();
  if (s === "") return null;
  try {
    const c = parseMoney(s);
    if (c < 0) throw new FieldError(field, `${label} can't be negative.`);
    return c;
  } catch (e) {
    if (e instanceof FieldError) throw e;
    if (e instanceof MoneyError) throw new FieldError(field, `${label} isn't a valid amount.`);
    throw e;
  }
}

/** Cents back to an editable string ("1250000.50" → "1,250,000.50"; whole dollars drop the cents). */
export function centsToInput(cents: Cents | null | undefined): string {
  if (cents == null) return "";
  const whole = Math.trunc(cents / 100);
  const frac = Math.abs(cents % 100);
  return `${whole.toLocaleString("en-US")}${frac ? `.${String(frac).padStart(2, "0")}` : ""}`;
}
