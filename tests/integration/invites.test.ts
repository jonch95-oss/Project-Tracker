import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db, schema } from "@/server/db";
import { callerFor, createUser } from "../support/fixtures";

function tokenFrom(url: string): string {
  return url.split("/invite/")[1]!;
}

describe("invitations", () => {
  let ownerId: string;
  beforeAll(async () => {
    ownerId = (await createUser("owner")).id;
  });

  it("owner invites; the invite email is sent; acceptance creates the account with the invited role", async () => {
    const owner = await callerFor(ownerId);
    const email = `elias-${Date.now()}@example.com`;
    const res = await owner.users.invite({ email, name: "Elias", role: "admin", title: "Partner" });
    expect(res.delivery).toBe("sent");

    const [mail] = await db().select().from(schema.emailOutbox).where(eq(schema.emailOutbox.toAddress, email));
    expect(mail?.category).toBe("invite");
    expect(mail?.text).toContain("/install");
    expect(mail?.text).toContain(tokenFrom(res.inviteUrl));

    const anon = await callerFor(null);
    const token = tokenFrom(res.inviteUrl);
    expect(await anon.invites.lookup({ token })).toMatchObject({ state: "valid", email, role: "admin" });

    await anon.invites.accept({ token, name: "Elias Cohen", password: "a strong passphrase 9" });
    const [u] = await db().select().from(schema.user).where(eq(schema.user.email, email));
    expect(u).toMatchObject({ role: "admin", status: "active", name: "Elias Cohen", title: "Partner", emailVerified: true });

    // Single use.
    expect(await anon.invites.lookup({ token })).toEqual({ state: "accepted" });
    await expect(anon.invites.accept({ token, name: "Again", password: "a strong passphrase 9" })).rejects.toThrow(/no longer valid/);
  });

  it("stores only a hash of the token", async () => {
    const owner = await callerFor(ownerId);
    const res = await owner.users.invite({ email: `hash-${Date.now()}@example.com`, name: "Hash", role: "member" });
    const token = tokenFrom(res.inviteUrl);
    const rows = await db().select().from(schema.invitation).where(eq(schema.invitation.id, res.id));
    expect(rows[0]!.tokenHash).not.toContain(token);
    expect(rows[0]!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("revoked and expired invitations cannot be used", async () => {
    const owner = await callerFor(ownerId);
    const anon = await callerFor(null);

    const r1 = await owner.users.invite({ email: `rev-${Date.now()}@example.com`, name: "Rev", role: "member" });
    await owner.users.revokeInvite({ invitationId: r1.id });
    expect(await anon.invites.lookup({ token: tokenFrom(r1.inviteUrl) })).toEqual({ state: "invalid" });
    await expect(anon.invites.accept({ token: tokenFrom(r1.inviteUrl), name: "Rev", password: "a strong passphrase 9" })).rejects.toThrow();

    const r2 = await owner.users.invite({ email: `exp-${Date.now()}@example.com`, name: "Exp", role: "member" });
    await db().update(schema.invitation).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.invitation.id, r2.id));
    expect(await anon.invites.lookup({ token: tokenFrom(r2.inviteUrl) })).toEqual({ state: "expired" });
    await expect(anon.invites.accept({ token: tokenFrom(r2.inviteUrl), name: "Exp", password: "a strong passphrase 9" })).rejects.toThrow();
  });

  it("re-inviting the same email revokes the older link", async () => {
    const owner = await callerFor(ownerId);
    const anon = await callerFor(null);
    const email = `again-${Date.now()}@example.com`;
    const first = await owner.users.invite({ email, name: "A", role: "member" });
    await owner.users.invite({ email, name: "A", role: "member" });
    expect(await anon.invites.lookup({ token: tokenFrom(first.inviteUrl) })).toEqual({ state: "invalid" });
  });

  it("rejects weak passwords and unknown tokens", async () => {
    const owner = await callerFor(ownerId);
    const anon = await callerFor(null);
    const r = await owner.users.invite({ email: `weak-${Date.now()}@example.com`, name: "W", role: "member" });
    await expect(anon.invites.accept({ token: tokenFrom(r.inviteUrl), name: "W", password: "short1" })).rejects.toThrow();
    await expect(anon.invites.accept({ token: tokenFrom(r.inviteUrl), name: "W", password: "onlyletterslong" })).rejects.toThrow();
    // Failed validation must not consume the invitation.
    expect((await anon.invites.lookup({ token: tokenFrom(r.inviteUrl) })).state).toBe("valid");
    expect(await anon.invites.lookup({ token: "x".repeat(43) })).toEqual({ state: "invalid" });
  });

  it("cannot invite an existing user", async () => {
    const owner = await callerFor(ownerId);
    const existing = await createUser("member");
    await expect(owner.users.invite({ email: existing.email, name: "Dup", role: "member" })).rejects.toThrow(/already has an account/);
  });

  it("owner manages roles and status with safeguards", async () => {
    const owner = await callerFor(ownerId);
    const target = await createUser("member");
    await owner.users.setRole({ userId: target.id, role: "external" });
    await owner.users.setStatus({ userId: target.id, status: "deactivated" });
    const [u] = await db().select().from(schema.user).where(eq(schema.user.id, target.id));
    expect(u).toMatchObject({ role: "external", status: "deactivated" });
    await expect(owner.users.setRole({ userId: ownerId, role: "admin" })).rejects.toThrow(/own owner role/);
    await expect(owner.users.setStatus({ userId: ownerId, status: "deactivated" })).rejects.toThrow(/own account/);
  });
});
