import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { allocate } from "@/core/money";
import { canProject } from "@/core/permissions";
import { todayET } from "@/core/time";
import { capitalAccount, computeDistribution, DEFAULT_TIERS, describeTiers, tierProblems, type InvestorPosition, type Tier } from "@/core/waterfall";
import { schema, type DbOrTx } from "../../db";
import { INVESTOR_KINDS } from "../../db/schema/app";
import { recordAudit } from "../../services/audit";
import { nextSequence } from "../../services/sequence";
import { notify } from "../../services/tasks";
import { planDate } from "../dates";
import { projectProcedure, router, type AuthedContext, type ProjectAccess } from "../init";

type Ctx = AuthedContext & { project: ProjectAccess };
const cents = z.number().int().min(0).max(1_000_000_000_000);
const text = (max: number) => z.string().trim().max(max);
const conflict = () => new TRPCError({ code: "CONFLICT", message: "Someone else just changed this. Reload to see the latest." });
const fmt = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

const tierSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pref"), rateBps: z.number().int() }),
  z.object({ kind: z.literal("return_of_capital") }),
  z.object({ kind: z.literal("split"), lpBps: z.number().int(), untilMultipleMilli: z.number().int().nullable() }),
]);

async function audit(tx: DbOrTx, c: Ctx, action: "create" | "update" | "delete", entityType: string, entityId: string, summary: string) {
  // Capital records are financial: the audit entry is hidden from people without financial access.
  await recordAudit(tx, { actorId: c.viewer.id, actorName: c.viewer.name, action, entityType, entityId, projectId: c.project.projectId, summary, ip: c.ip });
}

export async function projectTiers(conn: DbOrTx, projectId: string): Promise<{ tiers: Tier[]; version: number; custom: boolean }> {
  const [t] = await conn.select().from(schema.capitalTerms).where(eq(schema.capitalTerms.projectId, projectId));
  return t ? { tiers: t.tiers, version: t.version, custom: true } : { tiers: DEFAULT_TIERS, version: 0, custom: false };
}

/**
 * Every investor's position on a project: contributions as received on
 * calls, distributions as recorded, commitments and calls. The one place the
 * waterfall, the accounts and the portal read from.
 */
export async function loadCapital(conn: DbOrTx, projectId: string) {
  const commitments = await conn
    .select({ c: schema.capitalCommitment, inv: schema.investor })
    .from(schema.capitalCommitment)
    .innerJoin(schema.investor, eq(schema.investor.id, schema.capitalCommitment.investorId))
    .where(eq(schema.capitalCommitment.projectId, projectId))
    .orderBy(asc(schema.investor.name));
  const calls = await conn.select().from(schema.capitalCall).where(eq(schema.capitalCall.projectId, projectId)).orderBy(asc(schema.capitalCall.number));
  const callItems = calls.length ? await conn.select().from(schema.capitalCallItem).where(inArray(schema.capitalCallItem.callId, calls.map((c) => c.id))) : [];
  const dists = await conn.select().from(schema.distribution).where(eq(schema.distribution.projectId, projectId)).orderBy(asc(schema.distribution.number));
  const distItems = dists.length ? await conn.select().from(schema.distributionItem).where(inArray(schema.distributionItem.distributionId, dists.map((d) => d.id))) : [];
  const positions: InvestorPosition[] = commitments.map(({ inv }) => ({
    investorId: inv.id,
    contributions: callItems.filter((i) => i.investorId === inv.id && i.receivedCents > 0).map((i) => ({ on: i.receivedOn ?? calls.find((c) => c.id === i.callId)!.dueOn, cents: i.receivedCents })),
    distributions: distItems.filter((i) => i.investorId === inv.id).map((i) => ({ on: dists.find((d) => d.id === i.distributionId)!.paidOn, roc: i.rocCents, pref: i.prefCents, profit: i.profitCents })),
  }));
  const called = (investorId: string) => callItems.filter((i) => i.investorId === investorId).reduce((a, i) => a + i.amountCents, 0);
  return { commitments, calls, callItems, dists, distItems, positions, called };
}

/**
 * An investor record is shared by every project they're in: changing it
 * (name, email, portal login) needs the owner or financial edit rights on
 * all of those projects, so nobody rewires an account on a project they
 * can't see.
 */
async function assertCanEditInvestor(tx: DbOrTx, c: Ctx, investorId: string) {
  if (c.actor.role === "owner") return;
  const on = await tx
    .select({ projectId: schema.capitalCommitment.projectId, m: schema.projectMember })
    .from(schema.capitalCommitment)
    .leftJoin(schema.projectMember, and(eq(schema.projectMember.projectId, schema.capitalCommitment.projectId), eq(schema.projectMember.userId, c.viewer.id)))
    .where(eq(schema.capitalCommitment.investorId, investorId));
  if (on.some((r) => !canProject(c.actor, r.m, "financials.edit"))) {
    throw new TRPCError({ code: "FORBIDDEN", message: "This investor is on projects you can't edit. Ask the owner to change their details." });
  }
}

async function upsertCommitment(tx: DbOrTx, projectId: string, investorId: string, committedCents: number, version?: number) {
  const [existing] = await tx.select().from(schema.capitalCommitment).where(and(eq(schema.capitalCommitment.projectId, projectId), eq(schema.capitalCommitment.investorId, investorId)));
  if (existing) {
    if (version !== undefined && existing.version !== version) throw conflict();
    await tx.update(schema.capitalCommitment).set({ committedCents, version: existing.version + 1 }).where(eq(schema.capitalCommitment.id, existing.id));
  } else {
    await tx.insert(schema.capitalCommitment).values({ projectId, investorId, committedCents });
  }
  return !!existing;
}

/** Portal logins linked to these investors that are on the project with the capital flag (they hear about calls and distributions). */
async function portalAudience(tx: DbOrTx, projectId: string, investorIds: string[]): Promise<string[]> {
  if (investorIds.length === 0) return [];
  const rows = await tx
    .select({ userId: schema.investor.userId })
    .from(schema.investor)
    .innerJoin(schema.projectMember, and(eq(schema.projectMember.userId, schema.investor.userId), eq(schema.projectMember.projectId, projectId), eq(schema.projectMember.canViewFinancials, true)))
    .where(inArray(schema.investor.id, investorIds));
  return [...new Set(rows.map((r) => r.userId!).filter(Boolean))];
}

export const capitalRouter = router({
  /** The Capital section of Financials: terms, accounts, calls and distributions. */
  overview: projectProcedure("financials.view").query(async ({ ctx, input }) => {
    const c = ctx as Ctx;
    const today = todayET();
    const terms = await projectTiers(ctx.db, input.projectId);
    const cap = await loadCapital(ctx.db, input.projectId);
    const accounts = cap.commitments.map(({ c: com, inv }) => ({
      commitmentId: com.id,
      commitmentVersion: com.version,
      investor: { id: inv.id, name: inv.name, kind: inv.kind, contactName: inv.contactName, email: inv.email, userId: inv.userId, notes: inv.notes, version: inv.version },
      account: capitalAccount({ committed: com.committedCents, called: cap.called(inv.id), position: cap.positions.find((p) => p.investorId === inv.id)!, tiers: terms.tiers, asOf: today }),
    }));
    const canEdit = c.project.can("financials.edit");
    const allInvestors = canEdit ? await ctx.db.select({ id: schema.investor.id, name: schema.investor.name, kind: schema.investor.kind }).from(schema.investor).orderBy(asc(schema.investor.name)) : [];
    const portalUsers = canEdit ? await ctx.db.select({ id: schema.user.id, name: schema.user.name, email: schema.user.email }).from(schema.user).where(and(eq(schema.user.role, "investor"), eq(schema.user.status, "active"))).orderBy(asc(schema.user.name)) : [];
    const name = new Map(cap.commitments.map(({ inv }) => [inv.id, inv.name]));
    return {
      terms: { ...terms, description: describeTiers(terms.tiers) },
      accounts,
      totals: {
        committed: accounts.reduce((a, x) => a + x.account.committed, 0),
        contributed: accounts.reduce((a, x) => a + x.account.contributed, 0),
        distributed: accounts.reduce((a, x) => a + x.account.distributed, 0) + cap.dists.reduce((a, d) => a + d.gpCents, 0),
        promote: cap.dists.reduce((a, d) => a + d.gpCents, 0),
      },
      calls: [...cap.calls].reverse().map((call) => ({
        ...call,
        items: cap.callItems.filter((i) => i.callId === call.id).map((i) => ({ ...i, investorName: name.get(i.investorId) ?? "Investor" })),
      })),
      distributions: [...cap.dists].reverse().map((d) => ({ ...d, items: cap.distItems.filter((i) => i.distributionId === d.id).map((i) => ({ ...i, investorName: name.get(i.investorId) ?? "Investor" })) })),
      allInvestors,
      portalUsers,
      canEdit,
    };
  }),

  saveTerms: projectProcedure("financials.edit")
    .input(z.object({ tiers: z.array(tierSchema).min(1).max(8), version: z.number().int().min(0) }))
    .mutation(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      const problems = tierProblems(input.tiers);
      if (problems.length) throw new TRPCError({ code: "BAD_REQUEST", message: problems[0]! });
      return ctx.db.transaction(async (tx) => {
        const [cur] = await tx.select().from(schema.capitalTerms).where(eq(schema.capitalTerms.projectId, input.projectId)).for("update");
        if ((cur?.version ?? 0) !== input.version) throw conflict();
        if (cur) await tx.update(schema.capitalTerms).set({ tiers: input.tiers, version: cur.version + 1, updatedAt: new Date() }).where(eq(schema.capitalTerms.projectId, input.projectId));
        else await tx.insert(schema.capitalTerms).values({ projectId: input.projectId, tiers: input.tiers });
        await audit(tx, c, "update", "capital_terms", input.projectId, `${c.viewer.name} set the distribution waterfall: ${describeTiers(input.tiers).join("; ")}`);
        return { ok: true };
      });
    }),

  /** Add or edit an investor (shared across projects) and set their commitment here. */
  saveInvestor: projectProcedure("financials.edit")
    .input(
      z.object({
        investorId: z.uuid().optional(),
        version: z.number().int().min(1).optional(),
        name: text(160).min(1),
        kind: z.enum(INVESTOR_KINDS),
        contactName: text(160).nullish(),
        email: z.union([z.email().max(200), z.literal("")]).nullish(),
        userId: z.string().max(64).nullish(),
        notes: text(2000).nullish(),
        committedCents: cents,
        commitmentVersion: z.number().int().min(1).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      return ctx.db.transaction(async (tx) => {
        if (input.userId) {
          const [u] = await tx.select({ role: schema.user.role }).from(schema.user).where(eq(schema.user.id, input.userId));
          if (!u || u.role !== "investor") throw new TRPCError({ code: "BAD_REQUEST", message: "Link a portal login: a person invited with the Investor role." });
        }
        const values = { name: input.name, kind: input.kind, contactName: input.contactName || null, email: input.email ? input.email.toLowerCase() : null, userId: input.userId ?? null, notes: input.notes || null };
        let investorId = input.investorId;
        if (investorId) {
          await assertCanEditInvestor(tx, c, investorId);
          const [row] = await tx
            .update(schema.investor)
            .set({ ...values, version: sql`${schema.investor.version} + 1`, updatedAt: new Date() })
            .where(and(eq(schema.investor.id, investorId), eq(schema.investor.version, input.version ?? 0)))
            .returning({ id: schema.investor.id });
          if (!row) throw conflict();
        } else {
          const [row] = await tx.insert(schema.investor).values(values).returning({ id: schema.investor.id });
          investorId = row!.id;
        }
        const existed = await upsertCommitment(tx, input.projectId, investorId, input.committedCents, input.commitmentVersion);
        await audit(tx, c, existed ? "update" : "create", "capital_commitment", investorId, `${c.viewer.name} set ${input.name}'s commitment to ${fmt(input.committedCents)}`);
        return { investorId };
      });
    }),

  /** Bring an investor already in another project in, or change a commitment, without touching their shared record. */
  setCommitment: projectProcedure("financials.edit")
    .input(z.object({ investorId: z.uuid(), committedCents: cents, commitmentVersion: z.number().int().min(1).optional() }))
    .mutation(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      return ctx.db.transaction(async (tx) => {
        const [inv] = await tx.select({ id: schema.investor.id, name: schema.investor.name }).from(schema.investor).where(eq(schema.investor.id, input.investorId));
        if (!inv) throw new TRPCError({ code: "NOT_FOUND", message: "Investor not found" });
        const existed = await upsertCommitment(tx, input.projectId, inv.id, input.committedCents, input.commitmentVersion);
        await audit(tx, c, existed ? "update" : "create", "capital_commitment", inv.id, `${c.viewer.name} set ${inv.name}'s commitment to ${fmt(input.committedCents)}`);
        return { investorId: inv.id };
      });
    }),

  /** Take an investor off this project (only before any money has moved). */
  removeInvestor: projectProcedure("financials.edit")
    .input(z.object({ investorId: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      return ctx.db.transaction(async (tx) => {
        const cap = await loadCapital(tx, input.projectId);
        if (cap.callItems.some((i) => i.investorId === input.investorId) || cap.distItems.some((i) => i.investorId === input.investorId)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "This investor has calls or distributions here, so they stay on the record." });
        }
        await tx.delete(schema.capitalCommitment).where(and(eq(schema.capitalCommitment.projectId, input.projectId), eq(schema.capitalCommitment.investorId, input.investorId)));
        await audit(tx, c, "delete", "capital_commitment", input.investorId, `${c.viewer.name} removed an investor from this project`);
        return { ok: true };
      });
    }),

  /** A capital call: the total is split by commitment unless amounts are given per investor. */
  createCall: projectProcedure("financials.edit")
    .input(z.object({ noticeOn: planDate, dueOn: planDate, note: text(1000).nullish(), totalCents: cents.optional(), items: z.array(z.object({ investorId: z.uuid(), amountCents: cents })).max(200).optional() }))
    .mutation(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      if (input.dueOn < input.noticeOn) throw new TRPCError({ code: "BAD_REQUEST", message: "The due date comes after the notice." });
      return ctx.db.transaction(async (tx) => {
        const cap = await loadCapital(tx, input.projectId);
        if (cap.commitments.length === 0) throw new TRPCError({ code: "BAD_REQUEST", message: "Add investors and their commitments first." });
        const onProject = new Set(cap.commitments.map((x) => x.inv.id));
        let items: { investorId: string; amountCents: number }[];
        if (input.items?.length) {
          if (input.items.some((i) => !onProject.has(i.investorId))) throw new TRPCError({ code: "BAD_REQUEST", message: "That investor isn't on this project." });
          items = input.items.filter((i) => i.amountCents > 0);
        } else {
          const total = input.totalCents ?? 0;
          const weights = cap.commitments.map((x) => x.c.committedCents);
          if (total <= 0 || weights.every((w) => w === 0)) throw new TRPCError({ code: "BAD_REQUEST", message: "Enter the amount to call." });
          const parts = allocate(total, weights);
          items = cap.commitments.map((x, k) => ({ investorId: x.inv.id, amountCents: parts[k]! })).filter((i) => i.amountCents > 0);
        }
        if (items.length === 0) throw new TRPCError({ code: "BAD_REQUEST", message: "Enter the amount to call." });
        const number = await nextSequence(tx, input.projectId, "capital_call", cap.calls.at(-1)?.number ?? 0);
        const [call] = await tx.insert(schema.capitalCall).values({ projectId: input.projectId, number, noticeOn: input.noticeOn, dueOn: input.dueOn, note: input.note || null, createdById: c.viewer.id }).returning();
        await tx.insert(schema.capitalCallItem).values(items.map((i) => ({ callId: call!.id, investorId: i.investorId, amountCents: i.amountCents })));
        const total = items.reduce((a, i) => a + i.amountCents, 0);
        await audit(tx, c, "create", "capital_call", call!.id, `${c.viewer.name} issued capital call #${number} for ${fmt(total)}, due ${input.dueOn}`);
        const [p] = await tx.select({ name: schema.project.name }).from(schema.project).where(eq(schema.project.id, input.projectId));
        const audience = await portalAudience(tx, input.projectId, items.map((i) => i.investorId));
        await notify(tx, c.viewer.id, audience.map((userId) => ({ userId, kind: "comment" as const, title: `Capital call #${number}: ${p!.name}`, body: `Due ${input.dueOn}. Your amount is in your capital account.`, projectId: input.projectId, href: `/portal/${input.projectId}` })));
        return { id: call!.id, number };
      });
    }),

  recordReceipt: projectProcedure("financials.edit")
    .input(z.object({ itemId: z.uuid(), version: z.number().int().min(1), receivedCents: cents, receivedOn: planDate.nullable() }))
    .mutation(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      if (input.receivedCents > 0 && !input.receivedOn) throw new TRPCError({ code: "BAD_REQUEST", message: "Enter the day it was received." });
      if (input.receivedOn && input.receivedOn > todayET()) throw new TRPCError({ code: "BAD_REQUEST", message: "A receipt can't be in the future." });
      return ctx.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`capital:${input.projectId}`}))`);
        const [row] = await tx
          .select({ item: schema.capitalCallItem, number: schema.capitalCall.number })
          .from(schema.capitalCallItem)
          .innerJoin(schema.capitalCall, eq(schema.capitalCall.id, schema.capitalCallItem.callId))
          .where(and(eq(schema.capitalCallItem.id, input.itemId), eq(schema.capitalCall.projectId, input.projectId)));
        if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Not found" });
        if (row.item.version !== input.version) throw conflict();
        // Distributions were split knowing what had come in by then: a receipt they relied on can't change under them.
        const touched = [row.item.receivedCents > 0 ? row.item.receivedOn : null, input.receivedCents > 0 ? input.receivedOn : null].filter((x): x is string => !!x).sort()[0];
        if (touched) {
          const [later] = await tx
            .select({ number: schema.distribution.number, paidOn: schema.distribution.paidOn })
            .from(schema.distribution)
            .where(and(eq(schema.distribution.projectId, input.projectId), sql`${schema.distribution.paidOn} >= ${touched}`))
            .orderBy(asc(schema.distribution.paidOn))
            .limit(1);
          if (later) throw new TRPCError({ code: "BAD_REQUEST", message: `Distribution #${later.number} (${later.paidOn}) was split using this money. Remove the later distributions first.` });
        }
        await tx.update(schema.capitalCallItem).set({ receivedCents: input.receivedCents, receivedOn: input.receivedCents > 0 ? input.receivedOn : null, version: row.item.version + 1 }).where(eq(schema.capitalCallItem.id, row.item.id));
        await audit(tx, c, "update", "capital_call", row.item.callId, `${c.viewer.name} recorded ${fmt(input.receivedCents)} received on capital call #${row.number}`);
        return { ok: true };
      });
    }),

  deleteCall: projectProcedure("financials.edit")
    .input(z.object({ id: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      return ctx.db.transaction(async (tx) => {
        const [call] = await tx.select().from(schema.capitalCall).where(and(eq(schema.capitalCall.id, input.id), eq(schema.capitalCall.projectId, input.projectId)));
        if (!call) throw new TRPCError({ code: "NOT_FOUND", message: "Not found" });
        const [paid] = await tx.select({ n: sql<number>`count(*)::int` }).from(schema.capitalCallItem).where(and(eq(schema.capitalCallItem.callId, call.id), sql`${schema.capitalCallItem.receivedCents} > 0`));
        if ((paid?.n ?? 0) > 0) throw new TRPCError({ code: "BAD_REQUEST", message: "Money has come in on this call. Clear the receipts first." });
        await tx.delete(schema.capitalCall).where(eq(schema.capitalCall.id, call.id));
        await audit(tx, c, "delete", "capital_call", call.id, `${c.viewer.name} withdrew capital call #${call.number}`);
        return { ok: true };
      });
    }),

  /** What the waterfall would pay for an amount on a day (nothing is saved). */
  previewDistribution: projectProcedure("financials.edit")
    .input(z.object({ amountCents: cents.min(1), paidOn: planDate }))
    .query(async ({ ctx, input }) => {
      const terms = await projectTiers(ctx.db, input.projectId);
      const cap = await loadCapital(ctx.db, input.projectId);
      const r = computeDistribution({ amount: input.amountCents, on: input.paidOn, tiers: terms.tiers, investors: cap.positions });
      const name = new Map(cap.commitments.map(({ inv }) => [inv.id, inv.name]));
      return { ...r, shares: r.shares.map((s) => ({ ...s, investorName: name.get(s.investorId) ?? "Investor" })) };
    }),

  /** Record a distribution exactly as the waterfall splits it on that day. */
  recordDistribution: projectProcedure("financials.edit")
    .input(z.object({ amountCents: cents.min(1), paidOn: planDate, note: text(1000).nullish() }))
    .mutation(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      if (input.paidOn > todayET()) throw new TRPCError({ code: "BAD_REQUEST", message: "Record a distribution once it's paid (today or earlier)." });
      return ctx.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`capital:${input.projectId}`}))`);
        const cap = await loadCapital(tx, input.projectId);
        const last = cap.dists.at(-1);
        // The waterfall reads everything paid before: distributions are recorded in date order.
        if (last && input.paidOn < last.paidOn) throw new TRPCError({ code: "BAD_REQUEST", message: `Distributions go in date order; the last one was ${last.paidOn}.` });
        if (cap.positions.length === 0) throw new TRPCError({ code: "BAD_REQUEST", message: "Add investors first." });
        const terms = await projectTiers(tx, input.projectId);
        const r = computeDistribution({ amount: input.amountCents, on: input.paidOn, tiers: terms.tiers, investors: cap.positions });
        if (r.unallocated > 0) throw new TRPCError({ code: "BAD_REQUEST", message: "The waterfall can't place all of it. Check the tiers." });
        const number = await nextSequence(tx, input.projectId, "distribution", last?.number ?? 0);
        const [d] = await tx.insert(schema.distribution).values({ projectId: input.projectId, number, paidOn: input.paidOn, totalCents: input.amountCents, gpCents: r.gp, note: input.note || null, createdById: c.viewer.id }).returning();
        const rows = r.shares.filter((s) => s.roc + s.pref + s.profit > 0).map((s) => ({ distributionId: d!.id, investorId: s.investorId, rocCents: s.roc, prefCents: s.pref, profitCents: s.profit }));
        if (rows.length) await tx.insert(schema.distributionItem).values(rows);
        await audit(tx, c, "create", "distribution", d!.id, `${c.viewer.name} recorded distribution #${number}: ${fmt(input.amountCents)} on ${input.paidOn}`);
        const [p] = await tx.select({ name: schema.project.name }).from(schema.project).where(eq(schema.project.id, input.projectId));
        const audience = await portalAudience(tx, input.projectId, rows.map((x) => x.investorId));
        await notify(tx, c.viewer.id, audience.map((userId) => ({ userId, kind: "comment" as const, title: `Distribution #${number}: ${p!.name}`, body: `Paid ${input.paidOn}. Your share is in your capital account.`, projectId: input.projectId, href: `/portal/${input.projectId}` })));
        return { id: d!.id, number };
      });
    }),

  /** Only the latest distribution can be undone (later ones were split knowing it). */
  deleteDistribution: projectProcedure("financials.edit")
    .input(z.object({ id: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      const c = ctx as Ctx;
      return ctx.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`capital:${input.projectId}`}))`);
        const [latest] = await tx.select().from(schema.distribution).where(eq(schema.distribution.projectId, input.projectId)).orderBy(desc(schema.distribution.number)).limit(1);
        if (!latest || latest.id !== input.id) throw new TRPCError({ code: "BAD_REQUEST", message: "Only the latest distribution can be removed." });
        await tx.delete(schema.distribution).where(eq(schema.distribution.id, latest.id));
        await audit(tx, c, "delete", "distribution", latest.id, `${c.viewer.name} removed distribution #${latest.number}`);
        return { ok: true };
      });
    }),
});
