import "server-only";
import { and, eq, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { expiryLabel, expiryReminderMark, FINANCIAL_EXPIRY, isVendorCoi, vendorKey } from "@/core/expiries";
import { addDays, daysBetween, formatIsoDate, todayET } from "@/core/time";
import { db, schema, type DbOrTx } from "../db";
import { directoryCois } from "./directory";
import { activeOwners, notify } from "./tasks";

/** Who hears about an expiry: the owner(s) and the project's PM (money items only if they can see financials). */
async function expiryAudience(tx: DbOrTx, projectId: string, financial: boolean): Promise<string[]> {
  const pms = await tx
    .select({ userId: schema.projectMember.userId, fin: schema.projectMember.canViewFinancials })
    .from(schema.projectMember)
    .innerJoin(schema.user, eq(schema.user.id, schema.projectMember.userId))
    .where(and(eq(schema.projectMember.projectId, projectId), sql`lower(${schema.projectMember.projectRole}) = 'pm'`, eq(schema.user.status, "active"), sql`${schema.user.role} not in ('external', 'investor')`));
  return [...new Set([...(await activeOwners(tx)), ...pms.filter((m) => !financial || m.fin).map((m) => m.userId)])];
}

/**
 * Daily: reminders at 30, 14 and 7 days out, then every day once expired
 * (Module B). Each (item, expiry date, mark) is claimed once, so a re-run or
 * a missed day never double-sends; moving the date starts fresh reminders.
 */
export async function expiryReminderJob(now = new Date()): Promise<{ reminded: number }> {
  const today = todayET(now);
  return db().transaction(async (tx) => {
    const items = await tx
      .select({ item: schema.expiryItem, projectName: schema.project.name })
      .from(schema.expiryItem)
      .innerJoin(schema.project, eq(schema.project.id, schema.expiryItem.projectId))
      .where(and(isNull(schema.expiryItem.closedAt), isNull(schema.project.archivedAt), lte(schema.expiryItem.expiresOn, addDays(today, 30))))
      .limit(2000);
    if (items.length === 0) return { reminded: 0 };
    const sent = await tx.select().from(schema.expiryReminder).where(inArray(schema.expiryReminder.itemId, items.map((i) => i.item.id)));
    let reminded = 0;
    for (const { item, projectName } of items) {
      const marks = new Set(sent.filter((x) => x.itemId === item.id && x.expiresOn === item.expiresOn).map((x) => x.mark));
      const mark = expiryReminderMark(item.expiresOn, today, marks);
      if (!mark) continue;
      const [claimed] = await tx.insert(schema.expiryReminder).values({ itemId: item.id, expiresOn: item.expiresOn, mark }).onConflictDoNothing().returning();
      if (!claimed) continue;
      const n = daysBetween(today, item.expiresOn);
      const what = expiryLabel(item.category, item.vendorName ?? item.label);
      const when = n < 0 ? `expired ${-n} day${n === -1 ? "" : "s"} ago` : n === 0 ? "expires today" : `expires in ${n} days`;
      const people = await expiryAudience(tx, item.projectId, FINANCIAL_EXPIRY.has(item.category));
      reminded += await notify(
        tx,
        null,
        people.map((userId) => ({
          userId,
          kind: "expiry" as const,
          title: `${what} ${when}`,
          body: `${projectName} · ${formatIsoDate(item.expiresOn, { month: "short", day: "numeric", year: "numeric" })}`,
          projectId: item.projectId,
          href: `/projects/${item.projectId}?tab=dates`,
        })),
      );
    }
    return { reminded };
  });
}

/**
 * Vendors whose COI has lapsed: an expired, open COI on a live project and no
 * current one anywhere (a renewal filed on another project clears the flag).
 */
export async function vendorsWithExpiredCoi(conn: DbOrTx, today = todayET()): Promise<Map<string, string>> {
  const rows = await conn
    .select({ key: schema.expiryItem.vendorKey, name: schema.expiryItem.vendorName, category: schema.expiryItem.category, expiresOn: schema.expiryItem.expiresOn })
    .from(schema.expiryItem)
    .innerJoin(schema.project, eq(schema.project.id, schema.expiryItem.projectId))
    .where(and(isNull(schema.expiryItem.closedAt), isNotNull(schema.expiryItem.vendorKey), isNull(schema.project.archivedAt), sql`${schema.project.status} <> 'closed'`));
  // The directory's certificates count too: a renewal filed there clears the flag, a lapsed one raises it.
  const cois = [...rows.filter((r) => isVendorCoi(r.category) && r.key), ...(await directoryCois(conn))];
  // Covered per kind of certificate: a current GL doesn't excuse a lapsed workers' comp.
  const current = new Set(cois.filter((r) => r.expiresOn >= today).map((r) => `${r.key}|${r.category}`));
  return new Map(cois.filter((r) => r.expiresOn < today && !current.has(`${r.key}|${r.category}`)).map((r) => [r.key!, r.name ?? r.key!]));
}

/**
 * Projects touched by a vendor with an expired COI (Module B: flag the
 * vendor on every project they are on), via commitments or expiry items.
 */
export async function expiredCoiFlags(conn: DbOrTx, projectIds: string[], today = todayET()): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (projectIds.length === 0) return out;
  const expired = await vendorsWithExpiredCoi(conn, today);
  if (expired.size === 0) return out;
  const commitments = await conn.select({ projectId: schema.commitment.projectId, vendor: schema.commitment.vendorName }).from(schema.commitment).where(inArray(schema.commitment.projectId, projectIds));
  const items = await conn.select({ projectId: schema.expiryItem.projectId, key: schema.expiryItem.vendorKey, name: schema.expiryItem.vendorName }).from(schema.expiryItem).where(and(inArray(schema.expiryItem.projectId, projectIds), isNotNull(schema.expiryItem.vendorKey)));
  const add = (projectId: string, key: string) => {
    const name = expired.get(key);
    if (!name) return;
    const list = out.get(projectId) ?? [];
    if (!list.includes(name)) out.set(projectId, [...list, name]);
  };
  for (const c of commitments) add(c.projectId, vendorKey(c.vendor));
  for (const i of items) if (i.key) add(i.projectId, i.key);
  // Directory links (Module C): invoices, tasks given to the vendor and punch items name them too.
  const invoices = await conn.select({ projectId: schema.invoice.projectId, vendor: schema.invoice.vendorName }).from(schema.invoice).where(inArray(schema.invoice.projectId, projectIds));
  for (const i of invoices) add(i.projectId, vendorKey(i.vendor));
  const tasks = await conn.select({ projectId: schema.task.projectId, key: schema.vendor.key }).from(schema.task).innerJoin(schema.vendor, eq(schema.vendor.id, schema.task.vendorId)).where(inArray(schema.task.projectId, projectIds));
  for (const t of tasks) add(t.projectId, t.key);
  const punch = await conn.select({ projectId: schema.punchItem.projectId, vendor: schema.punchItem.vendorName }).from(schema.punchItem).where(and(inArray(schema.punchItem.projectId, projectIds), isNotNull(schema.punchItem.vendorName)));
  for (const p of punch) add(p.projectId, vendorKey(p.vendor));
  return out;
}

/** Expired items per project (for cards and the Needs-you rail). */
export async function expiredCounts(conn: DbOrTx, projectIds: string[], today = todayET(), includeFinancial: (projectId: string) => boolean = () => true): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (projectIds.length === 0) return out;
  const rows = await conn
    .select({ projectId: schema.expiryItem.projectId, category: schema.expiryItem.category })
    .from(schema.expiryItem)
    .where(and(inArray(schema.expiryItem.projectId, projectIds), isNull(schema.expiryItem.closedAt), sql`${schema.expiryItem.expiresOn} < ${today}`));
  for (const r of rows) if (!FINANCIAL_EXPIRY.has(r.category) || includeFinancial(r.projectId)) out.set(r.projectId, (out.get(r.projectId) ?? 0) + 1);
  return out;
}
