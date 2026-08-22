/**
 * E2E: data health, per source (issue #272, D-041; repointed by #642 P2).
 *
 * These are `/etl/salud`'s own exit criteria, still asserted, now against the
 * surfaces that absorbed them when #642 P2 deleted that page. Repointing
 * rather than deleting is the whole point: "every deleted section has a named
 * home" is a claim, and this file is what makes it a checked one.
 *
 *   - EC-1/EC-2/EC-3 (capture pending count, oldest age, the >5-min "Atascado"
 *     flag, success rate, extraction completeness) → `/admin/fuentes/<portal>`,
 *     the "Captura por portal" section.
 *   - The #270/#300 clean-vs-error distinction (a connector that stopped for
 *     budget renders green-with-a-notice; only `failed`/`circuit_open` shows
 *     attention) → the same source's `<ConnectorCard>` on Fuentes, which #642
 *     P2 taught to split `error_msg` into a notice vs an error rather than
 *     appending it raw.
 *   - Stale profiles + the #285 running-sweep guard → the Estado board's
 *     "Colas" tile (#640/#702), which reuses `STALE_PROFILES_SQL` and the same
 *     guard verbatim.
 *   - EC-4 (no error surface) is asserted on each destination.
 *
 * Drives a real Next.js server against a real Postgres, seeding
 * connector_registry / connector_config / connector_run_results /
 * extension_capture / listing / search_profile directly via `pg`. The two
 * synthetic connectors are REGISTERED here (unlike on the old page, which read
 * only run results): Fuentes renders its card from `/api/etl/connectors`, so
 * an unregistered name shows `fuente-not-found` and no card.
 *
 * Admin-gated (middleware.ts gates every UI page + `/api/etl/:path*`), so the
 * test sets the `ps_admin` cookie the way /admin/login does. Skips cleanly when
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
// A SYNTHETIC host, deliberately not a real portal (#642 P2). The per-portal
// aggregates are windowed averages over every capture on that host, so seeding
// three rows on `idealista.com` and asserting "80% completitud" only holds on
// an empty database — against the shared/demo DB, 2.168 real idealista
// captures averaging 0.501 drown the fixture and the assertion reads 50%.
// `hostToPortal` (lib/data-health.ts) falls through to the bare host for a
// host it doesn't recognise, so this spec gets a portal row of its own,
// containing exactly the three captures it seeded, on any database.
const E2E_HOST = "e2e-dh-portal.test";
const STUCK_URL = `https://${E2E_HOST}/inmueble/E2E-DH-STUCK`;
const DONE_URL = `https://${E2E_HOST}/inmueble/E2E-DH-DONE`;
const LISTING_URL = `https://${E2E_HOST}/venta-viviendas/E2E-DH-LISTING/`;
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
  await pool.query("DELETE FROM connector_config WHERE connector_name LIKE 'e2e_health_%'");
  await pool.query("DELETE FROM connector_registry WHERE connector_name LIKE 'e2e_health_%'");
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

  // Register the synthetic connectors. `/etl/salud` listed a connector from
  // its run results alone; Fuentes renders a source's card from
  // `/api/etl/connectors`, which reads the registry — without these rows the
  // page renders `fuente-not-found` and the card assertions below have
  // nothing to bind to.
  for (const conn of [HEALTHY_CONN, FAILED_CONN, SKIPPED_CONN]) {
    await pool.query(
      `INSERT INTO connector_registry
         (connector_name, registered, rate_limit_per_minute, discovers_full_inventory,
          supports_discovery, supported_filters)
       VALUES ($1, true, 20, false, true, '[]'::jsonb)`,
      [conn],
    );
    await pool.query(
      `INSERT INTO connector_config (connector_name, enabled) VALUES ($1, true)`,
      [conn],
    );
  }

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
  // surfaced as a neutral count and MUST NOT count as a failure (so the portal
  // stays at 100% success: 1 done / 0 failed).
  await pool.query(
    `INSERT INTO extension_capture
       (url, status, connector_name, fields_extracted, title, created_at, processed_at)
     VALUES ($1,'listing',$2, 12,
             'Página de resultados — 12 enlaces de detalle', NOW(), NOW())`,
    [LISTING_URL, E2E_HOST],
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

test("EC-1: capture pending count and oldest age render on the portal's Fuentes page", async ({
  page,
}) => {
  await page.goto(`/admin/fuentes/${E2E_HOST}`);
  await expect(page.getByTestId("fuente-detail-page")).toBeVisible();

  const section = page.getByTestId("fuente-portal-health");
  await expect(section).toBeVisible();
  await expect(section.getByTestId("portal-pending")).toContainText("1");
  await expect(section.getByTestId("portal-oldest")).toContainText(/más antiguo/);
});

test("EC-2: a portal stuck past the threshold is flagged", async ({ page }) => {
  await page.goto(`/admin/fuentes/${E2E_HOST}`);
  // The 10-minute-old pending capture is past the 5-minute threshold.
  await expect(page.getByTestId("portal-stuck")).toBeVisible();
  await expect(page.getByTestId("portal-stuck")).toHaveText("Atascado");
});

test("EC-3: success rate and extraction completeness render", async ({ page }) => {
  await page.goto(`/admin/fuentes/${E2E_HOST}`);
  // 1 done / 0 failed = 100%.
  await expect(page.getByTestId("portal-success")).toContainText("100%");
  // 8/10 fields extracted = 80% completeness.
  await expect(page.getByTestId("portal-completeness")).toContainText("80%");
});

test("a captured results page is a clean outcome, never a failure (#292)", async ({ page }) => {
  await page.goto(`/admin/fuentes/${E2E_HOST}`);
  // The listing capture is surfaced as a neutral informational count …
  await expect(page.getByTestId("portal-listing")).toContainText("1");
  // … and it did NOT count as a failure: the portal stays at 100% success
  // (1 done ✓ / 0 failed ✗), proving a captured results page is not an error.
  await expect(page.getByTestId("portal-success")).toContainText("100%");
  await expect(page.getByTestId("portal-success")).toContainText("0✗");
});

test("distinguishes a clean budget stop from a real failure", async ({ page }) => {
  // D-047's distinction, on the surface that inherited it. Before #642 P2 the
  // connector card appended `error_msg` to its last-run line with no
  // distinction at all, so moving the section here without this change would
  // have quietly dropped the semantics while appearing to preserve the data.
  await page.goto(`/admin/fuentes/${HEALTHY_CONN}`);
  await expect(page.getByTestId(`connector-${HEALTHY_CONN}`)).toBeVisible();
  await expect(page.getByTestId(`lastrun-notice-${HEALTHY_CONN}`)).toContainText("presupuesto");
  // The clean stop is NOT rendered as an error.
  await expect(page.getByTestId(`lastrun-error-${HEALTHY_CONN}`)).toHaveCount(0);
  await expect(page.getByTestId("error-display")).toHaveCount(0);

  await page.goto(`/admin/fuentes/${FAILED_CONN}`);
  await expect(page.getByTestId(`lastrun-error-${FAILED_CONN}`)).toContainText("soft-block");
  await expect(page.getByTestId(`lastrun-notice-${FAILED_CONN}`)).toHaveCount(0);
});

test("a disabled/skipped connector's reason is neutral, never an error (#292)", async ({
  page,
}) => {
  await page.goto(`/admin/fuentes/${SKIPPED_CONN}`);
  await expect(page.getByTestId(`connector-${SKIPPED_CONN}`)).toBeVisible();
  // 'skipped' is healthy per `connectorHealthLevel` — the reason renders as a
  // notice, not as the red used for real faults.
  await expect(page.getByTestId(`lastrun-notice-${SKIPPED_CONN}`)).toContainText(
    "disabled via connector_config",
  );
  await expect(page.getByTestId(`lastrun-error-${SKIPPED_CONN}`)).toHaveCount(0);
  await expect(page.getByTestId("error-display")).toHaveCount(0);
});

test("a profile stale only via last_fetched_at reaches the Estado queue tile", async ({
  page,
}) => {
  // The profile's last_materialized_at is newer than the listing's
  // first/last_seen_at but older than its last_fetched_at — so it is stale
  // ONLY because the predicate uses GREATEST across all three timestamps,
  // matching etl/materialize_reconciler.py::_stale_profiles_exist. #702's
  // Colas tile imports STALE_PROFILES_SQL, so this is the same population the
  // deleted page listed, counted instead of enumerated.
  await page.goto("/admin");
  const tile = page.getByTestId("queue-tile-perfiles_materializar");
  await expect(tile).toBeVisible();
  await expect(tile).not.toContainText("0");
});

test("stale profiles are not evaluated while a connector sweep is running", async ({ page }) => {
  // A running connector_runs row means last_seen_at is being bumped mid-sweep
  // before last_materialized_at catches up — the reconciler defers (#285), and
  // so must the tile (else it floods false positives for the whole sweep).
  const running = await pool.query<{ id: number }>(
    `INSERT INTO connector_runs (trigger, status) VALUES ('manual','running') RETURNING id`,
  );
  const runningId = running.rows[0].id;
  try {
    await page.goto("/admin");
    const tile = page.getByTestId("queue-tile-perfiles_materializar");
    await expect(tile).toBeVisible();
    // "sweep en curso", never a fabricated 0 — lib/db/queues.ts's own rule.
    await expect(tile).toContainText(/sweep en curso/i);
    await expect(page.getByText("Detalles técnicos")).toHaveCount(0);
  } finally {
    await pool.query("DELETE FROM connector_runs WHERE id = $1", [runningId]);
  }
});

test("EC-4: no error surface on either destination", async ({ page }) => {
  for (const path of [`/admin/fuentes/${E2E_HOST}`, `/admin/fuentes/${HEALTHY_CONN}`, "/admin"]) {
    await page.goto(path);
    await expect(page.getByText("Detalles técnicos")).toHaveCount(0);
    await expect(page.getByText("Error al cargar")).toHaveCount(0);
    await expect(page.getByText("there is no parameter")).toHaveCount(0);
    await expect(page.getByText("HTTP 500")).toHaveCount(0);
  }
});
