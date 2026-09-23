/** Verify the audit hash chain of DATABASE_URL (used by the restore drill). */
import { asc, gte } from "drizzle-orm";
import { GENESIS_HASH, verifyAuditChain } from "../src/core/audit";

async function main() {
  const { db, schema, closeDb } = await import("../src/server/db");
  const { rowToEntry } = await import("../src/server/services/audit");
  let prev = GENESIS_HASH;
  let seq = 1;
  let checked = 0;
  for (;;) {
    const rows = await db().select().from(schema.auditLog).where(gte(schema.auditLog.seq, seq)).orderBy(asc(schema.auditLog.seq)).limit(1000);
    if (!rows.length) break;
    const r = await verifyAuditChain(rows.map(rowToEntry), prev, seq);
    if (!r.ok) {
      console.error(`BROKEN at #${r.brokenAtSeq}: ${r.reason}`);
      process.exit(1);
    }
    checked += r.checked;
    prev = r.lastHash;
    seq += rows.length;
  }
  console.log(`Audit chain intact: ${checked} entries.`);
  await closeDb();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
