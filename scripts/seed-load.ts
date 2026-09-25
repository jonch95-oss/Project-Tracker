/**
 * LOAD-TEST DATA ONLY (brief §13). Never run against production.
 * On top of the demo seed, grows the database to 25 projects, 3,000 tasks and
 * 5,000 files, and adds 50 test people (load01…load50@demo.test, password
 * "demo password 1") on every project, each with work assigned.
 * Guarded: refuses unless LOAD_SEED=1 and the database name contains "load".
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

const PROJECTS = 25;
const TASKS = 3000;
const FILES = 5000;
const USERS = 50;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const dbName = new URL(url).pathname.slice(1);
  if (process.env.LOAD_SEED !== "1" || !/load/.test(dbName)) throw new Error(`Refusing to seed "${dbName}". Set LOAD_SEED=1 and use a database whose name contains "load".`);
  process.env.BETTER_AUTH_SECRET ??= "demo-secret-demo-secret-demo-secret-000000";
  const { auth } = await import("../src/server/auth");
  const schema = await import("../src/server/db/schema");
  const { buildProjectChecklist, defaultTemplateFor, reschedule } = await import("../src/server/services/checklist");
  const { ensureProjectFolders } = await import("../src/server/services/files");
  const { setCurrentPhase } = await import("../src/core/phases");
  const { addDays, todayET } = await import("../src/core/time");
  const { and, count, eq, inArray, ne, sql } = await import("drizzle-orm");
  const ctx = await auth().$context;
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool, { schema });
  const today = todayET();

  const [owner] = await db.select().from(schema.user).where(eq(schema.user.email, "jon@demo.test"));
  if (!owner) throw new Error("Run the demo seed first.");
  const companies = await db.select().from(schema.company);

  // People.
  const hash = await ctx.password.hash("demo password 1");
  const people: string[] = [];
  for (let i = 1; i <= USERS; i++) {
    const email = `load${String(i).padStart(2, "0")}@demo.test`;
    const [had] = await db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.email, email));
    if (had) {
      people.push(had.id);
      continue;
    }
    const u = await ctx.internalAdapter.createUser({ email, name: `Load Tester ${i}`, emailVerified: true, role: "member", status: "active" }, { method: "email-password" });
    await ctx.internalAdapter.linkAccount({ userId: u.id, providerId: "credential", accountId: u.id, password: hash });
    people.push(u.id);
  }

  // Projects, each with a real checklist from its default template, part-way through.
  const types = ["ground_up_condo", "gut_renovation", "contract_flip", "foreclosure_auction", "condo_conversion"] as const;
  const streets = ["Dean", "Bergen", "Pacific", "Prospect", "Park", "Sterling", "St Marks", "Lincoln", "Bainbridge", "Decatur", "Macon", "MacDonough", "Hancock", "Jefferson", "Madison", "Putnam", "Halsey", "Monroe", "Quincy", "Gates", "Greene", "Lexington", "Kosciuszko", "Hart", "Willoughby"];
  const have = (await db.select({ n: count() }).from(schema.project))[0]!.n;
  for (let i = have; i < PROJECTS; i++) {
    const type = types[i % types.length]!;
    const [row] = await db
      .insert(schema.project)
      .values({ name: `${streets[i % streets.length]} Street ${100 + i}`, address: `${100 + i} ${streets[i % streets.length]} Street`, bbl: `30${String(1000 + i).padStart(4, "0")}00${String(10 + i).padStart(2, "0")}`, type, companyId: companies[i % companies.length]!.id, latitude: 40.67 + (i % 7) * 0.004, longitude: -73.96 + (i % 5) * 0.006, createdById: owner.id })
      .returning();
    const tpl = await defaultTemplateFor(db as never, type);
    const start = addDays(today, -(120 + i * 9));
    await buildProjectChecklist(db as never, { projectId: row!.id, type, template: tpl, chosenToggles: [], today: start, userId: owner.id });
    await ensureProjectFolders(db as never, row!.id);
    const stored = await db.select().from(schema.projectPhase).where(eq(schema.projectPhase.projectId, row!.id));
    let phases = stored.map((x) => ({ key: x.key, name: x.name, sortOrder: x.sortOrder, status: x.status, startedOn: x.startedOn, completedOn: x.completedOn }));
    const ordered = [...phases].sort((a, b) => a.sortOrder - b.sortOrder);
    const reach = Math.min(ordered.length - 1, 1 + (i % 5));
    for (let k = 1; k <= reach; k++) phases = setCurrentPhase(phases, ordered[k]!.key, addDays(start, k * 25));
    for (const ph of phases) await db.update(schema.projectPhase).set({ status: ph.status, startedOn: ph.startedOn, completedOn: ph.completedOn }).where(and(eq(schema.projectPhase.projectId, row!.id), eq(schema.projectPhase.key, ph.key)));
    for (const ph of phases.filter((x) => x.status === "done")) await db.update(schema.task).set({ status: "done", completedOn: ph.completedOn, completedAt: new Date(`${ph.completedOn}T16:00:00Z`) }).where(and(eq(schema.task.projectId, row!.id), eq(schema.task.phaseKey, ph.key)));
    await reschedule(db as never, row!.id);
    await db.insert(schema.projectHeadline).values({ projectId: row!.id, purchasePriceCents: (1_000_000 + i * 150_000) * 100, totalBudgetCents: (3_000_000 + i * 300_000) * 100, projectedSelloutCents: (5_500_000 + i * 400_000) * 100 });
  }
  const projects = await db.select({ id: schema.project.id }).from(schema.project);

  // Everyone on every project.
  for (const p of projects) {
    await db
      .insert(schema.projectMember)
      .values(people.map((userId) => ({ projectId: p.id, userId, projectRole: "PM", canEditChecklist: true })))
      .onConflictDoNothing();
  }

  // Top up to 3,000 tasks, spread over the projects' current phases.
  const tasks = (await db.select({ n: count() }).from(schema.task))[0]!.n;
  const extra = Math.max(0, TASKS - tasks);
  if (extra > 0) {
    const current = await db.select({ projectId: schema.projectPhase.projectId, key: schema.projectPhase.key }).from(schema.projectPhase).where(eq(schema.projectPhase.status, "active"));
    const rows = Array.from({ length: extra }, (_, k) => {
      const c = current[k % current.length]!;
      return { projectId: c.projectId, phaseKey: c.key, title: `Follow-up item ${k + 1}`, dueOn: addDays(today, (k % 60) - 20), status: (["not_started", "in_progress", "waiting", "blocked"] as const)[k % 4], blockedReason: k % 4 === 3 ? "Waiting on the consultant" : null };
    });
    for (let k = 0; k < rows.length; k += 500) await db.insert(schema.task).values(rows.slice(k, k + 500));
  }
  // Hand out the open work: every load tester and Ariel get a share.
  const ariel = (await db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.email, "ariel@demo.test")))[0]!.id;
  const assignees = [...people, ariel];
  const open = await db.select({ id: schema.task.id }).from(schema.task).where(ne(schema.task.status, "done"));
  for (let a = 0; a < assignees.length; a++) {
    const mine = open.filter((_, k) => k % assignees.length === a).map((t) => t.id);
    if (mine.length) await db.update(schema.task).set({ assigneeId: assignees[a] }).where(inArray(schema.task.id, mine));
  }

  // Files (records only; load tests read listings, not bytes), spread over the unrestricted folders.
  const files = (await db.select({ n: count() }).from(schema.file))[0]!.n;
  const more = Math.max(0, FILES - files);
  if (more > 0) {
    const folders = await db.select({ id: schema.folder.id, projectId: schema.folder.projectId }).from(schema.folder).where(eq(schema.folder.gated, false));
    for (let k = 0; k < more; k += 500) {
      const batch = Array.from({ length: Math.min(500, more - k) }, (_, j) => {
        const f = folders[(k + j) % folders.length]!;
        return { projectId: f.projectId, folderId: f.id, name: `Document ${k + j + 1}.pdf`, createdById: owner.id };
      });
      const made = await db.insert(schema.file).values(batch).returning({ id: schema.file.id });
      await db.insert(schema.fileVersion).values(made.map((m, j) => ({ fileId: m.id, number: 1, objectKey: `load/${k + j}.pdf`, originalName: `doc-${k + j}.pdf`, contentType: "application/pdf", sizeBytes: 250_000 + j, uploadedById: owner.id })));
    }
  }

  const [p] = await db.select({ n: count() }).from(schema.project);
  const [t] = await db.select({ n: count() }).from(schema.task);
  const [f] = await db.select({ n: count() }).from(schema.file).where(sql`${schema.file.deletedAt} is null`);
  console.log(`Load seed: ${p!.n} projects, ${t!.n} tasks, ${f!.n} files, ${people.length} load testers (load01…load${USERS}@demo.test).`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
