import "server-only";
import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { edgesFrom, wouldCreateCycle } from "@/core/deps";
import type { ProjectTypeKey } from "@/core/labels";
import { DEFAULT_TEMPLATE_TYPES, defaultTemplate } from "@/core/seed-library";
import { parseTemplateDef } from "@/core/template-schema";
import {
  generateChecklist,
  scheduleDueDates,
  FIELD_LABEL,
  templateUpdateDiff,
  toggleImpact,
  validateTemplate,
  type DueRule,
  type GeneratedTask,
  type LiveTaskFull,
  type Recurrence,
  type TemplateDef,
  type TemplateUpdateDiff,
  type ToggleImpact,
  type UpdatableField,
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

/** Serialize checklist-structure changes on one project (dependencies, toggles, template updates). */
export async function lockProject(tx: DbOrTx, projectId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`checklist:${projectId}`}))`);
}

/**
 * Insert generated tasks (and their dependencies, by template key) into a
 * project. Dependencies may point at tasks already on the project, and tasks
 * already on the project whose definition lists a newly added task as a
 * prerequisite get that edge too (a toggle can add a prerequisite). An edge
 * that would close a loop with hand-made dependencies is skipped.
 */
async function insertGenerated(tx: DbOrTx, projectId: string, gen: GeneratedTask[], userId: string | null, def?: TemplateDef | null): Promise<void> {
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
  if (def) {
    const added = new Set(gen.map((g) => g.key));
    for (const t of existing) {
      if (!t.templateKey) continue;
      const wants = def.tasks.find((k) => k.key === t.templateKey)?.dependsOn ?? [];
      for (const d of wants) if (added.has(d)) deps.push({ taskId: t.id, dependsOnId: idByKey.get(d)! });
    }
  }
  if (!deps.length) return;
  const edges = await projectEdges(tx, projectId);
  const safe = deps.filter((d) => {
    if (wouldCreateCycle(edges, d.taskId, d.dependsOnId)) return false;
    edges.set(d.taskId, [...(edges.get(d.taskId) ?? []), d.dependsOnId]);
    return true;
  });
  if (safe.length) await tx.insert(schema.taskDependency).values(safe).onConflictDoNothing();
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
  const tasks = await tx.select().from(schema.task).where(eq(schema.task.projectId, projectId));
  const phases = await tx.select().from(schema.projectPhase).where(eq(schema.projectPhase.projectId, projectId)).orderBy(asc(schema.projectPhase.sortOrder));
  const edges = await projectEdges(tx, projectId);
  const keyOf = new Map(tasks.map((t) => [t.id, t.templateKey]));
  const live: LiveTaskFull[] = tasks.map((t) => ({
    id: t.id,
    templateKey: t.templateKey,
    title: t.title,
    phaseKey: t.phaseKey,
    started: t.status !== "not_started",
    description: t.description,
    role: t.role,
    due: (t.dueRule as DueRule | null) ?? null,
    requiresApproval: t.requiresApproval,
    approverRole: t.approverRole,
    requiredAttachment: t.requiredAttachment,
    recurrence: (t.recurrence as Recurrence | null) ?? null,
    killScreen: t.killScreen,
    milestone: t.milestone,
    subItems: t.subItems.map((x) => x.text),
    // Hand-made prerequisites (no template key) can't be compared with a template, so they're ignored here.
    dependsOn: (edges.get(t.id) ?? []).map((id) => keyOf.get(id)).filter((k): k is string => !!k),
  }));
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
  await lockProject(tx, projectId);
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
  await insertGenerated(tx, projectId, impact.add, userId, def);
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

async function revisionDef(tx: DbOrTx, templateId: string, version: number | null): Promise<TemplateDef | null> {
  if (version === null) return null;
  const [rev] = await tx
    .select({ definition: schema.templateRevision.definition })
    .from(schema.templateRevision)
    .where(and(eq(schema.templateRevision.templateId, templateId), eq(schema.templateRevision.version, version)));
  return rev ? parseTemplateDef(rev.definition) : null;
}

export async function templateUpdatePreview(tx: DbOrTx, projectId: string): Promise<{ diff: TemplateUpdateDiff; fromVersion: number | null; toVersion: number; templateName: string; next: TemplateDef } | null> {
  const { project, template } = await projectTemplate(tx, projectId);
  if (!template) return null;
  const { live } = await liveState(tx, projectId);
  // Diff from the revision the project came from; without it, compare against the latest (no field changes).
  const base = (await revisionDef(tx, template.row.id, project.templateVersion)) ?? template.def;
  const diff = templateUpdateDiff(base, template.def, effectiveToggles(project.type as ProjectTypeKey, project.toggles), live);
  return { diff, fromVersion: project.templateVersion, toVersion: template.row.version, templateName: template.row.name, next: template.def };
}

/**
 * Apply the template's latest version to a project: only what the template
 * changed, only on tasks that haven't started and weren't changed by hand.
 * `expectedVersion` guards against applying a version nobody reviewed.
 */
export async function applyTemplateUpdate(tx: DbOrTx, projectId: string, userId: string, expectedVersion?: number) {
  await lockProject(tx, projectId);
  const prev = await templateUpdatePreview(tx, projectId);
  if (!prev) throw new TRPCError({ code: "BAD_REQUEST", message: "This project wasn't made from a template." });
  if (expectedVersion !== undefined && prev.toVersion !== expectedVersion) {
    throw new TRPCError({ code: "CONFLICT", message: `The template was saved again (now version ${prev.toVersion}) since you reviewed it. Review the update again.` });
  }
  const { project } = await projectTemplate(tx, projectId);
  const { diff, next } = prev;
  const gen = generateChecklist(next, effectiveToggles(project.type as ProjectTypeKey, project.toggles));
  const phases = await tx.select().from(schema.projectPhase).where(eq(schema.projectPhase.projectId, projectId));
  const newPhases = gen.phases.filter((p) => !phases.some((x) => x.key === p.key));
  if (newPhases.length) {
    await tx.insert(schema.projectPhase).values(newPhases.map((p) => ({ projectId, key: p.key, name: p.name, sortOrder: 0, status: "pending" as const })));
    await renumberPhases(tx, projectId, next);
  }
  if (diff.remove.length) await tx.delete(schema.task).where(inArray(schema.task.id, diff.remove.map((t) => t.id)));
  const ids = new Map((await tx.select({ id: schema.task.id, key: schema.task.templateKey }).from(schema.task).where(eq(schema.task.projectId, projectId))).filter((r) => r.key).map((r) => [r.key!, r.id]));
  let changed = 0;
  for (const u of diff.update) {
    const c = u.changes;
    if (!Object.keys(c).length) continue;
    changed++;
    const [cur] = await tx.select({ subItems: schema.task.subItems }).from(schema.task).where(eq(schema.task.id, u.task.id));
    const set: Partial<typeof schema.task.$inferInsert> = {};
    if (c.title !== undefined) set.title = c.title;
    if (c.description !== undefined) set.description = c.description;
    if (c.role !== undefined) set.role = c.role;
    if (c.phaseKey !== undefined && gen.phases.some((p) => p.key === c.phaseKey)) set.phaseKey = c.phaseKey;
    if (c.due !== undefined) set.dueRule = c.due;
    if (c.requiresApproval !== undefined) set.requiresApproval = c.requiresApproval;
    if (c.approverRole !== undefined) set.approverRole = c.approverRole;
    if (c.requiredAttachment !== undefined) set.requiredAttachment = c.requiredAttachment;
    if (c.recurrence !== undefined) set.recurrence = c.recurrence;
    if (c.killScreen !== undefined) set.killScreen = c.killScreen;
    if (c.milestone !== undefined) set.milestone = c.milestone;
    if (c.subItems !== undefined) {
      // Keep ticks on items whose text didn't change.
      const old = cur?.subItems ?? [];
      set.subItems = c.subItems.map((text) => old.find((o) => o.text === text) ?? { id: randomUUID(), text, done: false });
    }
    if (Object.keys(set).length) await tx.update(schema.task).set({ ...set, version: sql`${schema.task.version} + 1`, updatedAt: new Date() }).where(eq(schema.task.id, u.task.id));
    if (c.dependsOn !== undefined) {
      // Replace only the template-keyed prerequisites; hand-made ones stay.
      const templKeyed = await tx
        .select({ dependsOnId: schema.taskDependency.dependsOnId, key: schema.task.templateKey })
        .from(schema.taskDependency)
        .innerJoin(schema.task, eq(schema.task.id, schema.taskDependency.dependsOnId))
        .where(eq(schema.taskDependency.taskId, u.task.id));
      const drop = templKeyed.filter((r) => r.key).map((r) => r.dependsOnId);
      if (drop.length) await tx.delete(schema.taskDependency).where(and(eq(schema.taskDependency.taskId, u.task.id), inArray(schema.taskDependency.dependsOnId, drop)));
      const edges = await projectEdges(tx, projectId);
      for (const k of c.dependsOn) {
        const on = ids.get(k);
        if (!on || wouldCreateCycle(edges, u.task.id, on)) continue;
        await tx.insert(schema.taskDependency).values({ taskId: u.task.id, dependsOnId: on }).onConflictDoNothing();
        edges.set(u.task.id, [...(edges.get(u.task.id) ?? []), on]);
      }
    }
  }
  await insertGenerated(tx, projectId, diff.add, userId, next);
  await tx.update(schema.project).set({ templateVersion: prev.toVersion, updatedAt: new Date() }).where(eq(schema.project.id, projectId));
  await reschedule(tx, projectId);
  return { added: diff.add.length, removed: diff.remove.length, changed, kept: diff.kept.length };
}

/** A readable summary of a diff for the preview dialogs. */
export function describeDiff(d: TemplateUpdateDiff) {
  return {
    add: d.add.map((k) => ({ key: k.key, title: k.title, phaseKey: k.phaseKey })),
    remove: d.remove.map((t) => ({ id: t.id, title: t.title })),
    update: d.update
      .filter((u) => Object.keys(u.changes).length || u.skipped.length)
      .map((u) => ({
        id: u.task.id,
        title: u.task.title,
        newTitle: u.changes.title ?? null,
        fields: (Object.keys(u.changes) as UpdatableField[]).map((f) => FIELD_LABEL[f]),
        skipped: u.skipped.map((f) => FIELD_LABEL[f]),
      })),
    kept: d.kept.map((t) => ({ id: t.id, title: t.title })),
  };
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
