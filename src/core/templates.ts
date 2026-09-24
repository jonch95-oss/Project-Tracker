/**
 * Templates (brief §5.1): a project type, ordered phases, and task templates
 * inside each phase. This module turns a template plus a project's toggles
 * into a checklist, schedules relative due dates, previews what a toggle
 * would add or remove, diffs a template update against a live project, and
 * turns a live project back into a template. Pure: no I/O, no clock.
 */
import { offsetDate, type OffsetUnit } from "./calendar";
import { findCycle } from "./deps";
import type { ProjectTypeKey } from "./labels";
import { conditionsMet, type Conditions } from "./toggles";
import { addDays, daysBetween } from "./time";

export type DueFrom = "phase_start" | { task: string };

export interface DueRule {
  days: number;
  unit: OffsetUnit;
  from: DueFrom;
}

export const RECURRENCE_FREQS = ["weekly", "biweekly", "monthly"] as const;
export type RecurrenceFreq = (typeof RECURRENCE_FREQS)[number];
export interface Recurrence {
  freq: RecurrenceFreq;
}

export interface TemplatePhaseDef extends Conditions {
  key: string;
  name: string;
}

export interface TemplateTaskDef extends Conditions {
  key: string;
  phaseKey: string;
  title: string;
  description?: string | null;
  role: string;
  due: DueRule;
  requiresApproval?: boolean;
  approverRole?: string | null;
  dependsOn?: string[];
  subItems?: string[];
  requiredAttachment?: string | null;
  recurrence?: Recurrence | null;
  /** A pipeline check that can kill the deal on its own. */
  killScreen?: boolean;
  milestone?: boolean;
}

export interface TemplateDef {
  name: string;
  projectType: ProjectTypeKey;
  description?: string | null;
  phases: TemplatePhaseDef[];
  tasks: TemplateTaskDef[];
  /** Default folders for Files (brief §14). */
  folders?: string[];
}

export interface GeneratedPhase {
  key: string;
  name: string;
  sortOrder: number;
}

export interface GeneratedTask {
  key: string;
  phaseKey: string;
  title: string;
  description: string | null;
  role: string;
  due: DueRule;
  requiresApproval: boolean;
  approverRole: string | null;
  dependsOn: string[];
  subItems: string[];
  requiredAttachment: string | null;
  recurrence: Recurrence | null;
  killScreen: boolean;
  milestone: boolean;
  sortOrder: number;
  /** The toggles that made this task appear (for "added by: Excavation"). */
  toggleSource: string[];
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

export interface TemplateProblem {
  where: string;
  message: string;
}

export function validateTemplate(t: TemplateDef): TemplateProblem[] {
  const out: TemplateProblem[] = [];
  if (!t.name.trim()) out.push({ where: "template", message: "The template needs a name." });
  if (t.phases.length === 0) out.push({ where: "template", message: "Add at least one phase." });
  const phaseKeys = new Set<string>();
  for (const p of t.phases) {
    if (!p.name.trim()) out.push({ where: `phase ${p.key}`, message: "Every phase needs a name." });
    if (phaseKeys.has(p.key)) out.push({ where: `phase ${p.key}`, message: `Two phases share the key "${p.key}".` });
    phaseKeys.add(p.key);
  }
  const taskKeys = new Set<string>();
  for (const k of t.tasks) {
    if (taskKeys.has(k.key)) out.push({ where: `task ${k.key}`, message: `Two tasks share the key "${k.key}".` });
    taskKeys.add(k.key);
  }
  for (const k of t.tasks) {
    const where = `task "${k.title || k.key}"`;
    if (!k.title.trim()) out.push({ where, message: "Every task needs a title." });
    if (!phaseKeys.has(k.phaseKey)) out.push({ where, message: "It's in a phase that doesn't exist." });
    if (!Number.isInteger(k.due.days) || k.due.days < 0 || k.due.days > 3650) out.push({ where, message: "Due offset must be 0–3650 days." });
    if (typeof k.due.from === "object") {
      if (!taskKeys.has(k.due.from.task)) out.push({ where, message: "Its due date is relative to a task that doesn't exist." });
      if (k.due.from.task === k.key) out.push({ where, message: "Its due date can't be relative to itself." });
    }
    for (const d of k.dependsOn ?? []) if (!taskKeys.has(d)) out.push({ where, message: `It depends on a task that doesn't exist (${d}).` });
    if (k.requiresApproval && !k.approverRole?.trim()) out.push({ where, message: "It requires approval but has no approver role." });
  }
  const deps = new Map(t.tasks.map((k) => [k.key, [...(k.dependsOn ?? [])]]));
  const cycle = findCycle(t.tasks.map((k) => k.key), deps);
  if (cycle) out.push({ where: "dependencies", message: `Dependencies go in a circle: ${cycle.map((c) => t.tasks.find((x) => x.key === c)?.title ?? c).join(" → ")}.` });
  const anchors = new Map(t.tasks.map((k) => [k.key, typeof k.due.from === "object" ? [k.due.from.task] : []]));
  const aCycle = findCycle(t.tasks.map((k) => k.key), anchors);
  if (aCycle) out.push({ where: "due dates", message: "Relative due dates go in a circle." });
  return out;
}

/* ------------------------------------------------------------------ */
/* Generation                                                          */
/* ------------------------------------------------------------------ */

export function includedPhases(t: TemplateDef, toggles: ReadonlySet<string>): GeneratedPhase[] {
  return t.phases.filter((p) => conditionsMet(p, toggles)).map((p, i) => ({ key: p.key, name: p.name, sortOrder: i }));
}

function taskIncluded(k: TemplateTaskDef, phases: ReadonlySet<string>, toggles: ReadonlySet<string>): boolean {
  return phases.has(k.phaseKey) && conditionsMet(k, toggles);
}

function toGenerated(k: TemplateTaskDef, sortOrder: number, included: ReadonlySet<string>): GeneratedTask {
  return {
    key: k.key,
    phaseKey: k.phaseKey,
    title: k.title,
    description: k.description ?? null,
    role: k.role,
    due: k.due,
    requiresApproval: !!k.requiresApproval,
    approverRole: k.requiresApproval ? (k.approverRole ?? null) : null,
    // Dependencies on tasks that aren't in this project are dropped.
    dependsOn: (k.dependsOn ?? []).filter((d) => included.has(d)),
    subItems: [...(k.subItems ?? [])],
    requiredAttachment: k.requiredAttachment ?? null,
    recurrence: k.recurrence ?? null,
    killScreen: !!k.killScreen,
    milestone: !!k.milestone,
    sortOrder,
    toggleSource: [...(k.showIf ?? [])],
  };
}

/** The checklist a new project gets: included phases and tasks, in template order. */
export function generateChecklist(t: TemplateDef, toggles: ReadonlySet<string>): { phases: GeneratedPhase[]; tasks: GeneratedTask[] } {
  const phases = includedPhases(t, toggles);
  const phaseSet = new Set(phases.map((p) => p.key));
  const kept = t.tasks.filter((k) => taskIncluded(k, phaseSet, toggles));
  const keys = new Set(kept.map((k) => k.key));
  return { phases, tasks: kept.map((k, i) => toGenerated(k, i, keys)) };
}

/* ------------------------------------------------------------------ */
/* Due dates                                                           */
/* ------------------------------------------------------------------ */

export interface SchedulableTask {
  key: string;
  phaseKey: string;
  due: DueRule | null;
  /** Current due date. */
  dueOn: string | null;
  /** Set by a person; never recomputed. */
  dueManual: boolean;
  completedOn: string | null;
}

/**
 * Fill in due dates that can be known now. A phase-relative rule needs its
 * phase to have started; a task-relative rule needs the anchor task's
 * completion date (or, failing that, its due date). Manually set dates are
 * left alone. Returns only the tasks whose date changed.
 */
export function scheduleDueDates(tasks: readonly SchedulableTask[], phaseStarts: ReadonlyMap<string, string>): Map<string, string> {
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  const resolved = new Map<string, string | null>();
  const visiting = new Set<string>();
  const compute = (t: SchedulableTask): string | null => {
    if (resolved.has(t.key)) return resolved.get(t.key)!;
    if (t.dueManual || !t.due) {
      resolved.set(t.key, t.dueOn);
      return t.dueOn;
    }
    if (visiting.has(t.key)) return t.dueOn; // anchor cycle: leave as is
    visiting.add(t.key);
    let anchor: string | null = null;
    if (t.due.from === "phase_start") anchor = phaseStarts.get(t.phaseKey) ?? null;
    else {
      const a = byKey.get(t.due.from.task);
      anchor = a ? (a.completedOn ?? compute(a)) : null;
    }
    visiting.delete(t.key);
    const d = anchor ? offsetDate(anchor, t.due.days, t.due.unit) : t.dueOn;
    resolved.set(t.key, d);
    return d;
  };
  const changed = new Map<string, string>();
  for (const t of tasks) {
    const d = compute(t);
    if (d && d !== t.dueOn) changed.set(t.key, d);
  }
  return changed;
}

export interface ProjectedPhase {
  key: string;
  status: "pending" | "active" | "done" | "skipped";
  startedOn: string | null;
}

/**
 * Every task's date as far as the plan can see: real due dates where they're
 * known, and, for phases that haven't started, the dates their rules give if
 * each phase starts the day after the one before it is projected to end (and
 * not before today). This is what a baseline locks and what the forecast is
 * measured over, so a later phase's work isn't "new delay" the day it starts.
 * `phases` must be in phase order. Returns key → date for every task that has one.
 */
export function projectDueDates(tasks: readonly SchedulableTask[], phases: readonly ProjectedPhase[], today: string): Map<string, string> {
  const starts = new Map<string, string>();
  let lastEnd: string | null = null;
  let dates = new Map<string, string>();
  const resolve = () => {
    const changed = scheduleDueDates(tasks, starts);
    return new Map(tasks.flatMap((t) => { const d = changed.get(t.key) ?? t.dueOn; return d ? [[t.key, d] as const] : []; }));
  };
  for (const p of phases) {
    if (p.status === "skipped") continue;
    let start: string = p.startedOn && p.status !== "pending" ? p.startedOn : lastEnd ? addDays(lastEnd, 1) : today;
    if (p.status === "pending" && start < today) start = today;
    starts.set(p.key, start);
    dates = resolve();
    let end: string = start;
    for (const t of tasks) {
      const d = t.phaseKey === p.key ? (t.completedOn ?? dates.get(t.key)) : undefined;
      if (d && d > end) end = d;
    }
    if (!lastEnd || end > lastEnd) lastEnd = end;
  }
  return phases.length ? dates : resolve();
}

/* ------------------------------------------------------------------ */
/* Toggles on a live project                                           */
/* ------------------------------------------------------------------ */

export interface LiveTask {
  id: string;
  templateKey: string | null;
  title: string;
  phaseKey: string;
  /** Anything other than "not started" counts as started. */
  started: boolean;
}

export interface LivePhase {
  key: string;
  status: "pending" | "active" | "done" | "skipped";
}

export interface ToggleImpact {
  add: GeneratedTask[];
  /** Not-started tasks that will be removed. */
  remove: LiveTask[];
  /** Started tasks the toggle no longer calls for: the user decides. */
  ask: LiveTask[];
  phasesAdded: GeneratedPhase[];
  phasesRemoved: string[];
}

/**
 * What changes when the project's toggles go from `before` to `after`. Only
 * tasks that came from the template are touched; tasks people added by hand
 * never move.
 */
export function toggleImpact(t: TemplateDef, before: ReadonlySet<string>, after: ReadonlySet<string>, live: readonly LiveTask[], livePhases: readonly LivePhase[]): ToggleImpact {
  const phasesBefore = new Set(includedPhases(t, before).map((p) => p.key));
  const phasesAfterList = includedPhases(t, after);
  const phasesAfter = new Set(phasesAfterList.map((p) => p.key));
  const livePhaseKeys = new Set(livePhases.filter((p) => p.status !== "skipped").map((p) => p.key));
  const present = new Set(live.map((l) => l.templateKey).filter(Boolean) as string[]);
  const after_ = generateChecklist(t, after);
  const nowIncluded = new Set(after_.tasks.map((k) => k.key));
  const wasIncluded = new Set(generateChecklist(t, before).tasks.map((k) => k.key));
  const add = after_.tasks.filter((k) => !wasIncluded.has(k.key) && !present.has(k.key));
  const leaving = live.filter((l) => l.templateKey && wasIncluded.has(l.templateKey) && !nowIncluded.has(l.templateKey));
  return {
    add,
    remove: leaving.filter((l) => !l.started),
    ask: leaving.filter((l) => l.started),
    phasesAdded: phasesAfterList.filter((p) => !phasesBefore.has(p.key) && !livePhaseKeys.has(p.key)),
    phasesRemoved: [...phasesBefore].filter((k) => !phasesAfter.has(k)),
  };
}

/* ------------------------------------------------------------------ */
/* Template updates → live projects                                    */
/* ------------------------------------------------------------------ */

/** The fields of a template task that an update can change on a live task. */
export const UPDATABLE_FIELDS = ["title", "description", "role", "phaseKey", "due", "requiresApproval", "approverRole", "requiredAttachment", "recurrence", "killScreen", "milestone", "subItems", "dependsOn"] as const;
export type UpdatableField = (typeof UPDATABLE_FIELDS)[number];

export const FIELD_LABEL: Record<UpdatableField, string> = {
  title: "title",
  description: "description",
  role: "role",
  phaseKey: "phase",
  due: "due rule",
  requiresApproval: "approval",
  approverRole: "approver",
  requiredAttachment: "required attachment",
  recurrence: "repeat",
  killScreen: "kill screen",
  milestone: "milestone",
  subItems: "sub-checklist",
  dependsOn: "prerequisites",
};

/** A live task with the fields an update compares (dependsOn as template keys). */
export interface LiveTaskFull extends LiveTask {
  description: string | null;
  role: string;
  due: DueRule | null;
  requiresApproval: boolean;
  approverRole: string | null;
  requiredAttachment: string | null;
  recurrence: Recurrence | null;
  killScreen: boolean;
  milestone: boolean;
  subItems: string[];
  dependsOn: string[];
}

export interface TaskChange {
  task: LiveTaskFull;
  /** New values for the fields the template changed and nobody changed by hand. */
  changes: Partial<Pick<GeneratedTask, UpdatableField>>;
  /** Fields the template changed but this project had already changed by hand (left alone). */
  skipped: UpdatableField[];
}

export interface TemplateUpdateDiff {
  add: GeneratedTask[];
  remove: LiveTaskFull[];
  update: TaskChange[];
  /** Started tasks the update would have changed or removed: left exactly as they are. */
  kept: LiveTaskFull[];
}

/** JSON with sorted object keys (stored jsonb doesn't keep key order). */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v);
}

const norm = (f: UpdatableField, v: unknown): string => {
  if (f === "dependsOn" && Array.isArray(v)) return stable([...v].sort());
  if (v === undefined || v === null || v === "" || v === false) return f === "subItems" || f === "dependsOn" ? "[]" : "null";
  if (Array.isArray(v) && v.length === 0) return "[]";
  return stable(v);
};

/**
 * Three-way diff for "apply template update": what changed between the
 * revision a project came from (`base`) and the latest one (`next`), applied
 * to the project as it is now (`live`). Only what the template changed is
 * touched; a field someone already changed by hand on the project is left
 * alone; tasks deleted by hand stay deleted; started tasks never change.
 */
export function templateUpdateDiff(base: TemplateDef, next: TemplateDef, toggles: ReadonlySet<string>, live: readonly LiveTaskFull[]): TemplateUpdateDiff {
  const b = new Map(generateChecklist(base, toggles).tasks.map((k) => [k.key, k]));
  const n = new Map(generateChecklist(next, toggles).tasks.map((k) => [k.key, k]));
  const byKey = new Map(live.filter((l) => l.templateKey).map((l) => [l.templateKey!, l]));
  const out: TemplateUpdateDiff = { add: [], remove: [], update: [], kept: [] };
  for (const [key, k] of n) if (!b.has(key) && !byKey.has(key)) out.add.push(k);
  for (const [key] of b) {
    if (n.has(key)) continue;
    const l = byKey.get(key);
    if (l) (l.started ? out.kept : out.remove).push(l);
  }
  for (const [key, nk] of n) {
    const bk = b.get(key);
    const l = byKey.get(key);
    if (!bk || !l) continue;
    const changedFields = UPDATABLE_FIELDS.filter((f) => norm(f, bk[f]) !== norm(f, nk[f]));
    if (!changedFields.length) continue;
    if (l.started) {
      out.kept.push(l);
      continue;
    }
    const changes: Partial<Pick<GeneratedTask, UpdatableField>> = {};
    const skipped: UpdatableField[] = [];
    for (const f of changedFields) {
      if (norm(f, l[f]) === norm(f, bk[f])) (changes as Record<string, unknown>)[f] = nk[f];
      else skipped.push(f);
    }
    if (Object.keys(changes).length || skipped.length) out.update.push({ task: l, changes, skipped });
  }
  return out;
}

export function diffIsEmpty(d: TemplateUpdateDiff): boolean {
  return d.add.length + d.remove.length + d.update.filter((u) => Object.keys(u.changes).length).length === 0;
}

/* ------------------------------------------------------------------ */
/* Save a live project as a template                                   */
/* ------------------------------------------------------------------ */

export interface ProjectSnapshotTask {
  id: string;
  templateKey: string | null;
  phaseKey: string;
  title: string;
  description: string | null;
  role: string;
  dueOn: string | null;
  due: DueRule | null;
  requiresApproval: boolean;
  approverRole: string | null;
  dependsOnIds: string[];
  subItems: string[];
  requiredAttachment: string | null;
  recurrence: Recurrence | null;
  toggleSource: string[];
  killScreen?: boolean;
  milestone?: boolean;
  /** From the source template, when known. */
  hideIf?: string[];
}

/** Keys that are safe, readable and unique. */
export function slugKey(text: string, taken: Set<string>): string {
  const base =
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 48) || "task";
  let k = base;
  for (let n = 2; taken.has(k); n++) k = `${base}_${n}`;
  taken.add(k);
  return k;
}

export function projectToTemplate(
  input: {
    name: string;
    projectType: ProjectTypeKey;
    description?: string | null;
    phases: { key: string; name: string; status: string; startedOn: string | null; showIf?: string[]; hideIf?: string[] }[];
    tasks: ProjectSnapshotTask[];
  },
): TemplateDef {
  // Phases skipped by hand are left out; phases set aside by a condition keep their condition.
  const phases = input.phases
    .filter((p) => p.status !== "skipped" || p.showIf?.length || p.hideIf?.length)
    .map((p) => ({ key: p.key, name: p.name, ...(p.showIf?.length ? { showIf: p.showIf } : {}), ...(p.hideIf?.length ? { hideIf: p.hideIf } : {}) }));
  const phaseKeys = new Set(phases.map((p) => p.key));
  const keptIds = new Set(input.tasks.filter((t) => phaseKeys.has(t.phaseKey)).map((t) => t.id));
  const starts = new Map(input.phases.map((p) => [p.key, p.startedOn]));
  const taken = new Set<string>();
  const keyOf = new Map<string, string>();
  for (const t of input.tasks) keyOf.set(t.id, t.templateKey && !taken.has(t.templateKey) ? (taken.add(t.templateKey), t.templateKey) : slugKey(t.title, taken));
  const tasks: TemplateTaskDef[] = input.tasks
    .filter((t) => phaseKeys.has(t.phaseKey))
    .map((t) => {
      // Keep the rule a task came with; for hand-made tasks, derive "days after phase start" from the dates.
      const start = starts.get(t.phaseKey);
      const due: DueRule = t.due ?? { days: t.dueOn && start ? Math.max(0, daysBetween(start, t.dueOn)) : 14, unit: "calendar", from: "phase_start" };
      const anchorTask = typeof due.from === "object" ? input.tasks.find((x) => x.templateKey === (due.from as { task: string }).task) : null;
      const anchor = anchorTask && keptIds.has(anchorTask.id) ? anchorTask : null;
      return {
        key: keyOf.get(t.id)!,
        phaseKey: t.phaseKey,
        title: t.title,
        description: t.description,
        role: t.role,
        due: typeof due.from === "object" ? (anchor ? { ...due, from: { task: keyOf.get(anchor.id)! } } : { ...due, from: "phase_start" }) : due,
        requiresApproval: t.requiresApproval,
        approverRole: t.approverRole,
        // Prerequisites that aren't in the new template are dropped.
        dependsOn: t.dependsOnIds.filter((id) => keptIds.has(id)).map((id) => keyOf.get(id)).filter((k): k is string => !!k),
        subItems: t.subItems,
        requiredAttachment: t.requiredAttachment,
        recurrence: t.recurrence,
        killScreen: !!t.killScreen,
        milestone: !!t.milestone,
        showIf: t.toggleSource.length ? t.toggleSource : undefined,
        hideIf: t.hideIf?.length ? t.hideIf : undefined,
      };
    });
  return { name: input.name, projectType: input.projectType, description: input.description ?? null, phases, tasks };
}

/**
 * When saving a project as a template, keep what the source template had for
 * conditions this project doesn't have on: its conditional phases and tasks.
 * References to anything not in the result are dropped.
 */
export function mergeConditionalParts(saved: TemplateDef, source: TemplateDef | null): TemplateDef {
  if (!source) return saved;
  const phases = [...saved.phases];
  for (const [i, sp] of source.phases.entries()) {
    if (phases.some((p) => p.key === sp.key) || !(sp.showIf?.length || sp.hideIf?.length)) continue;
    // Insert after the nearest earlier source phase that's present.
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const idx = phases.findIndex((p) => p.key === source.phases[j]!.key);
      if (idx !== -1) {
        at = idx + 1;
        break;
      }
    }
    phases.splice(at, 0, { ...sp });
  }
  const phaseKeys = new Set(phases.map((p) => p.key));
  const taken = new Set(saved.tasks.map((k) => k.key));
  const conditionalPhase = new Set(source.phases.filter((p) => p.showIf?.length || p.hideIf?.length).map((p) => p.key));
  const extra = source.tasks.filter((k) => !taken.has(k.key) && phaseKeys.has(k.phaseKey) && (k.showIf?.length || k.hideIf?.length || conditionalPhase.has(k.phaseKey)));
  const tasks = [...saved.tasks, ...extra.map((k) => ({ ...k }))];
  const keys = new Set(tasks.map((k) => k.key));
  return {
    ...saved,
    phases,
    tasks: tasks.map((k) => ({
      ...k,
      dependsOn: (k.dependsOn ?? []).filter((d) => keys.has(d)),
      due: typeof k.due.from === "object" && !keys.has(k.due.from.task) ? { ...k.due, from: "phase_start" as const } : k.due,
    })),
  };
}
