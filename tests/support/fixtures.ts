import { eq, sql } from "drizzle-orm";
import type { GlobalRole } from "@/core/permissions";
import { auth } from "@/server/auth";
import { db, schema } from "@/server/db";
import { loadViewer, type Context } from "@/server/trpc/init";
import { createCaller } from "@/server/trpc/root";

let n = 0;

/** Create an active user with a password (via Better Auth's own hashing). */
export async function createUser(role: GlobalRole, opts: { name?: string; email?: string; password?: string } = {}) {
  n++;
  const email = opts.email ?? `${role}${n}-${Date.now()}@example.com`;
  const ctx = await auth().$context;
  const user = await ctx.internalAdapter.createUser(
    { email, name: opts.name ?? `${role[0]!.toUpperCase()}${role.slice(1)} ${n}`, emailVerified: true, role, status: "active" },
    { method: "email-password" },
  );
  await ctx.internalAdapter.linkAccount({
    userId: user.id,
    providerId: "credential",
    accountId: user.id,
    password: await ctx.password.hash(opts.password ?? "correct horse battery 1"),
  });
  return { id: user.id, email, role };
}

export async function contextFor(userId: string | null): Promise<Context> {
  const viewer = userId ? await loadViewer(userId) : null;
  return {
    db: db(),
    headers: new Headers(),
    ip: "127.0.0.1",
    viewer,
    actor: viewer ? { userId: viewer.id, role: viewer.role, status: viewer.status } : null,
  };
}

export async function callerFor(userId: string | null) {
  return createCaller(await contextFor(userId));
}

export async function companyId(): Promise<string> {
  const [c] = await db().select({ id: schema.company.id }).from(schema.company).limit(1);
  return c!.id;
}

export async function createProject(ownerId: string, name = `Project ${++n}`) {
  const caller = await callerFor(ownerId);
  return caller.projects.create({
    name,
    address: `${100 + n} Test Street`,
    type: "ground_up_condo",
    companyId: await companyId(),
    bbl: null,
  });
}

export async function addMember(
  projectId: string,
  userId: string,
  flags: Partial<{ canViewFinancials: boolean; canEditChecklist: boolean; canApprove: boolean }> = {},
) {
  await db()
    .insert(schema.projectMember)
    .values({
      projectId,
      userId,
      projectRole: "PM",
      canViewFinancials: false,
      canEditChecklist: false,
      canApprove: false,
      ...flags,
    });
}

export async function deactivate(userId: string) {
  await db().update(schema.user).set({ status: "deactivated" }).where(eq(schema.user.id, userId));
}

export async function auditCount(): Promise<number> {
  const [r] = await db().select({ n: sql<number>`count(*)::int` }).from(schema.auditLog);
  return r!.n;
}
