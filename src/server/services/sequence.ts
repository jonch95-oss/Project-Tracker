import "server-only";
import { sql } from "drizzle-orm";
import { schema, type DbOrTx } from "../db";

/**
 * The next number for a project's RFIs, submittals, punch items, change
 * orders… Numbers are never reused, even after deletes (the sequence only
 * moves forward), and `current` seeds it from what already exists.
 */
export async function nextSequence(tx: DbOrTx, projectId: string, kind: string, current: number): Promise<number> {
  const [r] = await tx
    .insert(schema.projectSequence)
    .values({ projectId, kind, last: current + 1 })
    .onConflictDoUpdate({ target: [schema.projectSequence.projectId, schema.projectSequence.kind], set: { last: sql`greatest(${schema.projectSequence.last}, ${current}) + 1` } })
    .returning({ last: schema.projectSequence.last });
  return r!.last;
}
