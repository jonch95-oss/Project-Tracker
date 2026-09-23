/** Verify the audit hash chain of DATABASE_URL (used by the restore drill). */
import { asc, eq, gte } from "drizzle-orm";
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
  // Optional anchor "<seq> <hash>" recorded off-database by the backup job:
  // the chain must still contain it, which detects entries cut from the end.
  const i = process.argv.indexOf("--anchor");
  if (i >= 0) {
    const [aSeq, aHash] = (process.argv[i + 1] ?? "").trim().split(/\s+/);
    if (Number(aSeq) > 0) {
      const [row] = await db().select().from(schema.auditLog).where(eq(schema.auditLog.seq, Number(aSeq)));
      if (!row || row.hash !== aHash) {
        console.error(`ANCHOR MISMATCH: entry #${aSeq} is missing or altered (log truncated or rewritten).`);
        process.exit(1);
      }
      console.log(`Anchor #${aSeq} matches.`);
    }
  }
  console.log(`Audit chain intact: ${checked} entries.`);
  await closeDb();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
