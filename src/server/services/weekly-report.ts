import "server-only";
import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, ne, notInArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { keyDateLabel } from "@/core/key-dates";
import { currentPhase, daysInPhase, projectProgressBps, type PhaseState } from "@/core/phases";
import { slippageLabel } from "@/core/schedule";
import { TASK_STATUS_LABEL, type TaskStatus } from "@/core/tasks";
import { addDays, dayOfWeek, hourET, startOfDayET, todayET, type IsoDate } from "@/core/time";
import { db, schema, type DbOrTx } from "../db";
import { env } from "../env";
import { renderEmail, sendEmail } from "./email";
import { projectMoney } from "./financials";
import { slippageFor } from "./field";
import { notify } from "./tasks";
import { settingsFor } from "./push";
import { channelOn } from "@/core/notify";

/** How many items each list keeps (the counts are always the full numbers). */
const LIST = 8;

export interface ReportTask {
  id: string;
  title: string;
  who: string | null;
  date: string | null;
  note?: string | null;
}

export interface ReportProject {
  id: string;
  name: string;
  address: string;
  bbl: string | null;
  company: string;
  status: string;
  phase: string | null;
  phasesDone: number;
  phasesTotal: number;
  daysInPhase: number | null;
  progressBps: number;
  /** Days behind (positive) or ahead (negative) of the locked baseline. */
  slippage: number | null;
  slippageLabel: string | null;
  moved: {
    completed: ReportTask[];
    completedCount: number;
    phases: { name: string; change: "started" | "finished"; on: string }[];
  };
  stuck: {
    blocked: ReportTask[];
    blockedCount: number;
    overdue: ReportTask[];
    overdueCount: number;
    awaitingApproval: ReportTask[];
    awaitingApprovalCount: number;
    openViolations: number;
    ordersInForce: number;
  };
  next: {
    tasks: ReportTask[];
    tasksCount: number;
    keyDates: { label: string; date: string }[];
  };
  money: {
    purchasePrice: number | null;
    totalBudget: number | null;
    spentToDate: number;
    committed: number;
    forecastAtCompletion: number | null;
    projectedSellout: number | null;
    profit: number | null;
    marginBps: number | null;
  } | null;
}

export interface WeeklyReportData {
  weekOf: IsoDate;
  /** The seven days it looks back over: from (inclusive) to weekOf (exclusive). */
  from: IsoDate;
  /** The two weeks it looks ahead over: weekOf to until (inclusive). */
  until: IsoDate;
  generatedAt: string;
  totals: { projects: number; completed: number; blocked: number; overdue: number; awaitingApproval: number; behind: number };
  projects: ReportProject[];
}

/** The Monday on or before a date (New York). */
export function mondayOf(date: IsoDate): IsoDate {
  const dow = dayOfWeek(date);
  return addDays(date, dow === 0 ? -6 : 1 - dow);
}

/**
 * Build the report as things stand now, for the week ending the Monday
 * `weekOf`: what moved in the seven days before it, what's stuck today, and
 * what's due in the two weeks after. Active (non-archived) projects only.
 */
export async function buildWeeklyReport(conn: DbOrTx, weekOf: IsoDate, now = new Date()): Promise<WeeklyReportData> {
  const today = todayET(now);
  const from = addDays(weekOf, -7);
  const until = addDays(weekOf, 13);
  const fromTs = startOfDayET(from);
  const toTs = startOfDayET(weekOf);

  const projects = await conn
    .select({ id: schema.project.id, name: schema.project.name, address: schema.project.address, bbl: schema.project.bbl, status: schema.project.status, company: schema.company.name })
    .from(schema.project)
    .innerJoin(schema.company, eq(schema.company.id, schema.project.companyId))
    .where(isNull(schema.project.archivedAt))
    .orderBy(asc(schema.project.name));
  const ids = projects.map((p) => p.id);
  const empty: WeeklyReportData = { weekOf, from, until, generatedAt: now.toISOString(), totals: { projects: 0, completed: 0, blocked: 0, overdue: 0, awaitingApproval: 0, behind: 0 }, projects: [] };
  if (ids.length === 0) return empty;

  const assignee = alias(schema.user, "assignee");
  const taskCols = {
    id: schema.task.id,
    projectId: schema.task.projectId,
    phaseKey: schema.task.phaseKey,
    title: schema.task.title,
    status: schema.task.status,
    dueOn: schema.task.dueOn,
    blockedReason: schema.task.blockedReason,
    completedAt: schema.task.completedAt,
    approvalRequestedAt: schema.task.approvalRequestedAt,
    who: assignee.name,
  };
  const [phaseRows, counts, completed, open, keyDates, money, slip, violations, orders] = await Promise.all([
    conn.select().from(schema.projectPhase).where(inArray(schema.projectPhase.projectId, ids)).orderBy(asc(schema.projectPhase.projectId), asc(schema.projectPhase.sortOrder)),
    conn
      .select({ projectId: schema.task.projectId, phaseKey: schema.task.phaseKey, total: sql<number>`count(*)::int`, done: sql<number>`(count(*) filter (where ${schema.task.status} = 'done'))::int` })
      .from(schema.task)
      .where(inArray(schema.task.projectId, ids))
      .groupBy(schema.task.projectId, schema.task.phaseKey),
    conn
      .select(taskCols)
      .from(schema.task)
      .leftJoin(assignee, eq(assignee.id, schema.task.assigneeId))
      .where(and(inArray(schema.task.projectId, ids), eq(schema.task.status, "done"), gte(schema.task.completedAt, fromTs), lt(schema.task.completedAt, toTs)))
      .orderBy(desc(schema.task.completedAt)),
    conn
      .select(taskCols)
      .from(schema.task)
      .leftJoin(assignee, eq(assignee.id, schema.task.assigneeId))
      .where(and(inArray(schema.task.projectId, ids), ne(schema.task.status, "done")))
      .orderBy(asc(schema.task.dueOn), asc(schema.task.title)),
    conn
      .select({ projectId: schema.keyDate.projectId, kind: schema.keyDate.kind, label: schema.keyDate.label, date: schema.keyDate.date })
      .from(schema.keyDate)
      .where(and(inArray(schema.keyDate.projectId, ids), eq(schema.keyDate.done, false), gte(schema.keyDate.date, today), lte(schema.keyDate.date, until)))
      .orderBy(asc(schema.keyDate.date)),
    projectMoney(conn, ids),
    slippageFor(conn, ids, today),
    conn
      .select({ projectId: schema.violationCase.projectId, n: sql<number>`count(*)::int` })
      .from(schema.violationCase)
      .where(and(inArray(schema.violationCase.projectId, ids), notInArray(schema.violationCase.stage, ["dismissed", "paid", "resolved"])))
      .groupBy(schema.violationCase.projectId),
    conn
      .select({ projectId: schema.recordItem.projectId, n: sql<number>`count(*)::int` })
      .from(schema.recordItem)
      .where(and(inArray(schema.recordItem.projectId, ids), eq(schema.recordItem.critical, true)))
      .groupBy(schema.recordItem.projectId),
  ]);

  const item = (t: (typeof open)[number], date: string | null, note?: string | null): ReportTask => ({ id: t.id, title: t.title, who: t.who, date, ...(note !== undefined ? { note } : {}) });
  const out: ReportProject[] = projects.map((p) => {
    const phases: PhaseState[] = phaseRows
      .filter((r) => r.projectId === p.id)
      .map((r) => ({ key: r.key, name: r.name, sortOrder: r.sortOrder, status: r.status, startedOn: r.startedOn, completedOn: r.completedOn }));
    const c: Record<string, { total: number; done: number }> = {};
    for (const r of counts) if (r.projectId === p.id) c[r.phaseKey] = { total: r.total, done: r.done };
    const cur = currentPhase(phases);
    const counted = phases.filter((x) => x.status !== "skipped");
    const inWeek = (d: string | null): d is string => !!d && d >= from && d < weekOf;
    const done = completed.filter((t) => t.projectId === p.id);
    const mine = open.filter((t) => t.projectId === p.id);
    const blocked = mine.filter((t) => t.status === "blocked");
    const overdue = mine.filter((t) => t.dueOn && t.dueOn < today);
    const waiting = mine.filter((t) => t.status === "awaiting_approval");
    const upcoming = mine.filter((t) => t.dueOn && t.dueOn >= today && t.dueOn <= until);
    const m = money.get(p.id);
    const slippage = slip.get(p.id) ?? null;
    return {
      id: p.id,
      name: p.name,
      address: p.address,
      bbl: p.bbl,
      company: p.company,
      status: p.status,
      phase: cur?.name ?? null,
      phasesDone: counted.filter((x) => x.status === "done").length,
      phasesTotal: counted.length,
      daysInPhase: daysInPhase(phases, today),
      progressBps: projectProgressBps(phases, c),
      slippage,
      slippageLabel: slippageLabel(slippage),
      moved: {
        completed: done.slice(0, LIST).map((t) => item(t, t.completedAt ? todayET(t.completedAt) : null)),
        completedCount: done.length,
        phases: [
          ...phases.filter((x) => inWeek(x.startedOn)).map((x) => ({ name: x.name, change: "started" as const, on: x.startedOn! })),
          ...phases.filter((x) => inWeek(x.completedOn)).map((x) => ({ name: x.name, change: "finished" as const, on: x.completedOn! })),
        ].sort((a, b) => a.on.localeCompare(b.on)),
      },
      stuck: {
        blocked: blocked.slice(0, LIST).map((t) => item(t, t.dueOn, t.blockedReason)),
        blockedCount: blocked.length,
        overdue: overdue.slice(0, LIST).map((t) => item(t, t.dueOn, TASK_STATUS_LABEL[t.status as TaskStatus])),
        overdueCount: overdue.length,
        awaitingApproval: waiting.slice(0, LIST).map((t) => item(t, t.approvalRequestedAt ? todayET(t.approvalRequestedAt) : null)),
        awaitingApprovalCount: waiting.length,
        openViolations: violations.find((v) => v.projectId === p.id)?.n ?? 0,
        ordersInForce: orders.find((o) => o.projectId === p.id)?.n ?? 0,
      },
      next: {
        tasks: upcoming.slice(0, LIST).map((t) => item(t, t.dueOn)),
        tasksCount: upcoming.length,
        keyDates: keyDates.filter((k) => k.projectId === p.id).map((k) => ({ label: keyDateLabel(k.kind, k.label), date: k.date })),
      },
      money:
        m && !m.broken
          ? {
              purchasePrice: m.headline.purchasePrice,
              totalBudget: m.headline.totalBudget,
              spentToDate: m.headline.spentToDate,
              committed: m.headline.committed,
              forecastAtCompletion: m.headline.forecastAtCompletion,
              projectedSellout: m.headline.projectedSellout,
              profit: m.headline.profit,
              marginBps: m.headline.marginBps,
            }
          : null,
    };
  });

  return {
    ...empty,
    totals: {
      projects: out.length,
      completed: out.reduce((n, p) => n + p.moved.completedCount, 0),
      blocked: out.reduce((n, p) => n + p.stuck.blockedCount, 0),
      overdue: out.reduce((n, p) => n + p.stuck.overdueCount, 0),
      awaitingApproval: out.reduce((n, p) => n + p.stuck.awaitingApprovalCount, 0),
      behind: out.filter((p) => (p.slippage ?? 0) > 0).length,
    },
    projects: out,
  };
}

/** Build and keep this week's report (replacing an earlier build of the same week). */
export async function saveWeeklyReport(conn: DbOrTx, weekOf: IsoDate, now = new Date()): Promise<WeeklyReportData> {
  const data = await buildWeeklyReport(conn, weekOf, now);
  await conn
    .insert(schema.weeklyReport)
    .values({ weekOf, data, generatedAt: now })
    .onConflictDoUpdate({ target: schema.weeklyReport.weekOf, set: { data, generatedAt: now } });
  return data;
}

/**
 * Monday from 7am New York: build the week's report once, then tell the
 * owners (push and in-app, and email when they want it; the email goes out
 * once a sender is set up). A Monday missed entirely (no runs that day) is
 * built on the next run that week. Telling the owners is recorded separately,
 * so a failure there is retried rather than lost. No figures in the text
 * (brief §9).
 */
export async function weeklyReportJob(now = new Date()): Promise<Record<string, unknown>> {
  const today = todayET(now);
  const monday = mondayOf(today);
  if (today === monday && hourET(now) < 7) return { skipped: "not Monday 7am yet" };
  const conn = db();
  const [had] = await conn.select({ id: schema.weeklyReport.id, notifiedAt: schema.weeklyReport.notifiedAt, data: schema.weeklyReport.data }).from(schema.weeklyReport).where(eq(schema.weeklyReport.weekOf, monday));
  if (had?.notifiedAt) return { skipped: "already built" };
  const data = had ? (had.data as WeeklyReportData) : await saveWeeklyReport(conn, monday, now);
  const owners = await conn.select({ id: schema.user.id, email: schema.user.email, name: schema.user.name }).from(schema.user).where(and(eq(schema.user.role, "owner"), eq(schema.user.status, "active")));
  const prefs = await settingsFor(conn, owners.map((o) => o.id));
  const href = `/reports?week=${monday}`;
  const summary = `${data.totals.projects} project${data.totals.projects === 1 ? "" : "s"}: ${data.totals.completed} task${data.totals.completed === 1 ? "" : "s"} done last week, ${data.totals.blocked} blocked, ${data.totals.overdue} overdue.`;
  await notify(conn, null, owners.map((o) => ({ userId: o.id, kind: "report" as const, title: "Your weekly report is ready", body: summary, href })));
  let emailed = 0;
  for (const o of owners) {
    if (!channelOn(prefs.get(o.id)?.prefs, "report", "email")) continue;
    const content = renderEmail({ preheader: summary, heading: "Your weekly report", paragraphs: [`Hello ${o.name},`, summary], cta: { label: "Open the report", url: `${env().APP_URL}${href}` }, footnote: "The PDF is on the report page." });
    if ((await sendEmail({ to: o.email, subject: "Weekly report: Project Command", ...content, category: "report", urgent: false })) === "sent") emailed++;
  }
  await conn.update(schema.weeklyReport).set({ notifiedAt: new Date() }).where(eq(schema.weeklyReport.weekOf, monday));
  return { weekOf: monday, projects: data.totals.projects, owners: owners.length, emailed };
}
