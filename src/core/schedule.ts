/**
 * Schedule, baseline and slippage (Module E). Pure.
 *
 * A task's plan is its start (or, without one, its finish) to its finish
 * (the due date). The critical path is the chain of dependent tasks with no
 * slack; the forecast pushes open work that hasn't started to today and
 * carries the delay down the dependencies, which is what "days behind"
 * measures against the locked baseline.
 */
import { addDays, daysBetween } from "./time";

export interface ScheduleTask {
  id: string;
  /** Planned start; null means a one-day task (or milestone) on its finish date. */
  startOn: string | null;
  /** Planned finish (the due date). */
  dueOn: string | null;
  startedOn: string | null;
  completedOn: string | null;
  done: boolean;
  deps: string[];
}

export interface Span {
  start: string;
  finish: string;
}

/** The planned span, or null for undated tasks. */
export function plannedSpan(t: Pick<ScheduleTask, "startOn" | "dueOn">): Span | null {
  if (!t.dueOn) return null;
  const start = t.startOn && t.startOn <= t.dueOn ? t.startOn : t.dueOn;
  return { start, finish: t.dueOn };
}

const EPOCH = "2000-01-01";
const n = (d: string) => daysBetween(EPOCH, d);
const d = (x: number) => addDays(EPOCH, x);

/** Dependencies in an order where every task comes after the tasks it waits on (cycles are broken, never looped). */
function ordered(tasks: ScheduleTask[]): ScheduleTask[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const out: ScheduleTask[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (t: ScheduleTask) => {
    if (state.get(t.id) === "done" || state.get(t.id) === "visiting") return;
    state.set(t.id, "visiting");
    for (const dep of t.deps) {
      const p = byId.get(dep);
      if (p) visit(p);
    }
    state.set(t.id, "done");
    out.push(t);
  };
  for (const t of tasks) visit(t);
  return out;
}

export interface CriticalPath {
  /** Tasks with zero slack on the planned schedule. */
  critical: Set<string>;
  /** Slack in days per dated task. */
  slack: Map<string, number>;
  finish: string | null;
}

/** Classic forward / backward pass over the planned dates. Undated tasks pass their predecessors' finish through. */
export function criticalPath(tasks: ScheduleTask[]): CriticalPath {
  const seq = ordered(tasks);
  const es = new Map<string, number>();
  const ef = new Map<string, number>();
  const dur = new Map<string, number>();
  for (const t of seq) {
    const span = plannedSpan(t);
    const depFinish = Math.max(-Infinity, ...t.deps.map((x) => ef.get(x) ?? -Infinity));
    if (!span) {
      if (Number.isFinite(depFinish)) {
        es.set(t.id, depFinish);
        ef.set(t.id, depFinish);
        dur.set(t.id, 0);
      }
      continue;
    }
    const length = n(span.finish) - n(span.start) + 1;
    const start = Math.max(n(span.start), Number.isFinite(depFinish) ? depFinish + 1 : -Infinity);
    es.set(t.id, start);
    ef.set(t.id, start + length - 1);
    dur.set(t.id, length);
  }
  if (ef.size === 0) return { critical: new Set(), slack: new Map(), finish: null };
  const end = Math.max(...ef.values());
  const successors = new Map<string, string[]>();
  for (const t of tasks) for (const dep of t.deps) successors.set(dep, [...(successors.get(dep) ?? []), t.id]);
  const lf = new Map<string, number>();
  const ls = new Map<string, number>();
  for (const t of [...seq].reverse()) {
    if (!ef.has(t.id)) continue;
    const next = (successors.get(t.id) ?? []).filter((s) => ls.has(s));
    const finish = next.length ? Math.min(...next.map((s) => ls.get(s)! - (dur.get(s)! === 0 ? 0 : 1))) : end;
    lf.set(t.id, finish);
    ls.set(t.id, finish - Math.max(dur.get(t.id)! - 1, 0));
  }
  const slack = new Map<string, number>();
  const critical = new Set<string>();
  for (const [id, start] of es) {
    if (!plannedSpan(tasks.find((t) => t.id === id)!)) continue;
    const s = ls.get(id)! - start;
    slack.set(id, s);
    if (s <= 0) critical.add(id);
  }
  return { critical, slack, finish: d(end) };
}

/**
 * Forecast finish: done tasks sit where they finished; open tasks that
 * should have started keep their length but can't start before today (or
 * their actual start), and every delay flows down the dependencies.
 */
export function forecast(tasks: ScheduleTask[], today: string): { finish: string | null; byTask: Map<string, Span> } {
  const seq = ordered(tasks);
  const ef = new Map<string, number>();
  const byTask = new Map<string, Span>();
  const t0 = n(today);
  for (const t of seq) {
    const span = plannedSpan(t);
    const depFinish = Math.max(-Infinity, ...t.deps.map((x) => ef.get(x) ?? -Infinity));
    if (t.done) {
      const fin = t.completedOn ?? span?.finish;
      if (fin) {
        const st = t.startedOn ?? span?.start ?? fin;
        ef.set(t.id, n(fin));
        byTask.set(t.id, { start: st <= fin ? st : fin, finish: fin });
      }
      continue;
    }
    if (!span) {
      if (Number.isFinite(depFinish)) ef.set(t.id, depFinish);
      continue;
    }
    const length = n(span.finish) - n(span.start) + 1;
    let start = Math.max(n(span.start), Number.isFinite(depFinish) ? depFinish + 1 : -Infinity);
    if (t.startedOn) start = n(t.startedOn);
    else start = Math.max(start, t0);
    let finish = start + length - 1;
    // Started and overdue: it finishes today at the earliest.
    finish = Math.max(finish, t0);
    ef.set(t.id, finish);
    byTask.set(t.id, { start: d(start), finish: d(finish) });
  }
  return { finish: ef.size ? d(Math.max(...ef.values())) : null, byTask };
}

/** Positive: days behind the baseline finish; negative: ahead; null without a baseline or dates. */
export function slippageDays(baselineFinish: string | null, forecastFinish: string | null): number | null {
  if (!baselineFinish || !forecastFinish) return null;
  return daysBetween(baselineFinish, forecastFinish);
}

export function slippageLabel(days: number | null): string | null {
  if (days === null) return null;
  if (days === 0) return "On baseline";
  return days > 0 ? `${days} day${days === 1 ? "" : "s"} behind` : `${-days} day${days === -1 ? "" : "s"} ahead`;
}

/** The planned dates to lock as a baseline. */
export function baselineItems(tasks: ScheduleTask[]): { items: { taskId: string; start: string | null; finish: string | null }[]; finish: string | null } {
  const items = tasks.filter((t) => t.dueOn).map((t) => ({ taskId: t.id, start: plannedSpan(t)!.start, finish: t.dueOn }));
  return { items, finish: criticalPath(tasks).finish };
}
