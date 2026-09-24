/**
 * Project financials (brief §8). All money is integer cents; percentages are
 * basis points; nothing here touches floating-point money. Pure.
 */
import { applyBasisPoints, assertCents, equityMultipleMilli, ratioBasisPoints, roundDiv, subtract, sum, type Cents } from "./money";

export const BUDGET_CATEGORIES = [
  { key: "acquisition", label: "Acquisition" },
  { key: "closing", label: "Closing costs" },
  { key: "soft", label: "Soft costs" },
  { key: "hard", label: "Hard costs" },
  { key: "financing", label: "Financing" },
  { key: "contingency", label: "Contingency" },
  { key: "sales", label: "Sales & marketing" },
] as const;
export type BudgetCategory = (typeof BUDGET_CATEGORIES)[number]["key"];
export const categoryLabel = (k: string) => (k === "uncoded" ? "Not coded to a line" : (BUDGET_CATEGORIES.find((c) => c.key === k)?.label ?? k));

export const INVOICE_STATUSES = ["received", "approved", "rejected", "paid"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];
export const CHANGE_ORDER_STATUSES = ["pending", "approved", "rejected"] as const;
export type ChangeOrderStatus = (typeof CHANGE_ORDER_STATUSES)[number];
export const COMMITMENT_STATUSES = ["draft", "executed", "closed"] as const;
export const DRAW_STATUSES = ["draft", "submitted", "inspector_approved", "funded"] as const;
export type DrawStatus = (typeof DRAW_STATUSES)[number];
export const DRAW_STATUS_LABEL: Record<DrawStatus, string> = { draft: "Draft", submitted: "Submitted to lender", inspector_approved: "Inspector signed off", funded: "Funded" };
export const UNIT_STATUSES = ["available", "reserved", "contract", "closed"] as const;
export type UnitStatus = (typeof UNIT_STATUSES)[number];
export const UNIT_STATUS_LABEL: Record<UnitStatus, string> = { available: "Available", reserved: "Reserved", contract: "In contract", closed: "Closed" };

/* ------------------------------------------------------------------ */
/* Budget                                                              */
/* ------------------------------------------------------------------ */

export interface LineInput {
  id: string;
  category: string;
  originalCents: Cents;
}
export interface CommitmentInput {
  id?: string;
  budgetLineId: string | null;
  amountCents: Cents;
  status: string;
}
export interface InvoiceInput {
  budgetLineId: string | null;
  amountCents: Cents;
  status: string;
}
export interface ChangeOrderInput {
  budgetLineId: string | null;
  /** A change to a contract also changes what's committed. */
  commitmentId?: string | null;
  amountCents: Cents;
  status: string;
}

export interface LineTotals {
  id: string;
  category: string;
  original: Cents;
  approvedChanges: Cents;
  revised: Cents;
  committed: Cents;
  /** Approved and paid invoices (what's been billed and accepted). */
  invoiced: Cents;
  paid: Cents;
  /** What the line will cost: the larger of the revised budget, what's committed, and what's been invoiced. */
  forecast: Cents;
  /** Revised budget minus forecast: negative means over budget. */
  variance: Cents;
}

const counts = (s: string) => s === "approved" || s === "paid";

/** A contract's value today: its amount plus approved change orders written against it. */
export function revisedCommitment(c: { id?: string; amountCents: Cents }, changes: readonly ChangeOrderInput[]): Cents {
  return c.amountCents + sum(changes.filter((x) => c.id && x.commitmentId === c.id && x.status === "approved").map((x) => x.amountCents));
}

/** The pseudo-line that collects anything not coded to a budget line yet, so the headline never drops it. */
export const UNCODED = "uncoded";

/**
 * What a line will cost: its revised budget, plus any overrun of what's been
 * committed or invoiced beyond it. A credit line (negative budget) stays a
 * credit unless money is spent against it.
 */
export function lineForecast(revised: Cents, committed: Cents, invoiced: Cents): Cents {
  const spent = Math.max(committed, invoiced);
  return revised + Math.max(0, spent - Math.max(revised, 0));
}

/**
 * Roll commitments (with their approved change orders), invoices and approved
 * change orders up into each budget line. Anything uncoded is gathered in an
 * extra "uncoded" row (only when there is some), so totals always include it.
 */
export function lineTotals(lines: readonly LineInput[], commitments: readonly CommitmentInput[], invoices: readonly InvoiceInput[], changes: readonly ChangeOrderInput[]): LineTotals[] {
  const row = (id: string | null, category: string, original: Cents): LineTotals => {
    assertCents(original, "original budget");
    const approvedChanges = sum(changes.filter((c) => c.budgetLineId === id && c.status === "approved").map((c) => c.amountCents));
    const revised = original + approvedChanges;
    const committed = sum(commitments.filter((c) => c.budgetLineId === id && c.status !== "draft").map((c) => revisedCommitment(c, changes)));
    const invoiced = sum(invoices.filter((i) => i.budgetLineId === id && counts(i.status)).map((i) => i.amountCents));
    const paid = sum(invoices.filter((i) => i.budgetLineId === id && i.status === "paid").map((i) => i.amountCents));
    const forecast = lineForecast(revised, committed, invoiced);
    return { id: id ?? UNCODED, category: id ? category : UNCODED, original, approvedChanges, revised, committed, invoiced, paid, forecast, variance: subtract(revised, forecast) };
  };
  const out = lines.map((l) => row(l.id, l.category, l.originalCents));
  const uncoded = row(null, UNCODED, 0);
  if (uncoded.revised || uncoded.committed || uncoded.invoiced || uncoded.paid) out.push(uncoded);
  return out;
}

export type Totals = Omit<LineTotals, "id" | "category">;

export function totalOf(rows: readonly Totals[]): Totals {
  const pick = (k: keyof Totals) => sum(rows.map((r) => r[k]));
  return { original: pick("original"), approvedChanges: pick("approvedChanges"), revised: pick("revised"), committed: pick("committed"), invoiced: pick("invoiced"), paid: pick("paid"), forecast: pick("forecast"), variance: pick("variance") };
}

export function byCategory(rows: readonly LineTotals[]): { category: string; totals: Totals; lines: LineTotals[] }[] {
  const keys = [...BUDGET_CATEGORIES.map((c) => c.key as string), ...new Set(rows.map((r) => r.category).filter((c) => !BUDGET_CATEGORIES.some((b) => b.key === c)))];
  return keys.map((category) => {
    const lines = rows.filter((r) => r.category === category);
    return { category, totals: totalOf(lines), lines };
  }).filter((g) => g.lines.length > 0);
}

/* ------------------------------------------------------------------ */
/* Sales                                                               */
/* ------------------------------------------------------------------ */

export interface UnitInput {
  sf: number | null;
  askCents: Cents | null;
  contractCents: Cents | null;
  status: UnitStatus;
}

/** A unit's expected price: the contract price once in contract or closed, otherwise the ask. */
export function unitExpected(u: UnitInput): Cents {
  if ((u.status === "contract" || u.status === "closed") && u.contractCents != null) return u.contractCents;
  return u.askCents ?? 0;
}

/** Price per square foot in whole cents (null without a price or area). */
export function perSf(priceCents: Cents | null, sf: number | null): Cents | null {
  if (priceCents == null || !sf || sf <= 0 || !Number.isSafeInteger(sf)) return null;
  return roundDiv(priceCents, sf);
}

export interface SalesSummary {
  units: number;
  sold: number;
  inContract: number;
  projectedSellout: Cents;
  closedCents: Cents;
  contractCents: Cents;
}

export function salesSummary(units: readonly UnitInput[]): SalesSummary {
  return {
    units: units.length,
    sold: units.filter((u) => u.status === "closed").length,
    inContract: units.filter((u) => u.status === "contract").length,
    projectedSellout: sum(units.map(unitExpected)),
    closedCents: sum(units.filter((u) => u.status === "closed").map((u) => u.contractCents ?? 0)),
    contractCents: sum(units.filter((u) => u.status === "contract").map((u) => u.contractCents ?? 0)),
  };
}

/* ------------------------------------------------------------------ */
/* Headline                                                            */
/* ------------------------------------------------------------------ */

export interface HeadlineInput {
  /** Use the budget lines for the total budget and forecast (else the typed figure). */
  useBudgetDetail?: boolean;
  /** Use the unit schedule for projected sellout (else the typed figure). */
  useSalesDetail?: boolean;
  purchasePriceCents: Cents | null;
  /** Entered by hand; used when there are no budget lines yet. */
  totalBudgetCents: Cents | null;
  /** Entered by hand; used when there's no unit schedule yet. */
  projectedSelloutCents: Cents | null;
  /** Senior debt (construction / acquisition loans). */
  loanAmountCents: Cents | null;
}

export interface Headline {
  purchasePrice: Cents | null;
  totalBudget: Cents | null;
  spentToDate: Cents;
  committed: Cents;
  forecastAtCompletion: Cents | null;
  projectedSellout: Cents | null;
  profit: Cents | null;
  /** Profit over sellout, basis points. */
  marginBps: number | null;
  equityRequired: Cents | null;
  /** (equity + profit) / equity, in thousandths. */
  equityMultipleMilli: number | null;
}

/**
 * The headline (brief §8). The budget total and forecast come from the budget
 * lines once they're switched on as the source (or when nothing was typed);
 * sellout likewise from the unit schedule. A half-entered budget or schedule
 * never silently replaces the typed figures.
 */
export function headline(h: HeadlineInput, budget: Totals | null, sales: SalesSummary | null): Headline {
  const hasBudget = !!budget && (h.useBudgetDetail || h.totalBudgetCents == null);
  const totalBudget = hasBudget ? budget!.revised : h.totalBudgetCents;
  const forecast = hasBudget ? budget!.forecast : h.totalBudgetCents;
  const hasSales = !!sales && sales.units > 0 && (h.useSalesDetail || h.projectedSelloutCents == null);
  const sellout = hasSales ? sales!.projectedSellout : h.projectedSelloutCents;
  const profit = sellout != null && forecast != null ? subtract(sellout, forecast) : null;
  const equity = forecast != null ? Math.max(0, subtract(forecast, h.loanAmountCents ?? 0)) : null;
  return {
    purchasePrice: h.purchasePriceCents,
    totalBudget,
    spentToDate: budget?.paid ?? 0,
    committed: budget?.committed ?? 0,
    forecastAtCompletion: forecast,
    projectedSellout: sellout,
    profit,
    marginBps: profit != null && sellout ? ratioBasisPoints(profit, sellout) : null,
    equityRequired: equity,
    // A loss bigger than the equity returns nothing: 0.00x, never a negative multiple.
    equityMultipleMilli: equity && profit != null ? equityMultipleMilli(Math.max(0, equity + profit), equity) : null,
  };
}

/* ------------------------------------------------------------------ */
/* Draws                                                               */
/* ------------------------------------------------------------------ */

export interface DrawLine {
  invoiceId: string;
  amountCents: Cents;
  /** Retainage withheld on this invoice, basis points (e.g. 1000 = 10%). */
  retainageBps: number;
}

export interface DrawTotals {
  gross: Cents;
  retainage: Cents;
  /** What the lender funds now. */
  net: Cents;
}

/** A requisition from approved invoices: gross, retainage held back, and the net requested. */
export function drawTotals(lines: readonly DrawLine[]): DrawTotals {
  const gross = sum(lines.map((l) => l.amountCents));
  const retainage = sum(lines.map((l) => applyBasisPoints(l.amountCents, l.retainageBps)));
  return { gross, retainage, net: subtract(gross, retainage) };
}

/** A draw can be submitted once every lien waiver on its checklist is in. */
export function lienWaiversComplete(waivers: readonly { received: boolean }[]): boolean {
  return waivers.every((w) => w.received);
}

/** Next status for a draw, or why not. */
export function nextDrawStatus(status: DrawStatus, facts: { invoices: number; waiversComplete: boolean; inspectorSigned: boolean }): { next: DrawStatus } | { blocked: string } | null {
  if (status === "draft") {
    if (facts.invoices === 0) return { blocked: "Add approved invoices first." };
    if (!facts.waiversComplete) return { blocked: "Every lien waiver must be in before submitting." };
    return { next: "submitted" };
  }
  if (status === "submitted") return facts.inspectorSigned ? { next: "inspector_approved" } : { blocked: "Record the lender inspector's sign-off first." };
  if (status === "inspector_approved") return { next: "funded" };
  return null;
}
