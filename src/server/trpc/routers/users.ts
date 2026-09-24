import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { passwordProblem } from "@/core/password";
import { canAssignGlobalRole, GLOBAL_ROLES } from "@/core/permissions";
import { auth } from "../../auth";
import { schema } from "../../db";
import { env } from "../../env";
import { recordAudit } from "../../services/audit";
import { renderEmail, sendEmail } from "../../services/email";
import { rerouteApprovals } from "../../services/tasks";
import { generateToken, hashToken } from "../../services/tokens";
import { globalProcedure, protectedProcedure, publicProcedure, router } from "../init";

const INVITE_TTL_DAYS = 7;

const ROLE_LABEL: Record<(typeof GLOBAL_ROLES)[number], string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Team member",
  external: "Outside collaborator",
  investor: "Investor",
};

async function sendInviteEmail(opts: { to: string; name: string; inviter: string; role: string; token: string }) {
  const url = `${env().APP_URL}/invite/${opts.token}`;
  const content = renderEmail({
    preheader: `${opts.inviter} invited you to Project Command`,
    heading: "You're invited to Project Command",
    paragraphs: [
      `Hello ${opts.name},`,
      `${opts.inviter} has invited you to Project Command, the project tracker for Ariel Development and Lian Development, as ${opts.role}.`,
      "Choose a password to finish setting up your account. The link works for 7 days.",
      `On iPhone: after signing in, open the site in Safari, tap Share, then "Add to Home Screen" to install the app and receive notifications. Step-by-step guide: ${env().APP_URL}/install`,
    ],
    cta: { label: "Accept invitation", url },
    footnote: "If you were not expecting this, you can ignore this email.",
  });
  return sendEmail({ to: opts.to, subject: `${opts.inviter} invited you to Project Command`, ...content, category: "invite", urgent: true });
}

const passwordSchema = z.string().superRefine((p, ctx) => {
  const problem = passwordProblem(p);
  if (problem) ctx.addIssue({ code: "custom", message: problem });
});

export const invitesRouter = router({
  /** Public: what the invite page shows before the person sets a password. */
  lookup: publicProcedure.input(z.object({ token: z.string().min(20).max(100) })).query(async ({ ctx, input }) => {
    const tokenHash = await hashToken(input.token);
    const [inv] = await ctx.db
      .select({
        name: schema.invitation.name,
        email: schema.invitation.email,
        role: schema.invitation.role,
        expiresAt: schema.invitation.expiresAt,
        acceptedAt: schema.invitation.acceptedAt,
        revokedAt: schema.invitation.revokedAt,
      })
      .from(schema.invitation)
      .where(eq(schema.invitation.tokenHash, tokenHash));
    if (!inv || inv.revokedAt) return { state: "invalid" as const };
    if (inv.acceptedAt) return { state: "accepted" as const };
    if (inv.expiresAt < new Date()) return { state: "expired" as const };
    return { state: "valid" as const, name: inv.name, email: inv.email, role: inv.role };
  }),

  /** Public: set a password and create the account. The client then signs in. */
  accept: publicProcedure
    .input(z.object({ token: z.string().min(20).max(100), name: z.string().trim().min(1).max(120), password: passwordSchema }))
    .mutation(async ({ ctx, input }) => {
      const tokenHash = await hashToken(input.token);
      // Claim the invitation atomically so it can only be used once.
      const [claimed] = await ctx.db
        .update(schema.invitation)
        .set({ acceptedAt: new Date() })
        .where(
          and(
            eq(schema.invitation.tokenHash, tokenHash),
            isNull(schema.invitation.acceptedAt),
            isNull(schema.invitation.revokedAt),
            gt(schema.invitation.expiresAt, new Date()),
          ),
        )
        .returning();
      if (!claimed) throw new TRPCError({ code: "BAD_REQUEST", message: "This invitation is no longer valid." });

      const email = claimed.email.toLowerCase();
      let createdUserId: string | null = null;
      try {
        const [existing] = await ctx.db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.email, email));
        if (existing) throw new TRPCError({ code: "CONFLICT", message: "An account with this email already exists. Sign in instead." });

        const authCtx = await auth().$context;
        const hash = await authCtx.password.hash(input.password);
        const created = await authCtx.internalAdapter.createUser({
          email,
          name: input.name,
          emailVerified: true,
          role: claimed.role,
          status: "active",
          title: claimed.title,
          company: claimed.company,
        }, { method: "email-password" });
        createdUserId = created.id;
        await authCtx.internalAdapter.linkAccount({
          userId: created.id,
          providerId: "credential",
          accountId: created.id,
          password: hash,
        });
        await ctx.db.transaction(async (tx) => {
          await tx.update(schema.invitation).set({ acceptedUserId: created.id }).where(eq(schema.invitation.id, claimed.id));
          await recordAudit(tx, {
            actorId: created.id,
            actorName: input.name,
            action: "invite.accept",
            entityType: "user",
            entityId: created.id,
            summary: `${input.name} accepted an invitation as ${ROLE_LABEL[claimed.role]}`,
            data: { email, role: claimed.role },
            ip: ctx.ip,
          });
        });
        return { email };
      } catch (err) {
        // Undo a half-created account (cascades to its credential row), then
        // release the claim so the person can simply retry.
        if (createdUserId) await ctx.db.delete(schema.user).where(eq(schema.user.id, createdUserId));
        await ctx.db
          .update(schema.invitation)
          .set({ acceptedAt: null, acceptedUserId: null })
          .where(eq(schema.invitation.id, claimed.id));
        throw err;
      }
    }),
});

const inviteInput = z.object({
  email: z.email().transform((e) => e.toLowerCase()),
  name: z.string().trim().min(1).max(120),
  role: z.enum(GLOBAL_ROLES),
  title: z.string().trim().max(120).optional(),
  company: z.string().trim().max(120).optional(),
});

export const usersRouter = router({
  list: globalProcedure("users.manage").query(async ({ ctx }) => {
    const users = await ctx.db
      .select({
        id: schema.user.id,
        name: schema.user.name,
        email: schema.user.email,
        role: schema.user.role,
        status: schema.user.status,
        title: schema.user.title,
        company: schema.user.company,
        twoFactorEnabled: schema.user.twoFactorEnabled,
        createdAt: schema.user.createdAt,
        projectCount: sql<number>`(select count(*)::int from ${schema.projectMember} pm where pm.user_id = ${schema.user.id})`,
        lastSeenAt: schema.user.lastSeenAt,
      })
      .from(schema.user)
      .orderBy(asc(schema.user.status), asc(schema.user.name));
    return users.map((u) => ({ ...u, twoFactorEnabled: !!u.twoFactorEnabled }));
  }),

  invitations: globalProcedure("users.manage").query(async ({ ctx }) => {
    return ctx.db
      .select({
        id: schema.invitation.id,
        email: schema.invitation.email,
        name: schema.invitation.name,
        role: schema.invitation.role,
        expiresAt: schema.invitation.expiresAt,
        createdAt: schema.invitation.createdAt,
      })
      .from(schema.invitation)
      .where(and(isNull(schema.invitation.acceptedAt), isNull(schema.invitation.revokedAt)))
      .orderBy(desc(schema.invitation.createdAt));
  }),

  invite: globalProcedure("users.manage")
    .input(inviteInput)
    .mutation(async ({ ctx, input }) => {
      const [existing] = await ctx.db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.email, input.email));
      if (existing) throw new TRPCError({ code: "CONFLICT", message: "That person already has an account." });

      const token = generateToken();
      const tokenHash = await hashToken(token);
      const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000);

      const inv = await ctx.db.transaction(async (tx) => {
        // A fresh invitation replaces any pending one for the same email.
        await tx
          .update(schema.invitation)
          .set({ revokedAt: new Date() })
          .where(and(eq(schema.invitation.email, input.email), isNull(schema.invitation.acceptedAt), isNull(schema.invitation.revokedAt)));
        const [row] = await tx
          .insert(schema.invitation)
          .values({ ...input, tokenHash, expiresAt, invitedById: ctx.viewer.id })
          .returning({ id: schema.invitation.id });
        await recordAudit(tx, {
          actorId: ctx.viewer.id,
          actorName: ctx.viewer.name,
          action: "invite",
          entityType: "invitation",
          entityId: row!.id,
          summary: `${ctx.viewer.name} invited ${input.name} (${input.email}) as ${ROLE_LABEL[input.role]}`,
          data: { email: input.email, role: input.role },
          ip: ctx.ip,
        });
        return row!;
      });

      const delivery = await sendInviteEmail({
        to: input.email,
        name: input.name,
        inviter: ctx.viewer.name,
        role: ROLE_LABEL[input.role],
        token,
      });
      // The link is returned to the owner as well, so an invite can be shared
      // by hand (e.g. WhatsApp) if email is held or fails.
      return { id: inv.id, delivery, inviteUrl: `${env().APP_URL}/invite/${token}` };
    }),

  resendInvite: globalProcedure("users.manage")
    .input(z.object({ invitationId: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      const token = generateToken();
      const tokenHash = await hashToken(token);
      const [inv] = await ctx.db
        .update(schema.invitation)
        .set({ tokenHash, expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000) })
        .where(and(eq(schema.invitation.id, input.invitationId), isNull(schema.invitation.acceptedAt), isNull(schema.invitation.revokedAt)))
        .returning();
      if (!inv) throw new TRPCError({ code: "NOT_FOUND" });
      const delivery = await sendInviteEmail({ to: inv.email, name: inv.name, inviter: ctx.viewer.name, role: ROLE_LABEL[inv.role], token });
      return { delivery, inviteUrl: `${env().APP_URL}/invite/${token}` };
    }),

  revokeInvite: globalProcedure("users.manage")
    .input(z.object({ invitationId: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.transaction(async (tx) => {
        const [inv] = await tx
          .update(schema.invitation)
          .set({ revokedAt: new Date() })
          .where(and(eq(schema.invitation.id, input.invitationId), isNull(schema.invitation.acceptedAt)))
          .returning();
        if (!inv) throw new TRPCError({ code: "NOT_FOUND" });
        await recordAudit(tx, {
          actorId: ctx.viewer.id,
          actorName: ctx.viewer.name,
          action: "invite.revoke",
          entityType: "invitation",
          entityId: inv.id,
          summary: `${ctx.viewer.name} revoked the invitation for ${inv.email}`,
          ip: ctx.ip,
        });
      });
      return { ok: true };
    }),

  setRole: globalProcedure("users.manage")
    .input(z.object({ userId: z.string().min(1), role: z.enum(GLOBAL_ROLES) }))
    .mutation(async ({ ctx, input }) => {
      if (!canAssignGlobalRole(ctx.actor, input.role, input.userId)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "You cannot change your own owner role." });
      }
      await ctx.db.transaction(async (tx) => {
        const [before] = await tx.select().from(schema.user).where(eq(schema.user.id, input.userId));
        if (!before) throw new TRPCError({ code: "NOT_FOUND" });
        if (before.role === input.role) return;
        await tx.update(schema.user).set({ role: input.role, updatedAt: new Date() }).where(eq(schema.user.id, input.userId));
        await recordAudit(tx, {
          actorId: ctx.viewer.id,
          actorName: ctx.viewer.name,
          action: "permission.change",
          entityType: "user",
          entityId: input.userId,
          summary: `${ctx.viewer.name} changed ${before.name}'s role from ${ROLE_LABEL[before.role]} to ${ROLE_LABEL[input.role]}`,
          data: { from: before.role, to: input.role },
          ip: ctx.ip,
        });
      });
      return { ok: true };
    }),

  setStatus: globalProcedure("users.manage")
    .input(z.object({ userId: z.string().min(1), status: z.enum(["active", "deactivated"]) }))
    .mutation(async ({ ctx, input }) => {
      if (input.userId === ctx.viewer.id) {
        throw new TRPCError({ code: "FORBIDDEN", message: "You cannot deactivate your own account." });
      }
      await ctx.db.transaction(async (tx) => {
        const [before] = await tx.select().from(schema.user).where(eq(schema.user.id, input.userId));
        if (!before) throw new TRPCError({ code: "NOT_FOUND" });
        if (before.status === input.status) return;
        await tx.update(schema.user).set({ status: input.status, updatedAt: new Date() }).where(eq(schema.user.id, input.userId));
        if (input.status === "deactivated") {
          // End every session immediately, and send their pending approvals to someone who can act.
          await tx.delete(schema.session).where(eq(schema.session.userId, input.userId));
          await rerouteApprovals(tx, input.userId, ctx.viewer.id);
        }
        await recordAudit(tx, {
          actorId: ctx.viewer.id,
          actorName: ctx.viewer.name,
          action: input.status === "deactivated" ? "user.deactivate" : "user.reactivate",
          entityType: "user",
          entityId: input.userId,
          summary: `${ctx.viewer.name} ${input.status === "deactivated" ? "deactivated" : "reactivated"} ${before.name}`,
          ip: ctx.ip,
        });
      });
      return { ok: true };
    }),

  /**
   * While email is on hold, the owner creates a one-hour, single-use reset
   * link and shares it (WhatsApp, text). Uses Better Auth's own reset token
   * format, so the normal /reset-password page completes it.
   */
  createResetLink: globalProcedure("users.manage")
    .input(z.object({ userId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const [target] = await ctx.db
        .select({ id: schema.user.id, name: schema.user.name, status: schema.user.status })
        .from(schema.user)
        .where(eq(schema.user.id, input.userId));
      if (!target) throw new TRPCError({ code: "NOT_FOUND" });
      if (target.status !== "active") throw new TRPCError({ code: "BAD_REQUEST", message: "Reactivate this person first." });
      const token = generateToken();
      const authCtx = await auth().$context;
      await authCtx.internalAdapter.createVerificationValue({
        value: target.id,
        identifier: `reset-password:${token}`,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      });
      await recordAudit(ctx.db, {
        actorId: ctx.viewer.id,
        actorName: ctx.viewer.name,
        action: "password.resetLink",
        entityType: "user",
        entityId: target.id,
        summary: `${ctx.viewer.name} created a password reset link for ${target.name}`,
        ip: ctx.ip,
      });
      return { resetUrl: `${env().APP_URL}/reset-password?token=${encodeURIComponent(token)}`, expiresInMinutes: 60 };
    }),

  /** Project assignments and flags for one user (Team & permissions). */
  access: globalProcedure("users.manage")
    .input(z.object({ userId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      return ctx.db
        .select({
          projectId: schema.project.id,
          projectName: schema.project.name,
          address: schema.project.address,
          projectRole: schema.projectMember.projectRole,
          canViewFinancials: schema.projectMember.canViewFinancials,
          canEditChecklist: schema.projectMember.canEditChecklist,
          canApprove: schema.projectMember.canApprove,
        })
        .from(schema.projectMember)
        .innerJoin(schema.project, eq(schema.project.id, schema.projectMember.projectId))
        .where(eq(schema.projectMember.userId, input.userId))
        .orderBy(asc(schema.project.name));
    }),
});

export const meRouter = router({
  get: protectedProcedure.query(({ ctx }) => ctx.viewer),

  updateProfile: protectedProcedure
    .input(z.object({ name: z.string().trim().min(1).max(120), title: z.string().trim().max(120).nullable() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.transaction(async (tx) => {
        await tx.update(schema.user).set({ name: input.name, title: input.title, updatedAt: new Date() }).where(eq(schema.user.id, ctx.viewer.id));
        await recordAudit(tx, {
          actorId: ctx.viewer.id,
          actorName: input.name,
          action: "update",
          entityType: "user",
          entityId: ctx.viewer.id,
          summary: `${input.name} updated their profile`,
          data: { name: input.name, title: input.title },
          ip: ctx.ip,
        });
      });
      return { ok: true };
    }),
});
