import "server-only";
import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { twoFactor } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import { db, schema } from "./db";
import { env } from "./env";
import { recordAudit } from "./services/audit";
import { renderEmail, sendEmail } from "./services/email";

export const APP_NAME = "Project Command";

function clientIp(headers: Headers | undefined | null): string | null {
  if (!headers) return null;
  return (
    headers.get("cf-connecting-ip") ??
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    headers.get("x-real-ip") ??
    null
  );
}

function createAuth() {
  const appUrl = new URL(env().APP_URL);

  return betterAuth({
    appName: APP_NAME,
    baseURL: env().APP_URL,
    secret: env().BETTER_AUTH_SECRET,
    trustedOrigins: [appUrl.origin],
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
      cookieCache: { enabled: true, maxAge: 60 }, // short, so deactivation takes effect within a minute
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
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip", "x-forwarded-for", "x-real-ip"] },
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
          async after(session) {
            const [u] = await db()
              .select({ name: schema.user.name })
              .from(schema.user)
              .where(eq(schema.user.id, session.userId));
            await recordAudit(db(), {
              actorId: session.userId,
              actorName: u?.name ?? null,
              action: "login",
              entityType: "session",
              entityId: session.id,
              summary: `${u?.name ?? "User"} signed in`,
              data: { userAgent: session.userAgent ?? null },
              ip: session.ipAddress ?? null,
            });
          },
        },
      },
    },

    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === "/sign-up/email") {
          throw new APIError("FORBIDDEN", { message: "Accounts are created by invitation only." });
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
