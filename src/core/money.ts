/**
 * Money is always an integer number of cents. No floating-point money anywhere.
 * Values stay within Number.MAX_SAFE_INTEGER (~$90 trillion), which every
 * function asserts.
 */

export type Cents = number;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

export function assertCents(value: number, label = "amount"): asserts value is Cents {
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`${label} must be a safe integer number of cents, got ${value}`);
  }
}

/**
 * Parse user input such as "$1,250,000.5", "-300", "(1,200.00)" into cents.
 * Rejects more than two decimal places rather than silently rounding.
 */
export function parseMoney(input: string): Cents {
  const raw = input.trim();
  if (raw === "") throw new MoneyError("Empty amount");
  let negative = false;
  let s = raw;
  if (s.startsWith("(") && s.endsWith(")")) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  if (s.startsWith("-")) {
    negative = !negative;
    s = s.slice(1).trim();
  }
  s = s.replace(/^\$/, "").replace(/,/g, "").trim();
  const match = /^(\d+)(?:\.(\d{0,2}))?$/.exec(s);
  if (!match) throw new MoneyError(`Not a valid amount: "${input}"`);
  const dollars = match[1]!;
  const fraction = (match[2] ?? "").padEnd(2, "0");
  const cents = Number(dollars) * 100 + Number(fraction);
  assertCents(cents);
  return negative ? -cents : cents;
}

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const USD_WHOLE = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

/** Format cents for display. `whole` drops the cents (rounded half away from zero). */
export function formatMoney(cents: Cents, opts: { whole?: boolean } = {}): string {
  assertCents(cents);
  if (opts.whole) {
    const dollars = roundDiv(cents, 100);
    return USD_WHOLE.format(dollars);
  }
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  // Build from integer parts so we never format a float.
  const formatted = USD.format(whole).replace(/\.00$/, "") + "." + String(frac).padStart(2, "0");
  return sign + formatted;
}

/** Compact display for cards, e.g. $4.25M, $850K. Never used for math. */
export function formatMoneyCompact(cents: Cents): string {
  assertCents(cents);
  const sign = cents < 0 ? "-" : "";
  const dollars = Math.abs(cents) / 100;
  // The unit is chosen after rounding, so $999,950 reads "$1M", not "$1000K".
  if (dollars >= 999_950) return `${sign}$${trimZeros((dollars / 1_000_000).toFixed(2))}M`;
  if (dollars >= 999.5) return `${sign}$${trimZeros((dollars / 1_000).toFixed(1))}K`;
  return `${sign}$${Math.round(dollars)}`;
}

function trimZeros(s: string): string {
  return s.replace(/\.?0+$/, "");
}

export function add(...values: Cents[]): Cents {
  return sum(values);
}

export function sum(values: readonly Cents[]): Cents {
  let total = 0;
  for (const v of values) {
    assertCents(v);
    total += v;
  }
  assertCents(total, "sum");
  return total;
}

export function subtract(a: Cents, b: Cents): Cents {
  assertCents(a);
  assertCents(b);
  const r = a - b;
  assertCents(r, "difference");
  return r;
}

/** BigInt division rounded half away from zero (commercial rounding). */
function bigRoundDiv(n: bigint, d: bigint): bigint {
  if (d === 0n) throw new MoneyError("Division by zero");
  const negative = n < 0n !== d < 0n;
  const an = n < 0n ? -n : n;
  const ad = d < 0n ? -d : d;
  const q = an / ad;
  const rounded = (an % ad) * 2n >= ad ? q + 1n : q;
  return negative ? -rounded : rounded;
}

function toSafe(value: bigint, label: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new MoneyError(`${label} out of range`);
  return n;
}

/** Integer division rounded half away from zero. Both arguments must be integers. */
export function roundDiv(numerator: number, denominator: number): number {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)) {
    throw new MoneyError("roundDiv requires integers");
  }
  return toSafe(bigRoundDiv(BigInt(numerator), BigInt(denominator)), "quotient");
}

/** Multiply cents by a rate expressed in basis points (1 bp = 0.01%). */
export function applyBasisPoints(cents: Cents, bps: number): Cents {
  assertCents(cents);
  if (!Number.isSafeInteger(bps)) throw new MoneyError("Basis points must be an integer");
  return toSafe(bigRoundDiv(BigInt(cents) * BigInt(bps), 10_000n), "amount");
}

/** part / whole as basis points, rounded. Returns null when whole is 0. */
export function ratioBasisPoints(part: Cents, whole: Cents): number | null {
  assertCents(part);
  assertCents(whole);
  if (whole === 0) return null;
  return toSafe(bigRoundDiv(BigInt(part) * 10_000n, BigInt(whole)), "ratio");
}

export function formatBasisPoints(bps: number | null, digits = 1): string {
  if (bps === null) return "—";
  const pct = bps / 100;
  return `${pct.toFixed(digits)}%`;
}

/**
 * Split an amount across weights so the parts always sum exactly to the
 * total (largest-remainder method). Ties go to the earliest weight.
 */
export function allocate(total: Cents, weights: readonly number[]): Cents[] {
  assertCents(total);
  if (weights.length === 0) throw new MoneyError("allocate needs at least one weight");
  if (weights.some((w) => !Number.isSafeInteger(w) || w < 0)) {
    throw new MoneyError("Weights must be non-negative integers");
  }
  const weightSum = weights.reduce((a, b) => a + b, 0);
  if (weightSum === 0) throw new MoneyError("Weights sum to zero");

  const negative = total < 0;
  const abs = BigInt(Math.abs(total));
  const ws = BigInt(weightSum);
  const base = weights.map((w) => (abs * BigInt(w)) / ws);
  const remainders = weights.map((w, i) => ({ i, r: (abs * BigInt(w)) % ws }));
  let leftover = abs - base.reduce((a, b) => a + b, 0n);
  remainders.sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  for (const { i } of remainders) {
    if (leftover === 0n) break;
    base[i] = base[i]! + 1n;
    leftover -= 1n;
  }
  return base.map((b) => (negative ? -Number(b) : Number(b)));
}

/** Equity multiple as a ratio in thousandths (e.g. 1.850x → 1850). Null without equity. */
export function equityMultipleMilli(totalReturned: Cents, equityIn: Cents): number | null {
  assertCents(totalReturned);
  assertCents(equityIn);
  if (equityIn <= 0) return null;
  return toSafe(bigRoundDiv(BigInt(totalReturned) * 1000n, BigInt(equityIn)), "multiple");
}

export function formatMultiple(milli: number | null): string {
  if (milli === null) return "—";
  return `${(milli / 1000).toFixed(2)}x`;
}
