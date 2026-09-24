import "server-only";
import { and, eq, inArray, isNotNull, isNull, lt, ne, notInArray, or, sql } from "drizzle-orm";
import { OUTSIDE_ROLES } from "@/core/permissions";
import {
  CLOSED_STAGES,
  diffRecords,
  parseAddress,
  parseBbl,
  resolveComplaintOrders,
  SOURCE_BY_KEY,
  sourceStage,
  stageRank,
  summarizeCharges,
  type KnownRecord,
  type RecordItem,
  type SourceContext,
  type SourceDef,
  type SourceQuery,
  type ViolationStage,
} from "@/core/records";
import { hourET, todayET } from "@/core/time";
import { db, schema, type DbOrTx } from "../db";
import { env } from "../env";
import { logError } from "./errors";
import { activeOwners, notify } from "./tasks";

/* ------------------------------------------------------------------ */
/* Socrata client                                                      */
/* ------------------------------------------------------------------ */

export interface DatasetMeta {
  columns: Set<string>;
  rowsUpdatedAt: Date | null;
}

export interface RecordsClient {
  meta(dataset: string, deadline?: number): Promise<DatasetMeta>;
  /** Pages through the result (`$limit` is the page size) up to MAX_ROWS. */
  rows(dataset: string, query: SourceQuery, deadline?: number): Promise<Record<string, unknown>[]>;
}

/** Enough history for any one lot; more is truncated (and says so in the sync health). */
export const MAX_ROWS = 2000;

export class RecordsError extends Error {}

const BASE = "https://data.cityofnewyork.us";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Socrata over HTTPS with the app token: sequential, retried with backoff on
 * 429 / 5xx / network errors (honouring Retry-After), and never past the
 * caller's deadline, so a slow or down service can't overrun the job.
 */
function socrataClient(): RecordsClient {
  const token = env().SOCRATA_APP_TOKEN;
  async function get(url: string, deadline: number): Promise<unknown> {
    let wait = 1000;
    for (let attempt = 1; ; attempt++) {
      const left = deadline - Date.now();
      if (left < 1000) throw new RecordsError("Out of time for this run; retried next run");
      let res: Response | null = null;
      try {
        res = await fetch(url, { headers: { Accept: "application/json", ...(token ? { "X-App-Token": token } : {}) }, signal: AbortSignal.timeout(Math.min(20_000, left)) });
      } catch (err) {
        if (attempt >= 4) throw new RecordsError(`Network error after ${attempt} tries: ${String(err).slice(0, 200)}`);
      }
      if (res?.ok) return res.json();
      if (res && res.status !== 429 && res.status < 500) throw new RecordsError(`NYC Open Data answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
      if (attempt >= 4) throw new RecordsError(`NYC Open Data unavailable (${res?.status ?? "network"}) after ${attempt} tries`);
      const retryAfter = Number(res?.headers.get("retry-after"));
      const pause = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 20_000) : wait;
      if (Date.now() + pause > deadline) throw new RecordsError("NYC Open Data is rate-limiting or slow; retried next run");
      await sleep(pause);
      wait *= 3;
    }
  }
  return {
    async meta(dataset, deadline = Date.now() + 60_000) {
      const m = (await get(`${BASE}/api/views/${dataset}.json`, deadline)) as { columns?: { fieldName: string }[]; rowsUpdatedAt?: number };
      return { columns: new Set((m.columns ?? []).map((c) => c.fieldName)), rowsUpdatedAt: m.rowsUpdatedAt ? new Date(m.rowsUpdatedAt * 1000) : null };
    },
    async rows(dataset, query, deadline = Date.now() + 60_000) {
      const out: Record<string, unknown>[] = [];
      // A stable order makes paging safe: ties broken by the row id.
      const order = query.$order ? (query.$order.includes(":id") ? query.$order : `${query.$order}, :id`) : ":id";
      const { maxRows = MAX_ROWS, ...soql } = query;
      for (let offset = 0; offset < Math.min(maxRows, MAX_ROWS); offset += query.$limit) {
        const params = new URLSearchParams({ ...Object.fromEntries(Object.entries(soql).map(([k, v]) => [k, String(v)])), $order: order, $offset: String(offset) });
        const page = await get(`${BASE}/resource/${dataset}.json?${params}`, deadline);
        if (!Array.isArray(page)) throw new RecordsError("Unexpected response from NYC Open Data");
        out.push(...(page as Record<string, unknown>[]));
        if (page.length < query.$limit) break;
      }
      return out;
    },
  };
}

let clientOverride: RecordsClient | null = null;
/** Tests replay recorded rows instead of calling NYC Open Data. */
export function setRecordsClientForTests(c: RecordsClient | null) {
  clientOverride = c;
}
const client = () => clientOverride ?? socrataClient();
/**
 * Module A: a project that gets a lot (created with a BBL, or its BBL
 * changed) pulls its first public-records snapshot right after the request,
 * instead of waiting for the nightly run. Queued here, run by the request
 * handler once the response is on its way.
 */
const snapshotQueue = new Set<string>();
export function queueFirstSnapshot(projectId: string) {
  snapshotQueue.add(projectId);
}
export function takeSnapshotQueue(): string[] {
  const ids = [...snapshotQueue];
  snapshotQueue.clear();
  return ids;
}

/** The same client (token, retries, deadlines, test replay) for other NYC Open Data lookups. */
export const recordsClient = client;

/* ------------------------------------------------------------------ */
/* Sync one project                                                    */
/* ------------------------------------------------------------------ */

/** The order sources run in: BINs found early feed the complaint lookup; ACRIS legals feed ACRIS master. */
const ORDER = [
  "dobnow_jobs",
  "bis_jobs",
  "bis_permits",
  "dobnow_permits",
  "dob_violations",
  "ecb_violations",
  "dob_safety",
  "hpd_violations",
  "hpd_vacate",
  "fdny_vacate",
  "dob_complaints",
  "oath",
  "sr311",
  "tax_lien",
  "dof_charges",
  "acris_legals",
  "acris_master",
] as const;

/** Sources whose rows are shown as records ("acris_legals" only finds document ids). */
const HIDDEN_SOURCES = new Set(["acris_legals"]);

export interface SyncResult {
  projectId: string;
  ok: string[];
  failed: { source: string; error: string }[];
  alerts: number;
  skipped?: string;
}

/** How long one sync may hold a project before another may take over (a crashed run). */
const LEASE_MS = 15 * 60_000;

/** Take this project's sync lease; false if another sync (nightly or "Check now") holds it. */
async function takeLease(projectId: string): Promise<boolean> {
  const conn = db();
  await conn.insert(schema.recordSync).values({ projectId, source: "_run" }).onConflictDoNothing();
  const got = await conn
    .update(schema.recordSync)
    .set({ lockedUntil: new Date(Date.now() + LEASE_MS) })
    .where(and(eq(schema.recordSync.projectId, projectId), eq(schema.recordSync.source, "_run"), or(isNull(schema.recordSync.lockedUntil), lt(schema.recordSync.lockedUntil, new Date()))))
    .returning({ projectId: schema.recordSync.projectId });
  return got.length > 0;
}

/**
 * Pull every source for one project's lot, store the records, diff them and
 * raise alerts. Idempotent: records upsert, alerts dedupe on a stable key.
 * One failing source never stops the others; each failure is recorded. One
 * sync per project at a time (a lease), and never past `deadline`.
 */
export async function syncProjectRecords(
  projectId: string,
  opts: { now?: Date; meta?: Map<string, DatasetMeta>; deadline?: number; nightly?: boolean } = {},
): Promise<SyncResult> {
  const now = opts.now ?? new Date();
  const deadline = opts.deadline ?? Date.now() + 120_000;
  const conn = db();
  const [p] = await conn.select().from(schema.project).where(eq(schema.project.id, projectId));
  const result: SyncResult = { projectId, ok: [], failed: [], alerts: 0 };
  const lot = parseBbl(p?.bbl);
  if (!p || !lot) return { ...result, skipped: "no BBL" };
  if (!(await takeLease(projectId))) return { ...result, skipped: "busy" };

  try {
    const ctx: SourceContext = { lot, address: parseAddress(p.address), bins: [] };
    const raised: (typeof schema.recordAlert.$inferSelect)[] = [];
    const metaCache = opts.meta ?? new Map<string, DatasetMeta>();
    const c = client();
    const today = todayET(now);

    for (const key of ORDER) {
      const def = SOURCE_BY_KEY.get(key)!;
      try {
        if (Date.now() > deadline - 1000) throw new RecordsError("Out of time for this run; retried next run");
        let meta = metaCache.get(def.dataset);
        if (!meta) {
          meta = await c.meta(def.dataset, deadline);
          metaCache.set(def.dataset, meta);
        }
        const missing = def.columns.filter((col) => !meta!.columns.has(col));
        if (missing.length) throw new RecordsError(`Dataset ${def.dataset} changed: missing ${missing.join(", ")}`);
        const query = def.query(ctx);
        const rows = query ? await c.rows(def.dataset, query, deadline) : [];
        let items: RecordItem[];
        if (key === "dof_charges") items = [summarizeCharges(rows, today, lot)];
        else if (key === "acris_legals") {
          ctx.documentIds = [...new Set(rows.map((r) => String(r.document_id ?? "")).filter(Boolean))];
          items = [];
        } else items = dedupeItems(rows.map((r) => def.map(r, ctx)).filter((x): x is RecordItem => !!x));
        if (key === "dob_complaints") items = resolveComplaintOrders(items, today);
        for (const i of items) {
          const bin = i.detail.bin;
          if (bin && !ctx.bins.includes(String(bin))) ctx.bins.push(String(bin));
        }
        if (!HIDDEN_SOURCES.has(key)) raised.push(...(await applySource(projectId, def, items, meta.rowsUpdatedAt, now, rows.length < MAX_ROWS)));
        else await markSourceOk(conn, projectId, key, meta.rowsUpdatedAt, rows.length, now);
        result.ok.push(key);
      } catch (err) {
        const message = err instanceof RecordsError ? err.message : String(err).slice(0, 500);
        result.failed.push({ source: key, error: message });
        await conn
          .insert(schema.recordSync)
          .values({ projectId, source: key, lastRunAt: now, failures: 1, error: message })
          .onConflictDoUpdate({ target: [schema.recordSync.projectId, schema.recordSync.source], set: { lastRunAt: now, failures: sql`${schema.recordSync.failures} + 1`, error: message } });
        if (!(err instanceof RecordsError)) await logError("job", err, { path: `records:${key}`, context: { projectId } });
      }
    }
    // One notice per project per run, however many sources moved.
    result.alerts = raised.length;
    if (raised.length) await conn.transaction((tx) => notifyAlerts(tx, projectId, raised));
    const failed = result.failed.length > 0;
    await conn
      .update(schema.recordSync)
      .set({
        lastRunAt: now,
        // Consecutive failed runs drive the retry backoff.
        failures: failed ? sql`${schema.recordSync.failures} + 1` : 0,
        error: failed ? `${result.failed.length} source(s) failed` : null,
        ...(failed ? {} : { lastSuccessAt: now }),
        ...(opts.nightly ? { nightlyOn: today } : {}),
      })
      .where(and(eq(schema.recordSync.projectId, projectId), eq(schema.recordSync.source, "_run")));
    return result;
  } finally {
    await conn.update(schema.recordSync).set({ lockedUntil: null }).where(and(eq(schema.recordSync.projectId, projectId), eq(schema.recordSync.source, "_run")));
  }
}

/**
 * The lot changed (BBL or address edited): forget the old lot's records,
 * alerts, violation cases (and their hearing dates) and record-fed expiries,
 * so the next run starts fresh instead of calling the new lot's history news.
 */
export async function resetProjectRecords(tx: DbOrTx, projectId: string): Promise<void> {
  const cases = await tx.select({ keyDateId: schema.violationCase.keyDateId }).from(schema.violationCase).where(eq(schema.violationCase.projectId, projectId));
  const kd = cases.map((c) => c.keyDateId).filter((x): x is string => !!x);
  await tx.delete(schema.violationCase).where(eq(schema.violationCase.projectId, projectId));
  if (kd.length) await tx.delete(schema.keyDate).where(inArray(schema.keyDate.id, kd));
  await tx.delete(schema.recordAlert).where(eq(schema.recordAlert.projectId, projectId));
  await tx.delete(schema.recordItem).where(eq(schema.recordItem.projectId, projectId));
  await tx.delete(schema.expiryItem).where(and(eq(schema.expiryItem.projectId, projectId), isNotNull(schema.expiryItem.recordRef)));
  await tx.delete(schema.recordSync).where(eq(schema.recordSync.projectId, projectId));
}

/** A dataset can list the same record twice (amended rows): keep the last. */
function dedupeItems(items: RecordItem[]): RecordItem[] {
  return [...new Map(items.map((i) => [i.key, i])).values()];
}

async function markSourceOk(conn: DbOrTx, projectId: string, source: string, dataAsOf: Date | null, rows: number, now: Date) {
  await conn
    .insert(schema.recordSync)
    .values({ projectId, source, lastRunAt: now, lastSuccessAt: now, dataAsOf, rows, failures: 0, error: null })
    .onConflictDoUpdate({ target: [schema.recordSync.projectId, schema.recordSync.source], set: { lastRunAt: now, lastSuccessAt: now, dataAsOf, rows, failures: 0, error: null } });
}

/** Store one source's records, raise alerts, track violations and permit expiries. Returns the alerts raised (notified by the caller). */
/** Rows gone from a complete pull for this long are closed (the city removed or merged them). */
const GONE_AFTER_MS = 7 * 86_400_000;

async function applySource(projectId: string, def: SourceDef, items: RecordItem[], dataAsOf: Date | null, now: Date, complete: boolean): Promise<(typeof schema.recordAlert.$inferSelect)[]> {
  return db().transaction(async (tx) => {
    const [sync] = await tx.select().from(schema.recordSync).where(and(eq(schema.recordSync.projectId, projectId), eq(schema.recordSync.source, def.key)));
    const baseline = !sync?.lastSuccessAt;
    const knownRows = await tx.select({ key: schema.recordItem.key, status: schema.recordItem.status, critical: schema.recordItem.critical, open: schema.recordItem.open }).from(schema.recordItem).where(and(eq(schema.recordItem.projectId, projectId), eq(schema.recordItem.source, def.key)));
    const known = new Map<string, KnownRecord>(knownRows.map((k) => [k.key, k]));
    const today = todayET(now);
    const alerts = diffRecords(known, items, def.key, baseline, today);

    for (const i of items) {
      const values = { title: i.title.slice(0, 300), kind: i.kind, status: i.status, date: i.date, open: i.open, critical: i.critical, url: i.url, hearingOn: i.hearingOn ?? null, expiresOn: i.expiresOn ?? null, detail: i.detail, lastSeenAt: now };
      await tx
        .insert(schema.recordItem)
        .values({ projectId, source: def.key, key: i.key, ...values })
        .onConflictDoUpdate({ target: [schema.recordItem.projectId, schema.recordItem.source, schema.recordItem.key], set: values });
      if (i.kind === "violation" || (i.kind === "hearing" && !isDobTicket(i))) await trackViolation(tx, projectId, def.key, i, !known.has(i.key) && !baseline, known.get(i.key)?.open ?? null);
      if (i.kind === "permit") await trackPermitExpiry(tx, projectId, def.key, i, today, items);
    }

    // Open records missing from complete pulls for a week are no longer listed: close them and their cases.
    if (complete) {
      const gone = await tx
        .update(schema.recordItem)
        .set({ open: false, critical: false, status: sql`coalesce(${schema.recordItem.status}, '') || ' (no longer listed)'` })
        .where(and(eq(schema.recordItem.projectId, projectId), eq(schema.recordItem.source, def.key), eq(schema.recordItem.open, true), lt(schema.recordItem.lastSeenAt, new Date(now.getTime() - GONE_AFTER_MS))))
        .returning({ key: schema.recordItem.key });
      if (gone.length) {
        await tx
          .update(schema.violationCase)
          .set({ stage: "resolved", closedOn: today, version: sql`${schema.violationCase.version} + 1`, updatedAt: new Date() })
          .where(and(eq(schema.violationCase.projectId, projectId), eq(schema.violationCase.source, def.key), inArray(schema.violationCase.itemKey, gone.map((g) => g.key)), notInArray(schema.violationCase.stage, CLOSED_STAGES)));
      }
    }

    const inserted = alerts.length
      ? await tx
          .insert(schema.recordAlert)
          .values(alerts.map((a) => ({ projectId, source: def.key, itemKey: a.item.key, kind: a.kind, critical: a.critical, title: a.title.slice(0, 300), url: a.item.url, dedupeKey: a.dedupeKey })))
          .onConflictDoNothing()
          .returning()
      : [];
    await markSourceOk(tx, projectId, def.key, dataAsOf, items.length, now);
    return inserted;
  });
}

/** Who hears about public-record changes (brief §10): the owner(s) and the project's PM. */
export async function recordAudience(tx: DbOrTx, projectId: string): Promise<string[]> {
  const pms = await tx
    .select({ userId: schema.projectMember.userId })
    .from(schema.projectMember)
    .innerJoin(schema.user, eq(schema.user.id, schema.projectMember.userId))
    .where(and(eq(schema.projectMember.projectId, projectId), sql`lower(${schema.projectMember.projectRole}) = 'pm'`, notInArray(schema.user.role, [...OUTSIDE_ROLES]), eq(schema.user.status, "active")));
  return [...new Set([...(await activeOwners(tx)), ...pms.map((m) => m.userId)])];
}

async function notifyAlerts(tx: DbOrTx, projectId: string, alerts: (typeof schema.recordAlert.$inferSelect)[]) {
  const [p] = await tx.select({ name: schema.project.name }).from(schema.project).where(eq(schema.project.id, projectId));
  const people = await recordAudience(tx, projectId);
  const href = `/projects/${projectId}?tab=records`;
  const critical = alerts.filter((a) => a.critical);
  const normal = alerts.filter((a) => !a.critical);
  for (const a of critical) {
    await notify(tx, null, people.map((userId) => ({ userId, kind: "record_change" as const, title: `${a.title} · ${p?.name ?? "a project"}`, body: "Open the Public Records tab now.", projectId, href, critical: true, taskId: null })));
  }
  if (normal.length) {
    // One notice per project per sync, however many records moved.
    const title = normal.length === 1 ? normal[0]!.title : `${normal.length} public-record changes`;
    await notify(tx, null, people.map((userId) => ({ userId, kind: "record_change" as const, title: `${title} · ${p?.name ?? "a project"}`, body: normal.slice(0, 3).map((a) => a.title).join(" · "), projectId, href })));
  }
}

/** Keep a violation case in step with its record: create it, move it forward, set the hearing as a key date. */
/** DOB summonses at OATH are the ECB violations already tracked from the ECB dataset: no second case for them. */
function isDobTicket(i: RecordItem): boolean {
  return /BUILDINGS|\bDOB\b/i.test(i.title);
}

async function trackViolation(tx: DbOrTx, projectId: string, source: string, i: RecordItem, isNews: boolean, wasOpen: boolean | null) {
  // Locked: a person updating the case at the same moment is never overwritten.
  const [existing] = await tx.select().from(schema.violationCase).where(and(eq(schema.violationCase.projectId, projectId), eq(schema.violationCase.source, source), eq(schema.violationCase.itemKey, i.key))).for("update");
  // Closed violations from years ago aren't worth a case; open ones (and anything new) are.
  if (!existing && !i.open && !isNews) return;
  const fromSource = sourceStage(i);
  let stage: ViolationStage = existing?.stage ?? "issued";
  if (fromSource && (CLOSED_STAGES.includes(fromSource) || stageRank(fromSource) > stageRank(stage))) stage = fromSource;
  // Reopened at the source (it was closed there, now it's open again): back to issued. A case closed by hand stays closed.
  if (existing && wasOpen === false && i.open && CLOSED_STAGES.includes(existing.stage)) stage = "issued";
  const closedOn = CLOSED_STAGES.includes(stage) ? (existing?.closedOn ?? todayET()) : null;
  const hearingOn = i.hearingOn && (!existing?.hearingOn || i.hearingOn !== existing.hearingOn) ? i.hearingOn : (existing?.hearingOn ?? i.hearingOn ?? null);

  let keyDateId = existing?.keyDateId ?? null;
  if (hearingOn && !CLOSED_STAGES.includes(stage) && hearingOn >= todayET()) {
    const label = `Hearing: ${i.title}`.slice(0, 120);
    if (keyDateId) await tx.update(schema.keyDate).set({ date: hearingOn, label, done: false, updatedAt: new Date() }).where(eq(schema.keyDate.id, keyDateId));
    else {
      const [kd] = await tx.insert(schema.keyDate).values({ projectId, kind: "oath_hearing", label, date: hearingOn, notes: `From ${i.url}` }).returning({ id: schema.keyDate.id });
      keyDateId = kd!.id;
    }
  } else if (keyDateId && CLOSED_STAGES.includes(stage)) {
    await tx.update(schema.keyDate).set({ done: true, updatedAt: new Date() }).where(eq(schema.keyDate.id, keyDateId));
  }

  const values = { title: i.title.slice(0, 300), description: (i.detail.description as string | null) ?? null, url: i.url, issuedOn: i.date, stage, hearingOn, keyDateId, closedOn };
  if (existing) {
    const changed = existing.stage !== stage || existing.hearingOn !== hearingOn || existing.keyDateId !== keyDateId || existing.title !== values.title;
    if (changed) await tx.update(schema.violationCase).set({ ...values, version: sql`${schema.violationCase.version} + 1`, updatedAt: new Date() }).where(eq(schema.violationCase.id, existing.id));
  } else {
    await tx.insert(schema.violationCase).values({ projectId, source, itemKey: i.key, ...values }).onConflictDoNothing();
  }
}

/** Issued permits with an expiry date feed the expiry tracker (Module B); the sync keeps the date current. */
async function trackPermitExpiry(tx: DbOrTx, projectId: string, source: string, i: RecordItem, today: string, all: RecordItem[]) {
  const recordRef = `${source}:${i.key}`;
  const [existing] = await tx.select().from(schema.expiryItem).where(and(eq(schema.expiryItem.projectId, projectId), eq(schema.expiryItem.recordRef, recordRef)));
  // A renewal (DOB NOW: same permit, higher sequence) supersedes this one.
  const [permit, seq] = i.key.split("#");
  const superseded = seq !== undefined && all.some((o) => o.key.startsWith(`${permit}#`) && Number(o.key.split("#")[1]) > Number(seq));
  // Only live permits are tracked: expired history (BIS keeps old permits "ISSUED") never floods the tracker.
  if (!i.open || !i.expiresOn || superseded || (!existing && i.expiresOn < today)) {
    if (existing && !existing.closedAt) await tx.update(schema.expiryItem).set({ closedAt: new Date(), version: sql`${schema.expiryItem.version} + 1`, updatedAt: new Date() }).where(eq(schema.expiryItem.id, existing.id));
    return;
  }
  const category = /shed/i.test(`${i.title} ${i.detail.workType ?? ""}`) ? "shed_permit" : /crane/i.test(i.title) ? "crane_permit" : "dob_permit";
  if (!existing) {
    await tx.insert(schema.expiryItem).values({ projectId, category, label: i.title.slice(0, 120), expiresOn: i.expiresOn, recordRef, notes: i.url }).onConflictDoNothing();
  } else if (existing.expiresOn !== i.expiresOn) {
    // A new date from the city (a renewal) reopens it; a person's "closed" otherwise stands.
    await tx.update(schema.expiryItem).set({ expiresOn: i.expiresOn, closedAt: null, version: sql`${schema.expiryItem.version} + 1`, updatedAt: new Date() }).where(eq(schema.expiryItem.id, existing.id));
  }
}

/* ------------------------------------------------------------------ */
/* Nightly job                                                         */
/* ------------------------------------------------------------------ */

/** Hours (New York) the nightly pass runs in; failed sources retry any hour after their backoff. */
const NIGHT = { from: 1, to: 6 };

/**
 * Hourly from the tick: sync projects that are due (nightly window, or a
 * failed source whose backoff has passed), within a time budget so the tick
 * stays inside its limit. Throws after the batch if anything failed, so the
 * run shows red on System and admins are alerted: it never fails silently.
 */
export async function recordsSyncJob(now = new Date(), budgetMs = 150_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + budgetMs;
  const conn = db();
  const today = todayET(now);
  const nightly = hourET(now) >= NIGHT.from && hourET(now) < NIGHT.to;
  const candidates = await conn
    .select({ id: schema.project.id, lastRunAt: schema.recordSync.lastRunAt, failures: schema.recordSync.failures, nightlyOn: schema.recordSync.nightlyOn })
    .from(schema.project)
    .leftJoin(schema.recordSync, and(eq(schema.recordSync.projectId, schema.project.id), eq(schema.recordSync.source, "_run")))
    .where(and(isNull(schema.project.archivedAt), ne(schema.project.status, "closed"), sql`${schema.project.bbl} is not null`))
    .orderBy(sql`${schema.recordSync.lastRunAt} asc nulls first`);
  const due = candidates.filter((c) => {
    if (!c.lastRunAt) return true;
    // Once each night, whatever ran during the day ("Check now", a retry).
    if (nightly && c.nightlyOn !== today) return true;
    // Consecutive failed runs back off: 1h, 2h, 4h … capped at 12h.
    const failures = c.failures ?? 0;
    return failures > 0 && now.getTime() - c.lastRunAt.getTime() >= Math.min(2 ** (failures - 1), 12) * 3600_000;
  });

  const meta = new Map<string, DatasetMeta>();
  const results: SyncResult[] = [];
  for (const c of due) {
    // Leave room to record the outcome: the tick must never be killed mid-write.
    if (Date.now() > deadline - 15_000) break;
    const r = await syncProjectRecords(c.id, { now, meta, deadline: deadline - 10_000, nightly });
    if (r.skipped !== "busy") results.push(r);
  }
  const failed = results.filter((r) => r.failed.length);
  if (failed.length) await alertSyncFailure(failed, now);
  const summary = { due: due.length, synced: results.length, alerts: results.reduce((a, r) => a + r.alerts, 0), failedProjects: failed.length };
  if (failed.length) throw new Error(`Public records sync: ${failed.length} project(s) had failing sources (${[...new Set(failed.flatMap((f) => f.failed.map((x) => x.source)))].join(", ")})`);
  return summary;
}

/** Admins and owners hear about a failing sync once a day (never silently). */
async function alertSyncFailure(failed: SyncResult[], now: Date) {
  const conn = db();
  const title = "Public records sync is failing";
  const [already] = await conn
    .select({ id: schema.notification.id })
    .from(schema.notification)
    .where(and(eq(schema.notification.kind, "system"), eq(schema.notification.title, title), sql`${schema.notification.createdAt} > ${new Date(now.getTime() - 20 * 3600_000)}`))
    .limit(1);
  if (already) return;
  const admins = await conn.select({ id: schema.user.id }).from(schema.user).where(and(inArray(schema.user.role, ["owner", "admin"]), eq(schema.user.status, "active")));
  const sources = [...new Set(failed.flatMap((f) => f.failed.map((x) => x.source)))];
  await notify(
    conn,
    null,
    admins.map((a) => ({ userId: a.id, kind: "system" as const, title, body: `${failed.length} project(s); failing: ${sources.join(", ")}. It retries automatically; details on the System page.`, href: "/system" })),
  );
}

/** Housekeeping for the tests and the System page: projects whose last run had failures. */
export async function failingSyncs(conn: DbOrTx = db()) {
  return conn
    .select({ projectId: schema.recordSync.projectId, source: schema.recordSync.source, error: schema.recordSync.error, failures: schema.recordSync.failures, lastRunAt: schema.recordSync.lastRunAt })
    .from(schema.recordSync)
    .where(and(ne(schema.recordSync.source, "_run"), sql`${schema.recordSync.failures} > 0`));
}
