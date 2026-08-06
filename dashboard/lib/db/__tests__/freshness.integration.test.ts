/**
 * Real-Postgres integration test for issue #241 — the freshness indicator
 * must derive from the connector pipeline's own tables
 * (`connector_registry` / `connector_config` / `connector_run_results`),
 * NOT the dead PowerShop-era `etl_watermarks` table.
 *
 * Why real Postgres (a mocked query can't prove this): the exact bug being
 * fixed is that the old route queried a permanently-empty table and
 * degraded to a silent "200 + empty" that never looked broken. The
 * mutation-guard test below seeds a real successful connector run and
 * asserts the endpoint reports it — so a regression back to querying
 * `etl_watermarks` (which is never written and would return nothing) fails
 * loudly instead of silently returning empty again.
 *
 * Skips cleanly when no database is reachable; REQUIRE_DB=1 makes that a
 * hard failure (see AGENTS.md / etl/tests/conftest.py's contract).
 */
import { describe, it, expect, afterAll, afterEach } from "vitest";
import { Pool } from "pg";
import { buildPgPoolConfig } from "@/lib/db-shared";
import { resetPool as resetWritePool } from "@/lib/db-write";
import { resetPool as resetReadPool } from "@/lib/db";
import { getConnectorFreshness } from "../freshness";
import { GET as dataHealthGET } from "@/app/api/data-health/route";

const PREFIX = "zzz_test_freshness_";
const C_FRESH = `${PREFIX}fresh`;
const C_STALE = `${PREFIX}stale`;
const C_NEVER = `${PREFIX}never`;
const C_DISABLED = `${PREFIX}disabled`;
const C_REFRESHING = `${PREFIX}refreshing`;
const C_STUCK = `${PREFIX}stuck`;

const HOUR_MS = 60 * 60 * 1000;

async function withRealDb(fn: (pool: Pool) => Promise<void>) {
  const pool = new Pool(buildPgPoolConfig({ max: 2 }));
  try {
    await fn(pool);
  } finally {
    await pool.end();
  }
}

const REQUIRE_DB = process.env.REQUIRE_DB === "1";

const dbAvailable = await (async () => {
  const pool = new Pool(buildPgPoolConfig({ max: 1 }));
  try {
    await pool.query("SELECT 1");
    return true;
  } catch (err) {
    if (REQUIRE_DB) {
      throw new Error(
        "REQUIRE_DB=1 but Postgres is unreachable for freshness.integration.test.ts " +
          `(POSTGRES_DSN unset, or DB down): ${String(err)}`,
      );
    }
    // eslint-disable-next-line no-console
    console.warn(
      "[freshness.integration.test] no reachable Postgres (POSTGRES_DSN unset or DB down) " +
        "- skipping real-DB tests. Set POSTGRES_DSN to run them.",
    );
    return false;
  } finally {
    await pool.end().catch(() => {});
  }
})();

/** Insert a run + one result row for `connector` with a given status/age. */
async function seedRun(
  pool: Pool,
  connector: string,
  status: string,
  finishedAgoMs: number,
): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    "INSERT INTO connector_runs (trigger, status) VALUES ('test', 'success') RETURNING id",
  );
  const runId = rows[0].id;
  await pool.query(
    `INSERT INTO connector_run_results
        (run_id, connector_name, status, started_at, finished_at,
         discovered_count, fetched_count, error_count)
     VALUES ($1, $2, $3,
             NOW() - ($4::double precision * interval '1 millisecond'),
             NOW() - ($4::double precision * interval '1 millisecond'),
             0, 0, 0)`,
    [runId, connector, status, finishedAgoMs],
  );
  return runId;
}

async function seedRegistry(pool: Pool, connector: string): Promise<void> {
  await pool.query(
    `INSERT INTO connector_registry (connector_name, registered, supports_discovery)
     VALUES ($1, true, true)
     ON CONFLICT (connector_name) DO UPDATE SET registered = true`,
    [connector],
  );
}

async function seedConfig(
  pool: Pool,
  connector: string,
  enabled: boolean,
): Promise<void> {
  await pool.query(
    `INSERT INTO connector_config (connector_name, enabled)
     VALUES ($1, $2)
     ON CONFLICT (connector_name) DO UPDATE SET enabled = EXCLUDED.enabled`,
    [connector, enabled],
  );
}

/**
 * Seed a `connector_freshness_state` row — the new source of truth for
 * staleness (issue #295, D-050). `lastFreshAgoMs` = when the last cycle
 * completed (null = never fresh); `cycleStartedAgoMs` = when the in-progress
 * cycle started (null = idle). Both in ms-ago from NOW().
 */
async function seedFreshness(
  pool: Pool,
  connector: string,
  opts: {
    lastFreshAgoMs?: number | null;
    cycleStartedAgoMs?: number | null;
    targetScopeCount?: number | null;
  } = {},
): Promise<void> {
  const { lastFreshAgoMs = null, cycleStartedAgoMs = null, targetScopeCount = null } = opts;
  await pool.query(
    `INSERT INTO connector_freshness_state
        (connector_name, last_fresh_at, cycle_started_at, cycle_target_scope_count)
     VALUES (
       $1,
       CASE WHEN $2::double precision IS NULL THEN NULL
            ELSE NOW() - ($2::double precision * interval '1 millisecond') END,
       CASE WHEN $3::double precision IS NULL THEN NULL
            ELSE NOW() - ($3::double precision * interval '1 millisecond') END,
       $4::integer
     )
     ON CONFLICT (connector_name) DO UPDATE
        SET last_fresh_at = EXCLUDED.last_fresh_at,
            cycle_started_at = EXCLUDED.cycle_started_at,
            cycle_target_scope_count = EXCLUDED.cycle_target_scope_count`,
    [connector, lastFreshAgoMs, cycleStartedAgoMs, targetScopeCount],
  );
}

describe.runIf(dbAvailable)("issue #241 — connector freshness (real Postgres)", () => {
  afterAll(async () => {
    await resetWritePool();
    await resetReadPool();
  });

  afterEach(async () => {
    await withRealDb(async (pool) => {
      // connector_run_results cascades on connector_runs delete.
      await pool.query(
        "DELETE FROM connector_runs WHERE id IN (SELECT run_id FROM connector_run_results WHERE connector_name LIKE $1)",
        [`${PREFIX}%`],
      );
      await pool.query("DELETE FROM connector_run_results WHERE connector_name LIKE $1", [
        `${PREFIX}%`,
      ]);
      await pool.query("DELETE FROM connector_freshness_state WHERE connector_name LIKE $1", [
        `${PREFIX}%`,
      ]);
      await pool.query("DELETE FROM connector_config WHERE connector_name LIKE $1", [
        `${PREFIX}%`,
      ]);
      await pool.query("DELETE FROM connector_registry WHERE connector_name LIKE $1", [
        `${PREFIX}%`,
      ]);
    });
  });

  it("derives per-connector staleness from connector_freshness_state (issue #295)", async () => {
    await withRealDb(async (pool) => {
      // Enabled + last cycle completed 30 min ago, no cycle in progress → fresh.
      await seedRegistry(pool, C_FRESH);
      await seedConfig(pool, C_FRESH, true);
      await seedFreshness(pool, C_FRESH, { lastFreshAgoMs: 0.5 * HOUR_MS });
      await seedRun(pool, C_FRESH, "ok", 0.5 * HOUR_MS);

      // Enabled + last fresh 30h ago (> 24h default), no cycle → due → stale.
      // A more recent failed run drives lastRunStatus, not staleness.
      await seedRegistry(pool, C_STALE);
      await seedConfig(pool, C_STALE, true);
      await seedFreshness(pool, C_STALE, { lastFreshAgoMs: 30 * HOUR_MS });
      await seedRun(pool, C_STALE, "failed", 1 * HOUR_MS);

      // Enabled + registered but no freshness row → never fresh → due → stale.
      await seedRegistry(pool, C_NEVER);
      await seedConfig(pool, C_NEVER, true);

      // Disabled + long-overdue → reported but NEVER counted as stale.
      await seedRegistry(pool, C_DISABLED);
      await seedConfig(pool, C_DISABLED, false);
      await seedFreshness(pool, C_DISABLED, { lastFreshAgoMs: 30 * HOUR_MS });
    });

    const health = await getConnectorFreshness();
    const byName = new Map(health.connectors.map((c) => [c.connector, c]));

    // Mutation guard: the seeded connectors MUST appear with real data. A
    // regression to querying etl_watermarks would leave this map empty.
    expect(byName.has(C_FRESH)).toBe(true);
    expect(byName.has(C_STALE)).toBe(true);
    expect(byName.has(C_NEVER)).toBe(true);
    expect(byName.has(C_DISABLED)).toBe(true);

    const fresh = byName.get(C_FRESH)!;
    expect(fresh.enabled).toBe(true);
    expect(fresh.lastSuccessAt).not.toBeNull();
    expect(fresh.lastRunStatus).toBe("ok");
    expect(fresh.isStale).toBe(false);

    const stale = byName.get(C_STALE)!;
    expect(stale.isStale).toBe(true);
    expect(stale.lastSuccessAt).not.toBeNull();
    // Latest run of ANY status reflects the current failing state, not the
    // last good one — the whole point of a truthful freshness surface.
    expect(stale.lastRunStatus).toBe("failed");

    const never = byName.get(C_NEVER)!;
    expect(never.lastSuccessAt).toBeNull();
    expect(never.lastRunAt).toBeNull();
    expect(never.isStale).toBe(true);

    const disabled = byName.get(C_DISABLED)!;
    expect(disabled.enabled).toBe(false);
    // Disabled connector is reported but its staleness is never asserted.
    expect(disabled.isStale).toBe(false);

    // Any enabled stale connector makes the whole surface stale.
    expect(health.overallStale).toBe(true);
    // The stalest enabled connector must be a never-succeeded one (null
    // success sorts oldest) — never the disabled one.
    expect(health.stalestConnector).not.toBeNull();
    expect(health.stalestConnector!.lastSuccessAt).toBeNull();
    expect(health.stalestConnector!.connector).not.toBe(C_DISABLED);
  });

  it("GET /api/data-health returns the seeded run (endpoint, not just helper)", async () => {
    await withRealDb(async (pool) => {
      await seedRegistry(pool, C_FRESH);
      await seedConfig(pool, C_FRESH, true);
      await seedFreshness(pool, C_FRESH, { lastFreshAgoMs: 0.5 * HOUR_MS });
      await seedRun(pool, C_FRESH, "ok", 0.5 * HOUR_MS);
    });

    const res = await dataHealthGET();
    expect(res.status).toBe(200);
    const body = await res.json();

    // Mutation guard at the HTTP boundary: the endpoint must surface real
    // connector freshness. The dead etl_watermarks version returned `[]`.
    expect(Array.isArray(body.connectors)).toBe(true);
    const fresh = body.connectors.find(
      (c: { connector: string }) => c.connector === C_FRESH,
    );
    expect(fresh).toBeDefined();
    expect(fresh.lastSuccessAt).not.toBeNull();
    expect(fresh.isStale).toBe(false);
  });

  it("a mid-cycle connector is refreshing (not stale); a long-stuck one is stale (issue #295)", async () => {
    await withRealDb(async (pool) => {
      // Cycle in progress, started 1h ago (< 168h stuck horizon) → refreshing.
      await seedRegistry(pool, C_REFRESHING);
      await seedConfig(pool, C_REFRESHING, true);
      await seedFreshness(pool, C_REFRESHING, {
        lastFreshAgoMs: 30 * HOUR_MS, // last completed a while ago…
        cycleStartedAgoMs: 1 * HOUR_MS, // …but a fresh cycle is underway now
        targetScopeCount: 3,
      });

      // Cycle in progress but started 200h ago (> 168h stuck horizon) → stuck.
      await seedRegistry(pool, C_STUCK);
      await seedConfig(pool, C_STUCK, true);
      await seedFreshness(pool, C_STUCK, {
        lastFreshAgoMs: null,
        cycleStartedAgoMs: 200 * HOUR_MS,
        targetScopeCount: 5,
      });
    });

    const health = await getConnectorFreshness();
    const refreshing = health.connectors.find((x) => x.connector === C_REFRESHING)!;
    const stuck = health.connectors.find((x) => x.connector === C_STUCK)!;

    // Mid-cycle-not-stuck: a live refresh, NOT a problem.
    expect(refreshing.state).toBe("refreshing");
    expect(refreshing.isStale).toBe(false);

    // A cycle that has run far past the stuck horizon reads as stale (needs
    // attention) but is never falsely marked fresh.
    expect(stuck.state).toBe("stuck");
    expect(stuck.isStale).toBe(true);

    // The whole surface distinguishes the two: refreshing is signalled
    // separately from stale.
    expect(health.overallRefreshing).toBe(true);
    expect(health.overallStale).toBe(true);
  });
});
