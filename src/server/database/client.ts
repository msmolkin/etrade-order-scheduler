import pg from "pg";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import type { QueryResultRow } from "pg";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Test connection
pool.on("connect", () => {
  console.log("✓ Connected to PostgreSQL database");
});

pool.on("error", (err) => {
  console.error("Unexpected error on idle database client", err);
  process.exit(-1);
});

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: any[],
): Promise<pg.QueryResult<T>> {
  const start = Date.now();
  try {
    const result = await pool.query<T>(text, params);
    const duration = Date.now() - start;
    if (duration > 1000) {
      console.warn(`Slow query (${duration}ms):`, text);
    }
    return result;
  } catch (error) {
    console.error("Database query error:", error);
    throw error;
  }
}

export async function transaction<T>(
  callback: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function healthCheck(): Promise<boolean> {
  try {
    await query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

/** Applies schema.sql (CREATE TABLE IF NOT EXISTS, etc.). Safe to run on every startup. */
export async function runSchema(): Promise<{ ok: boolean; error?: string }> {
  try {
    const schemaPath = path.join(__dirname, "schema.sql");
    const schema = fs.readFileSync(schemaPath, "utf8");
    await pool.query(schema);
    return { ok: true };
  } catch (err: any) {
    const msg = err?.message || String(err);
    return { ok: false, error: msg };
  }
}
