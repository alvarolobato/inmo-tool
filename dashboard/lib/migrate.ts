/**
 * Schema migration runner — applies etl/schema/init.sql against PostgreSQL.
 *
 * The same init.sql is the single source of truth for the schema and is
 * also applied by the ETL container on startup (etl/main.py:_init_schema).
 * Running it from the dashboard too means a fresh `docker compose up
 * dashboard` against an older Postgres volume will pick up any new tables
 * the dashboard requires (e.g. `conversations` was added by a feature PR
 * but never made it into the running DB because the ETL container hadn't
 * been recreated since).
 *
 * Safety:
 *  - init.sql uses CREATE TABLE / INDEX IF NOT EXISTS, so it is idempotent.
 *  - A race with ETL's own init step is harmless for the same reason.
 *  - The runner is non-fatal: if it fails (e.g. DB not reachable at build
 *    time during Next.js prerender), the app still starts and the failure
 *    is logged.
 */

import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { getPool } from "@/lib/db-write";

const DEFAULT_SCHEMA_PATH = "/app/schema/init.sql";

function resolveSchemaPath(): string | null {
  const envPath = process.env.SCHEMA_SQL_PATH;
  if (envPath && existsSync(envPath)) return envPath;
  if (existsSync(DEFAULT_SCHEMA_PATH)) return DEFAULT_SCHEMA_PATH;
  // Dev/CI: dashboard/ is cwd, init.sql lives at ../etl/schema/init.sql
  const devPath = resolve(process.cwd(), "..", "etl", "schema", "init.sql");
  if (existsSync(devPath)) return devPath;
  return null;
}

export async function applyInitSql(): Promise<{
  applied: boolean;
  reason?: string;
  error?: string;
}> {
  const schemaPath = resolveSchemaPath();
  if (!schemaPath) {
    return {
      applied: false,
      reason: `init.sql not mounted (looked at SCHEMA_SQL_PATH and ${DEFAULT_SCHEMA_PATH})`,
    };
  }

  let sql: string;
  try {
    sql = readFileSync(schemaPath, "utf-8");
  } catch (err) {
    return {
      applied: false,
      reason: "could not read init.sql",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query(sql);
    return { applied: true };
  } catch (err) {
    return {
      applied: false,
      reason: "init.sql execution failed",
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    client.release();
  }
}
