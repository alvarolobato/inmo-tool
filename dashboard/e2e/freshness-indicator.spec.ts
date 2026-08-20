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

// ── Issue #586 (review findings B1/B2, PR #590) ────────────────────────────
//
// These three cover the exact scenarios the issue's Exit Criteria named
// (EC-1/2/3) but the original PR left unautomated. Two are mocked
// (`page.route`) rather than DB-seeded: this spec file runs against the
// SHARED e2e Postgres, not a per-run isolated database (AGENTS.md — pytest/
// vitest get isolation, `jobs.dashboard-e2e` talks to the shared service DB
// directly), so a real connector already sitting stale there could make an
// "everything fresh" assertion flaky for reasons that have nothing to do
// with this code. Mocking the API response tests exactly what these two
// scenarios are actually about — the FRONTEND's response to a given
// payload — deterministically. The third genuinely needs the real pipeline
// (seed → query → render), so it stays DB-backed, scoped to one real capture
// portal's own state rather than the global dot (which any other stale
// connector in the shared DB could already be driving amber).

test("all fresh stays green (EC-2)", async ({ page }) => {
  const now = new Date().toISOString();
  await page.route("**/api/data-health", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        connectors: [
          {
            connector: "e2e-mock-fresh",
            enabled: true,
            inScope: true,
            lastSuccessAt: now,
            lastRunAt: now,
            lastRunStatus: "ok",
            state: "fresh",
            isStale: false,
          },
        ],
        overallStale: false,
        overallRefreshing: false,
        overallUnknown: false,
        stalestConnector: { connector: "e2e-mock-fresh", lastSuccessAt: now, lastRunStatus: "ok" },
        freshestSuccessAt: now,
      }),
    });
  });

  await page.goto("/");
  const pill = page.getByTestId("freshness-indicator");
  // The "hace Xm" age suffix only appears once the mocked payload was
  // actually consumed — plain "Datos al día" alone is also the UNFETCHED
  // initial default, so asserting the suffix rules out a false pass where
  // the mock never actually intercepted anything.
  await expect(pill).toHaveText(/Datos al día · hace \d+m/);
});

test("API failure shows unknown, not green (EC-3)", async ({ page }) => {
  await page.route("**/api/data-health", async (route) => {
    await route.fulfill({
      status: 200, // the route itself always returns 200 (issue #241) — the
      // failure is INSIDE getConnectorFreshness(), degraded server-side.
      contentType: "application/json",
      body: JSON.stringify({
        connectors: [],
        overallStale: false,
        overallRefreshing: false,
        overallUnknown: true,
        stalestConnector: null,
        freshestSuccessAt: null,
      }),
    });
  });

  await page.goto("/");
  const pill = page.getByTestId("freshness-indicator");
  await expect(pill).toHaveText("Estado desconocido");
  await expect(pill).not.toHaveText(/Datos al día/);
});

test.describe("capture-portal staleness (EC-1) — real DB, scoped to one real portal", () => {
  // MUST be a real CAPTURE_PORTALS name: isCaptureOnlyForFreshness() gates on
  // isCapturePortal(), so a synthetic e2e-only name would never enter the
  // capture-only branch this test is covering. `aliseda` genuinely carries
  // production-shaped data on the shared e2e DB already — this test saves
  // and restores its `connector_config` row and only deletes the ONE
  // extension_capture row it inserts (a distinctive marker URL), never
  // touching aliseda's real capture history.
  const PORTAL = "aliseda";
  const MARKER_URL = "https://e2e-freshness-586.invalid/marker";
  let priorConfig: {
    enabled: boolean;
    capture_enabled: boolean | null;
    freshness_interval_hours: number | null;
  } | null = null;
  let hadConfigRow = false;

  test.beforeEach(async () => {
    test.skip(!dbAvailable, "no reachable Postgres");
    const { rows } = await pool.query(
      `SELECT enabled, capture_enabled, freshness_interval_hours
         FROM connector_config WHERE connector_name = $1`,
      [PORTAL],
    );
    hadConfigRow = rows.length > 0;
    priorConfig = rows[0] ?? null;
  });

  test.afterEach(async () => {
    if (!dbAvailable) return;
    await pool.query("DELETE FROM extension_capture WHERE connector_name = $1 AND url = $2", [
      PORTAL,
      MARKER_URL,
    ]);
    if (hadConfigRow && priorConfig) {
      await pool.query(
        `UPDATE connector_config
            SET enabled = $2, capture_enabled = $3, freshness_interval_hours = $4
          WHERE connector_name = $1`,
        [PORTAL, priorConfig.enabled, priorConfig.capture_enabled, priorConfig.freshness_interval_hours],
      );
    } else if (!hadConfigRow) {
      await pool.query("DELETE FROM connector_config WHERE connector_name = $1", [PORTAL]);
    }
  });

  test("a stale capture-only portal reads due/stale on its own /etl/connectors pill", async ({
    page,
  }) => {
    // Force a deterministic 24h window and a 'done' capture 11 days ago —
    // unambiguously past it, mirroring the owner's real "hace dos días".
    await pool.query(
      `INSERT INTO connector_config (connector_name, enabled, capture_enabled, freshness_interval_hours)
       VALUES ($1, false, true, 24)
       ON CONFLICT (connector_name) DO UPDATE
          SET enabled = false, capture_enabled = true, freshness_interval_hours = 24`,
      [PORTAL],
    );
    await pool.query(
      `INSERT INTO extension_capture (url, connector_name, status, created_at)
       VALUES ($1, $2, 'done', NOW() - interval '11 days')`,
      [MARKER_URL, PORTAL],
    );

    await page.goto("/etl/connectors");
    await page.getByTestId(`expand-${PORTAL}`).click();
    const stateBadge = page.getByTestId(`freshness-state-${PORTAL}`);
    await expect(stateBadge).toBeVisible();
    // "obsoleto, sin ciclo iniciado" (due) — never "fresco" — proving the
    // pill reads this portal's real extension_capture staleness, not a
    // permanently-empty connector_freshness_state row (issue #586 review B1).
    await expect(stateBadge).toContainText("obsoleto");
  });
});
