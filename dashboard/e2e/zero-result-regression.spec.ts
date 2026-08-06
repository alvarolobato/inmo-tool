/**
 * E2E: zero-results regression monitor on "Salud de datos" (issue #376, D-041).
 *
 * Drives a real Next.js server against a real Postgres, seeding several
 * connector_runs + connector_run_results rows whose `geography_scope` JSONB
 * encodes a per-(connector, scope) result-count history, then asserts:
 *
 *   - a scope that returned listings and then went 0 for N consecutive runs is
 *     FLAGGED ("dejaron de devolver resultados");
 *   - a scope that was ALWAYS 0 (sparse area) is NOT flagged;
 *   - a scope that recovered (later nonzero) is NOT flagged;
 *   - no error surface renders against the real seeded data (the D-041 bar).
 *
 * Admin-gated (middleware.ts `/etl/:path*`), so it sets the `ps_admin` cookie
 * the way /admin/login does. Skips cleanly when Postgres is unreachable or
 * ADMIN_API_KEY is unset, matching the other specs.
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

// Distinctive connector name so cleanup is precise and can't touch real data.
const CONN = "e2e_zrr_connector";
const DRIFTED_SCOPE = "e2e-zrr-drifted";
const SPARSE_SCOPE = "e2e-zrr-sparse";
const RECOVERED_SCOPE = "e2e-zrr-recovered";

let pool: Pool;
let dbAvailable = false;
const adminKey = process.env.ADMIN_API_KEY?.trim();
const runIds: number[] = [];

function geoEntry(scopeKey: string, count: number) {
  return {
    scope_key: scopeKey,
    center: null,
    radius_km: null,
    rooms: null,
    outcome: count > 0 ? "crawled" : "empty",
    discovered_count: count,
  };
}

async function purge(): Promise<void> {
  await pool.query(
    "DELETE FROM connector_run_results WHERE connector_name = $1",
    [CONN],
  );
  if (runIds.length) {
    await pool.query("DELETE FROM connector_runs WHERE id = ANY($1)", [runIds]);
  }
}

test.beforeAll(async () => {
  pool = buildPool();
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn("[zero-result-regression.spec] Postgres unreachable — skipping");
    return;
  }
  await purge();

  // Per-run result counts for each scope, oldest→newest. The drifted scope
  // returned listings then went 0 for 3 consecutive runs (default N=3); the
  // sparse scope was always 0; the recovered scope drifted then came back.
  const drifted = [12, 9, 0, 0, 0];
  const sparse = [0, 0, 0, 0, 0];
  const recovered = [7, 0, 0, 0, 5];

  for (let i = 0; i < drifted.length; i++) {
    const run = await pool.query<{ id: number }>(
      `INSERT INTO connector_runs (trigger, status, started_at)
       VALUES ('manual','success', NOW() - ($1 || ' hours')::interval)
       RETURNING id`,
      [String((drifted.length - i) * 2)],
    );
    const runId = run.rows[0].id;
    runIds.push(runId);
    const geo = [
      geoEntry(DRIFTED_SCOPE, drifted[i]),
      geoEntry(SPARSE_SCOPE, sparse[i]),
      geoEntry(RECOVERED_SCOPE, recovered[i]),
    ];
    const discovered = drifted[i] + sparse[i] + recovered[i];
    await pool.query(
      `INSERT INTO connector_run_results
         (run_id, connector_name, status, started_at, finished_at,
          discovered_count, fetched_count, error_count, geography_scope)
       VALUES ($1,$2,'ok', NOW(), NOW(), $3, $3, 0, $4::jsonb)`,
      [runId, CONN, discovered, JSON.stringify(geo)],
    );
  }
});

test.afterAll(async () => {
  if (dbAvailable) await purge();
  await pool?.end();
});

test.beforeEach(async ({ page, baseURL }) => {
  test.skip(!dbAvailable, "Postgres unavailable");
  test.skip(!adminKey, "ADMIN_API_KEY not set for the server under test");
  await page.context().addCookies([
    { name: "ps_admin", value: adminKey!, url: baseURL ?? "http://localhost:4000" },
  ]);
});

test("flags a scope that stopped returning results after N consecutive zeros", async ({
  page,
}) => {
  await page.goto("/etl/salud");
  await expect(page.getByTestId("data-health-page")).toBeVisible();

  // The section renders and the drifted scope is flagged with its count.
  const card = page.getByTestId(`zero-result-regression-${CONN}-${DRIFTED_SCOPE}`);
  await expect(card).toBeVisible();
  await expect(
    page.getByTestId(`zero-result-badge-${CONN}-${DRIFTED_SCOPE}`),
  ).toContainText("3");
  await expect(
    page.getByTestId(`zero-result-detail-${CONN}-${DRIFTED_SCOPE}`),
  ).toContainText("9");
});

test("does NOT flag an always-zero (sparse) or a recovered scope", async ({
  page,
}) => {
  await page.goto("/etl/salud");
  await expect(page.getByTestId("data-health-page")).toBeVisible();
  await expect(page.getByTestId("zero-result-regressions")).toBeVisible();

  await expect(
    page.getByTestId(`zero-result-regression-${CONN}-${SPARSE_SCOPE}`),
  ).toHaveCount(0);
  await expect(
    page.getByTestId(`zero-result-regression-${CONN}-${RECOVERED_SCOPE}`),
  ).toHaveCount(0);
});

test("loads with no error surface (D-041)", async ({ page }) => {
  await page.goto("/etl/salud");
  await expect(page.getByTestId("data-health-page")).toBeVisible();
  await expect(page.getByTestId("zero-result-regressions")).toBeVisible();

  await expect(page.getByText("Detalles técnicos")).toHaveCount(0);
  await expect(page.getByText("Error al cargar")).toHaveCount(0);
  await expect(page.getByText("there is no parameter")).toHaveCount(0);
  await expect(page.getByText("HTTP 500")).toHaveCount(0);
});
