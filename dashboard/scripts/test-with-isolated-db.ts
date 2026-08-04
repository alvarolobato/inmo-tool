#!/usr/bin/env tsx
/**
 * Wraps `vitest run` (or `vitest` in watch mode, or `vitest run --coverage`)
 * with a throwaway, per-invocation PostgreSQL database — issue #159.
 *
 * Why a wrapper script rather than a vitest `globalSetup`: vitest spawns
 * test files across a worker pool (threads or forks), and `globalSetup`
 * mutating `process.env` is not guaranteed to propagate into workers spawned
 * before or independently of that mutation across vitest versions/pool
 * types — an assumption not worth resting per-run test isolation on. A
 * wrapper that sets the env *before* the `vitest` process (and therefore
 * every worker it forks) even starts sidesteps the question entirely: every
 * child inherits `process.env` at fork time, unconditionally.
 *
 * What this does:
 *   1. Resolve whatever POSTGRES_* config is already in the environment
 *      (same resolution `buildPgPoolConfig` uses — POSTGRES_DSN, else the
 *      split POSTGRES_HOST/PORT/USER/PASSWORD/DB vars) and try to reach it.
 *      If nothing is reachable, run `vitest` unmodified — every
 *      `*.integration.test.ts` file already self-skips via its own
 *      `dbAvailable` check, so there is nothing to isolate.
 *   2. If reachable, CREATE DATABASE for a fresh, uniquely-named database,
 *      apply etl/schema/init.sql to it once, and run `vitest` with
 *      POSTGRES_DSN (and POSTGRES_DB) pointed at that database instead of
 *      whatever was configured.
 *   3. Always drop the database afterward (success, failure, or a signal),
 *      even if `vitest` itself crashes.
 *
 * A crashed/interrupted run simply leaves an orphaned, uniquely-named
 * database behind — nothing else ever reads it, so it can't poison a later
 * run (the "interrupted run must not affect the next run" acceptance
 * criterion) — dropping it here is cleanliness, not correctness.
 *
 * Usage (see package.json's `test`/`test:watch`/`test:coverage` scripts):
 *   tsx scripts/test-with-isolated-db.ts run
 *   tsx scripts/test-with-isolated-db.ts run --coverage
 *   tsx scripts/test-with-isolated-db.ts            (watch mode)
 */

import { spawn } from "child_process";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Client } from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const SCHEMA_SQL_PATH = path.join(REPO_ROOT, "etl", "schema", "init.sql");

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`[test-with-isolated-db] ${msg}`);
}

/** Postgres-identifier-safe, collision-resistant database name for one test run. */
function uniqueDbName(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `inmotool_test_${Date.now()}_${rand}`;
}

/** DSN pointing at the currently-configured database (same resolution as buildPgPoolConfig). */
function currentDsn(): string {
  const dsn = process.env.POSTGRES_DSN;
  if (dsn) return dsn;
  const host = process.env.POSTGRES_HOST || "localhost";
  const port = process.env.POSTGRES_PORT || "5432";
  const user = process.env.POSTGRES_USER || "postgres";
  const password = process.env.POSTGRES_PASSWORD || "";
  const db = process.env.POSTGRES_DB || "inmotool";
  const auth = password
    ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}`
    : encodeURIComponent(user);
  return `postgresql://${auth}@${host}:${port}/${db}`;
}

/** *dsn* with its database (path) replaced by *dbName*; everything else untouched. */
function dsnWithDb(dsn: string, dbName: string): string {
  const url = new URL(dsn);
  url.pathname = `/${dbName}`;
  return url.toString();
}

async function isReachable(dsn: string): Promise<boolean> {
  const client = new Client({ connectionString: dsn, connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    await client.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

async function createDatabase(adminDsn: string, dbName: string): Promise<void> {
  const client = new Client({ connectionString: adminDsn, connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    // CREATE DATABASE cannot run inside a transaction block; node-postgres
    // clients aren't in one by default for a single statement, so a plain
    // query is fine here.
    await client.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await client.end();
  }
}

async function applySchema(dsn: string): Promise<void> {
  const sql = readFileSync(SCHEMA_SQL_PATH, "utf-8");
  const client = new Client({ connectionString: dsn, connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    // No params -> node-postgres uses the simple query protocol, which
    // (like psycopg2's cursor.execute on a multi-statement string) allows
    // multiple ;-separated statements in one call.
    await client.query(sql);
  } finally {
    await client.end();
  }
}

async function dropDatabase(adminDsn: string, dbName: string): Promise<void> {
  const client = new Client({ connectionString: adminDsn, connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    // Terminate any lingering backends (a pool that didn't close cleanly)
    // before dropping — DROP DATABASE fails while sessions are attached.
    await client.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [dbName],
    );
    await client.query(`DROP DATABASE IF EXISTS "${dbName}"`);
  } catch (err) {
    log(`warning: failed to drop database "${dbName}": ${(err as Error).message}`);
  } finally {
    await client.end().catch(() => {});
  }
}

function runVitest(env: NodeJS.ProcessEnv): Promise<number> {
  const args = process.argv.slice(2);
  const vitestArgs = args.length > 0 ? args : ["run"];
  return new Promise((resolve) => {
    const child = spawn("npx", ["vitest", ...vitestArgs], {
      stdio: "inherit",
      env,
      cwd: path.resolve(__dirname, ".."),
    });
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", (err) => {
      log(`failed to spawn vitest: ${err.message}`);
      resolve(1);
    });
  });
}

async function main(): Promise<void> {
  const adminDsn = currentDsn();

  if (!(await isReachable(adminDsn))) {
    // Issue #160: skipped and passed are indistinguishable on the PR page. Of
    // the 18 *.integration.test.ts files, only 7 throw under REQUIRE_DB=1; the
    // other 11 use `describe.runIf(dbAvailable)`, which warns and passes green.
    // So a missing database on the vitest side is only *partly* a hard error at
    // the file level. Enforce it here at the wrapper level instead: when CI
    // sets REQUIRE_DB=1 and the admin DSN is unreachable, fail loudly rather
    // than run a suite where most DB-backed files quietly no-op. Locally,
    // without REQUIRE_DB, the old skip-and-run behaviour is unchanged.
    if (process.env.REQUIRE_DB === "1") {
      log(
        "REQUIRE_DB=1 but Postgres is unreachable (admin DSN unset or DB down). " +
          "Refusing to run — a green suite with every DB-backed file skipped is " +
          "exactly the false pass issue #160 exists to prevent.",
      );
      process.exit(1);
    }
    log(
      "no reachable Postgres (POSTGRES_DSN unset or DB down) — running vitest without an " +
        "isolated database; *.integration.test.ts files self-skip individually.",
    );
    const code = await runVitest(process.env);
    process.exit(code);
  }

  const dbName = uniqueDbName();
  log(`creating isolated test database "${dbName}"`);
  await createDatabase(adminDsn, dbName);

  const testDsn = dsnWithDb(adminDsn, dbName);
  await applySchema(testDsn);
  log(`schema applied — running vitest against "${dbName}"`);

  let exitCode = 1;
  let cleanedUp = false;
  const cleanup = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    log(`dropping isolated test database "${dbName}"`);
    await dropDatabase(adminDsn, dbName);
  };

  // Drop the database on a signal too (Ctrl-C, CI job cancellation), not
  // just on a clean exit — an interrupted run must not leave state behind
  // for the next run to trip over.
  const onSignal = (signal: NodeJS.Signals) => {
    cleanup().finally(() => process.exit(128 + (signal === "SIGINT" ? 2 : 15)));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    exitCode = await runVitest({
      ...process.env,
      POSTGRES_DSN: testDsn,
      POSTGRES_DB: dbName,
    });
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    await cleanup();
  }

  process.exit(exitCode);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[test-with-isolated-db] fatal:", err);
  process.exit(1);
});
