import "server-only";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { mean, median, perSf, phaseDurations, suggestDurations, type DurationSample } from "@/core/analytics";
import { BUDGET_CATEGORIES } from "@/core/financials";
import type { DueRule, TemplateDef } from "@/core/templates";
import { daysBetween, todayET } from "@/core/time";
import { schema, type DbOrTx } from "../db";
import { projectMoney } from "./financials";

const days = (a: Date, b: Date) => (b.getTime() - a.getTime()) / 86_400_000;
const round1 = (x: number | null) => (x === null ? null : Math.round(x * 10) / 10);

/** Module M: the owner's analytics across every project (archived ones included, for history). */
export async function portfolioAnalytics(conn: DbOrTx, today = todayET()) {
  const projects = await conn.select({ id: schema.project.id, name: schema.project.name, type: schema.project.type, grossSf: schema.project.grossSf, sellableSf: schema.project.sellableSf, archivedAt: schema.project.archivedAt, templateId: schema.project.templateId }).from(schema.project);
  const ids = projects.map((p) => p.id);
  const typeOf = new Map(projects.map((p) => [p.id, p.type]));

  // Actual days per phase, by project type.
  const phases = await conn.select().from(schema.projectPhase).where(and(isNotNull(schema.projectPhase.startedOn), isNotNull(schema.projectPhase.completedOn)));
  const durations = phaseDurations(phases.filter((p) => typeOf.has(p.projectId)).map((p) => ({ type: typeOf.get(p.projectId)!, phaseKey: p.key, phaseName: p.name, startedOn: p.startedOn!, completedOn: p.completedOn! })));

  // Cost per gross and sellable square foot, per project, and the median by type as the benchmark.
  const money = await projectMoney(conn, ids);
  const costs = projects
    .map((p) => {
      const m = money.get(p.id);
      if (!m?.budget || m.broken) return null;
      const hard = m.totals.filter((t) => t.category === "hard");
      const hardForecast = hard.reduce((a, t) => a + t.forecast, 0);
      const hardInvoiced = hard.reduce((a, t) => a + t.invoiced, 0);
      return {
        projectId: p.id,
        name: p.name,
        type: p.type,
        grossSf: p.grossSf,
        sellableSf: p.sellableSf,
        hardPerGsf: { forecast: perSf(hardForecast, p.grossSf), actual: perSf(hardInvoiced, p.grossSf) },
        totalPerGsf: { forecast: perSf(m.budget.forecast, p.grossSf), actual: perSf(m.budget.invoiced, p.grossSf) },
        hardPerSsf: { forecast: perSf(hardForecast, p.sellableSf), actual: perSf(hardInvoiced, p.sellableSf) },
        totalPerSsf: { forecast: perSf(m.budget.forecast, p.sellableSf), actual: perSf(m.budget.invoiced, p.sellableSf) },
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  const types = [...new Set(costs.map((c) => c.type))];
  const benchmarks = types.map((type) => {
    const mine = costs.filter((c) => c.type === type);
    const med = (f: (c: (typeof costs)[number]) => number | null) => {
      const v = median(mine.map(f).filter((x): x is number => x !== null));
      return v === null ? null : Math.round(v);
    };
    return { type, projects: mine.length, hardPerGsf: med((c) => c.hardPerGsf.forecast), totalPerGsf: med((c) => c.totalPerGsf.forecast), hardPerSsf: med((c) => c.hardPerSsf.forecast), totalPerSsf: med((c) => c.totalPerSsf.forecast) };
  });

  // Budget variance by category, across every project with a budget.
  const variance = BUDGET_CATEGORIES.map((c) => {
    let original = 0;
    let revised = 0;
    let forecast = 0;
    for (const m of money.values()) {
      if (m.broken) continue;
      for (const t of m.totals.filter((x) => x.category === c.key)) {
        original += t.original;
        revised += t.revised;
        forecast += t.forecast;
      }
    }
    return { category: c.key, label: c.label, original, revised, forecast, overBy: forecast - revised, pct: revised > 0 ? Math.round(((forecast - revised) / revised) * 1000) / 10 : null };
  }).filter((v) => v.original || v.revised || v.forecast);

  // Where tasks stall: lateness of finished work and what's stuck now, by phase and by person.
  const tasks = await conn
    .select({ phaseKey: schema.task.phaseKey, status: schema.task.status, dueOn: schema.task.dueOn, completedOn: schema.task.completedOn, waitingSince: schema.task.waitingSince, assigneeId: schema.task.assigneeId, assigneeName: schema.user.name, projectId: schema.task.projectId })
    .from(schema.task)
    .leftJoin(schema.user, eq(schema.user.id, schema.task.assigneeId));
  const phaseName = new Map(phases.map((p) => [p.key, p.name]));
  for (const p of await conn.select({ key: schema.projectPhase.key, name: schema.projectPhase.name }).from(schema.projectPhase)) if (!phaseName.has(p.key)) phaseName.set(p.key, p.name);
  const stall = <K extends string>(keyOf: (t: (typeof tasks)[number]) => K | null, label: (k: K) => string) => {
    const g = new Map<K, { late: number[]; done: number; overdue: number; stuck: number[] }>();
    for (const t of tasks) {
      const k = keyOf(t);
      if (k === null) continue;
      const e = g.get(k) ?? { late: [], done: 0, overdue: 0, stuck: [] };
      if (t.status === "done" && t.dueOn && t.completedOn) {
        e.done++;
        e.late.push(Math.max(0, daysBetween(t.dueOn, t.completedOn)));
      } else if (t.status !== "done") {
        if (t.dueOn && t.dueOn < today) e.overdue++;
        if ((t.status === "waiting" || t.status === "blocked") && t.waitingSince) e.stuck.push(daysBetween(t.waitingSince, today));
      }
      g.set(k, e);
    }
    return [...g]
      .map(([k, e]) => ({ key: k, label: label(k), finished: e.done, lateShare: e.done ? Math.round((e.late.filter((x) => x > 0).length / e.done) * 100) : null, avgDaysLate: round1(mean(e.late)), overdueNow: e.overdue, stuckNow: e.stuck.length, avgDaysStuck: round1(mean(e.stuck)) }))
      .filter((r) => r.finished || r.overdueNow || r.stuckNow)
      .sort((a, b) => b.overdueNow + b.stuckNow - (a.overdueNow + a.stuckNow) || (b.avgDaysLate ?? 0) - (a.avgDaysLate ?? 0));
  };
  const names = new Map(tasks.filter((t) => t.assigneeId).map((t) => [t.assigneeId!, t.assigneeName ?? "Someone"]));
  const byPhase = stall((t) => t.phaseKey, (k) => phaseName.get(k) ?? k);
  const byPerson = stall((t) => t.assigneeId, (k) => names.get(k) ?? "Someone");

  // Turnaround: RFIs answered, invoices approved.
  const rfis = await conn.select({ createdAt: schema.rfi.createdAt, answeredAt: schema.rfi.answeredAt }).from(schema.rfi).where(isNotNull(schema.rfi.answeredAt));
  const rfiDays = rfis.map((r) => days(r.createdAt, r.answeredAt!));
  const invoices = await conn.select({ createdAt: schema.invoice.createdAt, decidedAt: schema.invoice.decidedAt }).from(schema.invoice).where(and(isNotNull(schema.invoice.decidedAt), sql`${schema.invoice.status} in ('approved', 'paid')`));
  const invDays = invoices.map((i) => days(i.createdAt, i.decidedAt!));

  return {
    durations,
    costs,
    benchmarks,
    variance,
    stalls: { byPhase, byPerson },
    turnaround: {
      rfi: { answered: rfiDays.length, avgDays: round1(mean(rfiDays)), medianDays: round1(median(rfiDays)) },
      invoice: { approved: invDays.length, avgDays: round1(mean(invDays)), medianDays: round1(median(invDays)) },
    },
  };
}

/**
 * Suggested template durations from what tasks actually took: per template,
 * tasks that count from their phase's start, done on at least three
 * projects built from that template.
 */
export async function durationSuggestions(conn: DbOrTx) {
  const templates = await conn.select().from(schema.template).where(sql`${schema.template.archivedAt} is null`);
  const rows = await conn
    .select({ templateId: schema.project.templateId, templateKey: schema.task.templateKey, title: schema.task.title, phaseKey: schema.task.phaseKey, dueRule: schema.task.dueRule, completedOn: schema.task.completedOn, phaseStartedOn: schema.projectPhase.startedOn })
    .from(schema.task)
    .innerJoin(schema.project, eq(schema.project.id, schema.task.projectId))
    .innerJoin(schema.projectPhase, and(eq(schema.projectPhase.projectId, schema.task.projectId), eq(schema.projectPhase.key, schema.task.phaseKey)))
    .where(and(eq(schema.task.status, "done"), isNotNull(schema.task.templateKey), isNotNull(schema.task.completedOn), isNotNull(schema.projectPhase.startedOn), isNotNull(schema.project.templateId)));
  return templates
    .map((t) => {
      const def = t.definition as TemplateDef;
      const rules = new Map(def.tasks.filter((k) => k.due && k.due.from === "phase_start").map((k) => [k.key, k]));
      const samples: DurationSample[] = rows
        .filter((r) => r.templateId === t.id && r.templateKey && rules.has(r.templateKey))
        .map((r) => {
          const k = rules.get(r.templateKey!)!;
          const due = k.due as DueRule;
          return { templateKey: k.key, title: k.title, phaseKey: k.phaseKey, unit: due.unit ?? "business", currentDays: due.days, phaseStartedOn: r.phaseStartedOn!, completedOn: r.completedOn! };
        });
      return { templateId: t.id, name: t.name, version: t.version, projectType: t.projectType, suggestions: suggestDurations(samples) };
    })
    .filter((t) => t.suggestions.length > 0);
}
