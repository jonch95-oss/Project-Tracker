import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { createFirstOwnerInvite, secretsMatch } from "@/server/services/setup";

describe("first-owner setup", () => {
  it("compares secrets exactly", () => {
    expect(secretsMatch("abc", "abc")).toBe(true);
    expect(secretsMatch("abd", "abc")).toBe(false);
    expect(secretsMatch("ab", "abc")).toBe(false);
    expect(secretsMatch("abc", undefined)).toBe(false);
  });

  it("rejects a wrong key, and refuses once any user exists", async () => {
    const wrong = await createFirstOwnerInvite({ email: "jon@example.com", name: "Jon", secret: "nope" });
    expect(wrong).toEqual({ ok: false, error: "That setup key is not correct." });
    const [r] = await db().select({ n: sql<number>`count(*)::int` }).from(sql`"user"`);
    // Earlier test files created users, so the real key must still be refused.
    expect(r!.n).toBeGreaterThan(0);
    const res = await createFirstOwnerInvite({ email: "jon@example.com", name: "Jon", secret: process.env.CRON_SECRET! });
    expect(res).toEqual({ ok: false, error: "Setup is already complete. Sign in instead." });
  });
});
