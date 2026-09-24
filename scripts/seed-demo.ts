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
  const { setCurrentPhase } = await import("../src/core/phases");
  const { buildProjectChecklist, defaultTemplateFor, reschedule } = await import("../src/server/services/checklist");
  const { and, inArray, ne } = await import("drizzle-orm");
  const { addDays, todayET } = await import("../src/core/time");
  const { roundDiv } = await import("../src/core/money");
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
    // A real checklist from the default template, as if the project started path[0] days ago…
    const toggles = p.type === "ground_up_condo" ? ["construction_loan", "excavation", "jv"] : p.type === "gut_renovation" ? ["landmarked", "occupied"] : [];
    const tpl = await defaultTemplateFor(db as never, p.type);
    await buildProjectChecklist(db as never, { projectId: row!.id, type: p.type, template: tpl, chosenToggles: toggles, today: addDays(today, -path[0]![1]), userId: ids["jon@demo.test"]! });
    // …then walked through its phases on the recorded dates.
    const stored = await db.select().from(schema.projectPhase).where(eq(schema.projectPhase.projectId, row!.id));
    let phases = stored.map((x) => ({ key: x.key, name: x.name, sortOrder: x.sortOrder, status: x.status, startedOn: x.startedOn, completedOn: x.completedOn }));
    for (const [key, ago] of path.slice(1)) phases = setCurrentPhase(phases, key, addDays(today, -ago));
    for (const ph of phases) await db.update(schema.projectPhase).set({ status: ph.status, startedOn: ph.startedOn, completedOn: ph.completedOn }).where(and(eq(schema.projectPhase.projectId, row!.id), eq(schema.projectPhase.key, ph.key)));
    // Tasks in finished phases are done; the current phase is partly done.
    const donePhases = phases.filter((x) => x.status === "done").map((x) => x.key);
    if (donePhases.length) {
      for (const ph of phases.filter((x) => x.status === "done")) {
        await db.update(schema.task).set({ status: "done", completedOn: ph.completedOn, completedAt: new Date(`${ph.completedOn}T16:00:00Z`) }).where(and(eq(schema.task.projectId, row!.id), eq(schema.task.phaseKey, ph.key)));
      }
    }
    const current = phases.find((x) => x.status === "active");
    if (current) {
      const inPhase = await db.select({ id: schema.task.id }).from(schema.task).where(and(eq(schema.task.projectId, row!.id), eq(schema.task.phaseKey, current.key), ne(schema.task.status, "done")));
      const half = inPhase.slice(0, Math.floor(inPhase.length / 3)).map((t) => t.id);
      if (half.length) await db.update(schema.task).set({ status: "done", completedOn: addDays(today, -3), completedAt: new Date() }).where(inArray(schema.task.id, half));
    }
    await reschedule(db as never, row!.id);
    if (Object.values(headline).some((v) => v != null)) await db.insert(schema.projectHeadline).values({ projectId: row!.id, ...headline });
    await db.insert(schema.projectMember).values([
      { projectId: row!.id, userId: ids["jon@demo.test"]!, projectRole: "Principal", canViewFinancials: true, canEditChecklist: true, canApprove: true },
      { projectId: row!.id, userId: ids["elias@demo.test"]!, projectRole: "PM", canViewFinancials: true, canEditChecklist: true, canApprove: true },
      { projectId: row!.id, userId: ids["ariel@demo.test"]!, projectRole: "Construction", canEditChecklist: true },
      { projectId: row!.id, userId: ids["architect@demo.test"]!, projectRole: "Architect" },
    ]);
    // Work in the current phase: owners by role, a few statuses, one approval waiting, key dates.
    const open = await db.select().from(schema.task).where(and(eq(schema.task.projectId, row!.id), ne(schema.task.status, "done")));
    const byRole: Record<string, string> = { PM: ids["elias@demo.test"]!, Construction: ids["ariel@demo.test"]!, Design: ids["architect@demo.test"]!, Acquisitions: ids["jon@demo.test"]!, Owner: ids["jon@demo.test"]! };
    // Only the current and next phase are handed out, as a PM would.
    const idx = phases.findIndex((x) => x.status === "active");
    const handed = new Set(phases.slice(Math.max(idx, 0), Math.max(idx, 0) + 2).map((x) => x.key));
    for (const t of open.filter((x) => handed.has(x.phaseKey))) {
      const assigneeId = byRole[t.role] ?? ids["ariel@demo.test"]!;
      await db.update(schema.task).set({ assigneeId }).where(eq(schema.task.id, t.id));
    }
    const active = current ? open.filter((t) => t.phaseKey === current.key) : [];
    if (active[0]) await db.update(schema.task).set({ status: "in_progress" }).where(eq(schema.task.id, active[0].id));
    if (active[1]) await db.update(schema.task).set({ status: "waiting", waitingOn: "Expediter — DOB plan exam", waitingSince: addDays(today, -4), followUpOn: addDays(today, 1) }).where(eq(schema.task.id, active[1].id));
    if (active[2]) await db.update(schema.task).set({ status: "blocked", blockedReason: "Neighbor hasn't signed the access agreement" }).where(eq(schema.task.id, active[2].id));
    if (active[3]) await db.update(schema.task).set({ status: "awaiting_approval", requiresApproval: true, approverRole: "Owner", approverId: ids["jon@demo.test"]!, approvalRequestedAt: new Date() }).where(eq(schema.task.id, active[3].id));
    const kd = p.type === "foreclosure_auction" ? [{ kind: "auction", date: addDays(today, 5) }] : p.type === "contract_flip" ? [{ kind: "closing", date: addDays(today, 12) }, { kind: "dd_expiry", date: addDays(today, 3) }] : [{ kind: "loan_maturity", date: addDays(today, 200) }, { kind: "tco_expiry", date: addDays(today, 45) }];
    await db.insert(schema.keyDate).values(kd.map((k) => ({ projectId: row!.id, ...k })));
    // Public records and expiries for the townhouse: an ECB violation with a hearing, an old closed one, a DOB NOW job, a permit expiring soon, and an expired COI.
    if (p.type === "gut_renovation") {
      const pid = row!.id;
      const run = new Date(Date.now() - 6 * 3600_000);
      const url = "https://data.cityofnewyork.us/resource/6bgk-3dad.json?ecb_violation_number=39000123K";
      await db.insert(schema.recordItem).values([
        { projectId: pid, source: "ecb_violations", key: "39000123K", kind: "violation", title: "ECB violation 39000123K", status: "ACTIVE · PENDING", date: addDays(today, -12), open: true, url, hearingOn: addDays(today, 21), detail: { severity: "CLASS - 2", description: "Failure to maintain the sidewalk shed" } },
        { projectId: pid, source: "dob_violations", key: "5512003", kind: "violation", title: "DOB violation 031519C01", status: "V*-DOB VIOLATION - DISMISSED", date: "2019-03-15", open: false, url: "https://a810-bisweb.nyc.gov/bisweb/PropertyProfileOverviewServlet?boro=3&block=01137&lot=00045", detail: {} },
        { projectId: pid, source: "dobnow_jobs", key: "B01188420-I1", kind: "job", title: "DOB NOW Alteration B01188420-I1", status: "Approved", date: addDays(today, -60), open: true, url: "https://data.cityofnewyork.us/resource/w9ak-ipjd.json?job_filing_number=B01188420-I1", detail: { description: "Gut renovation of a 3-family townhouse" } },
        { projectId: pid, source: "dobnow_permits", key: "B01188420-I1-GC#1", kind: "permit", title: "General Construction permit B01188420-I1-GC", status: "Permit Issued", date: addDays(today, -40), open: true, url: "https://data.cityofnewyork.us/resource/rbx6-tga4.json?work_permit=B01188420-I1-GC", expiresOn: addDays(today, 18), detail: { expires: addDays(today, 18) } },
        { projectId: pid, source: "sr311", key: "61200011", kind: "sr311", title: "311: Noise - Residential (Banging/Pounding)", status: "Open", date: addDays(today, -1), open: true, url: "https://data.cityofnewyork.us/resource/erm2-nwe9.json?unique_key=61200011", detail: { agency: "NYPD" } },
        { projectId: pid, source: "acris_master", key: "2026071500123001", kind: "recording", title: "Mortgage recorded", status: "MTGE", date: addDays(today, -70), open: false, url: "https://a836-acris.nyc.gov/DS/DocumentSearch/DocumentDetail?doc_id=2026071500123001", detail: { docType: "MTGE" } },
        { projectId: pid, source: "dof_charges", key: "arrears", kind: "tax", title: "No property charges past due", status: "current", date: null, open: false, url: "https://a836-pts-access.nyc.gov/care/search/commonsearch.aspx?mode=persprop", detail: { pastDueCents: 0 } },
      ]);
      await db.insert(schema.recordSync).values([
        { projectId: pid, source: "_run", lastRunAt: run, lastSuccessAt: run },
        ...["dobnow_jobs", "bis_jobs", "bis_permits", "dobnow_permits", "dob_violations", "ecb_violations", "dob_safety", "hpd_violations", "hpd_vacate", "fdny_vacate", "dob_complaints", "oath", "sr311", "tax_lien", "dof_charges", "acris_legals", "acris_master"].map((source) => ({
          projectId: pid,
          source,
          lastRunAt: run,
          lastSuccessAt: run,
          dataAsOf: source.startsWith("acris") ? new Date(Date.now() - 50 * 86_400_000) : new Date(Date.now() - 86_400_000),
          rows: 1,
        })),
      ]);
      const [kd] = await db.insert(schema.keyDate).values({ projectId: pid, kind: "oath_hearing", label: "Hearing: ECB violation 39000123K", date: addDays(today, 21) }).returning();
      await db.insert(schema.violationCase).values({ projectId: pid, source: "ecb_violations", itemKey: "39000123K", title: "ECB violation 39000123K", description: "Failure to maintain the sidewalk shed", url, issuedOn: addDays(today, -12), stage: "hearing", hearingOn: addDays(today, 21), keyDateId: kd!.id });
      await db.insert(schema.recordAlert).values([
        { projectId: pid, source: "ecb_violations", itemKey: "39000123K", kind: "new", title: "New violation: ECB violation 39000123K", url, dedupeKey: "ecb_violations:39000123K:new" },
        { projectId: pid, source: "sr311", itemKey: "61200011", kind: "new", title: "New 311: Noise - Residential (Banging/Pounding)", url: "https://data.cityofnewyork.us/resource/erm2-nwe9.json?unique_key=61200011", dedupeKey: "sr311:61200011:new" },
      ]);
      await db.insert(schema.expiryItem).values([
        { projectId: pid, category: "dob_permit", label: "General Construction permit B01188420-I1-GC", expiresOn: addDays(today, 18), recordRef: "dobnow_permits:B01188420-I1-GC#1" },
        { projectId: pid, category: "builders_risk", label: "Policy BR-44120", expiresOn: addDays(today, 64) },
        { projectId: pid, category: "vendor_coi_gl", vendorName: "Northside Scaffold", vendorKey: "northside scaffold", expiresOn: addDays(today, -3) },
      ]);
    }
    // Financial detail for the condo: a budget, contracts, invoices, a change order, a draw and a unit schedule.
    if (p.type === "ground_up_condo") {
      const L = async (category: string, name: string, dollars: number) =>
        (await db.insert(schema.budgetLine).values({ projectId: row!.id, category, name, originalCents: dollars * 100 }).returning())[0]!.id;
      const land = await L("acquisition", "Land", 5_800_000);
      await L("closing", "Transfer taxes and title", 290_000);
      const arch = await L("soft", "Architect and engineers", 620_000);
      const hard = await L("hard", "General contractor", 9_400_000);
      await L("financing", "Construction loan interest and fees", 1_150_000);
      await L("contingency", "Hard-cost contingency", 470_000);
      await L("sales", "Marketing and broker fees", 1_300_000);
      const [gc] = await db.insert(schema.commitment).values({ projectId: row!.id, budgetLineId: hard, vendorName: "Brick & Beam Builders", description: "GC contract, foundation to TCO", amountCents: 9_150_000_00, retainageBps: 1000, signedOn: addDays(today, -150) }).returning();
      await db.insert(schema.commitment).values({ projectId: row!.id, budgetLineId: arch, vendorName: "Brooks Studio", description: "Architecture, CA through TCO", amountCents: 540_000_00, retainageBps: 0, signedOn: addDays(today, -300) });
      await db.insert(schema.invoice).values([
        { projectId: row!.id, budgetLineId: land, vendorName: "Seller (closing)", amountCents: 5_800_000_00, status: "paid", paidOn: addDays(today, -300), invoiceDate: addDays(today, -300) },
        { projectId: row!.id, budgetLineId: arch, vendorName: "Brooks Studio", number: "BS-14", amountCents: 45_000_00, status: "paid", paidOn: addDays(today, -40), invoiceDate: addDays(today, -50) },
        { projectId: row!.id, budgetLineId: hard, commitmentId: gc!.id, vendorName: "Brick & Beam Builders", number: "Req 4", amountCents: 820_000_00, retainageBps: 1000, status: "approved", invoiceDate: addDays(today, -10) },
        { projectId: row!.id, budgetLineId: hard, commitmentId: gc!.id, vendorName: "Brick & Beam Builders", number: "Req 5", amountCents: 910_500_00, retainageBps: 1000, status: "received", invoiceDate: addDays(today, -2) },
      ]);
      await db.insert(schema.changeOrder).values({ projectId: row!.id, budgetLineId: hard, commitmentId: gc!.id, number: 1, description: "Rock removal at the rear footing", amountCents: 185_000_00, scheduleDays: 8, status: "approved", decidedAt: new Date() });
      await db.insert(schema.projectHeadline).values({ projectId: row!.id, loanAmountCents: 12_500_000_00, useBudgetDetail: true, useSalesDetail: true }).onConflictDoUpdate({ target: schema.projectHeadline.projectId, set: { loanAmountCents: 12_500_000_00, useBudgetDetail: true, useSalesDetail: true } });
      // 18 units: A (2 bed), B (1 bed), C (3 bed) on floors 2–7; PH sold, a few in contract.
      const plan = { A: [1050, 2, 2, 1_850_000], B: [780, 1, 1, 1_290_000], C: [1400, 3, 2, 2_450_000] } as const;
      const status = (floor: number, line: string): "closed" | "contract" | "reserved" | "available" =>
        floor === 7 && line === "C" ? "closed" : floor >= 6 || (floor === 3 && line === "B") ? "contract" : floor === 4 && line === "A" ? "reserved" : "available";
      const units = [2, 3, 4, 5, 6, 7].flatMap((floor) =>
        (["A", "B", "C"] as const).map((line) => {
          const [sf, beds, baths, base] = plan[line];
          // Integer math only: +3% a floor, rounded to $5,000.
          const ask = roundDiv(base * (100 + (floor - 2) * 3), 100 * 5000) * 5000;
          const st = status(floor, line);
          return { unit: `${floor}${line}`, floor: String(floor), sf, beds, baths, askCents: ask * 100, contractCents: st === "contract" || st === "closed" ? (ask - 25_000) * 100 : null, status: st };
        }),
      );
      await db.insert(schema.saleUnit).values(units.map((u, i) => ({ projectId: row!.id, ...u, sortOrder: i })));
      // Field: a week of site logs, a locked baseline running a few days behind, an RFI, a submittal, an OAC meeting and punch items.
      const pid = row!.id;
      for (let back = 5; back >= 1; back--) {
        const date = addDays(today, -back);
        await db.insert(schema.siteLog).values({
          projectId: pid,
          date,
          weather: { summary: back === 2 ? "Rain" : "Partly cloudy", highF: 68 - back, lowF: 55 - back, precipIn: back === 2 ? 0.6 : 0, windMph: 9, source: "open-meteo" },
          manpower: [
            { trade: "Concrete", company: "Stone & Sons", count: 6 },
            { trade: "Carpentry", company: "Brick & Beam Builders", count: 4 },
            { trade: "Electrical", company: "Volt Electric", count: back % 2 ? 2 : 3 },
          ],
          workPerformed: back === 2 ? "Rain day: covered slab, cleaned up rebar." : `Formed and poured level ${8 - back} deck.`,
          inspections: back === 3 ? [{ what: "DOB concrete pour", result: "pass", notes: null }] : [],
          delays: back === 2 ? [{ cause: "Rain", hours: 4, notes: null }] : [],
          deliveries: back === 4 ? "Rebar, 22 tons" : null,
          createdById: ids["elias@demo.test"]!,
          updatedById: ids["elias@demo.test"]!,
        });
      }
      const constr = await db.select().from(schema.task).where(and(eq(schema.task.projectId, pid), eq(schema.task.phaseKey, "construction")));
      for (const [i, t] of constr.slice(0, 8).entries()) {
        await db.update(schema.task).set({ startOn: addDays(today, -20 + i * 12), dueOn: addDays(today, -10 + i * 12) }).where(eq(schema.task.id, t.id));
      }
      await db.insert(schema.scheduleBaseline).values({ projectId: pid, number: 1, finishOn: addDays(today, 70), items: [], reason: "Locked at the start of Pre-Construction", status: "current", lockedAt: new Date(Date.now() - 90 * 86_400_000) });
      await db.insert(schema.rfi).values([
        { projectId: pid, number: 1, subject: "Beam depth at grid C/4", question: "Can the W12 at grid C/4 go to W14 to clear the duct run?", fromName: "Brick & Beam Builders", toUserId: ids["architect@demo.test"]!, dueOn: addDays(today, 2), costImpactCents: 1_850_000, scheduleImpactDays: 2, status: "open", createdById: ids["jon@demo.test"]! },
        { projectId: pid, number: 2, subject: "Window sill height, units A", question: "Confirm 18\" sill height at A-line bedrooms.", fromName: "Brick & Beam Builders", toUserId: ids["architect@demo.test"]!, answer: "Confirmed: 18\" AFF, per A-401.", answeredAt: new Date(), status: "answered", createdById: ids["jon@demo.test"]! },
      ]);
      const [sub] = await db.insert(schema.submittal).values({ projectId: pid, number: 1, specSection: "08 41 13", item: "Storefront shop drawings", submittedBy: "ClearView Glass", reviewerId: ids["architect@demo.test"]!, dueOn: addDays(today, 6), createdById: ids["jon@demo.test"]! }).returning();
      await db.insert(schema.submittalRevision).values({ submittalId: sub!.id, revision: 0, submittedOn: addDays(today, -3) });
      const [mtg] = await db.insert(schema.meeting).values({ projectId: pid, type: "oac", number: 1, title: "Weekly OAC", heldOn: addDays(today, -2), attendees: [{ name: "Jon Lian", company: "Lian Development", userId: ids["jon@demo.test"]! }, { name: "Elias", company: null, userId: ids["elias@demo.test"]! }], agenda: "Schedule, RFIs, submittals, safety", notes: "Deck pours on track; storefront submittal is the long-lead item." }).returning();
      await db.insert(schema.meetingItem).values({ meetingId: mtg!.id, kind: "action", text: "Chase the storefront submittal review", assigneeId: ids["elias@demo.test"]!, dueOn: addDays(today, 3), sortOrder: 0 });
      await db.insert(schema.punchItem).values([
        { projectId: pid, number: 1, title: "Patch slab edge at stair 2", trade: "Concrete", vendorName: "Stone & Sons", floor: "3", unit: null, dueOn: addDays(today, 5), status: "open" },
        { projectId: pid, number: 2, title: "Reset outlet box height", trade: "Electrical", vendorName: "Volt Electric", floor: "4", unit: "4B", dueOn: addDays(today, 8), status: "ready" },
      ]);
    }
  }
  await pool.end();
  console.log("Demo seed complete. Users: jon@ / elias@ / ariel@ / architect@demo.test — password: demo password 1");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
