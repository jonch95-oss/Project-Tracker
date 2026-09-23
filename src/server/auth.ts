import "server-only";
import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { twoFactor } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import { db, schema } from "./db";
import { allowedOrigins, env } from "./env";
import { passwordProblem } from "@/core/password";
import { clientIp, TRUSTED_IP_HEADERS } from "./request-ip";
import { recordAudit } from "./services/audit";
import { renderEmail, sendEmail } from "./services/email";

export const APP_NAME = "Project Command";

function createAuth() {
  const appUrl = new URL(env().APP_URL);

  return betterAuth({
    appName: APP_NAME,
    baseURL: env().APP_URL,
    secret: env().BETTER_AUTH_SECRET,
    trustedOrigins: allowedOrigins(),
    database: drizzleAdapter(db(), { provider: "pg", schema }),

    emailAndPassword: {
      enabled: true,
      // Invite-only: accounts are created by accepting an invitation (see invites router).
      disableSignUp: true,
      minPasswordLength: 12,
      maxPasswordLength: 256,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: 60 * 60,
      async sendResetPassword({ user, url }) {
        const content = renderEmail({
          preheader: "Reset your Project Command password",
          heading: "Reset your password",
          paragraphs: [
            `Hello ${user.name},`,
            "Someone asked to reset the password for your Project Command account. The link below works for one hour.",
          ],
          cta: { label: "Choose a new password", url },
          footnote: "If you did not ask for this, you can ignore this email; your password will not change.",
        });
        await sendEmail({
          to: user.email,
          subject: "Reset your Project Command password",
          ...content,
          category: "password_reset",
          urgent: true,
        });
      },
      async onPasswordReset({ user }) {
        await recordAudit(db(), {
          actorId: user.id,
          actorName: user.name,
          action: "password.reset",
          entityType: "user",
          entityId: user.id,
          summary: `${user.name} reset their password`,
        });
      },
    },

    user: {
      additionalFields: {
        role: { type: "string", required: false, defaultValue: "member", input: false },
        status: { type: "string", required: false, defaultValue: "active", input: false },
        title: { type: "string", required: false, input: false },
        company: { type: "string", required: false, input: false },
        phone: { type: "string", required: false, input: false },
      },
    },

    session: {
      expiresIn: 60 * 60 * 24 * 30, // 30 days: field users stay signed in on their phones
      updateAge: 60 * 60 * 24,
      // No cookie cache: revoking a session (sign out elsewhere, deactivation) takes effect on the next request.
      cookieCache: { enabled: false },
    },

    rateLimit: {
      // Off only for automated tests; E2E_DISABLE_RATE_LIMIT is ignored unless the app runs on localhost.
      enabled: env().NODE_ENV !== "test" && !(process.env.E2E_DISABLE_RATE_LIMIT === "1" && appUrl.hostname === "localhost"),
      storage: "database",
      window: 60,
      max: 60,
      customRules: {
        "/sign-in/email": { window: 60, max: 10 }, // per IP; the office may share one
        "/request-password-reset": { window: 300, max: 3 },
        "/reset-password": { window: 300, max: 5 },
        "/two-factor/verify-totp": { window: 60, max: 5 },
        "/two-factor/verify-backup-code": { window: 60, max: 5 },
        "/passkey/verify-authentication": { window: 60, max: 10 },
      },
    },

    advanced: {
      useSecureCookies: appUrl.protocol === "https:",
      ipAddress: { ipAddressHeaders: TRUSTED_IP_HEADERS },
      database: { generateId: () => crypto.randomUUID() },
    },

    databaseHooks: {
      session: {
        create: {
          // Deactivated users cannot start a session by any method.
          async before(session) {
            const [u] = await db()
              .select({ status: schema.user.status })
              .from(schema.user)
              .where(eq(schema.user.id, session.userId));
            if (!u || u.status !== "active") return false;
          },
        },
      },
    },

    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === "/sign-up/email") {
          throw new APIError("FORBIDDEN", { message: "Accounts are created by invitation only." });
        }
        // Same password rule everywhere (invite, reset, change).
        if (ctx.path === "/reset-password" || ctx.path === "/change-password") {
          const pw = typeof ctx.body?.newPassword === "string" ? ctx.body.newPassword : "";
          const problem = passwordProblem(pw);
          if (problem) throw new APIError("BAD_REQUEST", { message: problem });
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        const returned = ctx.context.returned;
        const failed = returned instanceof APIError;
        const session = ctx.context.session ?? ctx.context.newSession;
        const actorId = session?.user.id ?? null;
        const actorName = session?.user.name ?? null;
        const ip = clientIp(ctx.request?.headers ?? ctx.headers);

        if (ctx.path === "/sign-in/email" && failed) {
          const email = typeof ctx.body?.email === "string" ? ctx.body.email.toLowerCase() : null;
          await recordAudit(db(), {
            actorId: null,
            action: "login.failed",
            entityType: "session",
            summary: `Failed sign-in for ${email ?? "unknown email"}`,
            data: { email },
            ip,
          });
          return;
        }
        if (failed || !actorId) return;

        // A sign-in is complete only when it hands back a real session:
        // password sign-in without 2FA, the 2FA challenge (no prior session),
        // or a passkey. The 2FA plugin creates and deletes a provisional
        // session first, so session-create hooks would log false sign-ins.
        const signInPaths = ["/sign-in/email", "/two-factor/verify-totp", "/two-factor/verify-backup-code", "/passkey/verify-authentication"];
        const pendingTwoFactor = typeof returned === "object" && returned !== null && "twoFactorRedirect" in returned;
        if (signInPaths.includes(ctx.path) && ctx.context.newSession && !ctx.context.session && !pendingTwoFactor) {
          const s = ctx.context.newSession;
          await db().update(schema.user).set({ lastSeenAt: new Date() }).where(eq(schema.user.id, s.user.id));
          await recordAudit(db(), {
            actorId: s.user.id,
            actorName: s.user.name,
            action: "login",
            entityType: "session",
            entityId: s.session.id,
            summary: `${s.user.name} signed in${ctx.path.startsWith("/passkey") ? " with a passkey" : ctx.path.startsWith("/two-factor") ? " with two-factor" : ""}`,
            data: { userAgent: s.session.userAgent ?? null },
            ip,
          });
          return;
        }

        const map: Record<string, { action: Parameters<typeof recordAudit>[1]["action"]; summary: string } | undefined> = {
          "/two-factor/disable": { action: "2fa.disable", summary: `${actorName} turned off two-factor authentication` },
          "/passkey/verify-registration": { action: "passkey.add", summary: `${actorName} added a passkey` },
          "/passkey/delete-passkey": { action: "passkey.remove", summary: `${actorName} removed a passkey` },
        };
        // verify-totp while already signed in means enabling 2FA (not a sign-in challenge).
        if (ctx.path === "/two-factor/verify-totp" && ctx.context.session) {
          map[ctx.path] = { action: "2fa.enable", summary: `${actorName} turned on two-factor authentication` };
        }
        const entry = map[ctx.path];
        if (!entry) return;
        await recordAudit(db(), {
          actorId,
          actorName,
          action: entry.action,
          entityType: "user",
          entityId: actorId,
          summary: entry.summary,
          ip,
        });
      }),
    },

    plugins: [
      twoFactor({ issuer: APP_NAME }),
      passkey({
        rpID: appUrl.hostname,
        rpName: APP_NAME,
        origin: appUrl.origin,
      }),
      nextCookies(),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

const globalForAuth = globalThis as unknown as { __pcAuth?: Auth };

export function auth(): Auth {
  globalForAuth.__pcAuth ??= createAuth();
  return globalForAuth.__pcAuth;
}

export type SessionUser = Auth["$Infer"]["Session"]["user"];
