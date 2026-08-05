/**
 * E2E: "Salud de datos" data-health page (issue #272, D-041).
 *
 * Drives a real Next.js server against a real Postgres, seeding
 * connector_run_results / extension_capture / listing / search_profile
 * directly via `pg`, then asserts the four exit criteria plus the D-041 bar:
 *
 *   - EC-1: pending count + oldest age per portal render.
 *   - EC-2: a portal with a >5-min-old pending capture is flagged "Atascado".
 *   - EC-3: success rate + extraction completeness render.
 *   - EC-4: no error surface against real seeded data.
 *
 * Also checks the clean-vs-error distinction (#270/#300): a connector that
 * stopped cleanly for budget renders green-with-a-notice, NOT as an error;
 * only a genuine `failed`/`circuit_open` run shows attention styling.
 *
 * Admin-gated (middleware.ts `/etl/:path*` + `/api/etl/:path*`), so the test
 * sets the `ps_admin` cookie the way /admin/login does. Skips cleanly when
 * Postgres is unreachable or ADMIN_API_KEY is unset, matching the other specs.
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

// Distinctive markers so cleanup is precise and can't touch real data.
const HEALTHY_CONN = "e2e_health_ok";
const FAILED_CONN = "e2e_health_failed";
// Issue #292: a legacy/disabled 'skipped' run must render NEUTRAL (never
// attention), and a captured search/listing page must render as a clean,
// informational outcome (never a failure).
const SKIPPED_CONN = "e2e_health_skipped";
const STUCK_URL = "https://www.idealista.com/inmueble/E2E-DH-STUCK";
const DONE_URL = "https://www.idealista.com/inmueble/E2E-DH-DONE";
const LISTING_URL = "https://www.idealista.com/venta-viviendas/E2E-DH-LISTING/";
const E2E_SOURCE = "e2e_health_src";
const E2E_PROFILE = "E2E Salud Perfil";

let pool: Pool;
let dbAvailable = false;
const adminKey = process.env.ADMIN_API_KEY?.trim();
let runId: number;
let listingId: number;
let profileId: number;
let propertyId: number;

async function purge(): Promise<void> {
  await pool.query("DELETE FROM extension_capture WHERE url LIKE '%E2E-DH-%'");
  await pool.query(
    "DELETE FROM connector_run_results WHERE connector_name LIKE 'e2e_health_%'",
  );
  await pool.query("DELETE FROM search_profile WHERE name = $1", [E2E_PROFILE]);
  await pool.query("DELETE FROM listing WHERE source = $1", [E2E_SOURCE]);
  await pool.query(
    "DELETE FROM property WHERE id IN (SELECT property_id FROM listing WHERE source = $1)",
    [E2E_SOURCE],
  );
}

test.beforeAll(async () => {
  pool = buildPool();
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn("[data-health.spec] Postgres unreachable — skipping");
    return;
  }
  await purge();

  // A connector run to attach results to.
  const run = await pool.query<{ id: number }>(
    `INSERT INTO connector_runs (trigger, status) VALUES ('manual','partial') RETURNING id`,
  );
  runId = run.rows[0].id;

  // Healthy connector: ok WITH a budget notice (clean stop) — must be green.
  await pool.query(
    `INSERT INTO connector_run_results
       (run_id, connector_name, status, started_at, finished_at,
        discovered_count, fetched_count, error_count, error_msg)
     VALUES ($1,$2,'ok', NOW(), NOW(), 20, 20, 0, 'nota: presupuesto de página agotado')`,
    [runId, HEALTHY_CONN],
  );
  // Failing connector: circuit_open — must render as attention.
  await pool.query(
    `INSERT INTO connector_run_results
       (run_id, connector_name, status, started_at, finished_at,
        discovered_count, fetched_count, error_count, error_msg)
     VALUES ($1,$2,'circuit_open', NOW(), NOW(), 5, 0, 7, 'discover failed: 403 soft-block')`,
    [runId, FAILED_CONN],
  );
  // Disabled/skipped connector (issue #292): a 'skipped' run — the kind a
  // pre-#292 DB still carries for a disabled connector — must render as a
  // neutral 'Omitido' badge, NOT amber/red, and NOT as an error surface.
  await pool.query(
    `INSERT INTO connector_run_results
       (run_id, connector_name, status, started_at, finished_at,
        discovered_count, fetched_count, error_count, error_msg)
     VALUES ($1,$2,'skipped', NOW(), NOW(), 0, 0, 0, 'disabled via connector_config')`,
    [runId, SKIPPED_CONN],
  );

  // A property + listing so the capture join to photo_urls resolves. The
  // timestamps are deliberately staggered to prove the staleness predicate
  // uses GREATEST(last_seen_at, last_fetched_at, first_seen_at), not
  // last_seen_at alone: first_seen_at/last_seen_at are OLD, only
  // last_fetched_at is recent (a detail re-fetch). A MAX(last_seen_at)-only
  // query would report this listing as 30 days old and NOT flag the profile;
  // GREATEST catches the recent re-fetch and DOES.
  const prop = await pool.query<{ id: number }>(
    `INSERT INTO property (created_at) VALUES (NOW()) RETURNING id`,
  );
  propertyId = prop.rows[0].id;
  const lst = await pool.query<{ id: number }>(
    `INSERT INTO listing
       (property_id, source, external_id, photo_urls,
        first_seen_at, last_seen_at, last_fetched_at)
     VALUES ($1,$2,'E2E-DH-1', ARRAY['a','b','c','d','e'],
        NOW() - INTERVAL '30 days', NOW() - INTERVAL '30 days', NOW())
     RETURNING id`,
    [propertyId, E2E_SOURCE],
  );
  listingId = lst.rows[0].id;

  // Stuck pending capture: created 10 minutes ago, still pending → flagged.
  await pool.query(
    `INSERT INTO extension_capture (url, status, created_at)
     VALUES ($1,'pending', NOW() - INTERVAL '10 minutes')`,
    [STUCK_URL],
  );
  // A recent done capture on the same portal (success rate + completeness).
  await pool.query(
    `INSERT INTO extension_capture
       (url, status, listing_id, fields_extracted, fields_available, created_at, processed_at)
     VALUES ($1,'done',$2, 8, 10, NOW(), NOW())`,
    [DONE_URL, listingId],
  );
  // A captured SEARCH/listing page (issue #292): status='listing', clean —
  // its detail links were harvested into the batch worklist. It must be
  // surfaced as a neutral count and MUST NOT count as a failure (so idealista
  // stays at 100% success: 1 done / 0 failed).
  await pool.query(
    `INSERT INTO extension_capture
       (url, status, connector_name, fields_extracted, title, created_at, processed_at)
     VALUES ($1,'listing','idealista', 12,
             'Página de resultados — 12 enlaces de detalle', NOW(), NOW())`,
    [LISTING_URL],
  );

  // A profile materialized 1 day ago — AFTER the listing's first/last_seen_at
  // (30 days ago) but BEFORE its last_fetched_at (now). So it is stale ONLY
  // via the last_fetched_at branch of GREATEST — the exact case a
  // last_seen_at-only query misses.
  const prof = await pool.query<{ id: number }>(
    `INSERT INTO search_profile (name, scope, thesis_params, last_materialized_at)
     VALUES ($1, $2::jsonb, '{}'::jsonb, NOW() - INTERVAL '1 day') RETURNING id`,
    [
      E2E_PROFILE,
      JSON.stringify({ geography: ["Estepona"], property_types: ["flat"] }),
    ],
  );
  profileId = prof.rows[0].id;
});

test.afterAll(async () => {
  if (dbAvailable) {
    await purge();
    if (runId) {
      await pool.query("DELETE FROM connector_runs WHERE id = $1", [runId]);
    }
  }
  await pool?.end();
});

test.beforeEach(async ({ page, baseURL }) => {
  test.skip(!dbAvailable, "Postgres unavailable");
  test.skip(!adminKey, "ADMIN_API_KEY not set for the server under test");
  await page.context().addCookies([
    { name: "ps_admin", value: adminKey!, url: baseURL ?? "http://localhost:4000" },
  ]);
});

test("renders capture health with pending count and oldest age (EC-1)", async ({
  page,
}) => {
  await page.goto("/etl/salud");
  await expect(page.getByTestId("data-health-page")).toBeVisible();

  // Portal capture health for idealista renders, with pending count + age.
  const pending = page.getByTestId("portal-pending-idealista");
  await expect(pending).toBeVisible();
  await expect(pending).toContainText("1");
  await expect(page.getByTestId("portal-oldest-idealista")).toContainText(
    /más antiguo/,
  );
});

test("flags a portal stuck past the threshold (EC-2)", async ({ page }) => {
  await page.goto("/etl/salud");
  await expect(page.getByTestId("portal-health-idealista")).toBeVisible();
  // The 10-minute-old pending capture is past the 5-minute threshold.
  await expect(page.getByTestId("portal-stuck-idealista")).toBeVisible();
  await expect(page.getByTestId("portal-stuck-idealista")).toHaveText("Atascado");
});

test("shows success rate and extraction completeness (EC-3)", async ({ page }) => {
  await page.goto("/etl/salud");
  await expect(page.getByTestId("portal-success-idealista")).toBeVisible();
  // 1 done / 0 failed = 100%.
  await expect(page.getByTestId("portal-success-idealista")).toContainText("100%");
  // 8/10 fields extracted = 80% completeness.
  await expect(page.getByTestId("portal-completeness-idealista")).toContainText(
    "80%",
  );
});

test("distinguishes a clean budget stop from a real failure", async ({ page }) => {
  await page.goto("/etl/salud");

  // Healthy connector: ok status badge + a "Parada limpia" info note.
  const okStatus = page.getByTestId(`connector-status-${HEALTHY_CONN}`);
  await expect(okStatus).toHaveText("OK");
  await expect(page.getByTestId(`connector-notice-${HEALTHY_CONN}`)).toContainText(
    "presupuesto",
  );
  // The clean stop is NOT rendered as an error.
  await expect(page.getByTestId(`connector-error-${HEALTHY_CONN}`)).toHaveCount(0);

  // Failing connector: attention status + the genuine error message.
  await expect(
    page.getByTestId(`connector-status-${FAILED_CONN}`),
  ).toHaveText("Circuito abierto");
  await expect(page.getByTestId(`connector-error-${FAILED_CONN}`)).toContainText(
    "soft-block",
  );
});

test("surfaces a profile stale only via last_fetched_at (GREATEST predicate)", async ({
  page,
}) => {
  await page.goto("/etl/salud");
  // The profile's last_materialized_at is newer than the listing's
  // first/last_seen_at but older than its last_fetched_at — so it is stale
  // ONLY because the predicate uses GREATEST across all three timestamps,
  // matching etl/materialize_reconciler.py::_stale_profiles_exist.
  await expect(page.getByTestId(`stale-profile-${profileId}`)).toBeVisible();
  await expect(page.getByTestId(`stale-profile-${profileId}`)).toContainText(
    E2E_PROFILE,
  );
});

test("does not flag stale profiles while a connector sweep is running", async ({
  page,
}) => {
  // A running connector_runs row means last_seen_at is being bumped mid-sweep
  // before last_materialized_at catches up — the reconciler defers, and so
  // must this page (else it floods false positives for the whole sweep).
  const running = await pool.query<{ id: number }>(
    `INSERT INTO connector_runs (trigger, status) VALUES ('manual','running') RETURNING id`,
  );
  const runningId = running.rows[0].id;
  try {
    await page.goto("/etl/salud");
    await expect(page.getByTestId("data-health-page")).toBeVisible();
    // The section is annotated as not-evaluable, and the otherwise-stale
    // profile is NOT flagged.
    await expect(page.getByTestId("stale-profiles-sweep")).toBeVisible();
    await expect(page.getByTestId("stale-profiles-sweep")).toContainText(
      "No evaluable",
    );
    await expect(page.getByTestId(`stale-profile-${profileId}`)).toHaveCount(0);
    // Still no error surface.
    await expect(page.getByText("Detalles técnicos")).toHaveCount(0);
  } finally {
    await pool.query("DELETE FROM connector_runs WHERE id = $1", [runningId]);
  }
});

test("renders a disabled/skipped connector as neutral, never as an error (#292)", async ({
  page,
}) => {
  await page.goto("/etl/salud");
  await expect(page.getByTestId(`connector-health-${SKIPPED_CONN}`)).toBeVisible();
  // Neutral 'Omitido' badge — NOT the attention (circuit_open/failed) styling.
  await expect(page.getByTestId(`connector-status-${SKIPPED_CONN}`)).toHaveText(
    "Omitido",
  );
  // A disabled connector never renders an error line, and its "disabled via
  // connector_config" reason is not surfaced as an error.
  await expect(page.getByTestId(`connector-error-${SKIPPED_CONN}`)).toHaveCount(0);
});

test("renders a captured listing/search page as a clean outcome, never a failure (#292)", async ({
  page,
}) => {
  await page.goto("/etl/salud");
  await expect(page.getByTestId("portal-health-idealista")).toBeVisible();
  // The listing capture is surfaced as a neutral informational count …
  await expect(page.getByTestId("portal-listing-idealista")).toContainText("1");
  // … and it did NOT count as a failure: the portal stays at 100% success
  // (1 done ✓ / 0 failed ✗), proving a captured results page is not an error.
  await expect(page.getByTestId("portal-success-idealista")).toContainText("100%");
  await expect(page.getByTestId("portal-success-idealista")).toContainText("0✗");
});

test("loads with no error surface (EC-4)", async ({ page }) => {
  await page.goto("/etl/salud");
  await expect(page.getByTestId("data-health-page")).toBeVisible();
  // Real content is present (at least one connector card).
  await expect(page.getByTestId(`connector-health-${HEALTHY_CONN}`)).toBeVisible();

  // No error surface — the D-041 bar.
  await expect(page.getByText("Detalles técnicos")).toHaveCount(0);
  await expect(page.getByText("Error al cargar")).toHaveCount(0);
  await expect(page.getByText("there is no parameter")).toHaveCount(0);
  await expect(page.getByText("HTTP 500")).toHaveCount(0);
});
