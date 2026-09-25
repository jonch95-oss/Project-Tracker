import "server-only";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env } from "../env";
import * as schema from "./schema";

export type Database = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type DbOrTx = Database | Tx;

const globalForDb = globalThis as unknown as { __pcPool?: Pool; __pcDb?: Database };

/**
 * One pool per process. Neon's free plan scales to zero, so the first query
 * after idle can take a few seconds; the generous connect timeout covers it.
 */
export function db(): Database {
  if (globalForDb.__pcDb) return globalForDb.__pcDb;
  const pool = new Pool({
    connectionString: env().DATABASE_URL,
    // Small per serverless instance (Vercel runs many side by side); DB_POOL_MAX raises it for a single long-running server (load tests).
    max: Number(process.env.DB_POOL_MAX) || (env().NODE_ENV === "production" ? 5 : 10),
    connectionTimeoutMillis: 15_000,
    idleTimeoutMillis: 30_000,
  });
  globalForDb.__pcPool = pool;
  globalForDb.__pcDb = drizzle(pool, { schema });
  return globalForDb.__pcDb;
}

export async function closeDb(): Promise<void> {
  await globalForDb.__pcPool?.end();
  globalForDb.__pcPool = undefined;
  globalForDb.__pcDb = undefined;
}

export { schema };
