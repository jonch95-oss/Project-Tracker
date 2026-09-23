import { TRPCError } from "@trpc/server";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { canGlobal, canGrantFlags, defaultFlags, PROJECT_ROLES } from "@/core/permissions";
import { schema } from "../../db";
import { recordAudit } from "../../services/audit";
import { globalProcedure, projectProcedure, protectedProcedure, router } from "../init";

const bblSchema = z
  .string()
  .trim()
  .regex(/^[1-5]\d{9}$/, "BBL is 10 digits: borough (1–5), 5-digit block, 4-digit lot")
  .nullable();

const projectInput = z.object({
  name: z.string().trim().min(1).max(160),
  address: z.string().trim().min(3).max(200),
  borough: z.enum(["Brooklyn", "Manhattan", "Queens", "Bronx", "Staten Island"]).default("Brooklyn"),
  bbl: bblSchema.optional(),
  type: z.enum(schema.PROJECT_TYPES),
  companyId: z.uuid(),
});

const flagsInput = z.object({
  projectRole: z.string().trim().min(1).max(60),
  canViewFinancials: z.boolean(),
  canEditChecklist: z.boolean(),
  canApprove: z.boolean(),
});

export const companiesRouter = router({
  list: protectedProcedure.query(({ ctx }) =>
    ctx.db
      .select({ id: schema.company.id, name: schema.company.name, shortName: schema.company.shortName })
      .from(schema.company)
      .orderBy(asc(schema.company.sortOrder)),
  ),
});

export const projectsRouter = router({
  /** Projects the viewer can see: all for the owner, assigned ones for everyone else. */
  list: protectedProcedure.query(async ({ ctx }) => {
    const base = ctx.db
      .select({
        id: schema.project.id,
        name: schema.project.name,
        address: schema.project.address,
        borough: schema.project.borough,
        bbl: schema.project.bbl,
        type: schema.project.type,
        companyName: schema.company.name,
        companyShort: schema.company.shortName,
        createdAt: schema.project.createdAt,
      })
      .from(schema.project)
      .innerJoin(schema.company, eq(schema.company.id, schema.project.companyId));
    if (canGlobal(ctx.actor, "projects.viewAll")) {
      return base.where(isNull(schema.project.archivedAt)).orderBy(asc(schema.project.name));
    }
    const mine = ctx.db
      .select({ id: schema.projectMember.projectId })
      .from(schema.projectMember)
      .where(eq(schema.projectMember.userId, ctx.actor.userId));
    return base
      .where(and(isNull(schema.project.archivedAt), inArray(schema.project.id, mine)))
      .orderBy(asc(schema.project.name));
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
        companyName: schema.company.name,
        version: schema.project.version,
      })
      .from(schema.project)
      .innerJoin(schema.company, eq(schema.company.id, schema.project.companyId))
      .where(eq(schema.project.id, input.projectId));
    if (!p) throw new TRPCError({ code: "NOT_FOUND" });
    return {
      ...p,
      access: {
        projectRole: ctx.project.membership?.projectRole ?? (ctx.actor.role === "owner" ? "Owner" : null),
        canViewFinancials: ctx.project.can("financials.view"),
        canEditChecklist: ctx.project.can("checklist.edit"),
        canApprove: ctx.project.can("task.approve"),
        canEdit: ctx.project.can("project.edit"),
        canManageMembers: ctx.project.can("project.manageMembers"),
      },
    };
  }),

  create: globalProcedure("project.create")
    .input(projectInput)
    .mutation(async ({ ctx, input }) => {
      return ctx.db.transaction(async (tx) => {
        const [p] = await tx
          .insert(schema.project)
          .values({ ...input, bbl: input.bbl ?? null, createdById: ctx.viewer.id })
          .returning({ id: schema.project.id });
        // The creator is always a member (admins need membership to see it).
        await tx.insert(schema.projectMember).values({
          projectId: p!.id,
          userId: ctx.viewer.id,
          projectRole: "PM",
          ...defaultFlags(ctx.actor.role),
          addedById: ctx.viewer.id,
        });
        await recordAudit(tx, {
          actorId: ctx.viewer.id,
          actorName: ctx.viewer.name,
          action: "create",
          entityType: "project",
          entityId: p!.id,
          projectId: p!.id,
          summary: `${ctx.viewer.name} created project ${input.name}`,
          data: { name: input.name, address: input.address, type: input.type, bbl: input.bbl ?? null },
          ip: ctx.ip,
        });
        return { id: p!.id };
      });
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
      flags: showFlags
        ? { canViewFinancials: r.canViewFinancials, canEditChecklist: r.canEditChecklist, canApprove: r.canApprove }
        : null,
    }));
  }),

  upsert: projectProcedure("project.manageMembers")
    .input(z.object({ userId: z.string().min(1) }).extend(flagsInput.shape))
    .mutation(async ({ ctx, input }) => {
      const { projectId, userId, ...flags } = input;
      if (!canGrantFlags(ctx.actor, ctx.project.membership, flags)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "You cannot grant access you do not have." });
      }
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
        const [removed] = await tx
          .delete(schema.projectMember)
          .where(and(eq(schema.projectMember.projectId, input.projectId), eq(schema.projectMember.userId, input.userId)))
          .returning();
        if (!removed) throw new TRPCError({ code: "NOT_FOUND" });
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
