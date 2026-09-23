/**
 * DEMO / TEST DATA ONLY. Never run against production.
 * Creates demo users (password "demo password 1") and a few projects so the
 * UI can be exercised. Guarded: refuses unless DEMO_SEED=1 and the database
 * name contains "dev", "test" or "demo".
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const dbName = new URL(url).pathname.slice(1);
  if (process.env.DEMO_SEED !== "1" || !/dev|test|demo/.test(dbName)) {
    throw new Error(`Refusing to seed "${dbName}". Set DEMO_SEED=1 and use a dev/test/demo database.`);
  }
  process.env.BETTER_AUTH_SECRET ??= "demo-secret-demo-secret-demo-secret-000000";
  const { auth } = await import("../src/server/auth");
  const schema = await import("../src/server/db/schema");
  const ctx = await auth().$context;
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool, { schema });

  const people = [
    { email: "jon@demo.test", name: "Jon Lian", role: "owner", title: "Principal" },
    { email: "elias@demo.test", name: "Elias Ariel", role: "admin", title: "Partner" },
    { email: "ariel@demo.test", name: "Ariel Cohen", role: "member", title: "Project Manager" },
    { email: "architect@demo.test", name: "Maya Brooks", role: "external", title: "Architect", company: "Brooks Studio" },
  ] as const;

  const ids: Record<string, string> = {};
  for (const p of people) {
    const existing = await ctx.internalAdapter.findUserByEmail(p.email);
    if (existing) {
      ids[p.email] = existing.user.id;
      continue;
    }
    const u = await ctx.internalAdapter.createUser({ ...p, emailVerified: true, status: "active" }, { method: "email-password" });
    await ctx.internalAdapter.linkAccount({ userId: u.id, providerId: "credential", accountId: u.id, password: await ctx.password.hash("demo password 1") });
    ids[p.email] = u.id;
  }

  const companies = await db.select().from(schema.company);
  const ariel = companies.find((c) => c.shortName === "Ariel")!;
  const lian = companies.find((c) => c.shortName === "Lian JV")!;
  const projects = [
    { name: "Sterling Place Townhouse", address: "412 Sterling Place", bbl: "3011370045", type: "gut_renovation", companyId: ariel.id },
    { name: "Bergen Street Condominium", address: "88 Bergen Street", bbl: "3003920021", type: "ground_up_condo", companyId: lian.id },
    { name: "Macon Street Auction", address: "215 Macon Street", bbl: null, type: "foreclosure_auction", companyId: ariel.id },
  ] as const;
  for (const p of projects) {
    const [row] = await db.insert(schema.project).values({ ...p, createdById: ids["jon@demo.test"] }).returning();
    await db.insert(schema.projectMember).values([
      { projectId: row!.id, userId: ids["elias@demo.test"]!, projectRole: "PM", canViewFinancials: true, canEditChecklist: true, canApprove: true },
      { projectId: row!.id, userId: ids["ariel@demo.test"]!, projectRole: "Construction", canEditChecklist: true },
      { projectId: row!.id, userId: ids["architect@demo.test"]!, projectRole: "Architect" },
    ]);
  }
  await pool.end();
  console.log("Demo seed complete. Users: jon@ / elias@ / ariel@ / architect@demo.test — password: demo password 1");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
