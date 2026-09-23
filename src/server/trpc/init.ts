import "server-only";
import { initTRPC, TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import superjson from "superjson";
import { z, ZodError } from "zod";
import {
  canGlobal,
  canProject,
  type Actor,
  type GlobalAction,
  type Membership,
  type ProjectAction,
} from "@/core/permissions";
import { auth } from "../auth";
import { db, schema, type Database } from "../db";
import { logError } from "../services/errors";

export interface Viewer {
  id: string;
  name: string;
  email: string;
  role: Actor["role"];
  status: Actor["status"];
  title: string | null;
  company: string | null;
  twoFactorEnabled: boolean;
}

export interface Context {
  db: Database;
  headers: Headers;
  ip: string | null;
  viewer: Viewer | null;
  actor: Actor | null;
}

export async function loadViewer(userId: string, conn: Database = db()): Promise<Viewer | null> {
  const [u] = await conn
    .select({
      id: schema.user.id,
      name: schema.user.name,
      email: schema.user.email,
      role: schema.user.role,
      status: schema.user.status,
      title: schema.user.title,
      company: schema.user.company,
      twoFactorEnabled: schema.user.twoFactorEnabled,
    })
    .from(schema.user)
    .where(eq(schema.user.id, userId));
  if (!u) return null;
  return { ...u, twoFactorEnabled: !!u.twoFactorEnabled };
}

/**
 * Build the request context. Role and status are always read fresh from the
 * database (never trusted from the cookie cache), so a role change or
 * deactivation applies to the very next request.
 */
export async function createContext(opts: { headers: Headers }): Promise<Context> {
  const session = await auth().api.getSession({ headers: opts.headers });
  const viewer = session ? await loadViewer(session.user.id) : null;
  const actor: Actor | null = viewer ? { userId: viewer.id, role: viewer.role, status: viewer.status } : null;
  const ip =
    opts.headers.get("cf-connecting-ip") ?? opts.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  return { db: db(), headers: opts.headers, ip, viewer, actor };
}

const t = initTRPC.context<Context>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        // Never leak stack traces to the client.
        stack: undefined,
        zodError: error.cause instanceof ZodError ? z.flattenError(error.cause) : null,
      },
    };
  },
});

export const router = t.router;
export const createCallerFactory = t.createCallerFactory;
export const middleware = t.middleware;

const errorLogging = t.middleware(async ({ ctx, path, next }) => {
  const result = await next();
  if (!result.ok && result.error.code === "INTERNAL_SERVER_ERROR") {
    await logError("trpc", result.error.cause ?? result.error, { path, userId: ctx.viewer?.id ?? null });
  }
  return result;
});

export const publicProcedure = t.procedure.use(errorLogging);

/** Signed in and active. */
export const protectedProcedure = publicProcedure.use(({ ctx, next }) => {
  if (!ctx.viewer || !ctx.actor) throw new TRPCError({ code: "UNAUTHORIZED" });
  if (ctx.actor.status !== "active") throw new TRPCError({ code: "FORBIDDEN", message: "Account deactivated" });
  return next({ ctx: { ...ctx, viewer: ctx.viewer, actor: ctx.actor } });
});

export type AuthedContext = Context & { viewer: Viewer; actor: Actor };

/** Requires a global permission (e.g. owner-only areas). */
export function globalProcedure(action: GlobalAction) {
  return protectedProcedure.use(({ ctx, next }) => {
    if (!canGlobal(ctx.actor, action)) throw new TRPCError({ code: "FORBIDDEN" });
    return next();
  });
}

export interface ProjectAccess {
  projectId: string;
  membership: Membership | null;
  can: (action: ProjectAction) => boolean;
}

/**
 * Resolve the viewer's access to one project. Unassigned users get NOT_FOUND
 * (not FORBIDDEN) so project existence never leaks.
 */
export async function projectAccess(ctx: AuthedContext, projectId: string): Promise<ProjectAccess> {
  const [proj] = await ctx.db
    .select({ id: schema.project.id })
    .from(schema.project)
    .where(eq(schema.project.id, projectId));
  const [m] = await ctx.db
    .select({
      projectRole: schema.projectMember.projectRole,
      canViewFinancials: schema.projectMember.canViewFinancials,
      canEditChecklist: schema.projectMember.canEditChecklist,
      canApprove: schema.projectMember.canApprove,
    })
    .from(schema.projectMember)
    .where(and(eq(schema.projectMember.projectId, projectId), eq(schema.projectMember.userId, ctx.actor.userId)));
  const membership = m ?? null;
  if (!proj || !canProject(ctx.actor, membership, "project.view")) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Project not found" });
  }
  return { projectId, membership, can: (action) => canProject(ctx.actor, membership, action) };
}

export function requireProject(access: ProjectAccess, action: ProjectAction): void {
  if (!access.can(action)) throw new TRPCError({ code: "FORBIDDEN" });
}

/**
 * Procedure for anything scoped to one project. The input must carry
 * `projectId`; the middleware checks view access and exposes `ctx.project`.
 */
export function projectProcedure(action: ProjectAction = "project.view") {
  return protectedProcedure.input(z.object({ projectId: z.uuid() })).use(async ({ ctx, input, next }) => {
    const access = await projectAccess(ctx, input.projectId);
    requireProject(access, action);
    return next({ ctx: { ...ctx, project: access } });
  });
}
