import "server-only";
import { asc, inArray } from "drizzle-orm";
import { headline, lineTotals, salesSummary, totalOf, type Headline, type LineTotals, type SalesSummary, type Totals } from "@/core/financials";
import { schema, type DbOrTx } from "../db";

export interface ProjectMoney {
  lines: (typeof schema.budgetLine.$inferSelect)[];
  totals: LineTotals[];
  budget: Totals | null;
  sales: SalesSummary | null;
  headline: Headline;
}

/**
 * Everything the financial headline needs, for many projects at once (portfolio
 * cards) or one (the Financials tab). Only ever called for projects the viewer
 * has financial visibility on.
 */
export async function projectMoney(conn: DbOrTx, projectIds: string[]): Promise<Map<string, ProjectMoney>> {
  const out = new Map<string, ProjectMoney>();
  if (projectIds.length === 0) return out;
  const [heads, lines, commitments, invoices, changes, units] = await Promise.all([
    conn.select().from(schema.projectHeadline).where(inArray(schema.projectHeadline.projectId, projectIds)),
    conn.select().from(schema.budgetLine).where(inArray(schema.budgetLine.projectId, projectIds)).orderBy(asc(schema.budgetLine.sortOrder), asc(schema.budgetLine.createdAt)),
    conn.select({ projectId: schema.commitment.projectId, budgetLineId: schema.commitment.budgetLineId, amountCents: schema.commitment.amountCents, status: schema.commitment.status }).from(schema.commitment).where(inArray(schema.commitment.projectId, projectIds)),
    conn.select({ projectId: schema.invoice.projectId, budgetLineId: schema.invoice.budgetLineId, amountCents: schema.invoice.amountCents, status: schema.invoice.status }).from(schema.invoice).where(inArray(schema.invoice.projectId, projectIds)),
    conn.select({ projectId: schema.changeOrder.projectId, budgetLineId: schema.changeOrder.budgetLineId, amountCents: schema.changeOrder.amountCents, status: schema.changeOrder.status }).from(schema.changeOrder).where(inArray(schema.changeOrder.projectId, projectIds)),
    conn.select({ projectId: schema.saleUnit.projectId, sf: schema.saleUnit.sf, askCents: schema.saleUnit.askCents, contractCents: schema.saleUnit.contractCents, status: schema.saleUnit.status }).from(schema.saleUnit).where(inArray(schema.saleUnit.projectId, projectIds)),
  ]);
  for (const id of projectIds) {
    const l = lines.filter((x) => x.projectId === id);
    const totals = lineTotals(
      l.map((x) => ({ id: x.id, category: x.category, originalCents: x.originalCents })),
      commitments.filter((x) => x.projectId === id),
      invoices.filter((x) => x.projectId === id),
      changes.filter((x) => x.projectId === id),
    );
    const budget = l.length ? totalOf(totals) : null;
    const u = units.filter((x) => x.projectId === id);
    const sales = u.length ? salesSummary(u) : null;
    const h = heads.find((x) => x.projectId === id);
    out.set(id, {
      lines: l,
      totals,
      budget,
      sales,
      headline: headline({ purchasePriceCents: h?.purchasePriceCents ?? null, totalBudgetCents: h?.totalBudgetCents ?? null, projectedSelloutCents: h?.projectedSelloutCents ?? null, loanAmountCents: h?.loanAmountCents ?? null }, budget, sales),
    });
  }
  return out;
}

/** The three figures portfolio cards show, computed (budget and sellout follow the detail once it exists). */
export async function cardHeadlines(conn: DbOrTx, projectIds: string[]) {
  const m = await projectMoney(conn, projectIds);
  return new Map(
    [...m].map(([id, x]) => [id, { purchasePriceCents: x.headline.purchasePrice, totalBudgetCents: x.headline.totalBudget, projectedSelloutCents: x.headline.projectedSellout }]),
  );
}

