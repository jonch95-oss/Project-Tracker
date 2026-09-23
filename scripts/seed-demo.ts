/**
 * DEMO / TEST DATA ONLY. Never run against production.
 * Creates demo users (password "demo password 1") and a few projects so the
 * UI can be exercised. Guarded: refuses unless DEMO_SEED=1 and the database
 * name contains "dev", "test" or "demo".
 */
import { eq } from "drizzle-orm";
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
  const { initialPhases, phasesForType, setCurrentPhase } = await import("../src/core/phases");
  const { addDays, todayET } = await import("../src/core/time");
  const today = todayET();
  const projects = [
    {
      p: { name: "Sterling Place Townhouse", address: "412 Sterling Place", bbl: "3011370045", type: "gut_renovation", companyId: ariel.id, latitude: 40.6746, longitude: -73.9716, lotAreaSqft: 2000, zoning: "R6B", residFar: 2.0, builtFar: 1.62, unusedZsf: 760, units: 3, grossSf: 4000, sellableSf: 3400 },
      path: [["pipeline", 210], ["under_contract", 170], ["due_diligence", 140], ["closing", 110], ["design_zoning", 75], ["dob_filing", 21]] as [string, number][],
      headline: { purchasePriceCents: 2_450_000_00, totalBudgetCents: 3_900_000_00, projectedSelloutCents: 6_200_000_00 },
    },
    {
      p: { name: "Bergen Street Condominium", address: "88 Bergen Street", bbl: "3003920021", type: "ground_up_condo", companyId: lian.id, latitude: 40.6868, longitude: -73.9903, lotAreaSqft: 5000, zoning: "R7A", residFar: 4.6, builtFar: 0, unusedZsf: 23000, units: 18, grossSf: 23000, sellableSf: 19500 },
      path: [["pipeline", 400], ["under_contract", 360], ["due_diligence", 330], ["closing", 300], ["design_zoning", 260], ["dob_filing", 180], ["pre_construction", 120], ["construction", 64]] as [string, number][],
      headline: { purchasePriceCents: 5_800_000_00, totalBudgetCents: 14_200_000_00, projectedSelloutCents: 24_500_000_00 },
    },
    {
      p: { name: "Macon Street Auction", address: "215 Macon Street", bbl: null, type: "foreclosure_auction", companyId: ariel.id, latitude: 40.6818, longitude: -73.9363, units: 2 },
      path: [["pipeline", 30], ["auction", 9]] as [string, number][],
      headline: { purchasePriceCents: null, totalBudgetCents: null, projectedSelloutCents: null },
    },
    {
      p: { name: "Halsey Street Assignment", address: "301 Halsey Street", bbl: null, type: "contract_flip", companyId: ariel.id, latitude: 40.6832, longitude: -73.9395, status: "on_hold" },
      path: [["pipeline", 60], ["under_contract", 38], ["marketing", 12]] as [string, number][],
      headline: { purchasePriceCents: 1_150_000_00, totalBudgetCents: null, projectedSelloutCents: 1_325_000_00 },
    },
  ] as const;
  for (const { p, path, headline } of projects) {
    const existing = await db.select({ id: schema.project.id }).from(schema.project).where(eq(schema.project.name, p.name));
    if (existing.length) continue;
    const [row] = await db.insert(schema.project).values({ ...p, createdById: ids["jon@demo.test"] }).returning();
    let phases = initialPhases(phasesForType(p.type), addDays(today, -path[0]![1]));
    for (const [key, ago] of path.slice(1)) phases = setCurrentPhase(phases, key, addDays(today, -ago));
    await db.insert(schema.projectPhase).values(phases.map((ph) => ({ ...ph, projectId: row!.id })));
    if (Object.values(headline).some((v) => v != null)) await db.insert(schema.projectHeadline).values({ projectId: row!.id, ...headline });
    await db.insert(schema.projectMember).values([
      { projectId: row!.id, userId: ids["jon@demo.test"]!, projectRole: "Principal", canViewFinancials: true, canEditChecklist: true, canApprove: true },
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
