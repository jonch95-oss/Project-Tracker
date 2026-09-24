import "server-only";
import { and, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { docCategoryLabel } from "@/core/directory";
import { expiryReminderMark, vendorKey } from "@/core/expiries";
import { addDays, daysBetween, formatIsoDate, todayET } from "@/core/time";
import { db, schema, type DbOrTx } from "../db";
import { activeOwners, notify } from "./tasks";

/** The directory company a typed vendor name means, if there is one (so commitments and invoices link themselves). */
export async function vendorIdForName(tx: DbOrTx, name: string | null | undefined): Promise<string | null> {
  const key = vendorKey(name);
  if (!key) return null;
  const [v] = await tx.select({ id: schema.vendor.id }).from(schema.vendor).where(and(eq(schema.vendor.key, key), isNull(schema.vendor.archivedAt)));
  return v?.id ?? null;
}

/** On an edit: keep the row's directory link while its name still means the same company; otherwise link by the new name. */
export async function keepOrLink(tx: DbOrTx, before: { name: string; vendorId: string | null } | undefined, name: string): Promise<string | null> {
  if (before?.vendorId && vendorKey(before.name) === vendorKey(name)) return before.vendorId;
  return vendorIdForName(tx, name);
}

export type VendorLink = "commitment" | "invoice" | "task" | "coi" | "punch";

/**
 * Where each vendor shows up, per project: contracts, invoices, tasks, COIs
 * on the expiry tracker and punch items, matched by directory link or by the
 * name as typed. `projectIds` limits it to projects the viewer can open.
 */
export async function vendorProjects(conn: DbOrTx, vendors: readonly { id: string; key: string }[], projectIds?: readonly string[]): Promise<Map<string, Map<string, Set<VendorLink>>>> {
  const out = new Map<string, Map<string, Set<VendorLink>>>(vendors.map((v) => [v.id, new Map()]));
  if (vendors.length === 0 || (projectIds && projectIds.length === 0)) return out;
  const byKey = new Map(vendors.map((v) => [v.key, v.id]));
  const ids = new Set(vendors.map((v) => v.id));
  const scope = <T extends { projectId: string }>(rows: T[]) => (projectIds ? rows.filter((r) => projectIds.includes(r.projectId)) : rows);
  const add = (vendorId: string | undefined | null, projectId: string, via: VendorLink) => {
    if (!vendorId || !ids.has(vendorId)) return;
    const m = out.get(vendorId)!;
    m.set(projectId, (m.get(projectId) ?? new Set()).add(via));
  };
  const named = (vendorId: string | null, name: string | null) => (vendorId && ids.has(vendorId) ? vendorId : byKey.get(vendorKey(name)));
  for (const r of scope(await conn.select({ projectId: schema.commitment.projectId, vendorId: schema.commitment.vendorId, name: schema.commitment.vendorName }).from(schema.commitment))) add(named(r.vendorId, r.name), r.projectId, "commitment");
  for (const r of scope(await conn.select({ projectId: schema.invoice.projectId, vendorId: schema.invoice.vendorId, name: schema.invoice.vendorName }).from(schema.invoice))) add(named(r.vendorId, r.name), r.projectId, "invoice");
  for (const r of scope(await conn.select({ projectId: schema.task.projectId, vendorId: schema.task.vendorId }).from(schema.task).where(inArray(schema.task.vendorId, [...ids])))) add(r.vendorId, r.projectId, "task");
  for (const r of scope(await conn.select({ projectId: schema.expiryItem.projectId, key: schema.expiryItem.vendorKey }).from(schema.expiryItem).where(isNotNull(schema.expiryItem.vendorKey)))) add(byKey.get(r.key!), r.projectId, "coi");
  for (const r of scope(await conn.select({ projectId: schema.punchItem.projectId, name: schema.punchItem.vendorName }).from(schema.punchItem).where(isNotNull(schema.punchItem.vendorName)))) add(byKey.get(vendorKey(r.name)), r.projectId, "punch");
  return out;
}

/**
 * Daily, with the expiry tracker: licenses and COIs in the directory remind
 * the owners at 30, 14 and 7 days, then daily once expired. The last mark
 * sent is kept on the document, so re-runs never double-send and a new
 * expiry date starts fresh.
 */
export async function directoryReminderJob(now = new Date()): Promise<{ reminded: number }> {
  const today = todayET(now);
  return db().transaction(async (tx) => {
    const docs = await tx
      .select({ d: schema.vendorDocument, vendorName: schema.vendor.name })
      .from(schema.vendorDocument)
      .innerJoin(schema.vendor, eq(schema.vendor.id, schema.vendorDocument.vendorId))
      .where(and(isNull(schema.vendor.archivedAt), isNotNull(schema.vendorDocument.expiresOn), lte(schema.vendorDocument.expiresOn, addDays(today, 30)), or(eq(schema.vendorDocument.kind, "license"), eq(schema.vendorDocument.kind, "coi"))))
      .limit(2000);
    // Only the newest document of each kind per vendor reminds: a renewal on file silences the old one.
    const newest = await tx
      .select({ vendorId: schema.vendorDocument.vendorId, category: schema.vendorDocument.category, latest: sql<string>`max(${schema.vendorDocument.expiresOn})` })
      .from(schema.vendorDocument)
      .where(isNotNull(schema.vendorDocument.expiresOn))
      .groupBy(schema.vendorDocument.vendorId, schema.vendorDocument.category);
    const latest = new Map(newest.map((n) => [`${n.vendorId}|${n.category}`, n.latest]));
    const owners = await activeOwners(tx);
    let reminded = 0;
    const seen = new Set<string>();
    for (const { d, vendorName } of docs) {
      if (latest.get(`${d.vendorId}|${d.category}`) !== d.expiresOn) continue;
      // Two copies of the same paper (same kind, same date) remind once.
      if (seen.has(`${d.vendorId}|${d.category}`)) continue;
      seen.add(`${d.vendorId}|${d.category}`);
      const sent = new Set(d.remindedFor === d.expiresOn && d.remindedMark ? [d.remindedMark] : []);
      const mark = expiryReminderMark(d.expiresOn!, today, sent);
      if (!mark) continue;
      const [claimed] = await tx
        .update(schema.vendorDocument)
        .set({ remindedMark: mark, remindedFor: d.expiresOn })
        .where(and(eq(schema.vendorDocument.id, d.id), sql`(${schema.vendorDocument.remindedMark} is distinct from ${mark} or ${schema.vendorDocument.remindedFor} is distinct from ${d.expiresOn})`))
        .returning({ id: schema.vendorDocument.id });
      if (!claimed) continue;
      const n = daysBetween(today, d.expiresOn!);
      const when = n < 0 ? `expired ${-n} day${n === -1 ? "" : "s"} ago` : n === 0 ? "expires today" : `expires in ${n} days`;
      reminded += await notify(
        tx,
        null,
        owners.map((userId) => ({
          userId,
          kind: "expiry" as const,
          title: `${vendorName}: ${docCategoryLabel(d.kind, d.category)} ${when}`,
          body: `Directory · ${formatIsoDate(d.expiresOn!, { month: "short", day: "numeric", year: "numeric" })}`,
          href: `/directory/${d.vendorId}`,
        })),
      );
    }
    return { reminded };
  });
}

/** Directory COIs by vendor key, for the vendor-wide expired-COI flag (Module B + C). */
export async function directoryCois(conn: DbOrTx): Promise<{ key: string; name: string; category: string; expiresOn: string }[]> {
  const rows = await conn
    .select({ key: schema.vendor.key, name: schema.vendor.name, category: schema.vendorDocument.category, expiresOn: schema.vendorDocument.expiresOn })
    .from(schema.vendorDocument)
    .innerJoin(schema.vendor, eq(schema.vendor.id, schema.vendorDocument.vendorId))
    .where(and(eq(schema.vendorDocument.kind, "coi"), isNotNull(schema.vendorDocument.expiresOn), isNull(schema.vendor.archivedAt)));
  return rows.map((r) => ({ ...r, expiresOn: r.expiresOn! }));
}
