import { and, eq, inArray } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { addBusinessDays } from "@/core/calendar";
import { defaultTemplate } from "@/core/seed-library";
import { todayET } from "@/core/time";
import { db, schema } from "@/server/db";
import { addMember, callerFor, companyId, createUser } from "../support/fixtures";

type Caller = Awaited<ReturnType<typeof callerFor>>;

async function newProject(c: Caller, opts: { type?: "gut_renovation" | "ground_up_condo" | "contract_flip" | "foreclosure_auction"; toggles?: string[]; name?: string } = {}) {
  return c.projects.create({
    name: opts.name ?? `Checklist ${Math.random().toString(36).slice(2, 7)}`,
    address: "10 Checklist Street",
    type: opts.type ?? "gut_renovation",
    companyId: await companyId(),
    bbl: null,
    toggles: opts.toggles ?? [],
  });
}

const task = async (projectId: string, key: string) => {
  const [t] = await db().select().from(schema.task).where(and(eq(schema.task.projectId, projectId), eq(schema.task.templateKey, key)));
  return t!;
};

describe("checklists from templates", () => {
  let owner: Awaited<ReturnType<typeof createUser>>;
  let c: Caller;
  beforeAll(async () => {
    owner = await createUser("owner");
    c = await callerFor(owner.id);
  });

  it("a new project gets its type's phases and tasks; the first phase's tasks get due dates now, later ones wait", async () => {
    const { id } = await newProject(c);
    const cl = await c.checklist.get({ projectId: id });
    const def = defaultTemplate("gut_renovation");
    expect(cl.phases.map((p) => p.key)).toEqual(def.phases.filter((p) => !p.showIf).map((p) => p.key));
    expect(cl.tasks.length).toBeGreaterThan(80);
    const mih = cl.tasks.find((t) => t.templateKey === "mih_check")!;
    expect(mih.dueOn).toBe(addBusinessDays(todayET(), 2));
    expect(mih.killScreen).toBe(true);
    expect(cl.tasks.find((t) => t.templateKey === "title_report")!.dueOn).toBeNull();
    expect(cl.template).toMatchObject({ name: "Gut renovation / townhouse conversion", projectVersion: 1 });
    // Toggle-only tasks are absent without their toggle.
    expect(cl.tasks.some((t) => t.templateKey === "geotech")).toBe(false);
  });

  it("answers at creation add their tasks; the type's own toggles are implied", async () => {
    const { id } = await newProject(c, { toggles: ["excavation", "occupied"] });
    const keys = (await c.checklist.get({ projectId: id })).tasks.map((t) => t.templateKey);
    expect(keys).toEqual(expect.arrayContaining(["geotech", "soe_design", "tenant_dd", "tenant_protection_plan"]));
    const flip = await newProject(c, { type: "contract_flip" });
    const fl = await c.checklist.get({ projectId: flip.id });
    expect(fl.impliedToggles).toEqual(["contract_flip"]);
    expect(fl.tasks.some((t) => t.templateKey === "assignment_rights")).toBe(true);
    await expect(newProject(c, { toggles: ["not_a_toggle"] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("starting a phase dates its tasks; completing an anchor dates the tasks relative to it", async () => {
    const { id } = await newProject(c);
    let p = await c.projects.get({ projectId: id });
    await c.projects.setPhase({ projectId: id, key: "under_contract", version: p.version });
    const signed = await task(id, "contract_signed");
    expect(signed.dueOn).toBe(addBusinessDays(todayET(), 12));
    const wired = await task(id, "deposit_wired");
    expect(wired.dueOn).toBe(addBusinessDays(signed.dueOn!, 2));
    // Contract signed depends on "negotiated"; finish that first, then sign today.
    const negotiated = await task(id, "contract_negotiated");
    await c.checklist.setDone({ projectId: id, taskId: negotiated.id, done: true, version: negotiated.version });
    await c.checklist.setDone({ projectId: id, taskId: signed.id, done: true, version: signed.version });
    expect((await task(id, "deposit_wired")).dueOn).toBe(addBusinessDays(todayET(), 2));
    p = await c.projects.get({ projectId: id });
    expect(p.phases.find((x) => x.key === "under_contract")?.status).toBe("active");
  });

  it("a task with unfinished prerequisites can't be checked off, and says what it's waiting on", async () => {
    const { id } = await newProject(c);
    const offer = await task(id, "partner_approval_offer");
    await expect(c.checklist.setDone({ projectId: id, taskId: offer.id, done: true, version: offer.version })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringMatching(/Waiting on: .*Pro forma/),
    });
    const cl = await c.checklist.get({ projectId: id });
    expect(cl.tasks.find((t) => t.id === offer.id)!.waitingOn.map((w) => w.title)).toEqual(expect.arrayContaining(["MIH check", "Pro forma / residual land value"]));
  });

  it("approval tasks go to 'awaiting approval' for people who can't approve; approvers complete them", async () => {
    const { id } = await newProject(c);
    const member = await createUser("member");
    await addMember(id, member.id);
    const mc = await callerFor(member.id);
    // "Contract signed (A)" needs "Contract negotiated" first.
    const neg = await task(id, "contract_negotiated");
    await mc.checklist.setDone({ projectId: id, taskId: neg.id, done: true, version: neg.version });
    const signed = await task(id, "contract_signed");
    expect((await mc.checklist.setDone({ projectId: id, taskId: signed.id, done: true, version: signed.version })).status).toBe("awaiting_approval");
    const again = await task(id, "contract_signed");
    expect((await c.checklist.setDone({ projectId: id, taskId: again.id, done: true, version: again.version })).status).toBe("done");
  });

  it("stale task edits are refused", async () => {
    const { id } = await newProject(c);
    const t = await task(id, "site_visit");
    await c.checklist.updateTask({ projectId: id, taskId: t.id, version: t.version, title: "Site visit with drone photos" });
    await expect(c.checklist.updateTask({ projectId: id, taskId: t.id, version: t.version, title: "Stale" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(c.checklist.setDone({ projectId: id, taskId: t.id, done: true, version: t.version })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("editing: add, re-date by hand (kept on reschedule), move phase, reorder, delete", async () => {
    const { id } = await newProject(c);
    const { id: newId } = await c.checklist.addTask({ projectId: id, phaseKey: "pipeline", title: "Call the broker", role: "Acquisitions", dueOn: "2030-01-15" });
    const t = await c.checklist.get({ projectId: id });
    const added = t.tasks.find((x) => x.id === newId)!;
    expect(added).toMatchObject({ dueOn: "2030-01-15", dueManual: true, templateKey: null });
    const mih = t.tasks.find((x) => x.templateKey === "mih_check")!;
    await c.checklist.updateTask({ projectId: id, taskId: mih.id, version: mih.version, dueOn: "2030-02-01" });
    let p = await c.projects.get({ projectId: id });
    await c.projects.setPhase({ projectId: id, key: "under_contract", version: p.version });
    expect((await task(id, "mih_check")).dueOn).toBe("2030-02-01");
    // Clearing the manual date goes back to the rule.
    const m2 = await task(id, "mih_check");
    await c.checklist.updateTask({ projectId: id, taskId: m2.id, version: m2.version, dueOn: null });
    expect((await task(id, "mih_check")).dueManual).toBe(false);
    // Move to another phase, reorder the pipeline, delete.
    const m3 = await task(id, "mih_check");
    await c.checklist.updateTask({ projectId: id, taskId: m3.id, version: m3.version, phaseKey: "due_diligence" });
    expect((await task(id, "mih_check")).phaseKey).toBe("due_diligence");
    const pipeline = (await c.checklist.get({ projectId: id })).tasks.filter((x) => x.phaseKey === "pipeline").map((x) => x.id);
    await c.checklist.reorder({ projectId: id, phaseKey: "pipeline", taskIds: [...pipeline].reverse() });
    expect((await c.checklist.get({ projectId: id })).tasks.filter((x) => x.phaseKey === "pipeline").map((x) => x.id)).toEqual([...pipeline].reverse());
    await expect(c.checklist.reorder({ projectId: id, phaseKey: "pipeline", taskIds: pipeline.slice(1) })).rejects.toMatchObject({ code: "CONFLICT" });
    await c.checklist.deleteTask({ projectId: id, taskId: newId });
    expect((await c.checklist.get({ projectId: id })).tasks.some((x) => x.id === newId)).toBe(false);
    p = await c.projects.get({ projectId: id });
    expect(p.id).toBe(id);
  });

  it("dependencies: a loop is refused with the chain named", async () => {
    const { id } = await newProject(c);
    const proForma = await task(id, "pro_forma"); // depends on pluto_pull and sales_comps
    const pluto = await task(id, "pluto_pull");
    await expect(c.checklist.setDependencies({ projectId: id, taskId: pluto.id, dependsOnIds: [proForma.id] })).rejects.toMatchObject({
      message: expect.stringMatching(/loop: .*PLUTO pull.*Pro forma.*PLUTO pull/),
    });
    await expect(c.checklist.setDependencies({ projectId: id, taskId: pluto.id, dependsOnIds: [pluto.id] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const site = await task(id, "site_visit");
    await c.checklist.setDependencies({ projectId: id, taskId: pluto.id, dependsOnIds: [site.id] });
    expect((await c.checklist.get({ projectId: id })).tasks.find((x) => x.id === pluto.id)!.dependsOn).toEqual([site.id]);
  });

  it("toggles: preview, then add; turning off removes not-started tasks and only the started ones you pick", async () => {
    const { id } = await newProject(c);
    const prev = await c.checklist.previewToggles({ projectId: id, toggles: ["excavation"] });
    expect(prev.add.map((a) => a.key).sort()).toEqual(["adjacent_survey", "geotech", "rpapl_881", "soe_design"]);
    expect(prev.add.find((a) => a.key === "geotech")?.phase).toBe("Due Diligence");
    const on = await c.checklist.setToggles({ projectId: id, toggles: ["excavation"] });
    expect(on.added).toBe(4);
    // Start one of them, then turn the toggle off.
    const geo = await task(id, "geotech");
    await c.checklist.setDone({ projectId: id, taskId: geo.id, done: true, version: geo.version });
    const offPrev = await c.checklist.previewToggles({ projectId: id, toggles: [] });
    expect(offPrev.remove).toHaveLength(3);
    expect(offPrev.ask.map((a) => a.id)).toEqual([geo.id]);
    const off = await c.checklist.setToggles({ projectId: id, toggles: [] });
    expect(off.removed).toBe(3);
    expect(await task(id, "geotech")).toBeDefined();
    await c.checklist.setToggles({ projectId: id, toggles: ["excavation"] });
    // Re-adding doesn't duplicate the started task.
    const rows = await db().select().from(schema.task).where(and(eq(schema.task.projectId, id), eq(schema.task.templateKey, "geotech")));
    expect(rows).toHaveLength(1);
    await c.checklist.setToggles({ projectId: id, toggles: [], removeStarted: [geo.id] });
    expect((await db().select().from(schema.task).where(and(eq(schema.task.projectId, id), eq(schema.task.templateKey, "geotech"))))).toHaveLength(0);
    await expect(c.checklist.setToggles({ projectId: id, toggles: [], removeStarted: [(await task(id, "mih_check")).id] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rental hold swaps AG Plan & Sales for Rental / Hold", async () => {
    const { id } = await newProject(c, { type: "ground_up_condo" });
    await c.checklist.setToggles({ projectId: id, toggles: ["rental_hold"] });
    const cl = await c.checklist.get({ projectId: id });
    expect(cl.phases.find((p) => p.key === "ag_plan_sales")?.status).toBe("skipped");
    const rental = cl.phases.find((p) => p.key === "rental_hold")!;
    expect(rental.status).toBe("pending");
    // It sits in template order: after TCO / CO, before Sold Out.
    const order = cl.phases.map((p) => p.key);
    expect(order.indexOf("rental_hold")).toBeGreaterThan(order.indexOf("tco_co"));
    expect(order.indexOf("rental_hold")).toBeLessThan(order.indexOf("closed"));
    expect(cl.tasks.some((t) => t.templateKey === "lease_up_plan")).toBe(true);
    expect(cl.tasks.some((t) => t.templateKey === "offering_plan_submitted")).toBe(false);
  });

  it("phases can be renamed and added", async () => {
    const { id } = await newProject(c);
    await c.checklist.renamePhase({ projectId: id, key: "pipeline", name: "Screening" });
    const { key } = await c.checklist.addPhase({ projectId: id, name: "Tenant Buyouts", afterKey: "closing" });
    const cl = await c.checklist.get({ projectId: id });
    expect(cl.phases[0]!.name).toBe("Screening");
    const order = cl.phases.map((p) => p.key);
    expect(order[order.indexOf("closing") + 1]).toBe(key);
    await c.checklist.addTask({ projectId: id, phaseKey: key, title: "Negotiate unit 2R buyout" });
  });

  it("outside collaborators see only tasks assigned to them", async () => {
    const { id } = await newProject(c);
    const ext = await createUser("external");
    await addMember(id, ext.id);
    const ec = await callerFor(ext.id);
    expect((await ec.checklist.get({ projectId: id })).tasks).toEqual([]);
    const t = await task(id, "survey");
    await db().update(schema.task).set({ assigneeId: ext.id }).where(eq(schema.task.id, t.id));
    const mine = await ec.checklist.get({ projectId: id });
    expect(mine.tasks.map((x) => x.id)).toEqual([t.id]);
    expect(mine.access.canEdit).toBe(false);
    const other = await task(id, "mih_check");
    await expect(ec.checklist.setDone({ projectId: id, taskId: other.id, done: true, version: other.version })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await ec.checklist.setDone({ projectId: id, taskId: t.id, done: true, version: t.version });
  });
});

describe("templates", () => {
  let owner: Awaited<ReturnType<typeof createUser>>;
  let c: Caller;
  beforeAll(async () => {
    owner = await createUser("owner");
    c = await callerFor(owner.id);
  });

  it("lists one default per type, seeded on first use", async () => {
    const list = await c.templates.list();
    const defaults = list.filter((t) => t.isDefault);
    expect(new Set(defaults.map((t) => t.projectType)).size).toBe(5);
    expect(defaults.every((t) => t.tasks > 20)).toBe(true);
  });

  it("saving validates the definition and uses optimistic locking; projects are not rewritten until an update is applied", async () => {
    const { id: templateId } = await c.templates.create({ name: "Lean gut reno", from: { projectType: "gut_renovation" } });
    const t = await c.templates.get({ templateId });
    // A project made from version 1.
    const { id: projectId } = await c.projects.create({ name: "From lean", address: "1 Lean St", type: "gut_renovation", companyId: await companyId(), bbl: null, templateId });
    const def = structuredClone(t.definition);
    // Rename one task, drop another, add a new one.
    def.tasks = def.tasks.map((k) => (k.key === "site_visit" ? { ...k, title: "Site visit and drone flight" } : k)).filter((k) => k.key !== "sales_comps");
    def.tasks = def.tasks.map((k) => ({ ...k, dependsOn: (k.dependsOn ?? []).filter((d) => d !== "sales_comps") }));
    def.tasks.push({ key: "neighbors_meeting", phaseKey: "pipeline", title: "Meet the neighbors", role: "Acquisitions", due: { days: 3, unit: "business", from: "phase_start" } });
    const saved = await c.templates.save({ templateId, version: t.version, definition: def });
    expect(saved.version).toBe(2);
    await expect(c.templates.save({ templateId, version: t.version, definition: def })).rejects.toMatchObject({ code: "CONFLICT" });

    // A broken definition is refused with a readable reason.
    const bad = structuredClone(def);
    bad.tasks.push({ key: "loop_a", phaseKey: "pipeline", title: "Loop A", role: "PM", due: { days: 1, unit: "business", from: "phase_start" }, dependsOn: ["loop_b"] });
    bad.tasks.push({ key: "loop_b", phaseKey: "pipeline", title: "Loop B", role: "PM", due: { days: 1, unit: "business", from: "phase_start" }, dependsOn: ["loop_a"] });
    await expect(c.templates.save({ templateId, version: 2, definition: bad })).rejects.toMatchObject({ message: expect.stringMatching(/circle/) });

    // The project still has version 1's tasks.
    expect(await task(projectId, "sales_comps")).toBeDefined();
    const preview = await c.templates.updatePreview({ projectId });
    expect(preview).toMatchObject({ fromVersion: 1, toVersion: 2 });
    expect(preview.add.map((a) => a.key)).toEqual(["neighbors_meeting"]);
    expect(preview.remove.map((r) => r.title)).toEqual(["Finished-product sales comps"]);
    expect(preview.update.find((u) => u.title === "Site visit with photos")).toMatchObject({ newTitle: "Site visit and drone flight", fields: ["title"] });
    await expect(c.templates.applyUpdate({ projectIds: [projectId], expectedVersion: 1 })).rejects.toMatchObject({ code: "CONFLICT" });
    const [res] = await c.templates.applyUpdate({ projectIds: [projectId], expectedVersion: 2 });
    expect(res).toMatchObject({ added: 1, removed: 1 });
    expect(res!.changed).toBeGreaterThanOrEqual(1);
    expect((await task(projectId, "site_visit")).title).toBe("Site visit and drone flight");
    const [p] = await db().select({ v: schema.project.templateVersion }).from(schema.project).where(eq(schema.project.id, projectId));
    expect(p!.v).toBe(2);
    expect((await c.templates.projects({ templateId })).map((x) => x.id)).toContain(projectId);
  });

  it("a template can't be created from another type's project or archived while default", async () => {
    const list = await c.templates.list();
    const flipDefault = list.find((t) => t.projectType === "contract_flip" && t.isDefault)!;
    await expect(c.projects.create({ name: "Mismatch", address: "2 X St", type: "gut_renovation", companyId: await companyId(), bbl: null, templateId: flipDefault.id })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(c.templates.setArchived({ templateId: flipDefault.id, archived: true })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const { id } = await c.templates.create({ name: "Other flip", from: { templateId: flipDefault.id } });
    await c.templates.setDefault({ templateId: id });
    const after = await c.templates.list();
    expect(after.filter((t) => t.projectType === "contract_flip" && t.isDefault).map((t) => t.id)).toEqual([id]);
    await c.templates.setArchived({ templateId: flipDefault.id, archived: true });
    expect((await c.templates.list()).some((t) => t.id === flipDefault.id)).toBe(false);
  });

  it("save as template round-trips a live project", async () => {
    const { id } = await newProject(c, { toggles: ["excavation"] });
    await c.checklist.addTask({ projectId: id, phaseKey: "pipeline", title: "Walk the block" });
    const { templateId } = await c.checklist.saveAsTemplate({ projectId: id, name: "Sterling pattern" });
    const t = await c.templates.get({ templateId });
    expect(t.definition.tasks.some((k) => k.title === "Walk the block")).toBe(true);
    expect(t.definition.tasks.find((k) => k.key === "geotech")?.showIf).toEqual(["excavation"]);
    const { id: second } = await c.projects.create({ name: "From pattern", address: "3 Pattern St", type: "gut_renovation", companyId: await companyId(), bbl: null, templateId, toggles: [] });
    const keys = (await c.checklist.get({ projectId: second })).tasks.map((k) => k.title);
    expect(keys).toContain("Walk the block");
    expect(keys).not.toContain("Geotech borings");
  });

  it("preview generates a dated checklist for a test project", async () => {
    const def = defaultTemplate("contract_flip");
    const out = await c.templates.preview({ definition: def, toggles: [], startOn: "2026-10-05" });
    expect(out.phases[0]!.key).toBe("pipeline");
    expect(out.tasks.find((k) => k.key === "mih_check")!.dueOn).toBe("2026-10-07");
    // Later phases get dates too (as if each started after the previous one's last task).
    expect(out.tasks.find((k) => k.key === "assignment_fee")!.dueOn).toBeTruthy();
  });
});

describe("Milestone 3 review regressions", () => {
  let owner: Awaited<ReturnType<typeof createUser>>;
  let c: Caller;
  beforeAll(async () => {
    owner = await createUser("owner");
    c = await callerFor(owner.id);
  });

  it("a blocked-task error never names tasks an outside collaborator can't see", async () => {
    const { id } = await newProject(c);
    const ext = await createUser("external");
    await addMember(id, ext.id);
    const offer = await task(id, "partner_approval_offer");
    const pluto = await task(id, "pluto_pull");
    await db().update(schema.task).set({ assigneeId: ext.id }).where(inArray(schema.task.id, [offer.id, pluto.id]));
    const ec = await callerFor(ext.id);
    const err = await ec.checklist.setDone({ projectId: id, taskId: offer.id, done: true, version: offer.version }).catch((e) => e);
    expect(err.code).toBe("PRECONDITION_FAILED");
    expect(err.message).not.toMatch(/MIH|E-designation|LPC|Pro forma/);
    expect(err.message).toMatch(/4 other tasks on the project/);
    // Counts too: only their own tasks.
    const p = await ec.projects.get({ projectId: id });
    const total = Object.values(p.taskCounts).reduce((a, x) => a + x.total, 0);
    expect(total).toBe(2);
  });

  it("template updates keep hand edits and hand deletions, and apply rule/role changes", async () => {
    const { id: templateId } = await c.templates.create({ name: `Regress ${Math.random()}`, from: { projectType: "gut_renovation" } });
    const { id: projectId } = await c.projects.create({ name: "Regress", address: "1 R St", type: "gut_renovation", companyId: await companyId(), bbl: null, templateId });
    const sv = await task(projectId, "site_visit");
    await c.checklist.updateTask({ projectId, taskId: sv.id, version: sv.version, title: "Site visit — owner already walked it" });
    await c.checklist.deleteTask({ projectId, taskId: (await task(projectId, "sales_comps")).id });
    const t = await c.templates.get({ templateId });
    const def = structuredClone(t.definition);
    def.tasks = def.tasks.map((k) => (k.key === "mih_check" ? { ...k, role: "Legal", due: { ...k.due, days: 4 } } : k.key === "site_visit" ? { ...k, title: "Site visit and drone" } : k));
    await c.templates.save({ templateId, version: t.version, definition: def });
    const prev = await c.checklist.templateUpdatePreview({ projectId });
    expect(prev.add).toEqual([]);
    expect(prev.update.find((u) => u.title.startsWith("Site visit"))).toMatchObject({ fields: [], skipped: ["title"] });
    await c.checklist.applyTemplateUpdate({ projectId, expectedVersion: prev.toVersion });
    expect((await task(projectId, "site_visit")).title).toBe("Site visit — owner already walked it");
    const mih = await task(projectId, "mih_check");
    expect(mih.role).toBe("Legal");
    expect((mih.dueRule as { days: number }).days).toBe(4);
    const rows = await db().select().from(schema.task).where(and(eq(schema.task.projectId, projectId), eq(schema.task.templateKey, "sales_comps")));
    expect(rows).toHaveLength(0);
  });

  it("turning a condition on wires existing tasks to the prerequisites it adds", async () => {
    const { id: templateId } = await c.templates.create({ name: `Wire ${Math.random()}`, from: { projectType: "gut_renovation" } });
    const t = await c.templates.get({ templateId });
    const def = structuredClone(t.definition);
    def.tasks = def.tasks.map((k) => (k.key === "site_visit" ? { ...k, dependsOn: [...(k.dependsOn ?? []), "geotech"] } : k));
    // geotech lives in Due Diligence; move it to the pipeline so it's a real prerequisite there.
    def.tasks = def.tasks.map((k) => (k.key === "geotech" ? { ...k, phaseKey: "pipeline" } : k));
    const saved = await c.templates.save({ templateId, version: t.version, definition: def });
    expect(saved.version).toBe(2);
    const { id } = await c.projects.create({ name: "Wire", address: "2 W St", type: "gut_renovation", companyId: await companyId(), bbl: null, templateId });
    await c.checklist.setToggles({ projectId: id, toggles: ["excavation"], expectedToggles: [] });
    const sv = await task(id, "site_visit");
    await expect(c.checklist.setDone({ projectId: id, taskId: sv.id, done: true, version: sv.version })).rejects.toMatchObject({ message: expect.stringMatching(/Geotech/) });
  });

  it("two simultaneous prerequisite edits can't form a loop", async () => {
    const { id } = await newProject(c);
    const a = await task(id, "mih_check");
    const b = await task(id, "lpc_check");
    const r = await Promise.allSettled([
      c.checklist.setDependencies({ projectId: id, taskId: a.id, dependsOnIds: [b.id] }),
      c.checklist.setDependencies({ projectId: id, taskId: b.id, dependsOnIds: [a.id] }),
    ]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  });

  it("save as template after skipping a phase is valid, and keeps flags and conditions", async () => {
    const { id } = await newProject(c, { type: "ground_up_condo" });
    let p = await c.projects.get({ projectId: id });
    await c.projects.skipPhase({ projectId: id, key: "design_zoning", skipped: true, version: p.version });
    const { templateId } = await c.checklist.saveAsTemplate({ projectId: id, name: `Skipped ${Math.random()}` });
    const t = await c.templates.get({ templateId });
    expect(t.definition.tasks.find((k) => k.key === "mih_check")?.killScreen).toBe(true);
    expect(t.definition.tasks.find((k) => k.key === "dob_filed")?.milestone).toBe(true);
    expect(t.definition.tasks.find((k) => k.key === "dob_filed")?.dependsOn ?? []).not.toContain("construction_documents");
    expect(t.definition.phases.find((ph) => ph.key === "rental_hold")?.showIf).toEqual(["rental_hold"]);
    expect(t.definition.tasks.find((k) => k.key === "finish_spec")).toBeUndefined(); // it was in the skipped phase
    // It saves again unchanged.
    await c.templates.save({ templateId, version: t.version, definition: t.definition });
    p = await c.projects.get({ projectId: id });
    expect(p.id).toBe(id);
  });

  it("approval can't be switched off or an approved task reopened without approve rights", async () => {
    const { id } = await newProject(c);
    const m = await createUser("member");
    await addMember(id, m.id, { canEditChecklist: true });
    const mc = await callerFor(m.id);
    const signed = await task(id, "partner_approval_offer");
    await expect(mc.checklist.updateTask({ projectId: id, taskId: signed.id, version: signed.version, requiresApproval: false })).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Owner approves a simple approval task; the member can't reopen it.
    const t = await task(id, "site_visit");
    await c.checklist.updateTask({ projectId: id, taskId: t.id, version: t.version, requiresApproval: true, approverRole: "Owner" });
    const t2 = await task(id, "site_visit");
    await c.checklist.setDone({ projectId: id, taskId: t2.id, done: true, version: t2.version });
    const t3 = await task(id, "site_visit");
    await expect(mc.checklist.setDone({ projectId: id, taskId: t3.id, done: false, version: t3.version })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("site-condition changes from a stale preview are refused", async () => {
    const { id } = await newProject(c);
    await c.checklist.setToggles({ projectId: id, toggles: ["occupied"], expectedToggles: [] });
    await expect(c.checklist.setToggles({ projectId: id, toggles: ["flood_zone"], expectedToggles: [] })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("sub-items can be ticked by people working the task, without version races", async () => {
    const { id } = await newProject(c);
    const m = await createUser("member");
    await addMember(id, m.id);
    const mc = await callerFor(m.id);
    const t = await task(id, "tenant_dd").catch(() => null);
    const withItems = t ?? (await db().select().from(schema.task).where(eq(schema.task.projectId, id))).find((x) => x.subItems.length > 1)!;
    await Promise.all(withItems.subItems.map((s) => mc.checklist.setSubItem({ projectId: id, taskId: withItems.id, itemId: s.id, done: true })));
    const [after] = await db().select().from(schema.task).where(eq(schema.task.id, withItems.id));
    expect(after!.subItems.every((s) => s.done)).toBe(true);
  });
});
