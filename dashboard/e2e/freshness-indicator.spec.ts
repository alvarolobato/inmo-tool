/**
 * E2E: TopBar freshness indicator (issue #241).
 *
 * The indicator (dashboard/components/FreshnessContext.tsx → TopBar) used to
 * read the PowerShop-era `etl_watermarks` table the connector pipeline never
 * writes, so it degraded to the bare default "Datos al día" (no age) on every
 * page — a silent false-negative that never looked broken. It now derives
 * from `connector_run_results` / `connector_config`.
 *
 * The load-bearing assertion is exactly the mutation guard: with a real
 * successful connector run seeded, the pill must render a real
 * connector-derived state (an age "hace Xh", or "desactualizados", or "sin
 * sincronizar") — NOT the empty "Datos al día" fallback the dead
 * etl_watermarks version produced. A regression back to the watermark table
 * would return an empty payload and fail this test.
 *
 * Requires a reachable Postgres and ADMIN_API_KEY (middleware.ts gates every
 * UI page). Skips cleanly otherwise, matching the other specs here.
 */
import { test, expect } from "@playwright/test";
import { Pool } from "pg";

function buildPool(): Pool {
  const dsn = process.env.POSTGRES_DSN;
  if (dsn) return new Pool({ connectionString: dsn, max: 2 });
  return new Pool({
    host: process.env.POSTGRES_HOST || "localhost",
    port: parseInt(process.env.POSTGRES_PORT || "5432", 10),
    user: process.env.POSTGRES_USER || "postgres",
    password: process.env.POSTGRES_PASSWORD || "",
    database: process.env.POSTGRES_DB || "inmotool",
    max: 2,
  });
}

const CONNECTOR = "e2e-freshness-conn";
const TRIGGER = "e2e-freshness";

let pool: Pool;
let dbAvailable = false;

test.beforeAll(async () => {
  pool = buildPool();
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn(
      "[freshness-indicator.spec] no reachable Postgres - skipping. " +
        "Set POSTGRES_DSN (or POSTGRES_HOST/PORT/USER/PASSWORD/DB) to run it.",
    );
    return;
  }

  await pool.query("DELETE FROM connector_runs WHERE trigger = $1", [TRIGGER]);
  await pool.query("DELETE FROM connector_config WHERE connector_name = $1", [CONNECTOR]);
  await pool.query("DELETE FROM connector_registry WHERE connector_name = $1", [CONNECTOR]);

  // Registered + enabled, mirroring orchestrator.sync_connector_registry().
  await pool.query(
    `INSERT INTO connector_registry
        (connector_name, registered, rate_limit_per_minute, discovers_full_inventory,
         supports_discovery, supported_filters)
     VALUES ($1, true, 20, false, true, '[]'::jsonb)`,
    [CONNECTOR],
  );
  await pool.query(
    `INSERT INTO connector_config (connector_name, enabled) VALUES ($1, true)`,
    [CONNECTOR],
  );

  // A successful run 20 minutes ago — real, recent freshness.
  const run = await pool.query<{ id: number }>(
    `INSERT INTO connector_runs (trigger, started_at, finished_at, duration_ms, status,
        connectors_ok, connectors_failed, total_connectors)
     VALUES ($1, NOW() - INTERVAL '22 minutes', NOW() - INTERVAL '20 minutes',
             120000, 'success', 1, 0, 1)
     RETURNING id`,
    [TRIGGER],
  );
  await pool.query(
    `INSERT INTO connector_run_results
        (run_id, connector_name, started_at, finished_at, status,
         discovered_count, fetched_count, error_count)
     VALUES ($1, $2, NOW() - INTERVAL '22 minutes', NOW() - INTERVAL '20 minutes',
             'ok', 12, 10, 0)`,
    [run.rows[0].id, CONNECTOR],
  );
});

test.afterAll(async () => {
  if (dbAvailable) {
    await pool.query("DELETE FROM connector_runs WHERE trigger = $1", [TRIGGER]);
    await pool.query("DELETE FROM connector_config WHERE connector_name = $1", [CONNECTOR]);
    await pool.query("DELETE FROM connector_registry WHERE connector_name = $1", [CONNECTOR]);
  }
  await pool?.end();
});

test.beforeEach(async ({ context, baseURL }) => {
  test.skip(!dbAvailable, "no reachable Postgres");
  const adminKey = process.env.ADMIN_API_KEY?.trim();
  test.skip(!adminKey, "ADMIN_API_KEY unset — middleware.ts gates every page");
  await context.addCookies([
    {
      name: "ps_admin",
      value: adminKey as string,
      url: baseURL ?? "http://localhost:4000",
    },
  ]);
});

test("freshness pill renders real connector-derived freshness, not the empty fallback", async ({
  page,
}) => {
  await page.goto("/");

  const pill = page.getByTestId("freshness-indicator");
  await expect(pill).toBeVisible();

  // Real connector state: an age, a "desactualizados", or "sin sincronizar".
  // The dead etl_watermarks version rendered exactly "Datos al día" with no
  // age — this regex fails against that empty fallback, which is the point.
  await expect(pill).toHaveText(/hace \d+|desactualizados|sin sincronizar/);

  // No error surface anywhere on the page.
  await expect(page.getByTestId("error-display")).toHaveCount(0);
  await expect(page.getByText("Detalles técnicos")).toHaveCount(0);
});
