import "server-only";
import { and, asc, eq, inArray, isNull, ne, notInArray, sql } from "drizzle-orm";
import { OUTSIDE_ROLES } from "@/core/permissions";
import { isActiveSiteDay, parseOpenMeteo } from "@/core/field";
import { projectDueDates, type DueRule } from "@/core/templates";
import { baselineItems, forecast, slippageDays, type ScheduleTask } from "@/core/schedule";
import { todayET } from "@/core/time";
import { db, schema, type DbOrTx } from "../db";
import type { SiteWeather } from "../db/schema/app";
import { logError } from "./errors";
import { activeOwners, notify } from "./tasks";

/* ------------------------------------------------------------------ */
/* Weather (Module D): Open-Meteo, free and keyless                    */
/* ------------------------------------------------------------------ */

export type WeatherFetcher = (lat: number, lon: number, date: string) => Promise<SiteWeather | null>;

const openMeteo: WeatherFetcher = async (lat, lon, date) => {
  const params = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max",
    temperature_unit: "fahrenheit",
    precipitation_unit: "inch",
    wind_speed_unit: "mph",
    timezone: "America/New_York",
    start_date: date,
    end_date: date,
  });
  try {
    const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const w = parseOpenMeteo(await res.json(), date);
    return w ? { ...w, source: "open-meteo" } : null;
  } catch (err) {
    await logError("request", err, { path: "weather" });
    return null;
  }
};

let weatherOverride: WeatherFetcher | null = null;
export function setWeatherForTests(f: WeatherFetcher | null) {
  weatherOverride = f;
}
export const fetchWeather: WeatherFetcher = (lat, lon, date) => (weatherOverride ?? openMeteo)(lat, lon, date);

/* ------------------------------------------------------------------ */
/* Schedule (Module E)                                                 */
/* ------------------------------------------------------------------ */

export type ScheduleRow = ScheduleTask & { title: string; phaseKey: string; status: string; milestone: boolean; assigneeId: string | null; sortOrder: number; projected: boolean };

/**
 * The project's tasks for the schedule. Tasks in phases that haven't started
 * get their projected dates (flagged `projected`), so the plan, the baseline
 * and the forecast all cover the whole job, not just the phases begun so far.
 */
export async function loadScheduleTasks(conn: DbOrTx, projectId: string, today = todayET()): Promise<ScheduleRow[]> {
  return (await loadScheduleTasksFor(conn, [projectId], today)).get(projectId) ?? [];
}

/** loadScheduleTasks for many projects in three queries (portfolio cards, reports). */
export async function loadScheduleTasksFor(conn: DbOrTx, projectIds: string[], today = todayET()): Promise<Map<string, ScheduleRow[]>> {
  const out = new Map<string, ScheduleRow[]>();
  if (projectIds.length === 0) return out;
  const tasks = await conn
    .select({
      id: schema.task.id,
      projectId: schema.task.projectId,
      title: schema.task.title,
      phaseKey: schema.task.phaseKey,
      status: schema.task.status,
      milestone: schema.task.milestone,
      assigneeId: schema.task.assigneeId,
      sortOrder: schema.task.sortOrder,
      startOn: schema.task.startOn,
      dueOn: schema.task.dueOn,
      startedOn: schema.task.startedOn,
      completedOn: schema.task.completedOn,
      templateKey: schema.task.templateKey,
      dueRule: schema.task.dueRule,
      dueManual: schema.task.dueManual,
    })
    .from(schema.task)
    .where(inArray(schema.task.projectId, projectIds));
  const phases = await conn
    .select({ projectId: schema.projectPhase.projectId, key: schema.projectPhase.key, status: schema.projectPhase.status, startedOn: schema.projectPhase.startedOn })
    .from(schema.projectPhase)
    .where(inArray(schema.projectPhase.projectId, projectIds))
    .orderBy(asc(schema.projectPhase.sortOrder));
  const deps = tasks.length
    ? await conn
        .select({ taskId: schema.taskDependency.taskId, dependsOnId: schema.taskDependency.dependsOnId })
        .from(schema.taskDependency)
        .innerJoin(schema.task, eq(schema.task.id, schema.taskDependency.taskId))
        .where(inArray(schema.task.projectId, projectIds))
    : [];
  const depsOf = new Map<string, string[]>();
  for (const d of deps) depsOf.set(d.taskId, [...(depsOf.get(d.taskId) ?? []), d.dependsOnId]);
  const keyOf = (t: (typeof tasks)[number]) => t.templateKey ?? `id:${t.id}`;
  for (const projectId of projectIds) {
    const mine = tasks.filter((t) => t.projectId === projectId);
    const projected = projectDueDates(
      mine.map((t) => ({ key: keyOf(t), phaseKey: t.phaseKey, due: (t.dueRule as DueRule | null) ?? null, dueOn: t.dueOn, dueManual: t.dueManual, completedOn: t.completedOn })),
      phases.filter((p) => p.projectId === projectId),
      today,
    );
    out.set(
      projectId,
      mine.map((row) => {
        const dueOn = row.dueOn ?? (row.status === "done" ? null : (projected.get(keyOf(row)) ?? null));
        return {
          id: row.id,
          title: row.title,
          phaseKey: row.phaseKey,
          status: row.status,
          milestone: row.milestone,
          assigneeId: row.assigneeId,
          sortOrder: row.sortOrder,
          startOn: row.startOn,
          dueOn,
          startedOn: row.startedOn,
          completedOn: row.completedOn,
          projected: !row.dueOn && !!dueOn,
          done: row.status === "done",
          deps: depsOf.get(row.id) ?? [],
        };
      }),
    );
  }
  return out;
}

export async function currentBaseline(conn: DbOrTx, projectId: string) {
  const [b] = await conn
    .select()
    .from(schema.scheduleBaseline)
    .where(and(eq(schema.scheduleBaseline.projectId, projectId), eq(schema.scheduleBaseline.status, "current")))
    .limit(1);
  return b ?? null;
}

/**
 * Lock a baseline now: the first one, or an approved re-baseline (which
 * turns the request row itself into the current baseline). The previous
 * baseline is kept as history.
 */
/** Serializes everything that locks or requests a baseline for one project (the manual lock, re-baselines, the phase hook). Call inside a transaction. */
export async function lockBaselineMutex(tx: DbOrTx, projectId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`baseline:${projectId}`}))`);
}

export async function lockBaseline(tx: DbOrTx, projectId: string, opts: { requestedById: string | null; approvedById: string | null; reason: string | null; requestId?: string }): Promise<string> {
  await lockBaselineMutex(tx, projectId);
  const tasks = await loadScheduleTasks(tx, projectId);
  const { items, finish: planned } = baselineItems(tasks);
  // The finish we commit to is the forecast at lock time (work already late is already late): later slippage is new delay.
  const finish = forecast(tasks, todayET()).finish ?? planned;
  await tx.update(schema.scheduleBaseline).set({ status: "superseded" }).where(and(eq(schema.scheduleBaseline.projectId, projectId), eq(schema.scheduleBaseline.status, "current")));
  if (opts.requestId) {
    await tx.update(schema.scheduleBaseline).set({ finishOn: finish, items, status: "current", approvedById: opts.approvedById, lockedAt: new Date() }).where(eq(schema.scheduleBaseline.id, opts.requestId));
    return opts.requestId;
  }
  const [row] = await tx
    .insert(schema.scheduleBaseline)
    .values({ projectId, number: await nextBaselineNumber(tx, projectId), finishOn: finish, items, reason: opts.reason, status: "current", requestedById: opts.requestedById, approvedById: opts.approvedById, lockedAt: new Date() })
    .returning({ id: schema.scheduleBaseline.id });
  return row!.id;
}

export async function nextBaselineNumber(tx: DbOrTx, projectId: string): Promise<number> {
  const [max] = await tx.select({ n: sql<number>`coalesce(max(${schema.scheduleBaseline.number}), 0)::int` }).from(schema.scheduleBaseline).where(eq(schema.scheduleBaseline.projectId, projectId));
  return (max?.n ?? 0) + 1;
}

/** Brief Module E: the baseline locks when the project enters Pre-Construction (if none is locked yet). */
export async function lockBaselineOnPreConstruction(tx: DbOrTx, projectId: string, currentPhaseKey: string | null, actorId: string | null): Promise<boolean> {
  if (currentPhaseKey !== "pre_construction") return false;
  await lockBaselineMutex(tx, projectId);
  if (await currentBaseline(tx, projectId)) return false;
  await lockBaseline(tx, projectId, { requestedById: actorId, approvedById: actorId, reason: "Locked at the start of Pre-Construction" });
  return true;
}

/** Days ahead (negative) or behind (positive) the baseline finish, per project, for cards and the weekly report. */
export async function slippageFor(conn: DbOrTx, projectIds: string[], today = todayET()): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (projectIds.length === 0) return out;
  const baselines = await conn.select({ projectId: schema.scheduleBaseline.projectId, finishOn: schema.scheduleBaseline.finishOn }).from(schema.scheduleBaseline).where(and(inArray(schema.scheduleBaseline.projectId, projectIds), eq(schema.scheduleBaseline.status, "current")));
  const all = await loadScheduleTasksFor(conn, baselines.filter((b) => b.finishOn).map((b) => b.projectId), today);
  for (const b of baselines) {
    if (!b.finishOn) continue;
    const f = forecast(all.get(b.projectId) ?? [], today);
    const s = slippageDays(b.finishOn, f.finish);
    if (s !== null) out.set(b.projectId, s);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Daily log nudge (Module D): 5pm on active construction days         */
/* ------------------------------------------------------------------ */

/** Who keeps the log: the project's PM and Construction (super) members; the owner if nobody is. */
async function logKeepers(tx: DbOrTx, projectId: string): Promise<string[]> {
  const rows = await tx
    .select({ userId: schema.projectMember.userId })
    .from(schema.projectMember)
    .innerJoin(schema.user, eq(schema.user.id, schema.projectMember.userId))
    .where(and(eq(schema.projectMember.projectId, projectId), sql`lower(${schema.projectMember.projectRole}) in ('pm', 'construction', 'gc')`, eq(schema.user.status, "active"), notInArray(schema.user.role, [...OUTSIDE_ROLES])));
  return rows.length ? rows.map((r) => r.userId) : (await activeOwners(tx)).slice(0, 1);
}

export async function siteLogNudgeJob(now = new Date()): Promise<{ nudged: number }> {
  const today = todayET(now);
  return db().transaction(async (tx) => {
    const projects = await tx
      .select({ id: schema.project.id, name: schema.project.name, phase: schema.projectPhase.key })
      .from(schema.project)
      .innerJoin(schema.projectPhase, and(eq(schema.projectPhase.projectId, schema.project.id), eq(schema.projectPhase.status, "active")))
      .where(and(isNull(schema.project.archivedAt), eq(schema.project.status, "active")));
    const due = projects.filter((p) => isActiveSiteDay(p.phase, today));
    if (due.length === 0) return { nudged: 0 };
    const logged = new Set(
      (await tx.select({ projectId: schema.siteLog.projectId }).from(schema.siteLog).where(and(inArray(schema.siteLog.projectId, due.map((p) => p.id)), eq(schema.siteLog.date, today)))).map((r) => r.projectId),
    );
    let nudged = 0;
    for (const p of due.filter((x) => !logged.has(x.id))) {
      const people = await logKeepers(tx, p.id);
      nudged += await notify(tx, null, people.map((userId) => ({ userId, kind: "system" as const, title: `Today's site log for ${p.name} isn't in yet`, body: "It takes under two minutes.", projectId: p.id, href: `/projects/${p.id}?tab=field&view=log` })));
    }
    return { nudged };
  });
}
