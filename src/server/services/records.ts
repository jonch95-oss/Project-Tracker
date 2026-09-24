import "server-only";
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import {
  CLOSED_STAGES,
  diffRecords,
  parseAddress,
  parseBbl,
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
  meta(dataset: string): Promise<DatasetMeta>;
  rows(dataset: string, query: SourceQuery): Promise<Record<string, unknown>[]>;
}

export class RecordsError extends Error {}

const BASE = "https://data.cityofnewyork.us";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Socrata over HTTPS with the app token: sequential, retried with backoff on
 * 429 / 5xx / network errors (honouring Retry-After), 20s per request.
 */
function socrataClient(): RecordsClient {
  const token = env().SOCRATA_APP_TOKEN;
  async function get(url: string): Promise<unknown> {
    let wait = 1000;
    for (let attempt = 1; ; attempt++) {
      let res: Response | null = null;
      try {
        res = await fetch(url, { headers: { Accept: "application/json", ...(token ? { "X-App-Token": token } : {}) }, signal: AbortSignal.timeout(20_000) });
      } catch (err) {
        if (attempt >= 4) throw new RecordsError(`Network error after ${attempt} tries: ${String(err).slice(0, 200)}`);
      }
      if (res?.ok) return res.json();
      if (res && res.status !== 429 && res.status < 500) throw new RecordsError(`NYC Open Data answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
      if (attempt >= 4) throw new RecordsError(`NYC Open Data unavailable (${res?.status ?? "network"}) after ${attempt} tries`);
      const retryAfter = Number(res?.headers.get("retry-after"));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 20_000) : wait);
      wait *= 3;
    }
  }
  return {
    async meta(dataset) {
      const m = (await get(`${BASE}/api/views/${dataset}.json`)) as { columns?: { fieldName: string }[]; rowsUpdatedAt?: number };
      return { columns: new Set((m.columns ?? []).map((c) => c.fieldName)), rowsUpdatedAt: m.rowsUpdatedAt ? new Date(m.rowsUpdatedAt * 1000) : null };
    },
    async rows(dataset, query) {
      const params = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]));
      const out = await get(`${BASE}/resource/${dataset}.json?${params}`);
      if (!Array.isArray(out)) throw new RecordsError("Unexpected response from NYC Open Data");
      return out as Record<string, unknown>[];
    },
  };
}

let clientOverride: RecordsClient | null = null;
/** Tests replay recorded rows instead of calling NYC Open Data. */
export function setRecordsClientForTests(c: RecordsClient | null) {
  clientOverride = c;
}
const client = () => clientOverride ?? socrataClient();

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

/**
 * Pull every source for one project's lot, store the records, diff them and
 * raise alerts. Idempotent: records upsert, alerts dedupe on a stable key.
 * One failing source never stops the others; each failure is recorded.
 */
export async function syncProjectRecords(projectId: string, opts: { now?: Date; meta?: Map<string, DatasetMeta> } = {}): Promise<SyncResult> {
  const now = opts.now ?? new Date();
  const conn = db();
  const [p] = await conn.select().from(schema.project).where(eq(schema.project.id, projectId));
  const result: SyncResult = { projectId, ok: [], failed: [], alerts: 0 };
  const lot = parseBbl(p?.bbl);
  if (!p || !lot) return { ...result, skipped: "no BBL" };

  const ctx: SourceContext = { lot, address: parseAddress(p.address), bins: [] };
  const raised: (typeof schema.recordAlert.$inferSelect)[] = [];
  const metaCache = opts.meta ?? new Map<string, DatasetMeta>();
  const c = client();

  for (const key of ORDER) {
    const def = SOURCE_BY_KEY.get(key)!;
    try {
      let meta = metaCache.get(def.dataset);
      if (!meta) {
        meta = await c.meta(def.dataset);
        metaCache.set(def.dataset, meta);
      }
      const missing = def.columns.filter((col) => !meta!.columns.has(col));
      if (missing.length) throw new RecordsError(`Dataset ${def.dataset} changed: missing ${missing.join(", ")}`);
      const query = def.query(ctx);
      const rows = query ? await c.rows(def.dataset, query) : [];
      let items: RecordItem[];
      if (key === "dof_charges") items = [summarizeCharges(rows, todayET(now), lot)];
      else if (key === "acris_legals") {
        ctx.documentIds = [...new Set(rows.map((r) => String(r.document_id ?? "")).filter(Boolean))];
        items = [];
      } else items = dedupeItems(rows.map((r) => def.map(r, ctx)).filter((x): x is RecordItem => !!x));
      for (const i of items) {
        const bin = i.detail.bin;
        if (bin && !ctx.bins.includes(String(bin))) ctx.bins.push(String(bin));
      }
      if (!HIDDEN_SOURCES.has(key)) raised.push(...(await applySource(projectId, def, items, meta.rowsUpdatedAt, now)));
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
  await conn
    .insert(schema.recordSync)
    .values({ projectId, source: "_run", lastRunAt: now, lastSuccessAt: result.failed.length ? null : now, failures: result.failed.length, error: result.failed.length ? `${result.failed.length} source(s) failed` : null })
    .onConflictDoUpdate({
      target: [schema.recordSync.projectId, schema.recordSync.source],
      set: { lastRunAt: now, failures: result.failed.length, error: result.failed.length ? `${result.failed.length} source(s) failed` : null, ...(result.failed.length ? {} : { lastSuccessAt: now }) },
    });
  return result;
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
async function applySource(projectId: string, def: SourceDef, items: RecordItem[], dataAsOf: Date | null, now: Date): Promise<(typeof schema.recordAlert.$inferSelect)[]> {
  return db().transaction(async (tx) => {
    const [sync] = await tx.select().from(schema.recordSync).where(and(eq(schema.recordSync.projectId, projectId), eq(schema.recordSync.source, def.key)));
    const baseline = !sync?.lastSuccessAt;
    const knownRows = await tx.select({ key: schema.recordItem.key, status: schema.recordItem.status, critical: schema.recordItem.critical, open: schema.recordItem.open }).from(schema.recordItem).where(and(eq(schema.recordItem.projectId, projectId), eq(schema.recordItem.source, def.key)));
    const known = new Map<string, KnownRecord>(knownRows.map((k) => [k.key, k]));
    const alerts = diffRecords(known, items, def.key, baseline);

    for (const i of items) {
      const values = { title: i.title.slice(0, 300), kind: i.kind, status: i.status, date: i.date, open: i.open, critical: i.critical, url: i.url, hearingOn: i.hearingOn ?? null, expiresOn: i.expiresOn ?? null, detail: i.detail, lastSeenAt: now };
      await tx
        .insert(schema.recordItem)
        .values({ projectId, source: def.key, key: i.key, ...values })
        .onConflictDoUpdate({ target: [schema.recordItem.projectId, schema.recordItem.source, schema.recordItem.key], set: values });
      if (i.kind === "violation" || i.kind === "hearing") await trackViolation(tx, projectId, def.key, i, !known.has(i.key) && !baseline);
      if (i.kind === "permit") await trackPermitExpiry(tx, projectId, def.key, i);
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
    .where(and(eq(schema.projectMember.projectId, projectId), sql`lower(${schema.projectMember.projectRole}) = 'pm'`, ne(schema.user.role, "external"), eq(schema.user.status, "active")));
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
async function trackViolation(tx: DbOrTx, projectId: string, source: string, i: RecordItem, isNews: boolean) {
  const [existing] = await tx.select().from(schema.violationCase).where(and(eq(schema.violationCase.projectId, projectId), eq(schema.violationCase.source, source), eq(schema.violationCase.itemKey, i.key)));
  // Closed violations from years ago aren't worth a case; open ones (and anything new) are.
  if (!existing && !i.open && !isNews) return;
  const fromSource = sourceStage(i);
  let stage: ViolationStage = existing?.stage ?? "issued";
  if (fromSource && (CLOSED_STAGES.includes(fromSource) || stageRank(fromSource) > stageRank(stage))) stage = fromSource;
  // Reopened at the source: back to issued.
  if (existing && i.open && CLOSED_STAGES.includes(existing.stage) && !(fromSource && CLOSED_STAGES.includes(fromSource))) stage = "issued";
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
async function trackPermitExpiry(tx: DbOrTx, projectId: string, source: string, i: RecordItem) {
  const recordRef = `${source}:${i.key}`;
  const [existing] = await tx.select().from(schema.expiryItem).where(and(eq(schema.expiryItem.projectId, projectId), eq(schema.expiryItem.recordRef, recordRef)));
  if (!i.open || !i.expiresOn) {
    if (existing && !existing.closedAt) await tx.update(schema.expiryItem).set({ closedAt: new Date(), updatedAt: new Date() }).where(eq(schema.expiryItem.id, existing.id));
    return;
  }
  const category = /shed/i.test(`${i.title} ${i.detail.workType ?? ""}`) ? "shed_permit" : /crane/i.test(i.title) ? "crane_permit" : "dob_permit";
  if (!existing) {
    await tx.insert(schema.expiryItem).values({ projectId, category, label: i.title.slice(0, 120), expiresOn: i.expiresOn, recordRef, notes: i.url }).onConflictDoNothing();
  } else if (existing.expiresOn !== i.expiresOn || existing.closedAt) {
    await tx.update(schema.expiryItem).set({ expiresOn: i.expiresOn, closedAt: null, version: sql`${schema.expiryItem.version} + 1`, updatedAt: new Date() }).where(eq(schema.expiryItem.id, existing.id));
  }
}

/* ------------------------------------------------------------------ */
/* Nightly job                                                         */
/* ------------------------------------------------------------------ */

/** Hours (New York) the nightly pass runs in; failed sources retry any hour after their backoff. */
const NIGHT = { from: 1, to: 6 };
const STALE_MS = 20 * 3600_000;

/**
 * Hourly from the tick: sync projects that are due (nightly window, or a
 * failed source whose backoff has passed), within a time budget so the tick
 * stays inside its limit. Throws after the batch if anything failed, so the
 * run shows red on System and admins are alerted: it never fails silently.
 */
export async function recordsSyncJob(now = new Date(), budgetMs = 180_000): Promise<Record<string, unknown>> {
  const started = Date.now();
  const conn = db();
  const nightly = hourET(now) >= NIGHT.from && hourET(now) < NIGHT.to;
  const staleBefore = new Date(now.getTime() - STALE_MS);
  const candidates = await conn
    .select({ id: schema.project.id, lastRunAt: schema.recordSync.lastRunAt, failures: schema.recordSync.failures })
    .from(schema.project)
    .leftJoin(schema.recordSync, and(eq(schema.recordSync.projectId, schema.project.id), eq(schema.recordSync.source, "_run")))
    .where(and(isNull(schema.project.archivedAt), ne(schema.project.status, "closed"), sql`${schema.project.bbl} is not null`))
    .orderBy(sql`${schema.recordSync.lastRunAt} asc nulls first`);
  const due = candidates.filter((c) => {
    if (!c.lastRunAt) return true;
    if (nightly && c.lastRunAt < staleBefore) return true;
    // Backoff for failures: 1h, 2h, 4h … capped at 12h.
    return (c.failures ?? 0) > 0 && now.getTime() - c.lastRunAt.getTime() >= Math.min(2 ** ((c.failures ?? 1) - 1), 12) * 3600_000;
  });

  const meta = new Map<string, DatasetMeta>();
  const results: SyncResult[] = [];
  for (const c of due) {
    if (Date.now() - started > budgetMs) break;
    results.push(await syncProjectRecords(c.id, { now, meta }));
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
