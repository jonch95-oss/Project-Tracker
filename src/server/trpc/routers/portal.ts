import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { forecast, slippageLabel } from "@/core/schedule";
import { todayET } from "@/core/time";
import { capitalAccount, describeTiers } from "@/core/waterfall";
import { schema, type DbOrTx } from "../../db";
import { currentBaseline, loadScheduleTasks, slippageFor } from "../../services/field";
import { canSeePhotos, projectsWithSharedPhotos } from "../../services/files";
import { z } from "zod";
import { planDate } from "../dates";
import { projectProcedure, protectedProcedure, router, type AuthedContext } from "../init";
import { loadCapital, projectTiers } from "./capital";

/** Phase progress: where the project is and how far along. */
async function phaseSummary(conn: DbOrTx, projectIds: string[]) {
  if (projectIds.length === 0) return new Map<string, { current: string | null; done: number; total: number; phases: { name: string; status: string }[] }>();
  const rows = await conn
    .select({ projectId: schema.projectPhase.projectId, name: schema.projectPhase.name, status: schema.projectPhase.status })
    .from(schema.projectPhase)
    .where(inArray(schema.projectPhase.projectId, projectIds))
    .orderBy(asc(schema.projectPhase.sortOrder));
  const out = new Map<string, { current: string | null; done: number; total: number; phases: { name: string; status: string }[] }>();
  for (const id of projectIds) {
    const mine = rows.filter((r) => r.projectId === id && r.status !== "skipped");
    out.set(id, { current: mine.find((p) => p.status === "active")?.name ?? null, done: mine.filter((p) => p.status === "done").length, total: mine.length, phases: mine.map((p) => ({ name: p.name, status: p.status })) });
  }
  return out;
}

/** The portal is for investors and lenders (and the internal team, to see what they see); outside collaborators work in the project itself. */
function portalViewer(ctx: AuthedContext) {
  if (ctx.actor.role === "external") throw new TRPCError({ code: "FORBIDDEN", message: "The portal is for investors and lenders." });
}

/** The investor records this login is linked to. */
async function myInvestorIds(conn: DbOrTx, userId: string): Promise<string[]> {
  return (await conn.select({ id: schema.investor.id }).from(schema.investor).where(eq(schema.investor.userId, userId))).map((r) => r.id);
}

async function myAccounts(conn: DbOrTx, projectId: string, investorIds: string[]) {
  if (investorIds.length === 0) return [];
  const cap = await loadCapital(conn, projectId);
  const terms = await projectTiers(conn, projectId);
  const today = todayET();
  return cap.commitments
    .filter(({ inv }) => investorIds.includes(inv.id))
    .map(({ c, inv }) => ({
      investorName: inv.name,
      account: capitalAccount({ committed: c.committedCents, called: cap.called(inv.id), position: cap.positions.find((p) => p.investorId === inv.id)!, tiers: terms.tiers, asOf: today }),
      calls: cap.calls
        .flatMap((call) => cap.callItems.filter((i) => i.callId === call.id && i.investorId === inv.id).map((i) => ({ number: call.number, noticeOn: call.noticeOn, dueOn: call.dueOn, amountCents: i.amountCents, receivedCents: i.receivedCents, receivedOn: i.receivedOn })))
        .reverse(),
      distributions: cap.dists
        .flatMap((d) => cap.distItems.filter((i) => i.distributionId === d.id && i.investorId === inv.id).map((i) => ({ number: d.number, paidOn: d.paidOn, rocCents: i.rocCents, prefCents: i.prefCents, profitCents: i.profitCents })))
        .reverse(),
      waterfall: describeTiers(terms.tiers),
    }));
}

export const portalRouter = router({
  /** Module J: the projects this investor or lender was given, with where each stands. */
  list: protectedProcedure.query(async ({ ctx }) => {
    const c = ctx as AuthedContext;
    portalViewer(c);
    const rows = await ctx.db
      .select({ p: schema.project, fin: schema.projectMember.canViewFinancials })
      .from(schema.projectMember)
      .innerJoin(schema.project, eq(schema.project.id, schema.projectMember.projectId))
      .where(and(eq(schema.projectMember.userId, c.viewer.id), isNull(schema.project.archivedAt)))
      .orderBy(asc(schema.project.name));
    const ids = rows.map((r) => r.p.id);
    const phases = await phaseSummary(ctx.db, ids);
    const slip = await slippageFor(ctx.db, ids);
    const photosOk = await projectsWithSharedPhotos(ctx.db, c.viewer.id, ids);
    const heroes = photosOk.size
      ? await ctx.db
          .select({ projectId: schema.projectPhoto.projectId, id: schema.projectPhoto.id, createdAt: schema.projectPhoto.createdAt })
          .from(schema.projectPhoto)
          .where(inArray(schema.projectPhoto.projectId, [...photosOk]))
          .orderBy(desc(schema.projectPhoto.createdAt))
      : [];
    const investorIds = await myInvestorIds(ctx.db, c.viewer.id);
    const out = [];
    for (const { p, fin } of rows) {
      const accounts = fin ? await myAccounts(ctx.db, p.id, investorIds) : [];
      out.push({
        id: p.id,
        name: p.name,
        address: p.address,
        borough: p.borough,
        type: p.type,
        phase: phases.get(p.id)!,
        slippage: slippageLabel(slip.get(p.id) ?? null),
        heroPhotoId: photosOk.has(p.id) ? (p.heroPhotoId ?? heroes.find((h) => h.projectId === p.id)?.id ?? null) : null,
        capital: accounts.length ? { committed: accounts.reduce((a, x) => a + x.account.committed, 0), contributed: accounts.reduce((a, x) => a + x.account.contributed, 0), distributed: accounts.reduce((a, x) => a + x.account.distributed, 0) } : null,
      });
    }
    return out;
  }),

  /** One project: progress, schedule status, recent photos and (with the flag) the viewer's own capital account. */
  project: projectProcedure().query(async ({ ctx, input }) => {
    const c = ctx as AuthedContext & { project: import("../init").ProjectAccess };
    portalViewer(c);
    const [p] = await ctx.db.select().from(schema.project).where(eq(schema.project.id, input.projectId));
    const phase = (await phaseSummary(ctx.db, [input.projectId])).get(input.projectId)!;
    const tasks = await loadScheduleTasks(ctx.db, input.projectId);
    const fc = forecast(tasks, todayET());
    const baseline = await currentBaseline(ctx.db, input.projectId);
    const slip = (await slippageFor(ctx.db, [input.projectId])).get(input.projectId) ?? null;
    const [counts] = await ctx.db
      .select({ total: sql<number>`count(*)::int`, done: sql<number>`(count(*) filter (where ${schema.task.status} = 'done'))::int` })
      .from(schema.task)
      .where(eq(schema.task.projectId, input.projectId));
    const photosOk = await canSeePhotos(ctx.db, c.project, c.viewer.id);
    const photos = photosOk
      ? await ctx.db
          .select({ id: schema.projectPhoto.id, caption: schema.projectPhoto.caption, takenAt: schema.projectPhoto.takenAt, createdAt: schema.projectPhoto.createdAt, width: schema.projectPhoto.width, height: schema.projectPhoto.height })
          .from(schema.projectPhoto)
          .where(eq(schema.projectPhoto.projectId, input.projectId))
          .orderBy(desc(schema.projectPhoto.createdAt))
          .limit(24)
      : [];
    const [m] = await ctx.db.select({ fin: schema.projectMember.canViewFinancials }).from(schema.projectMember).where(and(eq(schema.projectMember.projectId, input.projectId), eq(schema.projectMember.userId, c.viewer.id)));
    const accounts = m?.fin ? await myAccounts(ctx.db, input.projectId, await myInvestorIds(ctx.db, c.viewer.id)) : [];
    return {
      project: { id: p!.id, name: p!.name, address: p!.address, borough: p!.borough, type: p!.type, heroPhotoId: photosOk ? (p!.heroPhotoId ?? photos[0]?.id ?? null) : null },
      phase,
      progress: counts && counts.total > 0 ? Math.round((counts.done / counts.total) * 100) : 0,
      schedule: { forecastFinish: fc.finish, baselineFinish: baseline?.finishOn ?? null, slippage: slippageLabel(slip) },
      photos,
      accounts,
      canSeeAccount: !!m?.fin,
    };
  }),

  /** For the quarterly report: milestones reached and phases begun in a date range. */
  highlights: projectProcedure()
    .input(z.object({ from: planDate, to: planDate }))
    .query(async ({ ctx, input }) => {
      portalViewer(ctx as AuthedContext);
      const milestones = await ctx.db
        .select({ title: schema.task.title, completedOn: schema.task.completedOn })
        .from(schema.task)
        .where(and(eq(schema.task.projectId, input.projectId), eq(schema.task.milestone, true), sql`${schema.task.completedOn} between ${input.from} and ${input.to}`))
        .orderBy(asc(schema.task.completedOn));
      const phases = await ctx.db
        .select({ name: schema.projectPhase.name, startedOn: schema.projectPhase.startedOn })
        .from(schema.projectPhase)
        .where(and(eq(schema.projectPhase.projectId, input.projectId), sql`${schema.projectPhase.startedOn} between ${input.from} and ${input.to}`))
        .orderBy(asc(schema.projectPhase.startedOn));
      const [photos] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(schema.projectPhoto).where(and(eq(schema.projectPhoto.projectId, input.projectId), sql`(${schema.projectPhoto.createdAt} at time zone 'America/New_York')::date between ${input.from}::date and ${input.to}::date`));
      return { milestones, phases, photos: photos?.n ?? 0 };
    }),
});
