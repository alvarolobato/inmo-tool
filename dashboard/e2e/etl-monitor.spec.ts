/**
 * E2E: connector monitor UI (issue #104).
 *
 * The monitor was inherited from powershop-analytics and kept reading that
 * project's per-table sync tables (`etl_sync_runs`/`etl_sync_run_tables`),
 * which nothing has written to since Phase 1.1 — so the page rendered empty
 * against a schema whose real observability data lives in `connector_runs`/
 * `connector_run_results`. This drives the repointed UI against real seeded
 * rows in those tables.
 *
 * Deliberately seeds the two states the per-table model had no concept of
 * and which therefore had never been rendered anywhere: `circuit_open` (a
 * connector tripped its breaker mid-run) and `skipped` (an operator
 * disabled it via connector_config, issue #99).
 *
 * Requires a reachable Postgres (POSTGRES_DSN, or the individual
 * POSTGRES_HOST/PORT/USER/PASSWORD/DB vars) with the current schema applied.
 * Skips cleanly if no DB is reachable, matching the other specs here.
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

const TRIGGER = "e2e-monitor";

let pool: Pool;
let dbAvailable = false;
let runId: number;

test.beforeAll(async () => {
  pool = buildPool();
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn(
      "[etl-monitor.spec] no reachable Postgres - skipping e2e suite. " +
        "Set POSTGRES_DSN (or POSTGRES_HOST/PORT/USER/PASSWORD/DB) to run it.",
    );
    return;
  }

  // A finished run: 1 ok, 1 circuit_open (counted as failed by the
  // orchestrator), 1 skipped — mirroring how run_all_connectors tallies.
  const runResult = await pool.query<{ id: number }>(
    `INSERT INTO connector_runs
        (trigger, started_at, finished_at, duration_ms, status,
         connectors_ok, connectors_failed, connectors_skipped, total_connectors)
     VALUES ($1, NOW() - INTERVAL '10 minutes', NOW() - INTERVAL '8 minutes',
             120000, 'partial', 1, 1, 1, 3)
     RETURNING id`,
    [TRIGGER],
  );
  runId = runResult.rows[0].id;

  // fotocasa carries a resolved geography_scope (issue #109) and no failure
  // classification (clean); milanuncios carries a typed failure_classification
  // (issue #242) alongside its circuit_open. Both drive the run-detail UI.
  await pool.query(
    `INSERT INTO connector_run_results
        (run_id, connector_name, started_at, finished_at, status,
         discovered_count, fetched_count, error_count, error_msg,
         failure_classification, geography_scope, extraction_quality_summary)
     VALUES
        ($1, 'fotocasa',    NOW() - INTERVAL '10 minutes', NOW() - INTERVAL '9 minutes',
         'ok', 31, 28, 3, NULL, NULL,
         $2::jsonb, $3::jsonb),
        ($1, 'milanuncios', NOW() - INTERVAL '9 minutes',  NOW() - INTERVAL '8 minutes',
         'circuit_open', 41, 4, 8, 'circuit breaker open after 8/10 errors',
         'structure_change', NULL, NULL),
        ($1, 'idealista',   NOW() - INTERVAL '8 minutes',  NOW() - INTERVAL '8 minutes',
         'skipped', 0, 0, 0, 'disabled via connector_config', NULL, NULL, NULL)`,
    [
      runId,
      JSON.stringify([
        {
          scope_key: "madrid-capital",
          center: [40.4168, -3.7038],
          radius_km: 10,
          rooms: null,
          outcome: "crawled",
        },
      ]),
      // Issue #171: fotocasa ran healthy — a run-level extraction-quality
      // aggregate with a stable trend (not degraded).
      JSON.stringify({
        n: 28,
        mean_score: 0.88,
        grade_histogram: { A: 20, B: 6, C: 2, F: 0 },
        low_quality_count: 2,
        weights_version: 1,
        trend: {
          baseline_mean: 0.86,
          baseline_n_runs: 4,
          delta: 0.02,
          degraded: false,
        },
      }),
    ],
  );
});

test.afterAll(async () => {
  if (dbAvailable) {
    // ON DELETE CASCADE on connector_run_results.run_id clears the children.
    await pool.query("DELETE FROM connector_runs WHERE trigger = $1", [TRIGGER]);
  }
  await pool?.end();
});

test.beforeEach(async ({ context, baseURL }) => {
  test.skip(!dbAvailable, "no reachable Postgres");
  const adminKey = process.env.ADMIN_API_KEY?.trim();
  test.skip(
    !adminKey,
    "ADMIN_API_KEY unset — /etl is admin-gated by middleware.ts and would " +
      "redirect to /admin/login",
  );
  // The monitor sits behind the same admin gate as the rest of /etl (see
  // middleware.ts's matcher). Seed the session cookie /admin/login would set
  // rather than driving the login form on every spec.
  await context.addCookies([
    {
      name: "ps_admin",
      value: adminKey as string,
      url: baseURL ?? "http://localhost:4000",
    },
  ]);
});

test("monitor lists real connector runs with funnel counts and no error surface", async ({
  page,
}) => {
  await page.goto("/etl");

  await expect(page.getByTestId("run-list")).toBeVisible();
  const row = page.getByTestId(`run-row-${runId}`);
  await expect(row).toBeVisible();

  // Funnel totals are aggregated from connector_run_results (31+41+0 found,
  // 28+4+0 stored) — the run table itself stores no such column.
  await expect(row).toContainText("72");
  await expect(row).toContainText("32");

  // ok / failed / skipped — the skipped segment only appears because one is.
  await expect(page.getByTestId(`run-connectors-${runId}`)).toContainText("1 / 1 / 1");

  // No error surface anywhere on the page.
  await expect(page.getByTestId("error-display")).toHaveCount(0);
  await expect(page.getByText("Detalles técnicos")).toHaveCount(0);
});

test("run detail shows the per-connector funnel and the two new statuses", async ({
  page,
}) => {
  await page.goto(`/etl/${runId}`);

  await expect(page.getByTestId("run-detail")).toBeVisible();
  await expect(page.getByTestId("connector-stats")).toBeVisible();

  const fotocasa = page.getByTestId("connector-row-fotocasa");
  await expect(fotocasa).toContainText("31"); // discovered
  await expect(fotocasa).toContainText("28"); // fetched
  await expect(fotocasa).toContainText("3"); // errored

  // Both states the inherited per-table UI could not express. Scoped to the
  // connector's own row: "Circuito abierto" also appears as a chart-legend
  // label, and an unscoped match is ambiguous.
  await expect(
    page.getByTestId("connector-row-milanuncios").getByText("Circuito abierto"),
  ).toBeVisible();
  await expect(
    page.getByTestId("connector-row-idealista").getByText("Omitido"),
  ).toBeVisible();

  // A disabled connector's reason is informational, not an error — it must
  // not render in the red used for real faults.
  const skippedReason = page
    .getByTestId("connector-row-idealista-error")
    .locator("button");
  await expect(skippedReason).toContainText("disabled via connector_config");
  await expect(skippedReason).not.toHaveClass(/text-red-500/);

  // Issue #242: the typed failure classification renders as a human label on
  // the connector that has one, and is absent on the clean connector.
  await expect(
    page.getByTestId("connector-failure-milanuncios"),
  ).toContainText("Cambio de estructura");
  await expect(page.getByTestId("connector-failure-fotocasa")).toHaveCount(0);

  // Issue #109: the resolved geography a run actually ran against is shown per
  // connector, with its per-scope outcome — the audit trail #109 asked for.
  const geo = page.getByTestId("connector-row-fotocasa-geo");
  await expect(geo).toContainText("madrid-capital");
  await expect(geo).toContainText("Rastreada");

  // Issue #171: the run-level extraction-quality aggregate renders in the new
  // "Calidad" column — a grade + mean completeness percent — and fotocasa's
  // stable run carries no degraded alarm.
  const fotocasaQuality = page.getByTestId("connector-quality-fotocasa");
  await expect(fotocasaQuality).toContainText("88 %");
  await expect(fotocasaQuality).toContainText("A");

  await expect(page.getByTestId("error-display")).toHaveCount(0);
});

test("a silently-degraded connector (status ok) is flagged in the ETL monitor (#171)", async ({
  page,
}) => {
  // The #171 failure mode: a connector runs status='ok' with zero fetch errors,
  // but its average extraction completeness silently dropped vs recent runs
  // (a partial markup change). status/error_count cannot represent it — only
  // the run-level extraction-quality trend can. Seed exactly that and assert
  // the degraded badge makes it visible next to a genuinely-healthy connector.
  const r = await pool.query<{ id: number }>(
    `INSERT INTO connector_runs
        (trigger, started_at, finished_at, duration_ms, status,
         connectors_ok, connectors_failed, connectors_skipped, total_connectors)
     VALUES ($1, NOW() - INTERVAL '6 minutes', NOW() - INTERVAL '5 minutes',
             60000, 'success', 2, 0, 0, 2)
     RETURNING id`,
    [TRIGGER],
  );
  const degradedRunId = r.rows[0].id;

  const healthy = {
    n: 30,
    mean_score: 0.9,
    grade_histogram: { A: 24, B: 4, C: 2, F: 0 },
    low_quality_count: 2,
    weights_version: 1,
    trend: { baseline_mean: 0.89, baseline_n_runs: 5, delta: 0.01, degraded: false },
  };
  const degraded = {
    n: 22,
    mean_score: 0.58,
    grade_histogram: { A: 2, B: 3, C: 9, F: 8 },
    low_quality_count: 17,
    weights_version: 1,
    trend: { baseline_mean: 0.9, baseline_n_runs: 5, delta: -0.32, degraded: true },
  };

  await pool.query(
    `INSERT INTO connector_run_results
        (run_id, connector_name, started_at, finished_at, status,
         discovered_count, fetched_count, error_count, error_msg,
         failure_classification, geography_scope, extraction_quality_summary)
     VALUES
        ($1, 'fotocasa',    NOW() - INTERVAL '6 minutes', NOW() - INTERVAL '5 minutes',
         'ok', 31, 30, 0, NULL, NULL, NULL, $2::jsonb),
        ($1, 'milanuncios', NOW() - INTERVAL '6 minutes', NOW() - INTERVAL '5 minutes',
         'ok', 24, 22, 0, NULL, NULL, NULL, $3::jsonb)`,
    [degradedRunId, JSON.stringify(healthy), JSON.stringify(degraded)],
  );

  await page.goto(`/etl/${degradedRunId}`);
  await expect(page.getByTestId("run-detail")).toBeVisible();
  await expect(page.getByTestId("connector-stats")).toBeVisible();

  // milanuncios: status OK, zero errors — but the degraded trend badge is shown.
  await expect(
    page.getByTestId("connector-row-milanuncios").getByText("OK"),
  ).toBeVisible();
  const degradedBadge = page.getByTestId("connector-quality-trend-milanuncios");
  await expect(degradedBadge).toBeVisible();
  await expect(degradedBadge).toContainText("Calidad");

  // fotocasa is healthy in the same run — it must NOT carry the degraded badge,
  // so a real drop is distinguishable from a genuinely-healthy connector.
  const healthyTrend = page.getByTestId("connector-quality-trend-fotocasa");
  await expect(healthyTrend).not.toContainText("Calidad");

  await expect(page.getByTestId("error-display")).toHaveCount(0);
  await expect(page.getByText("Detalles técnicos")).toHaveCount(0);
});

test("a run where every connector was skipped is not badged as a success", async ({
  page,
}) => {
  // The orchestrator records status='success' whenever failed==0, so an
  // all-skipped run (the default state since #106 made connectors
  // disabled-by-default) would otherwise show a green "Completado" — the
  // badge operators scan first — while nothing actually ran.
  const r = await pool.query<{ id: number }>(
    `INSERT INTO connector_runs
        (trigger, started_at, finished_at, duration_ms, status,
         connectors_ok, connectors_failed, connectors_skipped, total_connectors)
     VALUES ($1, NOW() - INTERVAL '3 minutes', NOW() - INTERVAL '3 minutes',
             900, 'success', 0, 0, 3, 3)
     RETURNING id`,
    [TRIGGER],
  );
  const skippedRunId = r.rows[0].id;

  await page.goto("/etl");
  await expect(page.getByTestId(`run-connectors-${skippedRunId}`)).toContainText(
    "0 / 0 / 3",
  );
  await expect(
    page.locator(`a[href="/etl/${skippedRunId}"]`).first(),
  ).toContainText("Sin actividad");
});

test("the Ejecutar todo ahora button is present (issue #244)", async ({ page }) => {
  // The connector orchestrator now polls etl_manual_trigger
  // (etl/manual_trigger.py), so /api/etl/run is a real endpoint again — the
  // full-sweep control is back, not the hard 501 it was after issue #104.
  await page.goto("/etl");
  await expect(page.getByTestId("run-list")).toBeVisible();

  await expect(page.getByTestId("run-now-all")).toBeVisible();
  // The old source-project watermark-resync affordances stay gone.
  await expect(page.getByTestId("sync-now-button")).toHaveCount(0);
  await expect(page.getByTestId("force-resync-button")).toHaveCount(0);
});
