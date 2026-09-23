import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { isFinancialEntity } from "@/core/audit";
import { canGlobal, canGrantFlags, canProject, canRemoveMember, defaultFlags, PROJECT_ROLES, type Membership } from "@/core/permissions";
import { initialPhases, phasesForType, setCurrentPhase, setPhaseSkipped, type PhaseState } from "@/core/phases";
import { PROJECT_STATUSES } from "@/core/portfolio";
import { todayET } from "@/core/time";
import { schema, type DbOrTx } from "../../db";
import { tryGeocode } from "../../geo";
import { recordAudit } from "../../services/audit";
import { globalProcedure, projectProcedure, protectedProcedure, router, type AuthedContext } from "../init";

const bblSchema = z
  .string()
  .trim()
  .regex(/^[1-5]\d{9}$/, "BBL is 10 digits: borough (1–5), 5-digit block, 4-digit lot")
  .nullable();

const BOROUGHS = ["Brooklyn", "Manhattan", "Queens", "Bronx", "Staten Island"] as const;
export const BOROUGH_CODE = { Manhattan: "1", Bronx: "2", Brooklyn: "3", Queens: "4", "Staten Island": "5" } as const;
const BBL_BOROUGH_MESSAGE =
  "The BBL's first digit is the borough (1 Manhattan, 2 Bronx, 3 Brooklyn, 4 Queens, 5 Staten Island) and doesn't match the borough chosen.";

const count = z.number().int().min(0).max(100_000_000).nullable();
const far = z.number().min(0).max(99).multipleOf(0.01).nullable();
const cents = z.number().int().min(0).max(1e15).nullable();

const factsInput = z.object({
  description: z.string().trim().max(2000).nullable(),
  lotAreaSqft: count,
  zoning: z.string().trim().max(60).nullable(),
  residFar: far,
  builtFar: far,
  unusedZsf: count,
  units: z.number().int().min(0).max(10_000).nullable(),
  grossSf: count,
  sellableSf: count,
});

const headlineInput = z.object({
  purchasePriceCents: cents,
  totalBudgetCents: cents,
  projectedSelloutCents: cents,
});

const baseInput = z.object({
  name: z.string().trim().min(1).max(160),
  address: z.string().trim().min(3).max(200),
  borough: z.enum(BOROUGHS).default("Brooklyn"),
  bbl: bblSchema.optional(),
  type: z.enum(schema.PROJECT_TYPES),
  companyId: z.uuid(),
});

const bblMatchesBorough = (p: { bbl?: string | null; borough: (typeof BOROUGHS)[number] }) => !p.bbl || p.bbl.startsWith(BOROUGH_CODE[p.borough]);

const createInput = baseInput
  .extend({ facts: factsInput.partial().optional(), headline: headlineInput.partial().optional() })
  .refine(bblMatchesBorough, { path: ["bbl"], message: BBL_BOROUGH_MESSAGE });

const updateInput = baseInput
  .omit({ type: true })
  .extend({
    version: z.number().int().min(1),
    status: z.enum(PROJECT_STATUSES),
    facts: factsInput.partial(),
  })
  .refine(bblMatchesBorough, { path: ["bbl"], message: BBL_BOROUGH_MESSAGE });

const flagsInput = z.object({
  projectRole: z.string().trim().min(1).max(60),
  canViewFinancials: z.boolean(),
  canEditChecklist: z.boolean(),
  canApprove: z.boolean(),
});

type PhaseRow = typeof schema.projectPhase.$inferSelect;
const toState = (r: PhaseRow): PhaseState => ({
  key: r.key,
  name: r.name,
  sortOrder: r.sortOrder,
  status: r.status,
  startedOn: r.startedOn,
  completedOn: r.completedOn,
});

async function loadPhases(conn: DbOrTx, projectIds: string[]) {
  if (projectIds.length === 0) return new Map<string, PhaseState[]>();
  const rows = await conn
    .select()
    .from(schema.projectPhase)
    .where(inArray(schema.projectPhase.projectId, projectIds))
    .orderBy(asc(schema.projectPhase.projectId), asc(schema.projectPhase.sortOrder));
  const out = new Map<string, PhaseState[]>();
  for (const r of rows) {
    const list = out.get(r.projectId) ?? [];
    list.push(toState(r));
    out.set(r.projectId, list);
  }
  return out;
}

/** Hero photo per project: the pinned one, else the newest. */
async function loadHeroes(conn: DbOrTx, projects: { id: string; heroPhotoId: string | null }[]) {
  const out = new Map<string, { id: string; width: number; height: number }>();
  if (projects.length === 0) return out;
  const ids = projects.map((p) => p.id);
  const pinnedIds = projects.map((p) => p.heroPhotoId).filter((x): x is string => !!x);
  const pinned = pinnedIds.length
    ? await conn
        .select({ id: schema.projectPhoto.id, projectId: schema.projectPhoto.projectId, width: schema.projectPhoto.width, height: schema.projectPhoto.height })
        .from(schema.projectPhoto)
        .where(inArray(schema.projectPhoto.id, pinnedIds))
    : [];
  for (const p of pinned) out.set(p.projectId, { id: p.id, width: p.width, height: p.height });
  const newest = await conn.execute<{ id: string; project_id: string; width: number; height: number }>(sql`
    select distinct on (project_id) id, project_id, width, height
    from project_photo
    where project_id in (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)})
    order by project_id, created_at desc, id desc`);
  for (const r of newest.rows) if (!out.has(r.project_id)) out.set(r.project_id, { id: r.id, width: r.width, height: r.height });
  return out;
}

async function membershipsOf(conn: DbOrTx, userId: string, projectIds: string[]) {
  const out = new Map<string, Membership>();
  if (projectIds.length === 0) return out;
  const rows = await conn
    .select({
      projectId: schema.projectMember.projectId,
      projectRole: schema.projectMember.projectRole,
      canViewFinancials: schema.projectMember.canViewFinancials,
      canEditChecklist: schema.projectMember.canEditChecklist,
      canApprove: schema.projectMember.canApprove,
    })
    .from(schema.projectMember)
    .where(and(eq(schema.projectMember.userId, userId), inArray(schema.projectMember.projectId, projectIds)));
  for (const r of rows) out.set(r.projectId, r);
  return out;
}

function headlineOrNull(h: typeof schema.projectHeadline.$inferSelect | undefined) {
  return h ? { purchasePriceCents: h.purchasePriceCents, totalBudgetCents: h.totalBudgetCents, projectedSelloutCents: h.projectedSelloutCents } : null;
}

const conflict = () =>
  new TRPCError({
    code: "CONFLICT",
    message: "Someone else changed this project while you were editing. Your changes weren't saved; reload to see theirs, then try again.",
  });

/** Optimistic lock: bump the version, or tell the user someone else saved first. */
async function bumpVersion(tx: DbOrTx, projectId: string, expected: number | null, set: Partial<typeof schema.project.$inferInsert> = {}) {
  const where = expected === null ? eq(schema.project.id, projectId) : and(eq(schema.project.id, projectId), eq(schema.project.version, expected));
  const updated = await tx
    .update(schema.project)
    .set({ ...set, version: sql`${schema.project.version} + 1`, updatedAt: new Date() })
    .where(where)
    .returning({ version: schema.project.version });
  if (updated.length === 0) throw conflict();
  return updated[0]!.version;
}

async function savePhases(tx: DbOrTx, projectId: string, before: PhaseState[], after: PhaseState[]) {
  for (const p of after) {
    const b = before.find((x) => x.key === p.key);
    if (b && b.status === p.status && b.startedOn === p.startedOn && b.completedOn === p.completedOn) continue;
    await tx
      .update(schema.projectPhase)
      .set({ status: p.status, startedOn: p.startedOn, completedOn: p.completedOn })
      .where(and(eq(schema.projectPhase.projectId, projectId), eq(schema.projectPhase.key, p.key)));
  }
}

export const companiesRouter = router({
  list: protectedProcedure.query(({ ctx }) =>
    ctx.db
      .select({ id: schema.company.id, name: schema.company.name, shortName: schema.company.shortName })
      .from(schema.company)
      .orderBy(asc(schema.company.sortOrder)),
  ),
});

async function visibleProjectIds(ctx: AuthedContext, includeArchived: boolean): Promise<string[]> {
  const archived = includeArchived ? isNotNull(schema.project.archivedAt) : isNull(schema.project.archivedAt);
  if (canGlobal(ctx.actor, "projects.viewAll")) {
    const rows = await ctx.db.select({ id: schema.project.id }).from(schema.project).where(archived);
    return rows.map((r) => r.id);
  }
  const rows = await ctx.db
    .select({ id: schema.project.id })
    .from(schema.project)
    .innerJoin(schema.projectMember, eq(schema.projectMember.projectId, schema.project.id))
    .where(and(archived, eq(schema.projectMember.userId, ctx.actor.userId)));
  return rows.map((r) => r.id);
}

export const projectsRouter = router({
  /**
   * The portfolio: every project the viewer can see, with what the cards,
   * table, timeline and map need. Headline financials only where the viewer
   * has financial visibility on that project; team membership only for the
   * internal team (outside collaborators never see who else is on what).
   */
  list: protectedProcedure.input(z.object({ archived: z.boolean().default(false) }).optional()).query(async ({ ctx, input }) => {
    const ids = await visibleProjectIds(ctx, input?.archived ?? false);
    if (ids.length === 0) return { projects: [], people: [] };
    const rows = await ctx.db
      .select({
        id: schema.project.id,
        name: schema.project.name,
        address: schema.project.address,
        borough: schema.project.borough,
        bbl: schema.project.bbl,
        type: schema.project.type,
        status: schema.project.status,
        companyId: schema.project.companyId,
        companyName: schema.company.name,
        companyShort: schema.company.shortName,
        units: schema.project.units,
        sellableSf: schema.project.sellableSf,
        latitude: schema.project.latitude,
        longitude: schema.project.longitude,
        heroPhotoId: schema.project.heroPhotoId,
        archivedAt: schema.project.archivedAt,
        createdAt: schema.project.createdAt,
      })
      .from(schema.project)
      .innerJoin(schema.company, eq(schema.company.id, schema.project.companyId))
      .where(inArray(schema.project.id, ids))
      .orderBy(asc(schema.project.name));

    const [phases, heroes, mine] = await Promise.all([loadPhases(ctx.db, ids), loadHeroes(ctx.db, rows), membershipsOf(ctx.db, ctx.actor.userId, ids)]);
    const finIds = ids.filter((id) => canProject(ctx.actor, mine.get(id) ?? null, "financials.view"));
    const headlines = finIds.length ? await ctx.db.select().from(schema.projectHeadline).where(inArray(schema.projectHeadline.projectId, finIds)) : [];

    const internal = ctx.actor.role !== "external";
    const members = internal
      ? await ctx.db
          .select({ projectId: schema.projectMember.projectId, userId: schema.user.id, name: schema.user.name })
          .from(schema.projectMember)
          .innerJoin(schema.user, eq(schema.user.id, schema.projectMember.userId))
          .where(inArray(schema.projectMember.projectId, ids))
      : [];
    const people = new Map<string, string>();
    for (const m of members) people.set(m.userId, m.name);

    return {
      projects: rows.map((p) => ({
        ...p,
        phases: phases.get(p.id) ?? [],
        hero: heroes.get(p.id) ?? null,
        memberIds: members.filter((m) => m.projectId === p.id).map((m) => m.userId),
        headline: finIds.includes(p.id) ? (headlineOrNull(headlines.find((h) => h.projectId === p.id)) ?? { purchasePriceCents: null, totalBudgetCents: null, projectedSelloutCents: null }) : null,
      })),
      people: [...people].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
    };
  }),

  get: projectProcedure().query(async ({ ctx, input }) => {
    const [p] = await ctx.db
      .select({
        id: schema.project.id,
        name: schema.project.name,
        address: schema.project.address,
        borough: schema.project.borough,
        bbl: schema.project.bbl,
        type: schema.project.type,
        status: schema.project.status,
        description: schema.project.description,
        companyId: schema.project.companyId,
        companyName: schema.company.name,
        lotAreaSqft: schema.project.lotAreaSqft,
        zoning: schema.project.zoning,
        residFar: schema.project.residFar,
        builtFar: schema.project.builtFar,
        unusedZsf: schema.project.unusedZsf,
        units: schema.project.units,
        grossSf: schema.project.grossSf,
        sellableSf: schema.project.sellableSf,
        latitude: schema.project.latitude,
        longitude: schema.project.longitude,
        heroPhotoId: schema.project.heroPhotoId,
        archivedAt: schema.project.archivedAt,
        version: schema.project.version,
      })
      .from(schema.project)
      .innerJoin(schema.company, eq(schema.company.id, schema.project.companyId))
      .where(eq(schema.project.id, input.projectId));
    if (!p) throw new TRPCError({ code: "NOT_FOUND" });
    const [phases, heroes] = await Promise.all([loadPhases(ctx.db, [p.id]), loadHeroes(ctx.db, [p])]);
    const canFin = ctx.project.can("financials.view");
    const [h] = canFin ? await ctx.db.select().from(schema.projectHeadline).where(eq(schema.projectHeadline.projectId, p.id)) : [];
    return {
      ...p,
      phases: phases.get(p.id) ?? [],
      hero: heroes.get(p.id) ?? null,
      headline: canFin ? (headlineOrNull(h) ?? { purchasePriceCents: null, totalBudgetCents: null, projectedSelloutCents: null }) : null,
      access: {
        projectRole: ctx.project.membership?.projectRole ?? (ctx.actor.role === "owner" ? "Owner" : null),
        canViewFinancials: canFin,
        canEditFinancials: ctx.project.can("financials.edit"),
        canEditChecklist: ctx.project.can("checklist.edit"),
        canApprove: ctx.project.can("task.approve"),
        canEdit: ctx.project.can("project.edit"),
        canManageMembers: ctx.project.can("project.manageMembers"),
        canUploadPhotos: ctx.project.can("photos.upload"),
        canManagePhotos: ctx.project.can("photos.manage"),
        canViewActivity: ctx.project.can("activity.view"),
      },
    };
  }),

  create: globalProcedure("project.create")
    .input(createInput)
    .mutation(async ({ ctx, input }) => {
      const geo = await tryGeocode(input.address, input.borough);
      // A BBL from the city's address data fills in when none was typed, if it's in the right borough.
      const bbl = input.bbl ?? (geo?.bbl && geo.bbl.startsWith(BOROUGH_CODE[input.borough]) ? geo.bbl : null);
      const today = todayET();
      const flags = defaultFlags(ctx.actor.role);
      return ctx.db.transaction(async (tx) => {
        const [p] = await tx
          .insert(schema.project)
          .values({
            name: input.name,
            address: input.address,
            borough: input.borough,
            bbl,
            type: input.type,
            companyId: input.companyId,
            ...(input.facts ?? {}),
            latitude: geo?.latitude ?? null,
            longitude: geo?.longitude ?? null,
            createdById: ctx.viewer.id,
          })
          .returning({ id: schema.project.id });
        const id = p!.id;
        await tx.insert(schema.projectPhase).values(initialPhases(phasesForType(input.type), today).map((ph) => ({ ...ph, projectId: id })));
        // The creator is always a member (admins need membership to see it).
        await tx.insert(schema.projectMember).values({ projectId: id, userId: ctx.viewer.id, projectRole: "PM", ...flags, addedById: ctx.viewer.id });
        await recordAudit(tx, {
          actorId: ctx.viewer.id,
          actorName: ctx.viewer.name,
          action: "create",
          entityType: "project",
          entityId: id,
          projectId: id,
          summary: `${ctx.viewer.name} created project ${input.name}`,
          data: { name: input.name, address: input.address, type: input.type, bbl, geocoded: !!geo },
          ip: ctx.ip,
        });
        const h = input.headline;
        if (h && Object.values(h).some((v) => v != null) && (ctx.actor.role === "owner" || flags.canViewFinancials)) {
          await tx.insert(schema.projectHeadline).values({ projectId: id, ...h });
          await recordAudit(tx, {
            actorId: ctx.viewer.id,
            actorName: ctx.viewer.name,
            action: "update",
            entityType: "project_headline",
            entityId: id,
            projectId: id,
            summary: `${ctx.viewer.name} set the headline financials`,
            data: h,
            ip: ctx.ip,
          });
        }
        return { id };
      });
    }),

  update: projectProcedure("project.edit")
    .input(updateInput)
    .mutation(async ({ ctx, input }) => {
      const [before] = await ctx.db.select().from(schema.project).where(eq(schema.project.id, input.projectId));
      if (!before) throw new TRPCError({ code: "NOT_FOUND" });
      if (before.version !== input.version) throw conflict();
      const moved = before.address !== input.address || before.borough !== input.borough;
      const needBbl = !input.bbl;
      const geo = moved || needBbl ? await tryGeocode(input.address, input.borough) : null;
      // As on create: a blank BBL is filled from the city's address data when it's in the right borough.
      const bbl = input.bbl ?? (geo?.bbl && geo.bbl.startsWith(BOROUGH_CODE[input.borough]) ? geo.bbl : null);
      const changes = {
        name: input.name,
        address: input.address,
        borough: input.borough,
        bbl,
        companyId: input.companyId,
        status: input.status,
        ...input.facts,
        ...(moved ? { latitude: geo?.latitude ?? null, longitude: geo?.longitude ?? null } : {}),
      };
      return ctx.db.transaction(async (tx) => {
        const version = await bumpVersion(tx, input.projectId, input.version, changes);
        const changed = Object.fromEntries(
          Object.entries(changes).filter(([k, v]) => (before as Record<string, unknown>)[k] !== v),
        );
        await recordAudit(tx, {
          actorId: ctx.viewer.id,
          actorName: ctx.viewer.name,
          action: "update",
          entityType: "project",
          entityId: input.projectId,
          projectId: input.projectId,
          summary: `${ctx.viewer.name} edited ${input.name}`,
          data: { changed: Object.keys(changed), after: changed },
          ip: ctx.ip,
        });
        return { version };
      });
    }),

  /** Headline numbers (gated): owner, or an admin with financial visibility. */
  setHeadline: projectProcedure("financials.edit")
    .input(headlineInput)
    .mutation(async ({ ctx, input }) => {
      const { projectId, ...values } = input;
      await ctx.db.transaction(async (tx) => {
        await tx
          .insert(schema.projectHeadline)
          .values({ projectId, ...values })
          .onConflictDoUpdate({ target: schema.projectHeadline.projectId, set: { ...values, updatedAt: new Date() } });
        await recordAudit(tx, {
          actorId: ctx.viewer.id,
          actorName: ctx.viewer.name,
          action: "update",
          entityType: "project_headline",
          entityId: projectId,
          projectId,
          summary: `${ctx.viewer.name} updated the headline financials`,
          data: values,
          ip: ctx.ip,
        });
      });
      return { ok: true };
    }),

  /** Move the project to a phase (forwards or back). */
  setPhase: projectProcedure("project.edit")
    .input(z.object({ key: z.string().min(1).max(60), version: z.number().int().min(1) }))
    .mutation(async ({ ctx, input }) => {
      return ctx.db.transaction(async (tx) => {
        const version = await bumpVersion(tx, input.projectId, input.version);
        const before = (await loadPhases(tx, [input.projectId])).get(input.projectId) ?? [];
        let after: PhaseState[];
        try {
          after = setCurrentPhase(before, input.key, todayET());
        } catch (e) {
          throw new TRPCError({ code: "BAD_REQUEST", message: (e as Error).message });
        }
        await savePhases(tx, input.projectId, before, after);
        const from = before.find((p) => p.status === "active");
        const to = after.find((p) => p.key === input.key)!;
        await recordAudit(tx, {
          actorId: ctx.viewer.id,
          actorName: ctx.viewer.name,
          action: "update",
          entityType: "project_phase",
          entityId: input.projectId,
          projectId: input.projectId,
          summary: `${ctx.viewer.name} moved the project ${from ? `from ${from.name} ` : ""}to ${to.name}`,
          data: { from: from?.key ?? null, to: to.key },
          ip: ctx.ip,
        });
        return { version };
      });
    }),

  skipPhase: projectProcedure("project.edit")
    .input(z.object({ key: z.string().min(1).max(60), skipped: z.boolean(), version: z.number().int().min(1) }))
    .mutation(async ({ ctx, input }) => {
      return ctx.db.transaction(async (tx) => {
        const version = await bumpVersion(tx, input.projectId, input.version);
        const before = (await loadPhases(tx, [input.projectId])).get(input.projectId) ?? [];
        let after: PhaseState[];
        try {
          after = setPhaseSkipped(before, input.key, input.skipped);
        } catch (e) {
          throw new TRPCError({ code: "BAD_REQUEST", message: (e as Error).message });
        }
        await savePhases(tx, input.projectId, before, after);
        const ph = after.find((p) => p.key === input.key)!;
        await recordAudit(tx, {
          actorId: ctx.viewer.id,
          actorName: ctx.viewer.name,
          action: "update",
          entityType: "project_phase",
          entityId: input.projectId,
          projectId: input.projectId,
          summary: `${ctx.viewer.name} ${input.skipped ? "skipped" : "restored"} the ${ph.name} phase`,
          data: { key: ph.key, skipped: input.skipped },
          ip: ctx.ip,
        });
        return { version };
      });
    }),

  /** Archive hides a project from the portfolio without deleting anything. */
  setArchived: projectProcedure("project.edit")
    .input(z.object({ archived: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.transaction(async (tx) => {
        const [p] = await tx.select({ name: schema.project.name }).from(schema.project).where(eq(schema.project.id, input.projectId));
        await bumpVersion(tx, input.projectId, null, { archivedAt: input.archived ? new Date() : null });
        await recordAudit(tx, {
          actorId: ctx.viewer.id,
          actorName: ctx.viewer.name,
          action: "update",
          entityType: "project",
          entityId: input.projectId,
          projectId: input.projectId,
          summary: `${ctx.viewer.name} ${input.archived ? "archived" : "restored"} ${p?.name ?? "a project"}`,
          data: { archived: input.archived },
          ip: ctx.ip,
        });
      });
      return { ok: true };
    }),

  /**
   * The project's activity feed, newest first. Entries about money are left
   * out for anyone without financial visibility on this project.
   */
  activity: projectProcedure("activity.view")
    .input(z.object({ cursor: z.number().int().positive().nullish(), limit: z.number().int().min(1).max(100).default(40) }))
    .query(async ({ ctx, input }) => {
      const canFin = ctx.project.can("financials.view");
      const filters = [eq(schema.auditLog.projectId, input.projectId)];
      if (input.cursor) filters.push(lt(schema.auditLog.seq, input.cursor));
      if (!canFin) filters.push(sql`${schema.auditLog.entityType} not in ('project_headline','budget_line','commitment','invoice','change_order','draw','sale','capital')`);
      const rows = await ctx.db
        .select({
          seq: schema.auditLog.seq,
          occurredAt: schema.auditLog.occurredAt,
          actorName: schema.auditLog.actorName,
          action: schema.auditLog.action,
          entityType: schema.auditLog.entityType,
          summary: schema.auditLog.summary,
        })
        .from(schema.auditLog)
        .where(and(...filters))
        .orderBy(desc(schema.auditLog.seq))
        .limit(input.limit + 1);
      // Belt and braces: never return a financial entry to someone without the flag.
      const safe = canFin ? rows : rows.filter((r) => !isFinancialEntity(r.entityType));
      const items = safe.slice(0, input.limit);
      return { items, nextCursor: rows.length > input.limit ? items[items.length - 1]!.seq : null };
    }),
});

export const membersRouter = router({
  list: projectProcedure().query(async ({ ctx, input }) => {
    const rows = await ctx.db
      .select({
        userId: schema.user.id,
        name: schema.user.name,
        email: schema.user.email,
        globalRole: schema.user.role,
        status: schema.user.status,
        title: schema.user.title,
        company: schema.user.company,
        projectRole: schema.projectMember.projectRole,
        canViewFinancials: schema.projectMember.canViewFinancials,
        canEditChecklist: schema.projectMember.canEditChecklist,
        canApprove: schema.projectMember.canApprove,
      })
      .from(schema.projectMember)
      .innerJoin(schema.user, eq(schema.user.id, schema.projectMember.userId))
      .where(eq(schema.projectMember.projectId, input.projectId))
      .orderBy(asc(schema.user.name));
    const showFlags = ctx.project.can("project.manageMembers");
    // External collaborators see who is on the project, not everyone's emails or permissions.
    const isExternal = ctx.actor.role === "external";
    return rows.map((r) => ({
      userId: r.userId,
      name: r.name,
      title: r.title,
      company: r.company,
      projectRole: r.projectRole,
      status: r.status,
      email: isExternal ? null : r.email,
      globalRole: showFlags ? r.globalRole : null,
      flags: showFlags ? { canViewFinancials: r.canViewFinancials, canEditChecklist: r.canEditChecklist, canApprove: r.canApprove } : null,
    }));
  }),

  upsert: projectProcedure("project.manageMembers")
    .input(z.object({ userId: z.string().min(1) }).extend(flagsInput.shape))
    .mutation(async ({ ctx, input }) => {
      const { projectId, userId, ...flags } = input;
      await ctx.db.transaction(async (tx) => {
        const [target] = await tx.select({ id: schema.user.id, name: schema.user.name, role: schema.user.role, status: schema.user.status }).from(schema.user).where(eq(schema.user.id, userId));
        if (!target || target.status !== "active") throw new TRPCError({ code: "NOT_FOUND", message: "User not found" });
        if (target.role === "external" && flags.canEditChecklist) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Outside collaborators cannot edit checklists." });
        }
        const [before] = await tx
          .select()
          .from(schema.projectMember)
          .where(and(eq(schema.projectMember.projectId, projectId), eq(schema.projectMember.userId, userId)));
        if (!canGrantFlags(ctx.actor, ctx.project.membership, flags, before ?? null, target.role)) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message:
              target.role === "owner" || target.role === "admin"
                ? "Only the owner can change another admin's access."
                : "Only someone who can see financials can grant or remove financial access.",
          });
        }
        if (before) {
          await tx
            .update(schema.projectMember)
            .set({ ...flags, updatedAt: new Date() })
            .where(and(eq(schema.projectMember.projectId, projectId), eq(schema.projectMember.userId, userId)));
        } else {
          await tx.insert(schema.projectMember).values({ projectId, userId, ...flags, addedById: ctx.viewer.id });
        }
        await recordAudit(tx, {
          actorId: ctx.viewer.id,
          actorName: ctx.viewer.name,
          action: "permission.change",
          entityType: "project_member",
          entityId: userId,
          projectId,
          summary: before
            ? `${ctx.viewer.name} changed ${target.name}'s project access`
            : `${ctx.viewer.name} added ${target.name} to the project as ${flags.projectRole}`,
          data: {
            before: before
              ? { projectRole: before.projectRole, canViewFinancials: before.canViewFinancials, canEditChecklist: before.canEditChecklist, canApprove: before.canApprove }
              : null,
            after: flags,
          },
          ip: ctx.ip,
        });
      });
      return { ok: true };
    }),

  remove: projectProcedure("project.manageMembers")
    .input(z.object({ userId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.transaction(async (tx) => {
        const [target] = await tx
          .select({ role: schema.user.role, canViewFinancials: schema.projectMember.canViewFinancials })
          .from(schema.projectMember)
          .innerJoin(schema.user, eq(schema.user.id, schema.projectMember.userId))
          .where(and(eq(schema.projectMember.projectId, input.projectId), eq(schema.projectMember.userId, input.userId)));
        if (!target) throw new TRPCError({ code: "NOT_FOUND" });
        if (!canRemoveMember(ctx.actor, ctx.project.membership, target)) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Only the owner can remove this person." });
        }
        await tx
          .delete(schema.projectMember)
          .where(and(eq(schema.projectMember.projectId, input.projectId), eq(schema.projectMember.userId, input.userId)));
        const [u] = await tx.select({ name: schema.user.name }).from(schema.user).where(eq(schema.user.id, input.userId));
        await recordAudit(tx, {
          actorId: ctx.viewer.id,
          actorName: ctx.viewer.name,
          action: "permission.change",
          entityType: "project_member",
          entityId: input.userId,
          projectId: input.projectId,
          summary: `${ctx.viewer.name} removed ${u?.name ?? "a user"} from the project`,
          ip: ctx.ip,
        });
      });
      return { ok: true };
    }),

  /** Active users who could be added (for the add-member picker). */
  candidates: projectProcedure("project.manageMembers").query(async ({ ctx, input }) => {
    const current = ctx.db
      .select({ id: schema.projectMember.userId })
      .from(schema.projectMember)
      .where(eq(schema.projectMember.projectId, input.projectId));
    const rows = await ctx.db
      .select({ id: schema.user.id, name: schema.user.name, email: schema.user.email, role: schema.user.role })
      .from(schema.user)
      .where(eq(schema.user.status, "active"))
      .orderBy(asc(schema.user.name));
    const taken = new Set((await current).map((r) => r.id));
    return rows.filter((r) => !taken.has(r.id));
  }),
});

export { PROJECT_ROLES };
