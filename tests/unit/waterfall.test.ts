import { describe, expect, it } from "vitest";
import { capitalAccount, computeDistribution, DEFAULT_TIERS, describeTiers, prefEarned, tierProblems, unreturnedCapital, type InvestorPosition, type Tier } from "@/core/waterfall";

const $ = (dollars: number) => Math.round(dollars * 100);
const pos = (investorId: string, contributions: [string, number][], distributions: [string, number, number, number][] = []): InvestorPosition => ({
  investorId,
  contributions: contributions.map(([on, d]) => ({ on, cents: $(d) })),
  distributions: distributions.map(([on, roc, pref, profit]) => ({ on, roc: $(roc), pref: $(pref), profit: $(profit) })),
});
const total = (r: ReturnType<typeof computeDistribution>) => r.shares.reduce((a, s) => a + s.roc + s.pref + s.profit, 0) + r.gp + r.unallocated;

describe("preferred return (simple, actual/365, on unreturned capital)", () => {
  it("a year on $600,000 at 8% is $48,000", () => {
    expect(prefEarned(pos("a", [["2025-01-01", 600_000]]), 800, "2026-01-01")).toBe($(48_000));
  });
  it("accrues on the balance as it changes: capital in mid-year, some returned later", () => {
    // $100k from Jan 1 (181 days to Jul 1), then $200k to Oct 1 (92 days), then $50k returned: $150k for 92 days to Jan 1.
    const p = pos("a", [["2025-01-01", 100_000], ["2025-07-01", 100_000]], [["2025-10-01", 50_000, 0, 0]]);
    const expected = (100_000 * 0.1 * 181 + 200_000 * 0.1 * 92 + 150_000 * 0.1 * 92) / 365;
    expect(prefEarned(p, 1000, "2026-01-01")).toBe($(Number(expected.toFixed(2))));
    expect(unreturnedCapital(p, "2026-01-01")).toBe($(150_000));
    expect(prefEarned(p, 1000, "2024-12-31")).toBe(0);
  });
});

describe("the waterfall", () => {
  const investors = [pos("a", [["2025-01-01", 600_000]]), pos("b", [["2025-01-01", 400_000]])];

  it("8% pref, then capital, then 80/20: every cent placed", () => {
    const r = computeDistribution({ amount: $(1_500_000), on: "2026-01-01", tiers: DEFAULT_TIERS, investors });
    expect(r.shares).toEqual([
      { investorId: "a", pref: $(48_000), roc: $(600_000), profit: $(201_600) },
      { investorId: "b", pref: $(32_000), roc: $(400_000), profit: $(134_400) },
    ]);
    expect(r.gp).toBe($(84_000));
    expect(r.unallocated).toBe(0);
    expect(total(r)).toBe($(1_500_000));
  });

  it("a small distribution pays the pref pro rata and stops", () => {
    const r = computeDistribution({ amount: $(40_000), on: "2026-01-01", tiers: DEFAULT_TIERS, investors });
    expect(r.shares.map((s) => [s.pref, s.roc, s.profit])).toEqual([
      [$(24_000), 0, 0],
      [$(16_000), 0, 0],
    ]);
    expect(r.gp).toBe(0);
  });

  it("pref already paid isn't paid twice; capital already returned isn't returned twice", () => {
    const paid = [pos("a", [["2025-01-01", 600_000]], [["2025-12-31", 100_000, 48_000, 0]]), pos("b", [["2025-01-01", 400_000]], [["2025-12-31", 0, 32_000, 0]])];
    const r = computeDistribution({ amount: $(900_000), on: "2025-12-31", tiers: DEFAULT_TIERS, investors: paid });
    // Pref to Dec 31 is 364 days' worth minus what's been paid: a little under zero, so nothing more.
    expect(r.shares.map((s) => s.pref)).toEqual([0, 0]);
    expect(r.shares.map((s) => s.roc)).toEqual([$(500_000), $(400_000)]);
    expect(total(r)).toBe($(900_000));
  });

  it("promote tiers: 90/10 until the investors reach 1.5x, then 70/30", () => {
    const tiers: Tier[] = [{ kind: "return_of_capital" }, { kind: "split", lpBps: 9000, untilMultipleMilli: 1500 }, { kind: "split", lpBps: 7000, untilMultipleMilli: null }];
    const r = computeDistribution({ amount: $(2_000_000), on: "2026-06-30", tiers, investors: [pos("a", [["2025-01-01", 1_000_000]])] });
    const a = r.shares[0]!;
    expect(a.roc).toBe($(1_000_000));
    // Tier 2 sizes itself so the investor lands exactly on $1.5M; the rest splits 70/30.
    const tier2 = Math.ceil(($(500_000) * 10_000) / 9000);
    const tier3 = $(2_000_000) - $(1_000_000) - tier2;
    expect(a.profit).toBe(Math.round((tier2 * 9000) / 10_000) + Math.round((tier3 * 7000) / 10_000));
    expect(a.roc + a.profit).toBeGreaterThan($(1_500_000));
    expect(total(r)).toBe($(2_000_000));
    expect(r.unallocated).toBe(0);
  });

  it("a hurdle already met is skipped", () => {
    const tiers: Tier[] = [{ kind: "split", lpBps: 9000, untilMultipleMilli: 1200 }, { kind: "split", lpBps: 5000, untilMultipleMilli: null }];
    const r = computeDistribution({ amount: $(100_000), on: "2026-01-01", tiers, investors: [pos("a", [["2025-01-01", 100_000]], [["2025-06-01", 100_000, 0, 30_000]])] });
    expect(r.shares[0]!.profit).toBe($(50_000));
    expect(r.gp).toBe($(50_000));
  });

  it("odd cents are placed exactly (largest remainder)", () => {
    const three = [pos("a", [["2025-01-01", 1]]), pos("b", [["2025-01-01", 1]]), pos("c", [["2025-01-01", 1]])];
    const r = computeDistribution({ amount: 100, on: "2025-01-01", tiers: [{ kind: "split", lpBps: 10_000, untilMultipleMilli: null }], investors: three });
    expect(r.shares.map((s) => s.profit)).toEqual([34, 33, 33]);
  });
});

describe("tiers are checked before use", () => {
  it("the defaults are fine and read plainly", () => {
    expect(tierProblems(DEFAULT_TIERS)).toEqual([]);
    expect(describeTiers(DEFAULT_TIERS)).toEqual(["8% preferred return to investors", "Return of investors' capital", "80% investors / 20% sponsor thereafter"]);
  });
  it("must end with an open split, with sane rates and hurdles", () => {
    expect(tierProblems([])).toContain("Add at least one tier.");
    expect(tierProblems([{ kind: "return_of_capital" }])).toContain("End with a split that has no hurdle, so every dollar has somewhere to go.");
    expect(tierProblems([{ kind: "pref", rateBps: 0 }, { kind: "split", lpBps: 8000, untilMultipleMilli: null }])[0]).toMatch(/Tier 1/);
    expect(tierProblems([{ kind: "split", lpBps: 8000, untilMultipleMilli: 900 }, { kind: "split", lpBps: 8000, untilMultipleMilli: null }])[0]).toMatch(/above 1.00x/);
  });
});

describe("capital account", () => {
  it("committed, called, in, out, still to return, unfunded, and pref owed", () => {
    const p = pos("a", [["2025-01-01", 400_000]], [["2025-12-01", 100_000, 20_000, 0]]);
    const acct = capitalAccount({ committed: $(500_000), called: $(450_000), position: p, tiers: DEFAULT_TIERS, asOf: "2026-01-01" });
    expect(acct).toMatchObject({ committed: $(500_000), called: $(450_000), contributed: $(400_000), distributed: $(120_000), roc: $(100_000), pref: $(20_000), profit: 0, unreturned: $(300_000), unfunded: $(100_000) });
    const earned = (400_000 * 0.08 * 334 + 300_000 * 0.08 * 31) / 365;
    expect(acct.prefOwed).toBe($(Number(earned.toFixed(2))) - $(20_000));
    expect(capitalAccount({ committed: 0, called: 0, position: p, tiers: [{ kind: "split", lpBps: 10_000, untilMultipleMilli: null }], asOf: "2026-01-01" }).prefOwed).toBeNull();
  });
});
