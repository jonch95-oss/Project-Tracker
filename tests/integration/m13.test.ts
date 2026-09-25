import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { addDays, todayET } from "@/core/time";
import { db, schema } from "@/server/db";
import { buildWeeklyReport, mondayOf, saveWeeklyReport, weeklyReportJob } from "@/server/services/weekly-report";
import { addMember, callerFor, createProject, createUser } from "../support/fixtures";

const tag = () => `Zq${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function folderOf(projectId: string, name: string) {
  const [f] = await db().select().from(schema.folder).where(and(eq(schema.folder.projectId, projectId), eq(schema.folder.name, name)));
  return f!;
}

async function addFile(projectId: string, folderId: string, name: string, by: string) {
  const [f] = await db().insert(schema.file).values({ projectId, folderId, name, createdById: by }).returning({ id: schema.file.id });
  return f!.id;
}

describe("⌘K search is permission-aware (brief §7.7, §13)", () => {
  const T = tag();
  let owner: Awaited<ReturnType<typeof createUser>>;
  let member: Awaited<ReturnType<typeof createUser>>;
  let finMember: Awaited<ReturnType<typeof createUser>>;
  let outsider: Awaited<ReturnType<typeof createUser>>;
  let stranger: Awaited<ReturnType<typeof createUser>>;
  let admin: Awaited<ReturnType<typeof createUser>>;
  let investor: Awaited<ReturnType<typeof createUser>>;
  let projectId: string;
  let theirTask: string;
  let otherTask: string;
  let financialFile: string;
  let designFile: string;

  beforeAll(async () => {
    owner = await createUser("owner", { name: `${T} Owner` });
    member = await createUser("member", { name: `${T} Member` });
    finMember = await createUser("member");
    outsider = await createUser("external", { name: `${T} Outsider` });
    stranger = await createUser("member");
    admin = await createUser("admin");
    investor = await createUser("investor");
    ({ id: projectId } = await createProject(owner.id, `${T} Sterling Place`));
    await db().update(schema.project).set({ bbl: "3012340056" }).where(eq(schema.project.id, projectId));
    await addMember(projectId, member.id);
    await addMember(projectId, finMember.id, { canViewFinancials: true });
    await addMember(projectId, outsider.id);
    await addMember(projectId, investor.id);
    const made = await db()
      .insert(schema.task)
      .values([
        { projectId, phaseKey: "pipeline", title: `${T} survey the lot`, assigneeId: outsider.id },
        { projectId, phaseKey: "pipeline", title: `${T} negotiate the LOI` },
      ])
      .returning({ id: schema.task.id });
    theirTask = made[0]!.id;
    otherTask = made[1]!.id;
    financialFile = await addFile(projectId, (await folderOf(projectId, "Financial")).id, `${T} pro forma.xlsx`, owner.id);
    designFile = await addFile(projectId, (await folderOf(projectId, "Design")).id, `${T} plans.pdf`, owner.id);
  });

  const search = async (userId: string, q: string) => (await callerFor(userId)).search.query({ q });
  const idsOf = (hits: { kind: string; id: string }[], kind: string) => hits.filter((h) => h.kind === kind).map((h) => h.id);

  it("the owner finds the project by name, address and BBL (with or without dashes), its tasks and every file", async () => {
    const hits = await search(owner.id, T);
    expect(idsOf(hits, "project")).toEqual([projectId]);
    expect(idsOf(hits, "task").sort()).toEqual([theirTask, otherTask].sort());
    expect(idsOf(hits, "file").sort()).toEqual([financialFile, designFile].sort());
    expect(idsOf(await search(owner.id, "3-01234-0056"), "project")).toContain(projectId);
    const task = hits.find((h) => h.id === theirTask)!;
    expect(task.href).toBe(`/projects/${projectId}?tab=checklist&task=${theirTask}`);
    expect(hits.find((h) => h.id === designFile)!.href).toContain(`file=${designFile}`);
  });

  it("a team member without financial access never sees the Financial folder's files", async () => {
    const hits = await search(member.id, T);
    expect(idsOf(hits, "file")).toEqual([designFile]);
    expect(idsOf(hits, "task").sort()).toEqual([theirTask, otherTask].sort());
    expect(idsOf(hits, "person")).toContain(outsider.id);
    // With the flag, the pro forma shows.
    expect(idsOf(await search(finMember.id, T), "file").sort()).toEqual([financialFile, designFile].sort());
  });

  it("an outside collaborator sees only their own task, no unshared files and no people", async () => {
    const hits = await search(outsider.id, T);
    expect(idsOf(hits, "project")).toEqual([projectId]);
    expect(idsOf(hits, "task")).toEqual([theirTask]);
    expect(idsOf(hits, "file")).toEqual([]);
    expect(idsOf(hits, "person")).toEqual([]);
    // A shared folder shows; a shared Financial folder still doesn't without the flag.
    const design = await folderOf(projectId, "Design");
    const fin = await folderOf(projectId, "Financial");
    await db().insert(schema.folderShare).values([
      { folderId: design.id, userId: outsider.id },
      { folderId: fin.id, userId: outsider.id },
    ]);
    expect(idsOf(await search(outsider.id, T), "file")).toEqual([designFile]);
  });

  it("someone not on the project finds nothing from it; an admin finds it but not its money files", async () => {
    const none = await search(stranger.id, T);
    expect(none.filter((h) => h.kind !== "person")).toEqual([]);
    const a = await search(admin.id, T);
    expect(idsOf(a, "project")).toEqual([projectId]);
    expect(idsOf(a, "file")).toEqual([designFile]);
  });

  it("investors get nothing (they have their portal) and never appear as people", async () => {
    expect(await search(investor.id, T)).toEqual([]);
    await db().update(schema.user).set({ name: `${T} Investor` }).where(eq(schema.user.id, investor.id));
    expect(idsOf(await search(owner.id, T), "person")).not.toContain(investor.id);
  });

  it("typed wildcards are taken literally", async () => {
    expect(await search(owner.id, "%%%")).toEqual([]);
    expect(await search(owner.id, "____")).toEqual([]);
  });
});

describe("weekly owner report (brief §7.8)", () => {
  const T = tag();
  let owner: Awaited<ReturnType<typeof createUser>>;
  let projectId: string;
  const today = todayET();
  const weekOf = mondayOf(today);

  beforeAll(async () => {
    owner = await createUser("owner");
    ({ id: projectId } = await createProject(owner.id, `${T} Report Project`));
    const worker = await createUser("member", { name: `${T} Worker` });
    const assign = { projectId, phaseKey: "pipeline", assigneeId: worker.id };
    await db()
      .insert(schema.task)
      .values([
        // Finished in the week before this Monday.
        { ...assign, title: `${T} done last week`, status: "done", completedAt: new Date(new Date(`${addDays(weekOf, -3)}T15:00:00Z`)) },
        // Finished before that: not "moved".
        { ...assign, title: `${T} done long ago`, status: "done", completedAt: new Date(`${addDays(weekOf, -30)}T15:00:00Z`) },
        { ...assign, title: `${T} blocked`, status: "blocked", blockedReason: "Waiting on the survey" },
        { ...assign, title: `${T} overdue`, dueOn: addDays(today, -2) },
        { ...assign, title: `${T} due soon`, dueOn: addDays(weekOf, 5) },
        { ...assign, title: `${T} due later`, dueOn: addDays(weekOf, 40) },
      ]);
    await db().insert(schema.keyDate).values({ projectId, kind: "closing", date: addDays(weekOf, 6) });
    await db().insert(schema.projectHeadline).values({ projectId, purchasePriceCents: 250_000_000, totalBudgetCents: 900_000_000 }).onConflictDoUpdate({ target: schema.projectHeadline.projectId, set: { purchasePriceCents: 250_000_000, totalBudgetCents: 900_000_000 } });
  });

  it("covers what moved, what's stuck, the next two weeks and the headline financials", async () => {
    const r = await buildWeeklyReport(db(), weekOf);
    const p = r.projects.find((x) => x.id === projectId)!;
    expect(p).toBeDefined();
    const titles = (xs: { title: string }[]) => xs.map((x) => x.title).filter((t) => t.startsWith(T));
    expect(titles(p.moved.completed)).toEqual([`${T} done last week`]);
    expect(titles(p.stuck.blocked)).toEqual([`${T} blocked`]);
    expect(p.stuck.blocked.find((x) => x.title === `${T} blocked`)!.note).toBe("Waiting on the survey");
    expect(titles(p.stuck.overdue)).toContain(`${T} overdue`);
    expect(titles(p.next.tasks)).toContain(`${T} due soon`);
    expect(titles(p.next.tasks)).not.toContain(`${T} due later`);
    expect(p.next.keyDates.map((k) => k.label)).toContain("Closing");
    expect(p.money).toMatchObject({ purchasePrice: 250_000_000, totalBudget: 900_000_000 });
    expect(p.phase).toBeTruthy();
    expect(p.progressBps).toBeGreaterThanOrEqual(0);
    expect(r.totals.projects).toBeGreaterThanOrEqual(1);
  });

  it("runs Monday from 7am New York only, once, and tells the owner without any figures", async () => {
    // A Tuesday, and a Monday at 6am: nothing.
    expect(await weeklyReportJob(new Date("2031-03-11T15:00:00Z"))).toMatchObject({ skipped: expect.any(String) });
    expect(await weeklyReportJob(new Date("2031-03-10T10:00:00Z"))).toMatchObject({ skipped: expect.any(String) });
    // Monday 8am New York (12:00 UTC in March 2031, after the DST change).
    const r = await weeklyReportJob(new Date("2031-03-10T12:00:00Z"));
    expect(r).toMatchObject({ weekOf: "2031-03-10" });
    expect(await weeklyReportJob(new Date("2031-03-10T13:00:00Z"))).toMatchObject({ skipped: "already built" });
    const notes = await db().select().from(schema.notification).where(and(eq(schema.notification.userId, owner.id), eq(schema.notification.href, "/reports?week=2031-03-10")));
    expect(notes).toHaveLength(1);
    expect(`${notes[0]!.title} ${notes[0]!.body}`).not.toMatch(/\$/);
  });

  it("the owner can open saved weeks and the live report; nobody else can", async () => {
    await saveWeeklyReport(db(), weekOf);
    const oc = await callerFor(owner.id);
    expect((await oc.reports.list()).map((w) => w.weekOf)).toContain(weekOf);
    expect((await oc.reports.get({ weekOf })).projects.some((p) => p.id === projectId)).toBe(true);
    await expect(oc.reports.get({ weekOf: "1999-01-04" })).rejects.toBeTruthy();
    const admin = await createUser("admin");
    await expect((await callerFor(admin.id)).reports.live()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("the PDF has a page per project and is owner-only", async () => {
    const { GET } = await import("@/app/api/export/reports/[week]/route");
    const { auth } = await import("@/server/auth");
    const signIn = async (email: string) => {
      const res = await auth().handler(new Request("http://localhost:3000/api/auth/sign-in/email", { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:3000" }, body: JSON.stringify({ email, password: "correct horse battery 1" }) }));
      return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    };
    const call = async (cookie: string, week: string) => GET(new Request(`http://localhost:3000/api/export/reports/${week}`, { headers: { cookie } }), { params: Promise.resolve({ week }) } as never);
    const ok = await call(await signIn(owner.email), "live");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("application/pdf");
    const { PDFDocument } = await import("pdf-lib");
    const pdf = await PDFDocument.load(new Uint8Array(await ok.arrayBuffer()));
    const projects = (await buildWeeklyReport(db(), todayET())).projects.length;
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(projects + 1);
    const member = await createUser("member");
    expect((await call(await signIn(member.email), "live")).status).toBe(403);
  });
});
