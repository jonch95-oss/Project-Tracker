import { describe, expect, it } from "vitest";
import { byCategory, drawTotals, headline, lienWaiversComplete, lineTotals, nextDrawStatus, perSf, salesSummary, totalOf, unitExpected } from "@/core/financials";

const lines = [
  { id: "a", category: "hard", originalCents: 1_000_000_00 },
  { id: "b", category: "soft", originalCents: 200_000_00 },
  { id: "c", category: "hard", originalCents: 50_000_00 },
];

describe("budget roll-up", () => {
  const t = lineTotals(
    lines,
    [
      { budgetLineId: "a", amountCents: 900_000_00, status: "executed" },
      { budgetLineId: "a", amountCents: 150_000_00, status: "draft" }, // drafts don't count
      { budgetLineId: "c", amountCents: 60_000_00, status: "executed" },
    ],
    [
      { budgetLineId: "a", amountCents: 300_000_00, status: "paid" },
      { budgetLineId: "a", amountCents: 100_000_00, status: "approved" },
      { budgetLineId: "a", amountCents: 999_00, status: "received" }, // not yet approved
      { budgetLineId: "b", amountCents: 20_000_00, status: "rejected" },
    ],
    [
      { budgetLineId: "a", amountCents: 75_000_00, status: "approved" },
      { budgetLineId: "a", amountCents: 10_000_00, status: "pending" },
      { budgetLineId: "b", amountCents: -25_000_00, status: "approved" }, // a credit
    ],
  );
  it("revised = original + approved changes; committed, invoiced, paid; forecast and variance", () => {
    expect(t[0]).toEqual({ id: "a", category: "hard", original: 1_000_000_00, approvedChanges: 75_000_00, revised: 1_075_000_00, committed: 900_000_00, invoiced: 400_000_00, paid: 300_000_00, forecast: 1_075_000_00, variance: 0 });
    expect(t[1]!.revised).toBe(175_000_00);
    expect(t[1]!.invoiced).toBe(0);
    // Committed past budget: forecast follows the commitment and the variance goes negative.
    expect(t[2]).toMatchObject({ revised: 50_000_00, committed: 60_000_00, forecast: 60_000_00, variance: -10_000_00 });
  });
  it("totals and categories add up to the cent", () => {
    const all = totalOf(t);
    expect(all.revised).toBe(1_075_000_00 + 175_000_00 + 50_000_00);
    expect(all.variance).toBe(-10_000_00);
    const groups = byCategory(t);
    expect(groups.map((g) => g.category)).toEqual(["soft", "hard"]);
    expect(groups[1]!.totals.revised).toBe(1_125_000_00);
  });
});

describe("sales", () => {
  const units = [
    { sf: 1000, askCents: 1_500_000_00, contractCents: null, status: "available" as const },
    { sf: 1200, askCents: 1_900_000_00, contractCents: 1_850_000_00, status: "contract" as const },
    { sf: 800, askCents: 1_200_000_00, contractCents: 1_210_000_00, status: "closed" as const },
    { sf: null, askCents: null, contractCents: null, status: "reserved" as const },
  ];
  it("uses contract prices once in contract, the ask before", () => {
    expect(unitExpected(units[0]!)).toBe(1_500_000_00);
    expect(unitExpected(units[1]!)).toBe(1_850_000_00);
    const s = salesSummary(units);
    expect(s).toEqual({ units: 4, sold: 1, inContract: 1, projectedSellout: 1_500_000_00 + 1_850_000_00 + 1_210_000_00, closedCents: 1_210_000_00, contractCents: 1_850_000_00 });
  });
  it("$/sf rounds half away from zero in whole cents", () => {
    expect(perSf(1_500_000_00, 1000)).toBe(1_500_00);
    expect(perSf(100, 3)).toBe(33);
    expect(perSf(200, 3)).toBe(67);
    expect(perSf(null, 1000)).toBeNull();
    expect(perSf(100, 0)).toBeNull();
  });
});

describe("headline", () => {
  it("from the budget and unit schedule when they exist", () => {
    const h = headline(
      { purchasePriceCents: 2_000_000_00, totalBudgetCents: 1, projectedSelloutCents: 1, loanAmountCents: 4_000_000_00, useBudgetDetail: true, useSalesDetail: true },
      { original: 0, approvedChanges: 0, revised: 6_000_000_00, committed: 3_000_000_00, invoiced: 1_000_000_00, paid: 800_000_00, forecast: 6_200_000_00, variance: -200_000_00 },
      { units: 4, sold: 0, inContract: 0, projectedSellout: 8_000_000_00, closedCents: 0, contractCents: 0 },
    );
    expect(h).toEqual({
      purchasePrice: 2_000_000_00,
      totalBudget: 6_000_000_00,
      spentToDate: 800_000_00,
      committed: 3_000_000_00,
      forecastAtCompletion: 6_200_000_00,
      projectedSellout: 8_000_000_00,
      profit: 1_800_000_00,
      marginBps: 2250,
      equityRequired: 2_200_000_00,
      equityMultipleMilli: 1818, // (2.2M + 1.8M) / 2.2M = 1.818x
    });
  });
  it("falls back to the typed figures", () => {
    const h = headline({ purchasePriceCents: null, totalBudgetCents: 1_000_00, projectedSelloutCents: 1_500_00, loanAmountCents: null }, null, null);
    expect(h).toMatchObject({ totalBudget: 1_000_00, forecastAtCompletion: 1_000_00, projectedSellout: 1_500_00, profit: 500_00, marginBps: 3333, equityRequired: 1_000_00, equityMultipleMilli: 1500 });
    const none = headline({ purchasePriceCents: null, totalBudgetCents: null, projectedSelloutCents: null, loanAmountCents: null }, null, null);
    expect(none).toMatchObject({ profit: null, marginBps: null, equityRequired: null, equityMultipleMilli: null });
  });
  it("a loan larger than the cost means no equity and no multiple", () => {
    const h = headline({ purchasePriceCents: null, totalBudgetCents: 1_000_00, projectedSelloutCents: 900_00, loanAmountCents: 2_000_00 }, null, null);
    expect(h).toMatchObject({ profit: -100_00, equityRequired: 0, equityMultipleMilli: null });
  });
});

describe("draws", () => {
  it("retainage is held back per invoice, rounding each to the cent", () => {
    expect(drawTotals([
      { invoiceId: "1", amountCents: 100_000_00, retainageBps: 1000 },
      { invoiceId: "2", amountCents: 333_33, retainageBps: 500 }, // 5% of $333.33 = $16.67 (16.6665 rounds up)
    ])).toEqual({ gross: 100_333_33, retainage: 10_016_67, net: 90_316_66 });
  });
  it("status flow: waivers before submitting, inspector before approval", () => {
    expect(nextDrawStatus("draft", { invoices: 0, waiversComplete: true, inspectorSigned: false })).toEqual({ blocked: "Add approved invoices first." });
    expect(nextDrawStatus("draft", { invoices: 2, waiversComplete: false, inspectorSigned: false })).toMatchObject({ blocked: expect.stringMatching(/lien waiver/) });
    expect(nextDrawStatus("draft", { invoices: 2, waiversComplete: true, inspectorSigned: false })).toEqual({ next: "submitted" });
    expect(nextDrawStatus("submitted", { invoices: 2, waiversComplete: true, inspectorSigned: false })).toMatchObject({ blocked: expect.any(String) });
    expect(nextDrawStatus("submitted", { invoices: 2, waiversComplete: true, inspectorSigned: true })).toEqual({ next: "inspector_approved" });
    expect(nextDrawStatus("inspector_approved", { invoices: 2, waiversComplete: true, inspectorSigned: true })).toEqual({ next: "funded" });
    expect(nextDrawStatus("funded", { invoices: 2, waiversComplete: true, inspectorSigned: true })).toBeNull();
    expect(lienWaiversComplete([{ received: true }, { received: false }])).toBe(false);
    expect(lienWaiversComplete([])).toBe(true);
  });
});

describe("Milestone 6 review regressions", () => {
  it("a credit line stays a credit; spending against it counts from zero", () => {
    const [credit] = lineTotals([{ id: "x", category: "hard", originalCents: -50_000_00 }], [], [], []);
    expect(credit).toMatchObject({ revised: -50_000_00, forecast: -50_000_00, variance: 0 });
    const [spent] = lineTotals([{ id: "x", category: "hard", originalCents: -50_000_00 }], [], [{ budgetLineId: "x", amountCents: 10_000_00, status: "approved" }], []);
    expect(spent!.forecast).toBe(-40_000_00);
  });

  it("approved change orders against a contract change what's committed", () => {
    const lines = [{ id: "a", category: "hard", originalCents: 100_000_00 }];
    const commitments = [{ id: "gc", budgetLineId: "a", amountCents: 100_000_00, status: "executed" }];
    const credit = lineTotals(lines, commitments, [], [{ budgetLineId: "a", commitmentId: "gc", amountCents: -20_000_00, status: "approved" }]);
    expect(credit[0]).toMatchObject({ revised: 80_000_00, committed: 80_000_00, forecast: 80_000_00, variance: 0 });
    const add = lineTotals(lines, commitments, [], [{ budgetLineId: "a", commitmentId: "gc", amountCents: 20_000_00, status: "approved" }]);
    expect(add[0]).toMatchObject({ revised: 120_000_00, committed: 120_000_00 });
    const pending = lineTotals(lines, commitments, [], [{ budgetLineId: "a", commitmentId: "gc", amountCents: 20_000_00, status: "pending" }]);
    expect(pending[0]!.committed).toBe(100_000_00);
  });

  it("uncoded contracts and invoices are totalled in their own row", () => {
    const t = lineTotals([{ id: "a", category: "hard", originalCents: 100_00 }], [{ budgetLineId: null, amountCents: 999_000_00, status: "executed" }], [], []);
    expect(t.map((r) => r.id)).toEqual(["a", "uncoded"]);
    expect(totalOf(t).committed).toBe(999_000_00);
    expect(totalOf(t).forecast).toBe(100_00 + 999_000_00);
    expect(lineTotals([{ id: "a", category: "hard", originalCents: 1 }], [], [], [])).toHaveLength(1);
  });

  it("a half-entered budget or unit list never replaces typed figures unless switched on", () => {
    const partial = { original: 0, approvedChanges: 0, revised: 1_000_00, committed: 0, invoiced: 0, paid: 0, forecast: 1_000_00, variance: 0 };
    const oneUnit = { units: 1, sold: 0, inContract: 0, projectedSellout: 1_000_000_00, closedCents: 0, contractCents: 0 };
    const typed = { purchasePriceCents: null, totalBudgetCents: 20_000_000_00, projectedSelloutCents: 30_000_000_00, loanAmountCents: null };
    expect(headline(typed, partial, oneUnit)).toMatchObject({ totalBudget: 20_000_000_00, projectedSellout: 30_000_000_00 });
    expect(headline({ ...typed, useBudgetDetail: true, useSalesDetail: true }, partial, oneUnit)).toMatchObject({ totalBudget: 1_000_00, projectedSellout: 1_000_000_00 });
    // Nothing typed: the detail is all there is.
    expect(headline({ ...typed, totalBudgetCents: null, projectedSelloutCents: null }, partial, oneUnit)).toMatchObject({ totalBudget: 1_000_00, projectedSellout: 1_000_000_00 });
  });

  it("a loss beyond the equity shows 0.00x, not a negative multiple", () => {
    const h = headline({ purchasePriceCents: null, totalBudgetCents: 1_000_00, projectedSelloutCents: 100_00, loanAmountCents: 500_00 }, null, null);
    expect(h.equityMultipleMilli).toBe(0);
  });
});
