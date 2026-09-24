import "server-only";
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { isActiveSiteDay, parseOpenMeteo } from "@/core/field";
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

export async function loadScheduleTasks(conn: DbOrTx, projectId: string): Promise<(ScheduleTask & { title: string; phaseKey: string; status: string; milestone: boolean; assigneeId: string | null; sortOrder: number })[]> {
  const tasks = await conn
    .select({
      id: schema.task.id,
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
    })
    .from(schema.task)
    .where(eq(schema.task.projectId, projectId));
  const deps = tasks.length
    ? await conn
        .select({ taskId: schema.taskDependency.taskId, dependsOnId: schema.taskDependency.dependsOnId })
        .from(schema.taskDependency)
        .where(inArray(schema.taskDependency.taskId, tasks.map((t) => t.id)))
    : [];
  return tasks.map((t) => ({ ...t, done: t.status === "done", deps: deps.filter((d) => d.taskId === t.id).map((d) => d.dependsOnId) }));
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
export async function lockBaseline(tx: DbOrTx, projectId: string, opts: { requestedById: string | null; approvedById: string | null; reason: string | null; requestId?: string }): Promise<string> {
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
  if (await currentBaseline(tx, projectId)) return false;
  await lockBaseline(tx, projectId, { requestedById: actorId, approvedById: actorId, reason: "Locked at the start of Pre-Construction" });
  return true;
}

/** Days ahead (negative) or behind (positive) the baseline finish, per project, for cards and the weekly report. */
export async function slippageFor(conn: DbOrTx, projectIds: string[], today = todayET()): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (projectIds.length === 0) return out;
  const baselines = await conn.select({ projectId: schema.scheduleBaseline.projectId, finishOn: schema.scheduleBaseline.finishOn }).from(schema.scheduleBaseline).where(and(inArray(schema.scheduleBaseline.projectId, projectIds), eq(schema.scheduleBaseline.status, "current")));
  for (const b of baselines) {
    if (!b.finishOn) continue;
    const f = forecast(await loadScheduleTasks(conn, b.projectId), today);
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
    .where(and(eq(schema.projectMember.projectId, projectId), sql`lower(${schema.projectMember.projectRole}) in ('pm', 'construction', 'gc')`, eq(schema.user.status, "active"), ne(schema.user.role, "external")));
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
