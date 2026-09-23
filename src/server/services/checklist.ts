import "server-only";
import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { edgesFrom } from "@/core/deps";
import type { ProjectTypeKey } from "@/core/labels";
import { DEFAULT_TEMPLATE_TYPES, defaultTemplate } from "@/core/seed-library";
import { parseTemplateDef } from "@/core/template-schema";
import {
  generateChecklist,
  scheduleDueDates,
  templateUpdateDiff,
  toggleImpact,
  validateTemplate,
  type DueRule,
  type GeneratedTask,
  type LiveTask,
  type TemplateDef,
  type TemplateUpdateDiff,
  type ToggleImpact,
} from "@/core/templates";
import { impliedToggles } from "@/core/toggles";
import { schema, type Database, type DbOrTx } from "../db";

export type TemplateRow = typeof schema.template.$inferSelect;
export type TaskRow = typeof schema.task.$inferSelect;

const DEFAULTS_LOCK = 7_310_204_555;

/** Make sure every project type has its default template (idempotent, safe under concurrency). */
export async function ensureDefaultTemplates(conn: Database): Promise<void> {
  const have = await conn
    .select({ type: schema.template.projectType })
    .from(schema.template)
    .where(and(eq(schema.template.isDefault, true), isNull(schema.template.archivedAt)));
  if (have.length >= DEFAULT_TEMPLATE_TYPES.length) return;
  await conn.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${DEFAULTS_LOCK})`);
    const again = new Set(
      (
        await tx
          .select({ type: schema.template.projectType })
          .from(schema.template)
          .where(and(eq(schema.template.isDefault, true), isNull(schema.template.archivedAt)))
      ).map((r) => r.type),
    );
    for (const type of DEFAULT_TEMPLATE_TYPES) {
      if (again.has(type)) continue;
      const def = defaultTemplate(type);
      const [row] = await tx.insert(schema.template).values({ name: def.name, projectType: type, isDefault: true, definition: def }).returning({ id: schema.template.id });
      await tx.insert(schema.templateRevision).values({ templateId: row!.id, version: 1, definition: def });
    }
  });
}

export async function loadTemplate(conn: DbOrTx, id: string): Promise<{ row: TemplateRow; def: TemplateDef } | null> {
  const [row] = await conn.select().from(schema.template).where(eq(schema.template.id, id));
  return row ? { row, def: parseTemplateDef(row.definition) } : null;
}

export async function defaultTemplateFor(conn: Database, type: ProjectTypeKey): Promise<{ row: TemplateRow; def: TemplateDef }> {
  await ensureDefaultTemplates(conn);
  const [row] = await conn
    .select()
    .from(schema.template)
    .where(and(eq(schema.template.projectType, type), eq(schema.template.isDefault, true), isNull(schema.template.archivedAt)))
    .limit(1);
  return { row: row!, def: parseTemplateDef(row!.definition) };
}

export function assertValidTemplate(def: TemplateDef): void {
  const problems = validateTemplate(def);
  if (problems.length) {
    throw new TRPCError({ code: "BAD_REQUEST", message: problems.slice(0, 3).map((p) => `${p.where}: ${p.message}`).join(" ") });
  }
}

/** Toggles a project effectively has: what was chosen plus what its type implies. */
export function effectiveToggles(type: ProjectTypeKey, chosen: readonly string[]): Set<string> {
  return new Set([...chosen, ...impliedToggles(type)]);
}

function taskValues(projectId: string, g: GeneratedTask, sortOrder: number, userId: string | null) {
  return {
    id: randomUUID(),
    projectId,
    phaseKey: g.phaseKey,
    templateKey: g.key,
    title: g.title,
    description: g.description,
    role: g.role,
    dueRule: g.due,
    requiresApproval: g.requiresApproval,
    approverRole: g.approverRole,
    requiredAttachment: g.requiredAttachment,
    subItems: g.subItems.map((text) => ({ id: randomUUID(), text, done: false })),
    recurrence: g.recurrence,
    killScreen: g.killScreen,
    milestone: g.milestone,
    toggleSource: g.toggleSource,
    sortOrder,
    createdById: userId,
  };
}

/**
 * Insert generated tasks (and their dependencies, by template key) into a
 * project. Dependencies may point at tasks already on the project.
 */
async function insertGenerated(tx: DbOrTx, projectId: string, gen: GeneratedTask[], userId: string | null): Promise<void> {
  if (gen.length === 0) return;
  const existing = await tx.select({ id: schema.task.id, templateKey: schema.task.templateKey, phaseKey: schema.task.phaseKey, sortOrder: schema.task.sortOrder }).from(schema.task).where(eq(schema.task.projectId, projectId));
  // New tasks go after what's already in their phase, keeping template order among themselves.
  const nextOrder = new Map<string, number>();
  for (const t of existing) nextOrder.set(t.phaseKey, Math.max(nextOrder.get(t.phaseKey) ?? 0, t.sortOrder + 1));
  const values = gen.map((g) => {
    const o = nextOrder.get(g.phaseKey) ?? 0;
    nextOrder.set(g.phaseKey, o + 1);
    return taskValues(projectId, g, o, userId);
  });
  await tx.insert(schema.task).values(values);
  const idByKey = new Map<string, string>();
  for (const t of existing) if (t.templateKey) idByKey.set(t.templateKey, t.id);
  for (const v of values) idByKey.set(v.templateKey!, v.id);
  const deps: { taskId: string; dependsOnId: string }[] = [];
  for (const g of gen) {
    const id = idByKey.get(g.key)!;
    for (const d of g.dependsOn) {
      const on = idByKey.get(d);
      if (on) deps.push({ taskId: id, dependsOnId: on });
    }
  }
  // Existing tasks that depend on a newly added one (e.g. a toggle adds a prerequisite).
  if (deps.length) await tx.insert(schema.taskDependency).values(deps).onConflictDoNothing();
}

/** Recompute rule-based due dates the project can know now (after a phase starts, a task finishes, a toggle changes). */
export async function reschedule(tx: DbOrTx, projectId: string): Promise<number> {
  const tasks = await tx
    .select({ id: schema.task.id, key: schema.task.templateKey, phaseKey: schema.task.phaseKey, dueRule: schema.task.dueRule, dueOn: schema.task.dueOn, dueManual: schema.task.dueManual, completedOn: schema.task.completedOn })
    .from(schema.task)
    .where(eq(schema.task.projectId, projectId));
  const phases = await tx.select({ key: schema.projectPhase.key, startedOn: schema.projectPhase.startedOn, status: schema.projectPhase.status }).from(schema.projectPhase).where(eq(schema.projectPhase.projectId, projectId));
  const starts = new Map(phases.filter((p) => p.startedOn && (p.status === "active" || p.status === "done")).map((p) => [p.key, p.startedOn!]));
  // Hand-made tasks have no template key; give them a stable one for the scheduler.
  const schedulable = tasks.map((t) => ({ key: t.key ?? `id:${t.id}`, phaseKey: t.phaseKey, due: (t.dueRule as DueRule | null) ?? null, dueOn: t.dueOn, dueManual: t.dueManual, completedOn: t.completedOn }));
  const changed = scheduleDueDates(schedulable, starts);
  const idByKey = new Map(tasks.map((t) => [t.key ?? `id:${t.id}`, t.id]));
  for (const [k, due] of changed) await tx.update(schema.task).set({ dueOn: due, updatedAt: new Date() }).where(eq(schema.task.id, idByKey.get(k)!));
  return changed.size;
}

/** A brand-new project's phases and checklist from a template. The first phase starts today. */
export async function buildProjectChecklist(tx: DbOrTx, input: { projectId: string; type: ProjectTypeKey; template: { row: TemplateRow; def: TemplateDef }; chosenToggles: string[]; today: string; userId: string }) {
  const toggles = effectiveToggles(input.type, input.chosenToggles);
  const gen = generateChecklist(input.template.def, toggles);
  if (gen.phases.length === 0) throw new TRPCError({ code: "BAD_REQUEST", message: "That template has no phases for these answers." });
  await tx.insert(schema.projectPhase).values(
    gen.phases.map((p, i) => ({ projectId: input.projectId, key: p.key, name: p.name, sortOrder: i, status: i === 0 ? ("active" as const) : ("pending" as const), startedOn: i === 0 ? input.today : null })),
  );
  await insertGenerated(tx, input.projectId, gen.tasks, input.userId);
  await tx
    .update(schema.project)
    .set({ toggles: input.chosenToggles, templateId: input.template.row.id, templateVersion: input.template.row.version })
    .where(eq(schema.project.id, input.projectId));
  await reschedule(tx, input.projectId);
  return { phases: gen.phases.length, tasks: gen.tasks.length };
}

async function liveState(tx: DbOrTx, projectId: string) {
  const tasks = await tx.select({ id: schema.task.id, templateKey: schema.task.templateKey, title: schema.task.title, phaseKey: schema.task.phaseKey, status: schema.task.status }).from(schema.task).where(eq(schema.task.projectId, projectId));
  const phases = await tx.select().from(schema.projectPhase).where(eq(schema.projectPhase.projectId, projectId)).orderBy(asc(schema.projectPhase.sortOrder));
  const live: LiveTask[] = tasks.map((t) => ({ id: t.id, templateKey: t.templateKey, title: t.title, phaseKey: t.phaseKey, started: t.status !== "not_started" }));
  return { live, phases };
}

export async function projectTemplate(tx: DbOrTx, projectId: string): Promise<{ project: typeof schema.project.$inferSelect; template: { row: TemplateRow; def: TemplateDef } | null }> {
  const [p] = await tx.select().from(schema.project).where(eq(schema.project.id, projectId));
  if (!p) throw new TRPCError({ code: "NOT_FOUND" });
  const template = p.templateId ? await loadTemplate(tx, p.templateId) : null;
  return { project: p, template };
}

/**
 * The definition a project's checklist follows for toggles: the revision it
 * was generated from (so a later template edit doesn't change what a toggle does
 * until that update is applied to the project).
 */
async function projectDefinition(tx: DbOrTx, p: typeof schema.project.$inferSelect): Promise<TemplateDef | null> {
  if (!p.templateId) return null;
  const [rev] = await tx
    .select({ definition: schema.templateRevision.definition })
    .from(schema.templateRevision)
    .where(and(eq(schema.templateRevision.templateId, p.templateId), eq(schema.templateRevision.version, p.templateVersion ?? 1)));
  if (rev) return parseTemplateDef(rev.definition);
  return (await loadTemplate(tx, p.templateId))?.def ?? null;
}

export async function previewToggles(tx: DbOrTx, projectId: string, nextChosen: string[]): Promise<ToggleImpact & { phaseNames: Record<string, string> }> {
  const { project } = await projectTemplate(tx, projectId);
  const def = await projectDefinition(tx, project);
  if (!def) return { add: [], remove: [], ask: [], phasesAdded: [], phasesRemoved: [], phaseNames: {} };
  const type = project.type as ProjectTypeKey;
  const { live, phases } = await liveState(tx, projectId);
  const impact = toggleImpact(def, effectiveToggles(type, project.toggles), effectiveToggles(type, nextChosen), live, phases);
  const phaseNames: Record<string, string> = {};
  for (const p of def.phases) phaseNames[p.key] = p.name;
  for (const p of phases) phaseNames[p.key] = p.name;
  return { ...impact, phaseNames };
}

/**
 * Change a project's toggles: insert the tasks (and phases) they call for,
 * remove not-started tasks they no longer call for, and remove started ones
 * only where the person said so (`removeStarted`).
 */
export async function applyToggles(tx: DbOrTx, projectId: string, nextChosen: string[], removeStarted: string[], userId: string) {
  const impact = await previewToggles(tx, projectId, nextChosen);
  const allowedStarted = new Set(impact.ask.map((t) => t.id));
  for (const id of removeStarted) if (!allowedStarted.has(id)) throw new TRPCError({ code: "BAD_REQUEST", message: "That task isn't affected by this change." });
  const removeIds = [...impact.remove.map((t) => t.id), ...removeStarted];

  // Phases first, so new tasks have somewhere to go.
  const { project } = await projectTemplate(tx, projectId);
  const def = await projectDefinition(tx, project);
  const phases = await tx.select().from(schema.projectPhase).where(eq(schema.projectPhase.projectId, projectId)).orderBy(asc(schema.projectPhase.sortOrder));
  for (const ph of impact.phasesAdded) {
    const existing = phases.find((p) => p.key === ph.key);
    if (existing) await tx.update(schema.projectPhase).set({ status: "pending" }).where(eq(schema.projectPhase.id, existing.id));
    else await tx.insert(schema.projectPhase).values({ projectId, key: ph.key, name: ph.name, sortOrder: 0, status: "pending" });
  }
  for (const key of impact.phasesRemoved) {
    const ph = phases.find((p) => p.key === key);
    // Only an upcoming phase is set aside; a current or finished one stays where it is.
    if (ph && ph.status === "pending") await tx.update(schema.projectPhase).set({ status: "skipped", startedOn: null, completedOn: null }).where(eq(schema.projectPhase.id, ph.id));
  }
  if (impact.phasesAdded.length && def) await renumberPhases(tx, projectId, def);

  if (removeIds.length) await tx.delete(schema.task).where(and(eq(schema.task.projectId, projectId), inArray(schema.task.id, removeIds)));
  await insertGenerated(tx, projectId, impact.add, userId);
  await tx.update(schema.project).set({ toggles: nextChosen, version: sql`${schema.project.version} + 1`, updatedAt: new Date() }).where(eq(schema.project.id, projectId));
  await reschedule(tx, projectId);
  return { added: impact.add.length, removed: removeIds.length, phasesAdded: impact.phasesAdded.map((p) => p.name), phasesSetAside: impact.phasesRemoved };
}

/** Put template phases in template order; custom phases keep their place after the template phase they followed. */
async function renumberPhases(tx: DbOrTx, projectId: string, def: TemplateDef): Promise<void> {
  const phases = await tx.select().from(schema.projectPhase).where(eq(schema.projectPhase.projectId, projectId)).orderBy(asc(schema.projectPhase.sortOrder), asc(schema.projectPhase.createdAt));
  const order = new Map(def.phases.map((p, i) => [p.key, i]));
  // Anchor each custom phase to the nearest template phase before it.
  let lastAnchor = -1;
  const withRank = phases.map((p, i) => {
    const r = order.get(p.key);
    if (r !== undefined) lastAnchor = r;
    return { p, rank: r !== undefined ? r : lastAnchor + 0.5, i };
  });
  withRank.sort((a, b) => a.rank - b.rank || a.i - b.i);
  for (const [i, { p }] of withRank.entries()) if (p.sortOrder !== i) await tx.update(schema.projectPhase).set({ sortOrder: i }).where(eq(schema.projectPhase.id, p.id));
}

export async function templateUpdatePreview(tx: DbOrTx, projectId: string): Promise<{ diff: TemplateUpdateDiff; fromVersion: number | null; toVersion: number; templateName: string } | null> {
  const { project, template } = await projectTemplate(tx, projectId);
  if (!template) return null;
  const { live } = await liveState(tx, projectId);
  const diff = templateUpdateDiff(template.def, effectiveToggles(project.type as ProjectTypeKey, project.toggles), live);
  return { diff, fromVersion: project.templateVersion, toVersion: template.row.version, templateName: template.row.name };
}

/** Apply the template's latest version to a project: only not-started template tasks change. */
export async function applyTemplateUpdate(tx: DbOrTx, projectId: string, userId: string) {
  const prev = await templateUpdatePreview(tx, projectId);
  if (!prev) throw new TRPCError({ code: "BAD_REQUEST", message: "This project wasn't made from a template." });
  const { project, template } = await projectTemplate(tx, projectId);
  const { diff } = prev;
  // Phases the new version adds (for these toggles) join as upcoming.
  const gen = generateChecklist(template!.def, effectiveToggles(project.type as ProjectTypeKey, project.toggles));
  const phases = await tx.select().from(schema.projectPhase).where(eq(schema.projectPhase.projectId, projectId));
  const newPhases = gen.phases.filter((p) => !phases.some((x) => x.key === p.key));
  if (newPhases.length) {
    await tx.insert(schema.projectPhase).values(newPhases.map((p) => ({ projectId, key: p.key, name: p.name, sortOrder: 0, status: "pending" as const })));
    await renumberPhases(tx, projectId, template!.def);
  }
  if (diff.remove.length) await tx.delete(schema.task).where(inArray(schema.task.id, diff.remove.map((t) => t.id)));
  for (const r of diff.rename) await tx.update(schema.task).set({ title: r.to, updatedAt: new Date(), version: sql`${schema.task.version} + 1` }).where(eq(schema.task.id, r.task.id));
  await insertGenerated(tx, projectId, diff.add, userId);
  await tx.update(schema.project).set({ templateVersion: template!.row.version, updatedAt: new Date() }).where(eq(schema.project.id, projectId));
  await reschedule(tx, projectId);
  return { added: diff.add.length, removed: diff.remove.length, renamed: diff.rename.length, kept: diff.kept.length };
}

/** Blocking prerequisites of a task that aren't done (for "can't check this off yet because…"). */
export async function unmetPrerequisites(tx: DbOrTx, taskId: string): Promise<{ id: string; title: string }[]> {
  const rows = await tx
    .select({ id: schema.task.id, title: schema.task.title, status: schema.task.status })
    .from(schema.taskDependency)
    .innerJoin(schema.task, eq(schema.task.id, schema.taskDependency.dependsOnId))
    .where(eq(schema.taskDependency.taskId, taskId));
  return rows.filter((r) => r.status !== "done").map(({ id, title }) => ({ id, title }));
}

export async function projectEdges(tx: DbOrTx, projectId: string) {
  const rows = await tx
    .select({ taskId: schema.taskDependency.taskId, dependsOnId: schema.taskDependency.dependsOnId })
    .from(schema.taskDependency)
    .innerJoin(schema.task, eq(schema.task.id, schema.taskDependency.taskId))
    .where(eq(schema.task.projectId, projectId));
  return edgesFrom(rows);
}
