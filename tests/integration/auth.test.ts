import { base32 } from "@better-auth/utils/base32";
import { createOTP } from "@better-auth/utils/otp";
import { desc, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { auth } from "@/server/auth";
import { db, schema } from "@/server/db";
import { createContext } from "@/server/trpc/init";
import { createUser, deactivate } from "../support/fixtures";

const BASE = "http://localhost:3000/api/auth";

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return auth().handler(
    new Request(`${BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

function cookieHeader(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

describe("Better Auth wiring", () => {
  let member: Awaited<ReturnType<typeof createUser>>;
  beforeAll(async () => {
    member = await createUser("member", { password: "correct horse battery 1" });
  });

  it("signs in with email and password and resolves the viewer from the DB", async () => {
    const res = await post("/sign-in/email", { email: member.email, password: "correct horse battery 1" });
    expect(res.status).toBe(200);
    const ctx = await createContext({ headers: new Headers({ cookie: cookieHeader(res) }) });
    expect(ctx.viewer?.id).toBe(member.id);
    expect(ctx.actor).toEqual({ userId: member.id, role: "member", status: "active" });

    const [entry] = await db().select().from(schema.auditLog).orderBy(desc(schema.auditLog.seq)).limit(1);
    expect(entry?.action).toBe("login");
    expect(entry?.actorId).toBe(member.id);
  });

  it("rejects a wrong password and audits the failure without the password", async () => {
    const res = await post("/sign-in/email", { email: member.email, password: "wrong password 123" });
    expect(res.status).toBe(401);
    const [entry] = await db().select().from(schema.auditLog).orderBy(desc(schema.auditLog.seq)).limit(1);
    expect(entry?.action).toBe("login.failed");
    expect(JSON.stringify(entry?.data)).not.toContain("wrong password");
  });

  it("blocks public sign-up (invite only)", async () => {
    const res = await post("/sign-up/email", { email: "stranger@example.com", password: "whatever password 1", name: "Stranger" });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const found = await db().select().from(schema.user).where(eq(schema.user.email, "stranger@example.com"));
    expect(found).toHaveLength(0);
  });

  it("deactivated users cannot sign in, and existing sessions stop resolving", async () => {
    const u = await createUser("external", { password: "correct horse battery 1" });
    const ok = await post("/sign-in/email", { email: u.email, password: "correct horse battery 1" });
    expect(ok.status).toBe(200);
    const cookie = cookieHeader(ok);

    await deactivate(u.id);
    const denied = await post("/sign-in/email", { email: u.email, password: "correct horse battery 1" });
    expect(denied.status).toBeGreaterThanOrEqual(400);

    // Even if a cookie still exists, the context reads status fresh from the DB.
    const ctx = await createContext({ headers: new Headers({ cookie }) });
    expect(ctx.actor?.status ?? "deactivated").toBe("deactivated");
  });

  it("password reset emails go through the outbox as urgent mail", async () => {
    const res = await post("/request-password-reset", { email: member.email, redirectTo: "/reset-password" });
    expect(res.status).toBe(200);
    const [mail] = await db()
      .select()
      .from(schema.emailOutbox)
      .where(eq(schema.emailOutbox.toAddress, member.email))
      .orderBy(desc(schema.emailOutbox.createdAt))
      .limit(1);
    expect(mail?.category).toBe("password_reset");
    expect(mail?.status).toBe("sent");
    expect(mail?.urgent).toBe(true);
  });
});

describe("two-factor authentication", () => {
  it("enable → verify → sign-in requires a TOTP code", async () => {
    const u = await createUser("admin", { password: "correct horse battery 1" });
    const login = await post("/sign-in/email", { email: u.email, password: "correct horse battery 1" });
    const cookie = cookieHeader(login);

    const enable = await post("/two-factor/enable", { password: "correct horse battery 1" }, { cookie });
    expect(enable.status).toBe(200);
    const { totpURI, backupCodes } = (await enable.json()) as { totpURI: string; backupCodes: string[] };
    expect(backupCodes.length).toBeGreaterThanOrEqual(8);
    const secret = new TextDecoder().decode(base32.decode(new URL(totpURI).searchParams.get("secret")!));
    const code = () => createOTP(secret).totp();

    const verify = await post("/two-factor/verify-totp", { code: await code() }, { cookie });
    expect(verify.status).toBe(200);
    const [row] = await db().select().from(schema.user).where(eq(schema.user.id, u.id));
    expect(row?.twoFactorEnabled).toBe(true);
    const [entry] = await db().select().from(schema.auditLog).where(eq(schema.auditLog.action, "2fa.enable")).orderBy(desc(schema.auditLog.seq)).limit(1);
    expect(entry?.actorId).toBe(u.id);

    // A fresh sign-in now stops at the 2FA challenge.
    const second = await post("/sign-in/email", { email: u.email, password: "correct horse battery 1" });
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ twoFactorRedirect: true });
    const challengeCookie = cookieHeader(second);
    const noSession = await createContext({ headers: new Headers({ cookie: challengeCookie }) });
    expect(noSession.viewer).toBeNull();

    const bad = await post("/two-factor/verify-totp", { code: "000000" }, { cookie: challengeCookie });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    const good = await post("/two-factor/verify-totp", { code: await code() }, { cookie: challengeCookie });
    expect(good.status).toBe(200);
    const ctx = await createContext({ headers: new Headers({ cookie: cookieHeader(good) }) });
    expect(ctx.viewer?.id).toBe(u.id);
  });
});
