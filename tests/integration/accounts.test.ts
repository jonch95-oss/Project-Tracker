import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { auth } from "@/server/auth";
import { db, schema } from "@/server/db";
import { createOrResetAccount } from "@/server/services/create-account";
import { sendEmail } from "@/server/services/email";
import { assertOnProject } from "@/server/trpc/routers/docs";
import { projectPeople } from "@/server/trpc/routers/tasks";
import { callerFor, createProject, createUser } from "../support/fixtures";

const BASE = "http://localhost:3000/api/auth";
const TEMP = "Temporary 12345";

function post(path: string, body: unknown, cookie?: string) {
  return auth().handler(
    new Request(`${BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    }),
  );
}
const cookieOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
const userRow = async (id: string) => (await db().select().from(schema.user).where(eq(schema.user.id, id)))[0]!;
let n = 0;
const uname = () => `acct${Date.now().toString(36)}${++n}`;

describe("accounts made with a sign-in name", () => {
  it("signs in by name (any case), must replace the temporary password, and can't keep it", async () => {
    const username = uname();
    const { id, created } = await createOrResetAccount(db(), { name: "Test Person", username, role: "admin", password: TEMP });
    expect(created).toBe(true);
    const u = await userRow(id);
    expect(u.email).toBe(`${username}@users.invalid`);
    expect(u.mustChangePassword).toBe(true);

    const signIn = await post("/sign-in/username", { username: username.toUpperCase(), password: TEMP });
    expect(signIn.status).toBe(200);
    const cookie = cookieOf(signIn);

    // Same password again: refused, and the flag stays.
    const same = await post("/change-password", { currentPassword: TEMP, newPassword: TEMP }, cookie);
    expect(same.status).toBe(400);
    expect((await userRow(id)).mustChangePassword).toBe(true);

    const changed = await post("/change-password", { currentPassword: TEMP, newPassword: "My own password 99" }, cookie);
    expect(changed.status).toBe(200);
    expect((await userRow(id)).mustChangePassword).toBe(false);
  });

  it("nobody can pick or change their own sign-in name", async () => {
    const member = await createUser("external", { password: "correct horse battery 1" });
    const signIn = await post("/sign-in/email", { email: member.email, password: "correct horse battery 1" });
    const res = await post("/update-user", { username: "someonesname" }, cookieOf(signIn));
    expect(res.status).toBe(403);
    expect((await userRow(member.id)).username).toBeNull();
    // Changing their display name still works.
    expect((await post("/update-user", { name: "New Name" }, cookieOf(signIn))).status).toBe(200);
  });

  it("a reset changes only the password: role and status stay, sessions and second factors go", async () => {
    const username = uname();
    const { id } = await createOrResetAccount(db(), { name: "Owner Person", username, role: "owner", password: TEMP });
    await db().update(schema.user).set({ mustChangePassword: false, status: "deactivated" }).where(eq(schema.user.id, id));
    await db().insert(schema.twoFactor).values({ id: `tf-${id}`, secret: "x", backupCodes: "y", userId: id });
    await db().update(schema.user).set({ twoFactorEnabled: true }).where(eq(schema.user.id, id));
    await db().insert(schema.session).values({ id: `s-${id}`, token: `t-${id}`, userId: id, expiresAt: new Date(Date.now() + 3600_000), createdAt: new Date(), updatedAt: new Date() });

    const r = await createOrResetAccount(db(), { name: "Ignored", username, role: "admin", password: "Another temp 123" });
    expect(r.created).toBe(false);
    expect(r.notes.join(" ")).toMatch(/Role left as owner/);
    expect(r.notes.join(" ")).toMatch(/deactivated/);
    const u = await userRow(id);
    expect(u).toMatchObject({ role: "owner", status: "deactivated", name: "Owner Person", mustChangePassword: true, twoFactorEnabled: false });
    expect(await db().select().from(schema.session).where(eq(schema.session.userId, id))).toHaveLength(0);
    expect(await db().select().from(schema.twoFactor).where(eq(schema.twoFactor.userId, id))).toHaveLength(0);
  });

  it("won't reset an account whose sign-in name sits on a different email", async () => {
    const other = await createUser("external");
    const username = uname();
    await db().update(schema.user).set({ username, displayUsername: username }).where(eq(schema.user.id, other.id));
    await expect(createOrResetAccount(db(), { name: "X", username, role: "admin", password: TEMP })).rejects.toThrow(/different email/);
    expect((await userRow(other.id)).role).toBe("external");
    // With that email named, the owner means to reset exactly this account.
    const r = await createOrResetAccount(db(), { name: "X", username, role: "admin", password: TEMP, email: other.email });
    expect(r.created).toBe(false);
    expect((await userRow(other.id)).role).toBe("external");
  });

  it("gives an invited person (found by email) a sign-in name", async () => {
    const invited = await createUser("member");
    const username = uname();
    const r = await createOrResetAccount(db(), { name: "Invited", username, role: "member", password: TEMP, email: invited.email });
    expect(r).toMatchObject({ id: invited.id, created: false });
    expect((await userRow(invited.id)).username).toBe(username);
    await expect(createOrResetAccount(db(), { name: "Invited", username: uname(), role: "member", password: TEMP, email: invited.email })).rejects.toThrow(/already signs in/);
  });

  it("a password chosen through the email link clears the temporary one", async () => {
    const { id } = await createOrResetAccount(db(), { name: "Reset Person", username: uname(), role: "member", password: TEMP });
    const u = await userRow(id);
    await auth().options.emailAndPassword!.onPasswordReset!({ user: u as never } as never);
    expect((await userRow(id)).mustChangePassword).toBe(false);
  });

  it("never emails a placeholder address", async () => {
    expect(await sendEmail({ to: "someone@users.invalid", subject: "x", html: "x", text: "x", category: "password_reset", urgent: true } as never)).toBe("skipped");
    const rows = await db().select().from(schema.emailOutbox).where(eq(schema.emailOutbox.toAddress, "someone@users.invalid"));
    expect(rows).toHaveLength(0);
  });
});

describe("admins on projects they aren't on", () => {
  it("can be given work there and appear among its people", async () => {
    const owner = await createUser("owner");
    const admin = await createUser("admin");
    const p = await createProject(owner.id);
    const people = await projectPeople(db(), p.id);
    expect(people.find((x) => x.id === admin.id)).toMatchObject({ projectRole: "Admin", external: false });
    await expect(assertOnProject(db(), p.id, admin.id)).resolves.toBeUndefined();
    // …and they see it in the task screen's people list.
    const detail = await (await callerFor(admin.id)).projects.get({ projectId: p.id });
    expect(detail).toBeDefined();
  });
});
