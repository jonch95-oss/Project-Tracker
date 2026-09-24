import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { BUDGET_CATEGORIES, categoryLabel, drawTotals, revisedCommitment, lienWaiversComplete, nextDrawStatus, perSf, UNIT_STATUSES, type DrawStatus } from "@/core/financials";
import { formatMoney, sum } from "@/core/money";
import { todayET } from "@/core/time";
import { schema, type DbOrTx } from "../../db";
import { recordAudit } from "../../services/audit";
import { projectMoney } from "../../services/financials";
import { notify } from "../../services/tasks";
import { projectProcedure, router, type AuthedContext, type ProjectAccess } from "../init";

type Ctx = AuthedContext & { project: ProjectAccess };

/** $10 billion per amount: far above any real figure, and thousands of rows still total safely. */
const MAX_CENTS = 1_000_000_000_000;
const cents = z.number().int().min(-MAX_CENTS).max(MAX_CENTS);
const positive = z.number().int().min(0).max(MAX_CENTS);
const version = z.number().int().min(1);
const bps = z.number().int().min(0).max(10_000);
const date = z.iso.date();
const text = (max: number) => z.string().trim().max(max);

const conflict = (what: string) => new TRPCError({ code: "CONFLICT", message: `Someone else changed this ${what} a moment ago. It has been refreshed; try again.` });

/** Every financial audit entry uses an entity type the activity feed hides from people without financial access. */
async function audit(tx: DbOrTx, ctx: Ctx, entityType: "budget_line" | "commitment" | "invoice" | "change_order" | "draw" | "sale" | "project_headline", entityId: string, summary: string, action: "create" | "update" | "delete" | "approve" = "update", data?: unknown) {
  await recordAudit(tx, { actorId: ctx.viewer.id, actorName: ctx.viewer.name, action, entityType, entityId, projectId: ctx.project.projectId, summary, data, ip: ctx.ip });
}

/** Approvals of invoices and change orders (A): the owner, or anyone who sees the financials and may approve on the project. */
function canApproveMoney(ctx: Ctx): boolean {
  return ctx.actor.role === "owner" || (ctx.project.can("financials.view") && ctx.project.can("task.approve"));
}

/** Tell the people who can approve money that something is waiting (no dollar figures in notifications, brief §9). */
async function notifyMoneyApprovers(tx: DbOrTx, ctx: Ctx, title: string) {
  const rows = await tx
    .select({ id: schema.user.id, role: schema.user.role, fin: schema.projectMember.canViewFinancials, approve: schema.projectMember.canApprove })
    .from(schema.user)
    .leftJoin(schema.projectMember, and(eq(schema.projectMember.userId, schema.user.id), eq(schema.projectMember.projectId, ctx.project.projectId)))
    .where(and(eq(schema.user.status, "active"), sql`(${schema.user.role} = 'owner' or ${schema.projectMember.userId} is not null)`));
  const to = rows.filter((r) => r.role === "owner" || (r.fin && (r.approve || r.role === "admin")));
  await notify(tx, ctx.viewer.id, to.map((r) => ({ userId: r.id, kind: "approval_requested" as const, title, projectId: ctx.project.projectId, href: `/projects/${ctx.project.projectId}?tab=financials` })));
}

async function lineOnProject(tx: DbOrTx, projectId: string, id: string | null | undefined) {
  if (!id) return null;
  const [l] = await tx.select().from(schema.budgetLine).where(and(eq(schema.budgetLine.id, id), eq(schema.budgetLine.projectId, projectId)));
  if (!l) throw new TRPCError({ code: "BAD_REQUEST", message: "That budget line isn't on this project." });
  return l;
}

async function commitmentOnProject(tx: DbOrTx, projectId: string, id: string | null | undefined) {
  if (!id) return null;
  const [c] = await tx.select().from(schema.commitment).where(and(eq(schema.commitment.id, id), eq(schema.commitment.projectId, projectId)));
  if (!c) throw new TRPCError({ code: "BAD_REQUEST", message: "That commitment isn't on this project." });
  return c;
}

/** Invoice and contract PDFs live in the project's gated Financial folder. */
async function financialFile(tx: DbOrTx, projectId: string, fileId: string | null | undefined) {
  if (!fileId) return null;
  const [f] = await tx
    .select({ id: schema.file.id })
    .from(schema.file)
    .innerJoin(schema.folder, eq(schema.folder.id, schema.file.folderId))
    .where(and(eq(schema.file.id, fileId), eq(schema.file.projectId, projectId), eq(schema.folder.gated, true), isNull(schema.file.deletedAt)));
  if (!f) throw new TRPCError({ code: "BAD_REQUEST", message: "Attach a file from this project's Financial folder." });
  return f.id;
}

/** The next change-order or draw number. It never goes backwards, even after a delete (the number may already be on paper). */
async function nextNumber(tx: DbOrTx, table: typeof schema.changeOrder | typeof schema.draw, kind: "change_order" | "draw", projectId: string): Promise<number> {
  const [max] = await tx.select({ n: sql<number>`coalesce(max(${table.number}), 0)::int` }).from(table).where(eq(table.projectId, projectId));
  const [r] = await tx
    .insert(schema.projectSequence)
    .values({ projectId, kind, last: (max?.n ?? 0) + 1 })
    .onConflictDoUpdate({ target: [schema.projectSequence.projectId, schema.projectSequence.kind], set: { last: sql`greatest(${schema.projectSequence.last}, ${max?.n ?? 0}) + 1` } })
    .returning({ last: schema.projectSequence.last });
  return r!.last;
}

/** A contract's budget line wins: an invoice or change order against it is coded to the same line. */
function lineFor(input: string | null | undefined, commitment: { budgetLineId: string | null } | null): string | null {
  if (commitment?.budgetLineId) {
    if (input && input !== commitment.budgetLineId) throw new TRPCError({ code: "BAD_REQUEST", message: "That contract is coded to a different budget line. Leave the line on the contract's, or change the contract." });
    return commitment.budgetLineId;
  }
  return input ?? null;
}

/** Two people adding the same unit at once: the database's unique index decides; say so plainly. */
async function uniqueUnit<T>(unit: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const code = (e as { code?: string; cause?: { code?: string } }).cause?.code ?? (e as { code?: string }).code;
    if (code === "23505") throw new TRPCError({ code: "CONFLICT", message: `There's already a unit ${unit}.` });
    throw e;
  }
}

const lockDelete = (what: string) => new TRPCError({ code: "CONFLICT", message: `This ${what} changed or was removed a moment ago. It has been refreshed.` });

const lineInput = z.object({
  id: z.uuid().optional(),
  version: z.number().int().min(1).optional(),
  category: z.enum(BUDGET_CATEGORIES.map((c) => c.key) as [string, ...string[]]),
  name: text(120).min(1),
  originalCents: cents,
  notes: text(1000).nullish(),
});

const commitmentInput = z.object({
  id: z.uuid().optional(),
  version: z.number().int().min(1).optional(),
  budgetLineId: z.uuid().nullish(),
  vendorName: text(160).min(1),
  description: text(1000).nullish(),
  amountCents: positive,
  status: z.enum(["draft", "executed", "closed"]).default("executed"),
  signedOn: date.nullish(),
  retainageBps: bps.default(0),
  fileId: z.uuid().nullish(),
});

const invoiceInput = z.object({
  id: z.uuid().optional(),
  version: z.number().int().min(1).optional(),
  budgetLineId: z.uuid().nullish(),
  commitmentId: z.uuid().nullish(),
  vendorName: text(160).min(1),
  number: text(60).nullish(),
  invoiceDate: date.nullish(),
  amountCents: positive,
  retainageBps: bps.optional(),
  note: text(1000).nullish(),
  fileId: z.uuid().nullish(),
});

const changeInput = z.object({
  id: z.uuid().optional(),
  version: z.number().int().min(1).optional(),
  budgetLineId: z.uuid().nullish(),
  commitmentId: z.uuid().nullish(),
  description: text(1000).min(1),
  amountCents: cents,
  scheduleDays: z.number().int().min(-3650).max(3650).default(0),
  fileId: z.uuid().nullish(),
});

const unitInput = z.object({
  id: z.uuid().optional(),
  version: z.number().int().min(1).optional(),
  unit: text(40).min(1),
  floor: text(20).nullish(),
  sf: z.number().int().min(1).max(1_000_000).nullish(),
  beds: z.number().min(0).max(20).multipleOf(0.5).nullish(),
  baths: z.number().min(0).max(20).multipleOf(0.5).nullish(),
  askCents: positive.nullish(),
  contractCents: positive.nullish(),
  status: z.enum(UNIT_STATUSES),
  buyerName: text(160).nullish(),
  contractOn: date.nullish(),
  closingOn: date.nullish(),
});

export const financialsRouter = router({
  /** The whole Financials tab: headline, budget by category and line, and the registers. */
  overview: projectProcedure("financials.view").query(async ({ ctx, input }) => {
    const c = ctx as Ctx;
    const money = (await projectMoney(ctx.db, [input.projectId])).get(input.projectId)!;
    const [head] = await ctx.db.select().from(schema.projectHeadline).where(eq(schema.projectHeadline.projectId, input.projectId));
    const [commitments, invoices, changes, draws, units] = await Promise.all([
      ctx.db.select().from(schema.commitment).where(eq(schema.commitment.projectId, input.projectId)).orderBy(asc(schema.commitment.vendorName), asc(schema.commitment.createdAt)),
      ctx.db.select().from(schema.invoice).where(eq(schema.invoice.projectId, input.projectId)).orderBy(desc(schema.invoice.createdAt)),
      ctx.db.select().from(schema.changeOrder).where(eq(schema.changeOrder.projectId, input.projectId)).orderBy(asc(schema.changeOrder.number)),
      ctx.db.select().from(schema.draw).where(eq(schema.draw.projectId, input.projectId)).orderBy(asc(schema.draw.number)),
      ctx.db.select().from(schema.saleUnit).where(eq(schema.saleUnit.projectId, input.projectId)).orderBy(asc(schema.saleUnit.sortOrder), asc(schema.saleUnit.unit)),
    ]);
    const lineName = new Map(money.lines.map((l) => [l.id, `${categoryLabel(l.category)} · ${l.name}`]));
    const commitmentBilled = new Map<string, number>();
    for (const i of invoices) if (i.commitmentId && (i.status === "approved" || i.status === "paid")) commitmentBilled.set(i.commitmentId, (commitmentBilled.get(i.commitmentId) ?? 0) + i.amountCents);
    return {
      headline: money.headline,
      typed: {
        purchasePriceCents: head?.purchasePriceCents ?? null,
        totalBudgetCents: head?.totalBudgetCents ?? null,
        projectedSelloutCents: head?.projectedSelloutCents ?? null,
        loanAmountCents: head?.loanAmountCents ?? null,
        useBudgetDetail: head?.useBudgetDetail ?? false,
        useSalesDetail: head?.useSalesDetail ?? false,
        version: head?.version ?? 0,
      },
      sources: {
        budgetFromLines: !!money.budget && ((head?.useBudgetDetail ?? false) || head?.totalBudgetCents == null),
        selloutFromUnits: !!money.sales && money.sales.units > 0 && ((head?.useSalesDetail ?? false) || head?.projectedSelloutCents == null),
      },
      broken: money.broken,
      budget: money.budget,
      lines: money.lines.map((l) => ({ ...l, totals: money.totals.find((t) => t.id === l.id)! })),
      uncoded: money.totals.find((t) => t.id === "uncoded") ?? null,
      commitments: commitments.map((x) => ({
        ...x,
        lineName: x.budgetLineId ? (lineName.get(x.budgetLineId) ?? null) : null,
        billedCents: commitmentBilled.get(x.id) ?? 0,
        revisedCents: revisedCommitment(x, changes),
      })),
      invoices: invoices.map((x) => ({ ...x, lineName: x.budgetLineId ? (lineName.get(x.budgetLineId) ?? null) : null })),
      changeOrders: changes.map((x) => ({ ...x, lineName: x.budgetLineId ? (lineName.get(x.budgetLineId) ?? null) : null })),
      draws: draws.map((d) => {
        const on = invoices.filter((i) => i.drawId === d.id);
        return { ...d, invoiceIds: on.map((i) => i.id), totals: drawTotals(on.map((i) => ({ invoiceId: i.id, amountCents: i.amountCents, retainageBps: i.retainageBps }))) };
      }),
      units: units.map((u) => ({ ...u, askPerSf: perSf(u.askCents, u.sf), contractPerSf: perSf(u.contractCents, u.sf) })),
      // Retainage withheld on submitted and funded draws, owed to vendors at completion.
      retainageHeldCents: sum(
        draws.filter((d) => d.status !== "draft").map((d) => drawTotals(invoices.filter((i) => i.drawId === d.id).map((i) => ({ invoiceId: i.id, amountCents: i.amountCents, retainageBps: i.retainageBps }))).retainage),
      ),
      sales: money.sales,
      access: { canEdit: ctx.project.can("financials.edit"), canApprove: canApproveMoney(c), canExport: ctx.actor.role === "owner" },
    };
  }),

  saveHeadline: projectProcedure("financials.edit")
    .input(
      z.object({
        version: z.number().int().min(0),
        purchasePriceCents: positive.nullable(),
        totalBudgetCents: positive.nullable(),
        projectedSelloutCents: positive.nullable(),
        loanAmountCents: positive.nullable(),
        useBudgetDetail: z.boolean(),
        useSalesDetail: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      await ctx.db.transaction(async (tx) => {
        const { projectId, version: expected, ...values } = input;
        const [cur] = await tx.select().from(schema.projectHeadline).where(eq(schema.projectHeadline.projectId, projectId)).for("update");
        if ((cur?.version ?? 0) !== expected) throw conflict("headline");
        if (cur) await tx.update(schema.projectHeadline).set({ ...values, version: sql`${schema.projectHeadline.version} + 1`, updatedAt: new Date() }).where(eq(schema.projectHeadline.projectId, projectId));
        else await tx.insert(schema.projectHeadline).values({ projectId, ...values });
        await audit(tx, c, "project_headline", projectId, `${ctx.viewer.name} updated the headline figures`, "update", values);
      });
      return { ok: true };
    }),

  /* ---------------- budget ---------------- */

  saveLine: projectProcedure("financials.edit")
    .input(lineInput)
    .mutation(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      return ctx.db.transaction(async (tx) => {
        const values = { category: input.category, name: input.name, originalCents: input.originalCents, notes: input.notes ?? null };
        if (input.id) {
          const r = await tx
            .update(schema.budgetLine)
            .set({ ...values, version: sql`${schema.budgetLine.version} + 1`, updatedAt: new Date() })
            .where(and(eq(schema.budgetLine.id, input.id), eq(schema.budgetLine.projectId, input.projectId), eq(schema.budgetLine.version, input.version ?? 0)))
            .returning({ id: schema.budgetLine.id });
          if (!r.length) throw conflict("budget line");
          await audit(tx, c, "budget_line", input.id, `${ctx.viewer.name} updated ${values.name}: ${formatMoney(values.originalCents)}`);
          return { id: input.id };
        }
        const [max] = await tx.select({ m: sql<number>`coalesce(max(${schema.budgetLine.sortOrder}), -1)::int` }).from(schema.budgetLine).where(and(eq(schema.budgetLine.projectId, input.projectId), eq(schema.budgetLine.category, input.category)));
        const [row] = await tx.insert(schema.budgetLine).values({ ...values, projectId: input.projectId, sortOrder: (max?.m ?? -1) + 1 }).returning({ id: schema.budgetLine.id });
        await audit(tx, c, "budget_line", row!.id, `${ctx.viewer.name} added ${values.name} (${categoryLabel(values.category)}): ${formatMoney(values.originalCents)}`, "create");
        return { id: row!.id };
      });
    }),

  /** A line with commitments, invoices or change orders on it can't be removed (they'd lose their coding). */
  deleteLine: projectProcedure("financials.edit")
    .input(z.object({ id: z.uuid(), version }))
    .mutation(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      return ctx.db.transaction(async (tx) => {
        // Lock the line: anything being coded to it right now waits, then sees it gone.
        const [l] = await tx.select().from(schema.budgetLine).where(and(eq(schema.budgetLine.id, input.id), eq(schema.budgetLine.projectId, input.projectId))).for("update");
        if (!l || l.version !== input.version) throw lockDelete("budget line");
        const used = await tx.execute<{ n: number }>(sql`select (
          (select count(*) from ${schema.commitment} where budget_line_id = ${input.id}) +
          (select count(*) from ${schema.invoice} where budget_line_id = ${input.id}) +
          (select count(*) from ${schema.changeOrder} where budget_line_id = ${input.id}))::int as n`);
        if ((used.rows[0]?.n ?? 0) > 0) throw new TRPCError({ code: "BAD_REQUEST", message: "Commitments, invoices or change orders are coded to this line. Re-code them first." });
        await tx.delete(schema.budgetLine).where(eq(schema.budgetLine.id, input.id));
        await audit(tx, c, "budget_line", input.id, `${ctx.viewer.name} removed the budget line ${l.name}`, "delete");
        return { ok: true };
      });
    }),

  /** Seed a budget with one line per category so there's somewhere to start. */
  startBudget: projectProcedure("financials.edit").mutation(async ({ ctx, input }) => {
    const c = ctx as Ctx;
    return ctx.db.transaction(async (tx) => {
      const [n] = await tx.select({ n: sql<number>`count(*)::int` }).from(schema.budgetLine).where(eq(schema.budgetLine.projectId, input.projectId));
      if ((n?.n ?? 0) > 0) return { created: 0 };
      await tx.insert(schema.budgetLine).values(BUDGET_CATEGORIES.map((cat) => ({ projectId: input.projectId, category: cat.key, name: cat.label, originalCents: 0 })));
      await audit(tx, c, "budget_line", input.projectId, `${ctx.viewer.name} started the budget`, "create");
      return { created: BUDGET_CATEGORIES.length };
    });
  }),

  /* ---------------- commitments ---------------- */

  saveCommitment: projectProcedure("financials.edit")
    .input(commitmentInput)
    .mutation(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      return ctx.db.transaction(async (tx) => {
        await lineOnProject(tx, input.projectId, input.budgetLineId);
        const values = {
          budgetLineId: input.budgetLineId ?? null,
          vendorName: input.vendorName,
          description: input.description ?? null,
          amountCents: input.amountCents,
          status: input.status,
          signedOn: input.signedOn ?? null,
          retainageBps: input.retainageBps,
          fileId: await financialFile(tx, input.projectId, input.fileId),
        };
        if (input.id) {
          const r = await tx
            .update(schema.commitment)
            .set({ ...values, version: sql`${schema.commitment.version} + 1`, updatedAt: new Date() })
            .where(and(eq(schema.commitment.id, input.id), eq(schema.commitment.projectId, input.projectId), eq(schema.commitment.version, input.version ?? 0)))
            .returning({ id: schema.commitment.id });
          if (!r.length) throw conflict("commitment");
          await audit(tx, c, "commitment", input.id, `${ctx.viewer.name} updated the ${values.vendorName} commitment: ${formatMoney(values.amountCents)}`);
          return { id: input.id };
        }
        const [row] = await tx.insert(schema.commitment).values({ ...values, projectId: input.projectId, createdById: ctx.viewer.id }).returning({ id: schema.commitment.id });
        await audit(tx, c, "commitment", row!.id, `${ctx.viewer.name} added a ${formatMoney(values.amountCents)} commitment with ${values.vendorName}`, "create");
        return { id: row!.id };
      });
    }),

  deleteCommitment: projectProcedure("financials.edit")
    .input(z.object({ id: z.uuid(), version }))
    .mutation(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      return ctx.db.transaction(async (tx) => {
        const [x] = await tx.select().from(schema.commitment).where(and(eq(schema.commitment.id, input.id), eq(schema.commitment.projectId, input.projectId))).for("update");
        if (!x || x.version !== input.version) throw lockDelete("commitment");
        const used = await tx.execute<{ n: number }>(sql`select ((select count(*) from ${schema.invoice} where commitment_id = ${input.id}) + (select count(*) from ${schema.changeOrder} where commitment_id = ${input.id}))::int as n`);
        if ((used.rows[0]?.n ?? 0) > 0) throw new TRPCError({ code: "BAD_REQUEST", message: "Invoices or change orders are written against this contract. Close it instead." });
        await tx.delete(schema.commitment).where(eq(schema.commitment.id, input.id));
        await audit(tx, c, "commitment", input.id, `${ctx.viewer.name} removed the ${x.vendorName} commitment`, "delete");
        return { ok: true };
      });
    }),

  /* ---------------- invoices ---------------- */

  /** Record or correct an invoice. Once approved it's locked (send it back to change it). */
  saveInvoice: projectProcedure("financials.edit")
    .input(invoiceInput)
    .mutation(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      return ctx.db.transaction(async (tx) => {
        await lineOnProject(tx, input.projectId, input.budgetLineId);
        const commitment = await commitmentOnProject(tx, input.projectId, input.commitmentId);
        const values = {
          budgetLineId: lineFor(input.budgetLineId, commitment),
          commitmentId: commitment?.id ?? null,
          vendorName: input.vendorName,
          number: input.number ?? null,
          invoiceDate: input.invoiceDate ?? null,
          amountCents: input.amountCents,
          retainageBps: input.retainageBps ?? commitment?.retainageBps ?? 0,
          note: input.note ?? null,
          fileId: await financialFile(tx, input.projectId, input.fileId),
        };
        if (input.id) {
          const [cur] = await tx.select().from(schema.invoice).where(and(eq(schema.invoice.id, input.id), eq(schema.invoice.projectId, input.projectId)));
          if (!cur) throw new TRPCError({ code: "NOT_FOUND" });
          if (cur.status !== "received" && cur.status !== "rejected") throw new TRPCError({ code: "BAD_REQUEST", message: "Approved and paid invoices are locked." });
          const r = await tx
            .update(schema.invoice)
            .set({ ...values, status: "received", version: sql`${schema.invoice.version} + 1`, updatedAt: new Date() })
            .where(and(eq(schema.invoice.id, input.id), eq(schema.invoice.version, input.version ?? 0)))
            .returning({ id: schema.invoice.id });
          if (!r.length) throw conflict("invoice");
          await audit(tx, c, "invoice", input.id, `${ctx.viewer.name} updated invoice ${values.number ?? ""} from ${values.vendorName}: ${formatMoney(values.amountCents)}`.replace("  ", " "));
          if (cur.status === "rejected") await notifyMoneyApprovers(tx, c, `The invoice from ${values.vendorName} was corrected and needs approval`);
          return { id: input.id };
        }
        const [row] = await tx.insert(schema.invoice).values({ ...values, projectId: input.projectId, createdById: ctx.viewer.id }).returning({ id: schema.invoice.id });
        await audit(tx, c, "invoice", row!.id, `${ctx.viewer.name} logged a ${formatMoney(values.amountCents)} invoice from ${values.vendorName}`, "create");
        await notifyMoneyApprovers(tx, c, `An invoice from ${values.vendorName} needs approval`);
        return { id: row!.id };
      });
    }),

  /** Approve (A) or reject with a note. Must be coded to a budget line first. */
  decideInvoice: projectProcedure("financials.view")
    .input(z.object({ id: z.uuid(), version: z.number().int().min(1), decision: z.enum(["approved", "rejected"]), note: text(1000).optional() }))
    .mutation(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      if (!canApproveMoney(c)) throw new TRPCError({ code: "FORBIDDEN", message: "Only someone who can approve financials can do this." });
      return ctx.db.transaction(async (tx) => {
        const [inv] = await tx.select().from(schema.invoice).where(and(eq(schema.invoice.id, input.id), eq(schema.invoice.projectId, input.projectId)));
        if (!inv) throw new TRPCError({ code: "NOT_FOUND" });
        if (inv.status !== "received") throw new TRPCError({ code: "CONFLICT", message: "This invoice was already decided. It has been refreshed." });
        if (input.decision === "approved" && !inv.budgetLineId) throw new TRPCError({ code: "BAD_REQUEST", message: "Code it to a budget line before approving." });
        if (input.decision === "rejected" && !input.note) throw new TRPCError({ code: "BAD_REQUEST", message: "Add a note saying why." });
        const r = await tx
          .update(schema.invoice)
          .set({ status: input.decision, decisionNote: input.note ?? null, decidedById: ctx.viewer.id, decidedAt: new Date(), version: sql`${schema.invoice.version} + 1`, updatedAt: new Date() })
          .where(and(eq(schema.invoice.id, inv.id), eq(schema.invoice.version, input.version)))
          .returning({ id: schema.invoice.id });
        if (!r.length) throw conflict("invoice");
        await audit(tx, c, "invoice", inv.id, `${ctx.viewer.name} ${input.decision} the ${formatMoney(inv.amountCents)} invoice from ${inv.vendorName}`, "approve");
        return { ok: true };
      });
    }),

  markPaid: projectProcedure("financials.edit")
    .input(z.object({ id: z.uuid(), version: z.number().int().min(1), paidOn: date.nullable() }))
    .mutation(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      return ctx.db.transaction(async (tx) => {
        const [inv] = await tx.select().from(schema.invoice).where(and(eq(schema.invoice.id, input.id), eq(schema.invoice.projectId, input.projectId)));
        if (!inv) throw new TRPCError({ code: "NOT_FOUND" });
        const paying = input.paidOn !== null;
        if (paying && inv.status !== "approved") throw new TRPCError({ code: "BAD_REQUEST", message: "Only approved invoices can be marked paid." });
        if (!paying && inv.status !== "paid") throw new TRPCError({ code: "BAD_REQUEST", message: "It isn't marked paid." });
        if (!paying && inv.drawId) {
          const [d] = await tx.select({ status: schema.draw.status }).from(schema.draw).where(eq(schema.draw.id, inv.drawId));
          if (d && d.status !== "draft") throw new TRPCError({ code: "BAD_REQUEST", message: "This invoice is on a submitted draw." });
        }
        const r = await tx
          .update(schema.invoice)
          .set({ status: paying ? "paid" : "approved", paidOn: input.paidOn, version: sql`${schema.invoice.version} + 1`, updatedAt: new Date() })
          .where(and(eq(schema.invoice.id, inv.id), eq(schema.invoice.version, input.version)))
          .returning({ id: schema.invoice.id });
        if (!r.length) throw conflict("invoice");
        await audit(tx, c, "invoice", inv.id, paying ? `${ctx.viewer.name} marked the ${inv.vendorName} invoice paid on ${input.paidOn}` : `${ctx.viewer.name} unmarked the ${inv.vendorName} invoice as paid`);
        return { ok: true };
      });
    }),

  deleteInvoice: projectProcedure("financials.edit")
    .input(z.object({ id: z.uuid(), version }))
    .mutation(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      return ctx.db.transaction(async (tx) => {
        const [inv] = await tx.select().from(schema.invoice).where(and(eq(schema.invoice.id, input.id), eq(schema.invoice.projectId, input.projectId))).for("update");
        if (!inv || inv.version !== input.version) throw lockDelete("invoice");
        if (inv.status === "approved" || inv.status === "paid" || inv.drawId) throw new TRPCError({ code: "BAD_REQUEST", message: "Approved, paid or drawn invoices can't be deleted." });
        await tx.delete(schema.invoice).where(eq(schema.invoice.id, inv.id));
        await audit(tx, c, "invoice", inv.id, `${ctx.viewer.name} deleted the ${formatMoney(inv.amountCents)} invoice from ${inv.vendorName}`, "delete");
        return { ok: true };
      });
    }),

  /**
   * Send an approved, paid or rejected invoice back to "to approve" so it can
   * be corrected (an approval can be wrong). Not once it's on a submitted draw.
   */
  reopenInvoice: projectProcedure("financials.view")
    .input(z.object({ id: z.uuid(), version, note: text(1000).min(1) }))
    .mutation(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      if (!canApproveMoney(c)) throw new TRPCError({ code: "FORBIDDEN", message: "Only someone who can approve financials can do this." });
      return ctx.db.transaction(async (tx) => {
        const [inv] = await tx.select().from(schema.invoice).where(and(eq(schema.invoice.id, input.id), eq(schema.invoice.projectId, input.projectId))).for("update");
        if (!inv || inv.version !== input.version) throw lockDelete("invoice");
        if (inv.status === "received") return { ok: true };
        if (inv.drawId) {
          const [d] = await tx.select({ status: schema.draw.status }).from(schema.draw).where(eq(schema.draw.id, inv.drawId));
          if (d && d.status !== "draft") throw new TRPCError({ code: "BAD_REQUEST", message: "This invoice is on a submitted draw; it can't be reopened." });
        }
        await tx
          .update(schema.invoice)
          .set({ status: "received", paidOn: null, drawId: null, decisionNote: input.note, decidedById: null, decidedAt: null, version: sql`${schema.invoice.version} + 1`, updatedAt: new Date() })
          .where(eq(schema.invoice.id, inv.id));
        await audit(tx, c, "invoice", inv.id, `${ctx.viewer.name} reopened the ${formatMoney(inv.amountCents)} invoice from ${inv.vendorName}: ${input.note}`, "update");
        return { ok: true };
      });
    }),

  /* ---------------- change orders ---------------- */

  saveChangeOrder: projectProcedure("financials.edit")
    .input(changeInput)
    .mutation(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      return ctx.db.transaction(async (tx) => {
        await lineOnProject(tx, input.projectId, input.budgetLineId);
        const commitment = await commitmentOnProject(tx, input.projectId, input.commitmentId);
        const values = {
          budgetLineId: lineFor(input.budgetLineId, commitment),
          commitmentId: commitment?.id ?? null,
          description: input.description,
          amountCents: input.amountCents,
          scheduleDays: input.scheduleDays,
          fileId: await financialFile(tx, input.projectId, input.fileId),
        };
        if (input.id) {
          const [cur] = await tx.select().from(schema.changeOrder).where(and(eq(schema.changeOrder.id, input.id), eq(schema.changeOrder.projectId, input.projectId)));
          if (!cur) throw new TRPCError({ code: "NOT_FOUND" });
          if (cur.status === "approved") throw new TRPCError({ code: "BAD_REQUEST", message: "Approved change orders are locked. Issue a new one to adjust." });
          const r = await tx
            .update(schema.changeOrder)
            .set({ ...values, status: "pending", version: sql`${schema.changeOrder.version} + 1`, updatedAt: new Date() })
            .where(and(eq(schema.changeOrder.id, input.id), eq(schema.changeOrder.version, input.version ?? 0)))
            .returning({ id: schema.changeOrder.id });
          if (!r.length) throw conflict("change order");
          await audit(tx, c, "change_order", input.id, `${ctx.viewer.name} updated CO #${cur.number}: ${formatMoney(values.amountCents)}`);
          return { id: input.id };
        }
        // Serialize numbering per project.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"co:" + input.projectId}))`);
        const number = await nextNumber(tx, schema.changeOrder, "change_order", input.projectId);
        const [row] = await tx.insert(schema.changeOrder).values({ ...values, number, projectId: input.projectId, createdById: ctx.viewer.id }).returning({ id: schema.changeOrder.id });
        await audit(tx, c, "change_order", row!.id, `${ctx.viewer.name} raised CO #${number}: ${formatMoney(values.amountCents)}${values.scheduleDays ? `, ${values.scheduleDays} days` : ""}`, "create");
        await notifyMoneyApprovers(tx, c, `Change order #${number} needs approval`);
        return { id: row!.id, number };
      });
    }),

  /** Approve (A): updates the revised budget of its line. */
  decideChangeOrder: projectProcedure("financials.view")
    .input(z.object({ id: z.uuid(), version: z.number().int().min(1), decision: z.enum(["approved", "rejected"]), note: text(1000).optional() }))
    .mutation(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      if (!canApproveMoney(c)) throw new TRPCError({ code: "FORBIDDEN", message: "Only someone who can approve financials can do this." });
      return ctx.db.transaction(async (tx) => {
        const [co] = await tx.select().from(schema.changeOrder).where(and(eq(schema.changeOrder.id, input.id), eq(schema.changeOrder.projectId, input.projectId)));
        if (!co) throw new TRPCError({ code: "NOT_FOUND" });
        if (co.status !== "pending") throw new TRPCError({ code: "CONFLICT", message: "This change order was already decided. It has been refreshed." });
        if (input.decision === "approved" && !co.budgetLineId) throw new TRPCError({ code: "BAD_REQUEST", message: "Code it to a budget line before approving." });
        if (input.decision === "rejected" && !input.note) throw new TRPCError({ code: "BAD_REQUEST", message: "Add a note saying why." });
        const r = await tx
          .update(schema.changeOrder)
          .set({ status: input.decision, decisionNote: input.note ?? null, decidedById: ctx.viewer.id, decidedAt: new Date(), version: sql`${schema.changeOrder.version} + 1`, updatedAt: new Date() })
          .where(and(eq(schema.changeOrder.id, co.id), eq(schema.changeOrder.version, input.version)))
          .returning({ id: schema.changeOrder.id });
        if (!r.length) throw conflict("change order");
        await audit(tx, c, "change_order", co.id, `${ctx.viewer.name} ${input.decision} CO #${co.number} (${formatMoney(co.amountCents)})`, "approve");
        return { ok: true };
      });
    }),

  deleteChangeOrder: projectProcedure("financials.edit")
    .input(z.object({ id: z.uuid(), version }))
    .mutation(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      return ctx.db.transaction(async (tx) => {
        const [co] = await tx.select().from(schema.changeOrder).where(and(eq(schema.changeOrder.id, input.id), eq(schema.changeOrder.projectId, input.projectId))).for("update");
        if (!co || co.version !== input.version) throw lockDelete("change order");
        if (co.status === "approved") throw new TRPCError({ code: "BAD_REQUEST", message: "Approved change orders can't be deleted." });
        await tx.delete(schema.changeOrder).where(eq(schema.changeOrder.id, co.id));
        await audit(tx, c, "change_order", co.id, `${ctx.viewer.name} deleted CO #${co.number}`, "delete");
        return { ok: true };
      });
    }),

  /* ---------------- draws ---------------- */

  /** A new draft draw (requisition), numbered in order. */
  createDraw: projectProcedure("financials.edit")
    .input(z.object({ periodEnd: date.nullish() }))
    .mutation(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      return ctx.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"draw:" + input.projectId}))`);
        const open = await tx.select({ id: schema.draw.id }).from(schema.draw).where(and(eq(schema.draw.projectId, input.projectId), eq(schema.draw.status, "draft")));
        if (open.length) throw new TRPCError({ code: "BAD_REQUEST", message: "Finish the draft draw first." });
        const number = await nextNumber(tx, schema.draw, "draw", input.projectId);
        const [row] = await tx.insert(schema.draw).values({ projectId: input.projectId, number, periodEnd: input.periodEnd ?? todayET() }).returning({ id: schema.draw.id });
        await audit(tx, c, "draw", row!.id, `${ctx.viewer.name} started draw #${number}`, "create");
        return { id: row!.id, number };
      });
    }),

  /**
   * Edit a draft draw: which approved invoices it requisitions, the lien
   * waiver checklist (one per vendor, kept as invoices change), inspector
   * sign-off and notes.
   */
  updateDraw: projectProcedure("financials.edit")
    .input(
      z.object({
        id: z.uuid(),
        version: z.number().int().min(1),
        invoiceIds: z.array(z.uuid()).max(500).optional(),
        lienWaivers: z.array(z.object({ vendor: text(160).min(1), received: z.boolean() })).max(200).optional(),
        inspectorName: text(160).nullish(),
        inspectorSignedOn: date.nullish(),
        periodEnd: date.nullish(),
        notes: text(2000).nullish(),
        fundedCents: positive.nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      return ctx.db.transaction(async (tx) => {
        const [d] = await tx.select().from(schema.draw).where(and(eq(schema.draw.id, input.id), eq(schema.draw.projectId, input.projectId))).for("update");
        if (!d) throw new TRPCError({ code: "NOT_FOUND" });
        if (d.version !== input.version) throw conflict("draw");
        const set: Partial<typeof schema.draw.$inferInsert> = {};
        const status = d.status as DrawStatus;
        const key = (v: string) => v.trim().toLowerCase();
        let waivers = d.lienWaivers;
        if (input.invoiceIds !== undefined) {
          if (status !== "draft") throw new TRPCError({ code: "BAD_REQUEST", message: "A submitted draw's invoices are locked." });
          const ids = [...new Set(input.invoiceIds)];
          const rows = ids.length ? await tx.select().from(schema.invoice).where(and(eq(schema.invoice.projectId, input.projectId), inArray(schema.invoice.id, ids))).for("update") : [];
          if (rows.length !== ids.length) throw new TRPCError({ code: "BAD_REQUEST", message: "Some of those invoices aren't on this project." });
          const bad = rows.find((i) => (i.status !== "approved" && i.status !== "paid") || (i.drawId && i.drawId !== d.id));
          if (bad) throw new TRPCError({ code: "BAD_REQUEST", message: `The ${bad.vendorName} invoice isn't approved or is already on another draw.` });
          await tx.update(schema.invoice).set({ drawId: null }).where(and(eq(schema.invoice.drawId, d.id)));
          if (ids.length) await tx.update(schema.invoice).set({ drawId: d.id }).where(inArray(schema.invoice.id, ids));
          // One lien waiver per vendor on the draw (names matched loosely); keep what's already been received.
          const vendors = new Map<string, string>();
          for (const r of rows) if (!vendors.has(key(r.vendorName))) vendors.set(key(r.vendorName), r.vendorName.trim());
          waivers = [...vendors].sort((a, b) => a[1].localeCompare(b[1])).map(([k, v]) => ({ vendor: v, received: waivers.find((w) => key(w.vendor) === k)?.received ?? false }));
          set.lienWaivers = waivers;
        }
        if (input.lienWaivers !== undefined) {
          // Only tick or untick the vendors already on the checklist; it can't be replaced or emptied.
          if (status !== "draft") throw new TRPCError({ code: "BAD_REQUEST", message: "Lien waivers are locked once the draw is submitted." });
          set.lienWaivers = waivers.map((w) => ({ ...w, received: input.lienWaivers!.find((x) => key(x.vendor) === key(w.vendor))?.received ?? w.received }));
        }
        const inspectorLocked = status === "inspector_approved" || status === "funded";
        if ((input.inspectorName !== undefined && (input.inspectorName ?? null) !== d.inspectorName) || (input.inspectorSignedOn !== undefined && (input.inspectorSignedOn ?? null) !== d.inspectorSignedOn)) {
          if (inspectorLocked) throw new TRPCError({ code: "BAD_REQUEST", message: "The inspector's sign-off is locked once recorded." });
          if (input.inspectorName !== undefined) set.inspectorName = input.inspectorName ?? null;
          if (input.inspectorSignedOn !== undefined) set.inspectorSignedOn = input.inspectorSignedOn ?? null;
        }
        if (input.periodEnd !== undefined && (input.periodEnd ?? null) !== d.periodEnd) {
          if (status !== "draft") throw new TRPCError({ code: "BAD_REQUEST", message: "The period is locked once the draw is submitted." });
          set.periodEnd = input.periodEnd ?? null;
        }
        if (input.notes !== undefined) set.notes = input.notes ?? null;
        if (input.fundedCents !== undefined && (input.fundedCents ?? null) !== d.fundedCents) {
          if (status === "draft") throw new TRPCError({ code: "BAD_REQUEST", message: "Record the funded amount after the draw is submitted." });
          set.fundedCents = input.fundedCents ?? null;
        }
        const [r] = await tx.update(schema.draw).set({ ...set, version: sql`${schema.draw.version} + 1`, updatedAt: new Date() }).where(eq(schema.draw.id, d.id)).returning({ version: schema.draw.version });
        await audit(tx, c, "draw", d.id, `${ctx.viewer.name} updated draw #${d.number}`, "update", { changed: Object.keys(set), invoices: input.invoiceIds?.length });
        return { version: r!.version };
      });
    }),

  /** Move a draw along: submitted (all waivers in) → inspector signed off → funded. */
  advanceDraw: projectProcedure("financials.edit")
    .input(z.object({ id: z.uuid(), version: z.number().int().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      return ctx.db.transaction(async (tx) => {
        const [d] = await tx.select().from(schema.draw).where(and(eq(schema.draw.id, input.id), eq(schema.draw.projectId, input.projectId))).for("update");
        if (!d) throw new TRPCError({ code: "NOT_FOUND" });
        if (d.version !== input.version) throw conflict("draw");
        const [n] = await tx.select({ n: sql<number>`count(*)::int` }).from(schema.invoice).where(eq(schema.invoice.drawId, d.id));
        const step = nextDrawStatus(d.status as DrawStatus, { invoices: n?.n ?? 0, waiversComplete: lienWaiversComplete(d.lienWaivers), inspectorSigned: !!d.inspectorSignedOn });
        if (!step) throw new TRPCError({ code: "BAD_REQUEST", message: "This draw is already funded." });
        if ("blocked" in step) throw new TRPCError({ code: "PRECONDITION_FAILED", message: step.blocked });
        const today = todayET();
        const [r] = await tx
          .update(schema.draw)
          .set({ status: step.next, ...(step.next === "submitted" ? { submittedOn: today } : {}), ...(step.next === "funded" ? { fundedOn: today } : {}), version: sql`${schema.draw.version} + 1`, updatedAt: new Date() })
          .where(eq(schema.draw.id, d.id))
          .returning({ version: schema.draw.version });
        await audit(tx, c, "draw", d.id, `${ctx.viewer.name} moved draw #${d.number} to ${step.next.replace("_", " ")}`);
        return { version: r!.version, status: step.next };
      });
    }),

  deleteDraw: projectProcedure("financials.edit")
    .input(z.object({ id: z.uuid(), version }))
    .mutation(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      return ctx.db.transaction(async (tx) => {
        const [d] = await tx.select().from(schema.draw).where(and(eq(schema.draw.id, input.id), eq(schema.draw.projectId, input.projectId))).for("update");
        if (!d || d.version !== input.version) throw lockDelete("draw");
        if (d.status !== "draft") throw new TRPCError({ code: "BAD_REQUEST", message: "Only draft draws can be deleted." });
        await tx.update(schema.invoice).set({ drawId: null }).where(eq(schema.invoice.drawId, d.id));
        await tx.delete(schema.draw).where(eq(schema.draw.id, d.id));
        await audit(tx, c, "draw", d.id, `${ctx.viewer.name} deleted draft draw #${d.number}`, "delete");
        return { ok: true };
      });
    }),

  /* ---------------- sales ---------------- */

  saveUnit: projectProcedure("financials.edit")
    .input(unitInput)
    .mutation(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      if ((input.status === "contract" || input.status === "closed") && input.contractCents == null) throw new TRPCError({ code: "BAD_REQUEST", message: "Enter the contract price." });
      return uniqueUnit(input.unit, () => ctx.db.transaction(async (tx) => {
        const values = {
          unit: input.unit,
          floor: input.floor ?? null,
          sf: input.sf ?? null,
          beds: input.beds ?? null,
          baths: input.baths ?? null,
          askCents: input.askCents ?? null,
          contractCents: input.contractCents ?? null,
          status: input.status,
          buyerName: input.buyerName ?? null,
          contractOn: input.contractOn ?? null,
          closingOn: input.closingOn ?? null,
        };
        const clash = await tx
          .select({ id: schema.saleUnit.id })
          .from(schema.saleUnit)
          .where(and(eq(schema.saleUnit.projectId, input.projectId), sql`lower(${schema.saleUnit.unit}) = lower(${input.unit})`, input.id ? sql`${schema.saleUnit.id} <> ${input.id}` : undefined));
        if (clash.length) throw new TRPCError({ code: "CONFLICT", message: `There's already a unit ${input.unit}.` });
        if (input.id) {
          const r = await tx
            .update(schema.saleUnit)
            .set({ ...values, version: sql`${schema.saleUnit.version} + 1`, updatedAt: new Date() })
            .where(and(eq(schema.saleUnit.id, input.id), eq(schema.saleUnit.projectId, input.projectId), eq(schema.saleUnit.version, input.version ?? 0)))
            .returning({ id: schema.saleUnit.id });
          if (!r.length) throw conflict("unit");
          await audit(tx, c, "sale", input.id, `${ctx.viewer.name} updated unit ${values.unit}`);
          return { id: input.id };
        }
        const [max] = await tx.select({ m: sql<number>`coalesce(max(${schema.saleUnit.sortOrder}), -1)::int` }).from(schema.saleUnit).where(eq(schema.saleUnit.projectId, input.projectId));
        const [row] = await tx.insert(schema.saleUnit).values({ ...values, projectId: input.projectId, sortOrder: (max?.m ?? -1) + 1 }).returning({ id: schema.saleUnit.id });
        await audit(tx, c, "sale", row!.id, `${ctx.viewer.name} added unit ${values.unit}`, "create");
        return { id: row!.id };
      }));
    }),

  deleteUnit: projectProcedure("financials.edit")
    .input(z.object({ id: z.uuid(), version }))
    .mutation(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      return ctx.db.transaction(async (tx) => {
        const [u] = await tx.delete(schema.saleUnit).where(and(eq(schema.saleUnit.id, input.id), eq(schema.saleUnit.projectId, input.projectId), eq(schema.saleUnit.version, input.version))).returning();
        if (!u) throw lockDelete("unit");
        await audit(tx, c, "sale", u.id, `${ctx.viewer.name} removed unit ${u.unit}`, "delete");
        return { ok: true };
      });
    }),
});
