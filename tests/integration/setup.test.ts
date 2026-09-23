/**
 * First-owner setup runs against its own empty database, so it is independent
 * of test order and covers the happy path.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, db, schema } from "@/server/db";
import { resetEnvForTests } from "@/server/env";
import { createFirstOwnerInvite, hasAnyUser, secretsMatch } from "@/server/services/setup";
import { hashToken } from "@/server/services/tokens";

const KEY = "setup-key-setup-key-setup-key-000";
const original = { url: process.env.DATABASE_URL, key: process.env.SETUP_KEY };

async function freshDatabase(name: string): Promise<string> {
  const base = new URL(process.env.DATABASE_URL!);
  const admin = new URL(base);
  admin.pathname = "/postgres";
  const c = new Client({ connectionString: admin.toString() });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await c.query(`CREATE DATABASE "${name}"`);
  await c.end();
  const url = new URL(base);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: url.toString() });
  await migrate(drizzle(pool), { migrationsFolder: "./drizzle" });
  await pool.end();
  return url.toString();
}

beforeAll(async () => {
  const url = await freshDatabase("pc_setup_test");
  await closeDb();
  process.env.DATABASE_URL = url;
  process.env.SETUP_KEY = KEY;
  resetEnvForTests();
});

afterAll(async () => {
  await closeDb();
  process.env.DATABASE_URL = original.url;
  if (original.key === undefined) delete process.env.SETUP_KEY;
  else process.env.SETUP_KEY = original.key;
  resetEnvForTests();
});

describe("first-owner setup", () => {
  it("compares secrets exactly", () => {
    expect(secretsMatch("abc", "abc")).toBe(true);
    expect(secretsMatch("abd", "abc")).toBe(false);
    expect(secretsMatch("ab", "abc")).toBe(false);
    expect(secretsMatch("abc", undefined)).toBe(false);
  });

  it("rejects a wrong key and records the attempt", async () => {
    expect(await hasAnyUser()).toBe(false);
    const res = await createFirstOwnerInvite({ email: "jon@example.com", name: "Jon", secret: "wrong-wrong-wrong-wrong-wrong-00" });
    expect(res).toEqual({ ok: false, error: "That setup key is not correct." });
    const [row] = await db().execute<{ n: number }>(sql`select count(*)::int as n from audit_log where entity_type = 'setup'`).then((r) => r.rows);
    expect(row?.n).toBe(1);
  });

  it("creates a single-use owner invitation on an empty database", async () => {
    const res = await createFirstOwnerInvite({ email: "Jon@Example.com", name: "Jon", secret: KEY });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const token = res.inviteUrl.split("/invite/")[1]!;
    const invites = await db().select().from(schema.invitation);
    expect(invites).toHaveLength(1);
    expect(invites[0]).toMatchObject({ email: "jon@example.com", role: "owner", tokenHash: await hashToken(token) });

    // A second run replaces the pending link rather than creating two owners.
    const again = await createFirstOwnerInvite({ email: "jon@example.com", name: "Jon", secret: KEY });
    expect(again.ok).toBe(true);
    const pending = (await db().select().from(schema.invitation)).filter((i) => !i.revokedAt);
    expect(pending).toHaveLength(1);
  });

  it("refuses once any user exists", async () => {
    await db().insert(schema.user).values({ id: "u-existing", name: "Someone", email: "someone@example.com", role: "member" });
    const res = await createFirstOwnerInvite({ email: "jon@example.com", name: "Jon", secret: KEY });
    expect(res).toEqual({ ok: false, error: "Setup is already complete. Sign in instead." });
  });
});
