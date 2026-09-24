/**
 * Module J: capital accounts and the distribution waterfall. Pure; all
 * amounts are integer cents, rates and splits are basis points.
 *
 * The waterfall is a list of tiers applied in order to each distribution:
 *
 * - `pref`: the preferred return, simple (not compounding) interest at
 *   `rateBps` a year on each investor's unreturned capital, from the day it
 *   came in; only what hasn't been paid yet is owed.
 * - `return_of_capital`: contributions not yet returned.
 * - `split`: what's left is shared LP / GP (the GP share is the sponsor's
 *   promote). With `untilMultiple` the tier stops once the investors as a
 *   group have received that multiple of their capital (e.g. 1.5x), and the
 *   next tier takes over; the last split has no hurdle and takes the rest.
 *
 * Within a tier, money goes to investors in proportion to what each is owed
 * (pref, capital) or to their capital (splits), and the parts always sum to
 * the whole, to the cent.
 */
import { allocate, type Cents } from "./money";
import { daysBetween } from "./time";

export type Tier = { kind: "pref"; rateBps: number } | { kind: "return_of_capital" } | { kind: "split"; lpBps: number; untilMultipleMilli: number | null };

export interface Contribution {
  on: string;
  cents: Cents;
}

export interface PaidDistribution {
  on: string;
  roc: Cents;
  pref: Cents;
  profit: Cents;
}

export interface InvestorPosition {
  investorId: string;
  contributions: readonly Contribution[];
  distributions: readonly PaidDistribution[];
}

export interface DistributionShare {
  investorId: string;
  roc: Cents;
  pref: Cents;
  profit: Cents;
}

export interface DistributionResult {
  shares: DistributionShare[];
  /** The sponsor's promote. */
  gp: Cents;
  /** Money no tier could place (only when the tiers end with a hurdle). */
  unallocated: Cents;
}

export const DEFAULT_TIERS: Tier[] = [{ kind: "pref", rateBps: 800 }, { kind: "return_of_capital" }, { kind: "split", lpBps: 8000, untilMultipleMilli: null }];

/** Problems with a set of tiers, in plain words (empty when it's usable). */
export function tierProblems(tiers: readonly Tier[]): string[] {
  const out: string[] = [];
  if (tiers.length === 0) out.push("Add at least one tier.");
  tiers.forEach((t, i) => {
    const n = `Tier ${i + 1}`;
    if (t.kind === "pref" && (!Number.isInteger(t.rateBps) || t.rateBps <= 0 || t.rateBps > 5000)) out.push(`${n}: the preferred return is a rate between 0% and 50%.`);
    if (t.kind === "split") {
      if (!Number.isInteger(t.lpBps) || t.lpBps < 0 || t.lpBps > 10_000) out.push(`${n}: the investors' share is between 0% and 100%.`);
      if (t.untilMultipleMilli !== null && (!Number.isInteger(t.untilMultipleMilli) || t.untilMultipleMilli <= 1000)) out.push(`${n}: a hurdle is a multiple above 1.00x.`);
      if (t.untilMultipleMilli !== null && t.lpBps === 0) out.push(`${n}: a hurdle tier needs a share for the investors.`);
    }
  });
  const last = tiers[tiers.length - 1];
  if (last && !(last.kind === "split" && last.untilMultipleMilli === null)) out.push("End with a split that has no hurdle, so every dollar has somewhere to go.");
  if (tiers.filter((t) => t.kind === "pref").length > 1) out.push("Use one preferred return tier.");
  if (tiers.filter((t) => t.kind === "return_of_capital").length > 1) out.push("Use one return of capital tier.");
  return out;
}

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

/** Capital still to be returned to an investor as of a day (contributions less capital returned, never negative). */
export function unreturnedCapital(p: InvestorPosition, asOf: string): Cents {
  const inn = sum(p.contributions.filter((c) => c.on <= asOf).map((c) => c.cents));
  const back = sum(p.distributions.filter((d) => d.on <= asOf).map((d) => d.roc));
  return Math.max(0, inn - back);
}

/**
 * Preferred return earned to `asOf` (inclusive of the day's balance up to
 * that day): simple interest on unreturned capital, day by day between
 * events, actual/365. Not reduced by pref already paid.
 */
export function prefEarned(p: InvestorPosition, rateBps: number, asOf: string): Cents {
  const events = [...p.contributions.map((c) => ({ on: c.on, delta: c.cents })), ...p.distributions.map((d) => ({ on: d.on, delta: -d.roc }))].filter((e) => e.on <= asOf).sort((a, b) => (a.on < b.on ? -1 : a.on > b.on ? 1 : 0));
  let balance = 0n;
  let from: string | null = null;
  let acc = 0n; // cents × bps × days
  for (const e of events) {
    if (from !== null && balance > 0n) acc += balance * BigInt(rateBps) * BigInt(daysBetween(from, e.on));
    balance += BigInt(e.delta);
    if (balance < 0n) balance = 0n;
    from = e.on;
  }
  if (from !== null && balance > 0n) acc += balance * BigInt(rateBps) * BigInt(daysBetween(from, asOf));
  const denom = 10_000n * 365n;
  return Number((acc + denom / 2n) / denom);
}

/** Pro-rata split of `amount` by `weights`, tolerating all-zero weights (nobody gets anything). */
function share(amount: Cents, weights: readonly number[]): Cents[] {
  if (amount <= 0 || sum(weights) === 0) return weights.map(() => 0);
  return allocate(amount, weights);
}

/** How one distribution of `amount` on `on` flows through the tiers. */
export function computeDistribution(input: { amount: Cents; on: string; tiers: readonly Tier[]; investors: readonly InvestorPosition[] }): DistributionResult {
  const { on, tiers, investors } = input;
  let avail = input.amount;
  const shares: DistributionShare[] = investors.map((i) => ({ investorId: i.investorId, roc: 0, pref: 0, profit: 0 }));
  let gp = 0;
  const contributed = investors.map((i) => sum(i.contributions.filter((c) => c.on <= on).map((c) => c.cents)));
  const priorTotal = investors.map((i) => sum(i.distributions.map((d) => d.roc + d.pref + d.profit)));
  const paidNow = () => shares.map((s) => s.roc + s.pref + s.profit);

  for (const t of tiers) {
    if (avail <= 0) break;
    if (t.kind === "pref") {
      const owed = investors.map((i) => Math.max(0, prefEarned(i, t.rateBps, on) - sum(i.distributions.map((d) => d.pref))));
      const pay = share(Math.min(avail, sum(owed)), owed);
      pay.forEach((c, k) => (shares[k]!.pref += c));
      avail -= sum(pay);
    } else if (t.kind === "return_of_capital") {
      const owed = investors.map((i) => unreturnedCapital(i, on));
      const pay = share(Math.min(avail, sum(owed)), owed);
      pay.forEach((c, k) => (shares[k]!.roc += c));
      avail -= sum(pay);
    } else {
      let take = avail;
      if (t.untilMultipleMilli !== null) {
        // The investors, as a group, stop at this multiple of their capital; the tier's size is what gets them there.
        const target = Math.ceil((sum(contributed) * t.untilMultipleMilli) / 1000);
        const got = sum(priorTotal) + sum(paidNow());
        const need = Math.max(0, target - got);
        take = Math.min(avail, t.lpBps === 0 ? 0 : Math.ceil((need * 10_000) / t.lpBps));
      }
      if (take <= 0) continue;
      const lp = t.lpBps === 10_000 ? take : Math.round((take * t.lpBps) / 10_000);
      const pay = share(lp, contributed);
      pay.forEach((c, k) => (shares[k]!.profit += c));
      // With nobody to pay (no capital in), the investors' part stays unplaced rather than going to the sponsor.
      const placed = sum(pay);
      gp += take - lp;
      avail -= placed + (take - lp);
    }
  }
  return { shares, gp, unallocated: avail };
}

export interface CapitalAccount {
  committed: Cents;
  called: Cents;
  contributed: Cents;
  distributed: Cents;
  roc: Cents;
  pref: Cents;
  profit: Cents;
  unreturned: Cents;
  unfunded: Cents;
  /** Preferred return earned but not yet paid (null without a pref tier). */
  prefOwed: Cents | null;
}

/** One investor's account on one project as of a day. */
export function capitalAccount(input: { committed: Cents; called: Cents; position: InvestorPosition; tiers: readonly Tier[]; asOf: string }): CapitalAccount {
  const { position: p, asOf } = input;
  const contributed = sum(p.contributions.filter((c) => c.on <= asOf).map((c) => c.cents));
  const roc = sum(p.distributions.map((d) => d.roc));
  const pref = sum(p.distributions.map((d) => d.pref));
  const profit = sum(p.distributions.map((d) => d.profit));
  const prefTier = input.tiers.find((t): t is Extract<Tier, { kind: "pref" }> => t.kind === "pref");
  return {
    committed: input.committed,
    called: input.called,
    contributed,
    distributed: roc + pref + profit,
    roc,
    pref,
    profit,
    unreturned: Math.max(0, contributed - roc),
    unfunded: Math.max(0, input.committed - contributed),
    prefOwed: prefTier ? Math.max(0, prefEarned(p, prefTier.rateBps, asOf) - pref) : null,
  };
}

/** Plain-words summary of the tiers, for the portal and the report. */
export function describeTiers(tiers: readonly Tier[]): string[] {
  return tiers.map((t) => {
    if (t.kind === "pref") return `${(t.rateBps / 100).toFixed(t.rateBps % 100 ? 2 : 0)}% preferred return to investors`;
    if (t.kind === "return_of_capital") return "Return of investors' capital";
    const lp = t.lpBps / 100;
    const split = `${lp % 1 ? lp.toFixed(2) : lp}% investors / ${(100 - lp) % 1 ? (100 - lp).toFixed(2) : 100 - lp}% sponsor`;
    return t.untilMultipleMilli !== null ? `${split} until investors reach ${(t.untilMultipleMilli / 1000).toFixed(2)}x` : `${split} thereafter`;
  });
}

/** "2026-Q3" → the quarter's first and last day; null if it isn't a quarter. */
export function quarterBounds(q: string): { from: string; to: string; label: string } | null {
  const m = /^(\d{4})-Q([1-4])$/.exec(q);
  if (!m) return null;
  const y = Number(m[1]);
  const n = Number(m[2]);
  const startMonth = (n - 1) * 3 + 1;
  const endMonth = startMonth + 2;
  const lastDay = new Date(Date.UTC(y, endMonth, 0)).getUTCDate();
  const pad = (x: number) => String(x).padStart(2, "0");
  return { from: `${y}-${pad(startMonth)}-01`, to: `${y}-${pad(endMonth)}-${pad(lastDay)}`, label: `Q${n} ${y}` };
}

/** The quarter a day falls in, e.g. "2026-Q3"; `offset` -1 is the one before. */
export function quarterOf(day: string, offset = 0): string {
  const y = Number(day.slice(0, 4));
  const idx = y * 4 + Math.floor((Number(day.slice(5, 7)) - 1) / 3) + offset;
  return `${Math.floor(idx / 4)}-Q${(idx % 4) + 1}`;
}
